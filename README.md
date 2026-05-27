# Email Maintenance Router

An AI-powered Cloudflare Workers Email Routing handler that extracts maintenance windows from inbound emails and generates `.ics` calendar files for automatic calendar import.

## Setup

1. **Use `wrangler.jsonc`** with AI binding:
    ```jsonc
    {
       "ai": {
          "binding": "AI"
       }
    }
    ```

2. **Deploy** to Cloudflare Workers:
   ```bash
   wrangler deploy
   ```

   For the explicit production environment:
   ```bash
   wrangler deploy --env production
   ```

3. **Configure Email Routing** in Cloudflare dashboard:
   - Add a catch-all rule that routes matching emails to your Worker
   - Or route specific addresses (e.g., `maintenance@example.com`) to this handler

## How It Works

1. **Receive** an inbound email about maintenance
2. **Parse** the email body and extracted plain text
3. **AI Extraction** calls Llama 3.1 8B to find:
   - Maintenance start date/time + timezone
   - Maintenance end date/time + timezone
   - Optional title and rationale notes
4. **Generate** a valid `.ics` (iCalendar) event
5. **Reply** with the `.ics` file as attachment

The recipient can drag-drop the `.ics` file into their calendar app, or open it to auto-import the event.

## Environment Variables

- `AI_MODEL` (optional): Override the AI model. Defaults to `@cf/meta/llama-3.1-8b-instruct`
- `ALLOW_LIST` (optional): Comma-separated sender email addresses allowed to use the router
   - Example: `noc@example.com,noc@example.net`
   - If omitted/empty, all senders are accepted
- `SEND_TO` (optional): Destination mailbox that receives the generated calendar invite
   - Example: `maint@example.org`
   - If omitted, it falls back to the original sender address
- `DEBUG` (optional): Enables structured debug logging in Worker logs
   - Set to `true` to enable, `false` to disable

`wrangler.jsonc` supports separate values per environment:

```jsonc
{
   "vars": {
      "DEBUG": "true"
   },
   "env": {
      "production": {
         "vars": {
            "DEBUG": "false"
         }
      }
   }
}
```

## Example Email

See `sample-email.txt` for a realistic maintenance notification. The AI will extract:
```json
{
  "title": "Database Maintenance",
  "start_iso": "2026-05-28T22:00:00Z",
  "end_iso": "2026-05-29T01:00:00Z",
  "rationale": "Upgrading storage layer and applying security patches"
}
```

## Testing Locally

Run the sample email through your AI binding in a local test:
```bash
wrangler tail --follow
```

Or using the local Wrangler binary:
```bash
node_modules/wrangler/bin/wrangler.js tail --follow
```

Then send a test email matching the format in `sample-email.txt` to your configured email route.

With `DEBUG=true`, tail logs include structured events such as `email.received`, `email.parsed`, `ai.window_extracted`, `email.fallback_reply_sent`, `email.reply_sent`, and `email.error`.

For fast local iteration without deploy, run the local harness:
```bash
npm run test:local-email
```

It reads `sample-email.txt`, runs the same parse + AI-result + ICS generation flow, and writes `maintenance.local.ics`.

Optional arguments:
```bash
npm run test:local-email -- sample-email.txt out.ics
```

Override the mocked AI output to test different extraction results:
```bash
MOCK_AI_RESPONSE='{"title":"Planned Work","start_iso":"2026-06-01T22:00:00Z","end_iso":"2026-06-02T01:00:00Z","rationale":"test"}' npm run test:local-email
```

## Response

- **Success**: A reply email with the `.ics` file attached
- **Failure**: A fallback reply asking for clearer start/end times

---

Built on Cloudflare Workers Email Routing + AI Workers API.
