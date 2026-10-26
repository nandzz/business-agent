# business-agent

Nandzz Business Agent runtime: the WhatsApp webhook, a per-chat queue and the
agent worker, on Cloudflare Workers + Durable Objects. See the "Business Agent —
Roadmap" doc for the full design.

**Phase 1.** The business (booking config, agent settings, knowledge) is loaded
per message from Supabase through the private `mcp-agent` edge function, which
scopes every call to the business number and the customer of the chat (signed
per-call run tokens, checked in Postgres). Bookings, reschedules and cancels are
real and follow the owner's autonomy setting (off / pending approval / confirm).
Slot math is the portal's own `features/booking/domain/calendar.ts`, imported
from the sibling submodule (`../portal`), so this repo must sit next to it in the
harness.

## Layout

- `src/index.ts`: `GET/POST /webhook` (Meta handshake, signature check, routing), `/health`, `/debug/chat` (local only)
- `src/chat.ts`: `ChatQueue` Durable Object, one per chat: dedupe, debounce, owner takeover pause, working hours, one run at a time
- `src/agent.ts`: OpenAI Responses tool loop + voice-note transcription
- `src/context.ts`: loads the business for one run (`agent_api.get_context`)
- `src/tools.ts`: the agent's tools; reads and writes go through mcp-agent, slot math runs here
- `src/mcp.ts`: mcp-agent client, mints one signed run token per tool call
- `src/meta.ts`: WhatsApp Cloud API payloads and Graph calls
- `src/mock.ts`, `src/mock-page.ts`: local mock WhatsApp (`MOCK_WHATSAPP=1`): fake Graph DO + `/mock` page

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in Meta + OpenAI values
npm run dev                      # http://localhost:8787
```

Without Meta, with `DRY_RUN=1` (replies are logged, not sent):

```bash
npm run simulate -- "Ciao, avete posto sabato mattina?"
npm run simulate -- --echo "Ti scrivo io"   # owner typed on the phone → agent pauses
```

### Mock WhatsApp (no Meta needed)

```bash
npm run mock                     # then open http://localhost:8787/mock
```

A customer phone and the business's WhatsApp Business app side by side. What
you type goes through the real webhook path (signed with `META_APP_SECRET`, any
value works), the real agent, OpenAI, mcp-agent and Supabase dev: bookings are
real in dev. Only the transport is faked: the worker's Graph calls (send, read +
typing, voice-note download) land in the `MockWhatsApp` Durable Object instead of
`graph.facebook.com`. Supports voice notes (mic button), owner takeover (type in
the business pane) and approvals (decide in the local portal, which pings
`AGENT_WORKER_URL=http://localhost:8787`). The business number defaults to
`TEST_PHONE_NUMBER_ID`, the dev test connection. `MOCK_WHATSAPP` is `0` in
`wrangler.jsonc`, so a deployed worker never serves `/mock`.

With the Meta test number, expose the worker over HTTPS and point the app's
webhook at it (callback `https://<tunnel>/webhook`, verify token = `META_VERIFY_TOKEN`,
fields `messages` + `smb_message_echoes`):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8787
```

Each run logs one `agent_run` line with `total_ms` (first message received →
reply sent, debounce included), `transcribe_ms`, `llm_ms`, `send_ms`, tools and tokens.
