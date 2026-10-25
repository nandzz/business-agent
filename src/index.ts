// Webhook receiver: one URL for every business. Verifies Meta's signature,
// routes each message to its chat's Durable Object and answers 200 at once
// (Meta retries anything slow or non-2xx).
import { isOn, type Env } from "./env";
import { extractEvents, verifySignature, type WebhookPayload } from "./meta";

export { ChatQueue } from "./chat";

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
      const receivedAt = Date.now();
      const raw = await request.arrayBuffer();
      if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.META_APP_SECRET))) {
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

    if (url.pathname === "/debug/chat" && request.method === "GET" && isOn(env.DEBUG_ROUTES)) {
      const phoneNumberId = url.searchParams.get("phone_number_id") ?? "";
      const waId = url.searchParams.get("wa_id") ?? "";
      const state = await env.CHAT.getByName(chatName(phoneNumberId, waId)).inspect();
      return Response.json(state);
    }

    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
