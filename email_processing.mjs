function decodeBase64ToText(compactBase64) {
    if (typeof atob === "function") {
        return atob(compactBase64);
    }

    if (typeof Buffer !== "undefined") {
        return Buffer.from(compactBase64, "base64").toString("utf8");
    }

    throw new Error("No base64 decoder available in this runtime");
}

export function decodeTransferEncoding(body, headers) {
    const transferEncodingMatch = headers.match(/content-transfer-encoding:\s*([^\r\n]+)/i);
    const transferEncoding = transferEncodingMatch?.[1]?.trim().toLowerCase();

    if (transferEncoding === "base64") {
        const compact = body.replace(/\s/g, "");
        try {
            return decodeBase64ToText(compact);
        } catch {
            return body;
        }
    }

    if (transferEncoding === "quoted-printable") {
        return body
            .replace(/=\r?\n/g, "")
            .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    return body;
}

export function extractTextBody(rawEmail) {
    const separatorMatch = rawEmail.match(/\r?\n\r?\n/);
    if (!separatorMatch) return rawEmail;

    const separator = separatorMatch[0];
    const separatorIndex = rawEmail.indexOf(separator);
    const headerBlock = rawEmail.slice(0, separatorIndex);
    const bodyBlock = rawEmail.slice(separatorIndex + separator.length);

    const boundaryMatch = headerBlock.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
    if (!boundaryMatch) {
        return decodeTransferEncoding(bodyBlock, headerBlock).trim();
    }

    const boundary = boundaryMatch[1];
    const rawParts = bodyBlock.split(`--${boundary}`);

    for (const rawPart of rawParts) {
        const part = rawPart.trim();
        if (!part || part === "--") continue;

        const partSeparatorMatch = part.match(/\r?\n\r?\n/);
        if (!partSeparatorMatch) continue;

        const partSeparator = partSeparatorMatch[0];
        const partHeaderIndex = part.indexOf(partSeparator);
        const partHeaders = part.slice(0, partHeaderIndex);
        const partBody = part.slice(partHeaderIndex + partSeparator.length);

        if (/content-type:\s*text\/plain/i.test(partHeaders)) {
            return decodeTransferEncoding(partBody, partHeaders).trim();
        }
    }

    return decodeTransferEncoding(bodyBlock, headerBlock).trim();
}

function extractJsonObject(text) {
    if (!text) return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const jsonSlice = text.slice(start, end + 1);
    try {
        return JSON.parse(jsonSlice);
    } catch {
        return null;
    }
}

export function parseAiResult(aiResult) {
    const rawText = typeof aiResult === "string" ? aiResult : aiResult?.response || aiResult?.result || "";
    const parsed = extractJsonObject(rawText);
    if (!parsed || !parsed.start_iso || !parsed.end_iso) return null;

    const start = new Date(parsed.start_iso);
    const end = new Date(parsed.end_iso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;

    return {
        start,
        end,
        title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : "",
    };
}

const MONTH_INDEX = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
};

function inferYearHint(text) {
    const dateLine = text.match(/(?:^|\n)\s*(?:DATE|SPAN)\s*:\s*[^\n]*?(\d{4})/i);
    if (dateLine?.[1]) return Number(dateLine[1]);

    const anyYear = text.match(/\b(20\d{2})\b/);
    if (anyYear?.[1]) return Number(anyYear[1]);

    return new Date().getUTCFullYear();
}


export async function extractMaintenanceWindowWithAi(emailBody, env) {

    if (!env.AI || typeof env.AI.run !== "function") {
        throw new Error("AI binding is missing. Add an AI binding (for example: AI) in wrangler.");
    }

    const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
    const systemPrompt = [
        "You extract maintenance windows from maintenance notification emails.",
        "Return only valid JSON with this exact schema:",
        '{"title":"string","start_iso":"ISO-8601 date-time with timezone","end_iso":"ISO-8601 date-time with timezone","rationale":"string"}',
        "Rules:",
        "- Prefer explicit maintenance window lines over generic headers.",
        "- If both LOCAL and UTC windows are present, use the UTC window.",
        "- If only LOCAL is present, convert LOCAL to ISO with an explicit numeric timezone offset when possible.",
        "- If DATE or SPAN is present but time-window lines exist, ignore DATE/SPAN for start/end extraction.",
        "- Parse patterns like: 'UTC: MONDAY, 18 MAY 14:00 - TUESDAY, 19 MAY 01:00'.",
        "- Parse patterns like: 'LOCAL: MONDAY, 18 MAY 07:00 - MONDAY, 18 MAY 18:00'.",
        "- Infer timezone from the email if present; otherwise use UTC.",
        "- If only one date is provided and an end time is earlier than start time, assume end is next day.",
        "- Preserve cross-day windows (for example Monday to Tuesday) exactly as written.",
        "- Title should be a concise maintenance title from Subject/Description (strip ticket IDs like [CHG0129464] when possible).",
        "- If you cannot determine both start and end confidently, return null.",
        "When returning null, output exactly: null",
    ].join("\n");

    const aiResult = await env.AI.run(model, {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: emailBody },
        ],
        max_tokens: 300,
    });

    if (typeof aiResult === "string" && aiResult.trim() === "null") return null;
    if (aiResult?.response && String(aiResult.response).trim() === "null") return null;

    return parseAiResult(aiResult);
}

function foldIcsLine(line) {
    const maxLength = 73;
    if (line.length <= maxLength) return line;

    const chunks = [];
    for (let index = 0; index < line.length; index += maxLength) {
        const chunk = line.slice(index, index + maxLength);
        chunks.push(index === 0 ? chunk : ` ${chunk}`);
    }
    return chunks.join("\r\n");
}

function escapeIcsText(value) {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
}

function toIcsDateTime(date) {
    const iso = date.toISOString().replace(/[-:]/g, "");
    return `${iso.slice(0, 15)}Z`;
}

export function createIcs({ summary, description, start, end, uidDomain }) {
    const uid = `${crypto.randomUUID()}@${uidDomain}`;
    const dtStamp = toIcsDateTime(new Date());
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Maintenance Router//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${toIcsDateTime(start)}`,
        `DTEND:${toIcsDateTime(end)}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        `DESCRIPTION:${escapeIcsText(description)}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ];

    return lines.map(foldIcsLine).join("\r\n");
}
