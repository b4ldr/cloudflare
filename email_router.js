import { EmailMessage } from "cloudflare:email";
import { createIcs, extractMaintenanceWindowWithAi, extractTextBody } from "./email_processing.mjs";

function toText(stream) {
    return new Response(stream).text();
}

function buildReplyMime({ from, to, subject, bodyText, icsContent, uidDomain, inReplyTo }) {
    const boundary = `mix_${crypto.randomUUID()}`;
    const encodedIcs = btoa(icsContent);
    const messageId = `<${crypto.randomUUID()}@${uidDomain || "local"}>`;
    const date = new Date().toUTCString();
    const threadHeaders = inReplyTo
        ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`]
        : [];

    return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        ...threadHeaders,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        bodyText,
        "",
        `--${boundary}`,
        "Content-Type: text/calendar; method=PUBLISH; charset=utf-8; name=\"maintenance.ics\"",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment; filename=\"maintenance.ics\"",
        "",
        encodedIcs,
        "",
        `--${boundary}--`,
        "",
    ].join("\r\n");
}

function buildPlainTextReplyMime({ from, to, subject, bodyText, uidDomain, inReplyTo }) {
    const messageId = `<${crypto.randomUUID()}@${uidDomain || "local"}>`;
    const date = new Date().toUTCString();
    const threadHeaders = inReplyTo
        ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`]
        : [];

    return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        ...threadHeaders,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        bodyText,
        "",
    ].join("\r\n");
}

function parseAllowList(value) {
    if (!value || typeof value !== "string") return [];
    return value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

function isDebugEnabled(env) {
    const value = String(env.DEBUG || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

function logDebug(enabled, event, metadata = {}) {
    if (!enabled) return;
    console.log(
        JSON.stringify({
            level: "debug",
            event,
            ...metadata,
        })
    );
}

export default {
    async email(message, env, ctx) {
        const debug = isDebugEnabled(env);

        try {
            const allowList = parseAllowList(env.ALLOW_LIST);
            const sendTo = (env.SEND_TO || message.from || "").trim().toLowerCase();
            const fromAddress = (message.from || "").trim().toLowerCase();
            const inReplyTo = message.headers.get("message-id") || "";
            const uidDomain = message.to.split("@")[1] || "local";

            logDebug(debug, "email.received", {
                from: message.from,
                to: message.to,
                inReplyTo,
                sendTo,
            });

            if (allowList.length > 0 && !allowList.includes(fromAddress)) {
                logDebug(debug, "email.rejected", { reason: "sender_not_allowed", from: message.from });
                message.setReject("Address not allowed");
                return;
            }

            if (!sendTo) {
                logDebug(debug, "email.rejected", { reason: "send_to_missing" });
                message.setReject("SEND_TO is not configured");
                return;
            }

            const rawEmail = await toText(message.raw);
            const emailBody = extractTextBody(rawEmail);
            logDebug(debug, "email.parsed", {
                rawLength: rawEmail.length,
                bodyLength: emailBody.length,
                subject: message.headers.get("subject") || "",
            });

            const window = await extractMaintenanceWindowWithAi(emailBody, env);

            if (!window) {
                logDebug(debug, "ai.window_not_found", { model: env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct" });
                const fallbackMime = buildPlainTextReplyMime({
                    from: message.to,
                    to: sendTo,
                    subject: "Could not extract maintenance window",
                    bodyText:
                        "I couldn't confidently extract both maintenance start and end times from your email. Please include explicit date, time, and timezone (for example: 2026-05-27 22:00 UTC to 2026-05-28 01:00 UTC).",
                    uidDomain,
                    inReplyTo,
                });
                const fallbackReply = new EmailMessage(message.to, sendTo, fallbackMime);
                await message.reply(fallbackReply);
                logDebug(debug, "email.fallback_reply_sent", { to: sendTo });
                return;
            }

            logDebug(debug, "ai.window_extracted", {
                start: window.start.toISOString(),
                end: window.end.toISOString(),
                title: window.title || "",
            });

            const subjectTitle = (message.headers.get("subject") || "Maintenance Window")
                .replace(/^\s*(re|fwd?)\s*:\s*/i, "")
                .trim() || "Maintenance Window";
            const eventSummary = window.title || subjectTitle;

            const icsContent = createIcs({
                summary: eventSummary,
                description: emailBody.slice(0, 2000),
                start: window.start,
                end: window.end,
                uidDomain,
            });

            const mime = buildReplyMime({
                from: message.to,
                to: sendTo,
                subject: `Calendar invite: ${eventSummary}`,
                bodyText: [
                    "Attached is the calendar file for the detected maintenance window.",
                    "",
                    `Start: ${window.start.toISOString()}`,
                    `End: ${window.end.toISOString()}`,
                    window.rationale ? `AI notes: ${window.rationale}` : "",
                ].join("\n"),
                icsContent,
                uidDomain,
                inReplyTo,
            });

            const reply = new EmailMessage(message.to, sendTo, mime);
            await message.reply(reply);
            logDebug(debug, "email.reply_sent", { to: sendTo, subject: `Calendar invite: ${eventSummary}` });
        } catch (error) {
            logDebug(debug, "email.error", {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack || "" : "",
            });
            throw error;
        }
    },
};
