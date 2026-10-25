# business-agent

Nandzz Business Agent runtime: the WhatsApp webhook, a per-chat queue and the
agent worker, on Cloudflare Workers + Durable Objects. See the "Business Agent —
Roadmap" doc for the full design.

**Phase 0 spike.** The business, its knowledge and calendar come from
`src/fixture.ts`; bookings and handoffs are logged, not saved. Slot math is the
portal's own `features/booking/domain/calendar.ts`, imported from the sibling
submodule (`../portal`), so this repo must sit next to it in the harness.

## Layout

- `src/index.ts`: `GET/POST /webhook` (Meta handshake, signature check, routing), `/health`, `/debug/chat` (local only)
- `src/chat.ts`: `ChatQueue` Durable Object, one per chat: dedupe, debounce, owner takeover pause, working hours, one run at a time
- `src/agent.ts`: OpenAI Responses tool loop + voice-note transcription
- `src/tools.ts`: the agent's tools (fixture-backed for now, Agent MCP later)
- `src/meta.ts`: WhatsApp Cloud API payloads and Graph calls

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

With the Meta test number, expose the worker over HTTPS and point the app's
webhook at it (callback `https://<tunnel>/webhook`, verify token = `META_VERIFY_TOKEN`,
fields `messages` + `smb_message_echoes`):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8787
```

Each run logs one `agent_run` line with `total_ms` (first message received →
reply sent, debounce included), `transcribe_ms`, `llm_ms`, `send_ms`, tools and tokens.
