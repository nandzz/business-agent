// Webhook receiver: one URL for every business. Verifies Meta's signature,
// routes each message to its chat's Durable Object and answers 200 at once
// (Meta retries anything slow or non-2xx).
import { isOn, type Env } from "./env";
import { callAgentTool } from "./mcp";
import { extractEvents, verifySignature, type WebhookPayload } from "./meta";
import { handleMock } from "./mock";

export { ChatQueue } from "./chat";
export { MockWhatsApp } from "./mock";

const chatName = (phoneNumberId: string, customerWaId: string) => `${phoneNumberId}:${customerWaId}`;

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

    if ((url.pathname === "/mock" || url.pathname.startsWith("/mock/")) && isOn(env.MOCK_WHATSAPP)) {
      return handleMock(request, env, url, (raw, signature) => handleWebhook(raw, signature, env, ctx), chatName);
    }

    if (url.pathname === "/internal/approval-decided" && request.method === "POST") {
      // The portal decided an approval: tell the customer. Signed like Meta's
      // webhooks (HMAC-SHA256 hex of the raw body), ids only, ≤5 min old.
      const raw = await request.arrayBuffer();
      if (!(await verifySignature(raw, request.headers.get("x-nandzz-signature"), env.AGENT_NOTIFY_SECRET))) {
        return new Response("bad signature", { status: 401 });
      }
      let body: { approval_id?: unknown; phone_number_id?: unknown; customer_wa_id?: unknown; ts?: unknown };
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const fresh = typeof body.ts === "number" && Math.abs(Date.now() / 1000 - body.ts) < 300;
      const ids = [body.approval_id, body.phone_number_id, body.customer_wa_id];
      if (!fresh || !ids.every((v) => typeof v === "string" && v.length > 0 && v.length < 100)) {
        return new Response("bad request", { status: 400 });
      }
      ctx.waitUntil(
        env.CHAT.getByName(chatName(body.phone_number_id as string, body.customer_wa_id as string))
          .approvalDecided(body.phone_number_id as string, body.customer_wa_id as string, body.approval_id as string)
          .catch((err) => console.error(JSON.stringify({ evt: "approval_notify_failed", err: String(err) }))),
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
