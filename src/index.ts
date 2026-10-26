// Webhook receiver: one URL for every business. Verifies Meta's signature,
// routes each message to its chat's Durable Object and answers 200 at once
// (Meta retries anything slow or non-2xx).
import { isOn, type Env } from "./env";
import { callAgentTool } from "./mcp";
import { extractEvents, verifySignature, type WebhookPayload } from "./meta";
import { handleDebugWhatsApp } from "./debug-whatsapp";

export { ChatQueue } from "./chat";
export { DebugWhatsApp } from "./debug-whatsapp";

const chatName = (phoneNumberId: string, customerWaId: string) => `${phoneNumberId}:${customerWaId}`;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 100;

// A disconnect forgets every chat of the number at once.
const MAX_FORGET = 5000;

// Pings from the portal are signed like Meta's webhooks (HMAC-SHA256 hex of
// the raw body), carry ids only and are at most 5 min old. Returns the parsed
// body, or the error response to send.
async function readPortalPing<T>(request: Request, env: Env): Promise<(T & { ts?: unknown }) | Response> {
  const raw = await request.arrayBuffer();
  if (!(await verifySignature(raw, request.headers.get("x-nandzz-signature"), env.AGENT_NOTIFY_SECRET))) {
    return new Response("bad signature", { status: 401 });
  }
  let body: T & { ts?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const fresh = typeof body.ts === "number" && Math.abs(Date.now() / 1000 - body.ts) < 300;
  return fresh ? body : new Response("bad request", { status: 400 });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "GET") {
      // Meta's one-time subscription handshake.
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        env.META_VERIFY_TOKEN &&
        url.searchParams.get("hub.verify_token") === env.META_VERIFY_TOKEN;
      return ok
        ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
        : new Response("forbidden", { status: 403 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(await request.arrayBuffer(), request.headers.get("x-hub-signature-256"), env, ctx);
    }

    if ((url.pathname === "/debug/whatsapp" || url.pathname.startsWith("/debug/whatsapp/")) && isOn(env.DEBUG_ROUTES)) {
      return handleDebugWhatsApp(request, env, url, (raw, signature) => handleWebhook(raw, signature, env, ctx), chatName);
    }

    if (url.pathname === "/internal/approval-decided" && request.method === "POST") {
      // The portal decided an approval: tell the customer.
      const body = await readPortalPing<{ approval_id?: unknown; phone_number_id?: unknown; customer_wa_id?: unknown }>(request, env);
      if (body instanceof Response) return body;
      if (![body.approval_id, body.phone_number_id, body.customer_wa_id].every(isId)) {
        return new Response("bad request", { status: 400 });
      }
      ctx.waitUntil(
        env.CHAT.getByName(chatName(body.phone_number_id as string, body.customer_wa_id as string))
          .approvalDecided(body.phone_number_id as string, body.customer_wa_id as string, body.approval_id as string)
          .catch((err) => console.error(JSON.stringify({ evt: "approval_notify_failed", err: String(err) }))),
      );
      return new Response("accepted", { status: 202 });
    }

    if (url.pathname === "/internal/forget-chats" && request.method === "POST") {
      // The owner deleted conversations or disconnected the number: drop the
      // working memory (recent turns, queued messages) of those chats too.
      const body = await readPortalPing<{ chats?: unknown }>(request, env);
      if (body instanceof Response) return body;
      const chats = Array.isArray(body.chats) ? (body.chats as { phone_number_id?: unknown; customer_wa_id?: unknown }[]) : null;
      if (!chats || chats.length > MAX_FORGET || !chats.every((c) => isId(c?.phone_number_id) && isId(c?.customer_wa_id))) {
        return new Response("bad request", { status: 400 });
      }
      ctx.waitUntil(
        Promise.all(
          chats.map((c) =>
            env.CHAT.getByName(chatName(c.phone_number_id as string, c.customer_wa_id as string))
              .reset()
              .catch((err) => console.error(JSON.stringify({ evt: "forget_chat_failed", err: String(err) }))),
          ),
        ),
      );
      return new Response("accepted", { status: 202 });
    }

    if (url.pathname === "/debug/chat" && request.method === "GET" && isOn(env.DEBUG_ROUTES)) {
      const phoneNumberId = url.searchParams.get("phone_number_id") ?? "";
      const waId = url.searchParams.get("wa_id") ?? "";
      const state = await env.CHAT.getByName(chatName(phoneNumberId, waId)).inspect();
      return Response.json(state);
    }

    if (url.pathname === "/debug/mcp-ping" && request.method === "GET" && isOn(env.DEBUG_ROUTES)) {
      // Phase 0 probe: worker → mcp-agent → Postgres token check, timed.
      const t0 = Date.now();
      try {
        const result = await callAgentTool(
          env,
          {
            phoneNumberId: url.searchParams.get("phone_number_id") ?? "debug",
            customerWaId: url.searchParams.get("wa_id") ?? "390000000000",
          },
          "ping",
        );
        return Response.json({ ms: Date.now() - t0, result });
      } catch (err) {
        return Response.json({ ms: Date.now() - t0, error: String(err) }, { status: 502 });
      }
    }

    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(raw: ArrayBuffer, signature: string | null, env: Env, ctx: ExecutionContext): Promise<Response> {
  const receivedAt = Date.now();
  if (!(await verifySignature(raw, signature, env.META_APP_SECRET))) {
    console.warn(JSON.stringify({ evt: "bad_signature" }));
    return new Response("bad signature", { status: 401 });
  }
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const events = extractEvents(payload, receivedAt);
  ctx.waitUntil(
    Promise.all(
      events.map((event) =>
        env.CHAT.getByName(chatName(event.phoneNumberId, event.customerWaId))
          .ingest(event)
          .catch((err) => console.error(JSON.stringify({ evt: "ingest_failed", err: String(err) }))),
      ),
    ),
  );
  return new Response("ok", { status: 200 });
}
