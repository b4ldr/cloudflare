import fs from "node:fs/promises";
import path from "node:path";
import { createIcs, extractMaintenanceWindowWithAi, extractTextBody } from "../email_processing.mjs";

function defaultMockAiResponse() {
    return JSON.stringify({
        title: "Maintenance Window",
        start_iso: "2026-05-28T22:00:00Z",
        end_iso: "2026-05-29T01:00:00Z",
        rationale: "Mocked AI response for local iteration",
    });
}

async function main() {
    const emailPath = process.argv[2] || "sample-email.txt";
    const outputPath = process.argv[3] || "maintenance.local.ics";

    const absolutePath = path.resolve(process.cwd(), emailPath);
    const rawEmail = await fs.readFile(absolutePath, "utf8");
    const emailBody = extractTextBody(rawEmail);

    const mockResponse = process.env.MOCK_AI_RESPONSE || defaultMockAiResponse();
    const env = {
        AI_MODEL: process.env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct",
        AI: {
            run: async () => ({ response: mockResponse }),
        },
    };

    const window = await extractMaintenanceWindowWithAi(emailBody, env);
    if (!window) {
        console.error("Could not extract maintenance window from mocked AI response.");
        process.exit(1);
    }

    const icsContent = createIcs({
        summary: window.title || "Maintenance Window",
        description: emailBody.slice(0, 2000),
        start: window.start,
        end: window.end,
        uidDomain: "local",
    });

    await fs.writeFile(path.resolve(process.cwd(), outputPath), icsContent, "utf8");

    console.log("Local maintenance test complete");
    console.log(`Email file: ${emailPath}`);
    console.log(`ICS output: ${outputPath}`);
    console.log(`Start: ${window.start.toISOString()}`);
    console.log(`End: ${window.end.toISOString()}`);
    console.log("Tip: set MOCK_AI_RESPONSE to test alternate AI extraction outputs.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
