// WhatsApp Cloud API: webhook payload shapes, signature check, and the few
// Graph calls the worker makes (send text, mark read + typing, fetch media).
import { isOn, type Env } from "./env";
import { DEBUG_MEDIA_PREFIX, debugWhatsApp } from "./debug-whatsapp";

export type WebhookPayload = {
  object: string;
  entry?: {
    id: string; // WABA id
    changes?: { field: string; value: ChangeValue }[];
  }[];
};

type ChangeValue = {
  messaging_product?: "whatsapp";
  metadata?: { display_phone_number: string; phone_number_id: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  // smb_message_echoes: what the owner typed in the WhatsApp Business app.
  message_echoes?: (WaMessage & { to: string })[];
  statuses?: unknown[];
};

export type WaMessage = {
  id: string;
  from: string;
  timestamp: string; // unix seconds
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  button?: { text: string };
  interactive?: {
    button_reply?: { title: string };
    list_reply?: { title: string };
  };
};

// Normalized events the router hands to the per-chat queue.
export type InboundEvent =
  | {
      kind: "message";
      wabaId: string;
      phoneNumberId: string;
      customerWaId: string;
      customerName?: string;
      message: WaMessage;
      receivedAt: number;
    }
  | {
      kind: "owner_echo";
      wabaId: string;
      phoneNumberId: string;
      customerWaId: string;
      message: WaMessage;
      receivedAt: number;
    };

export function extractEvents(payload: WebhookPayload, receivedAt: number): InboundEvent[] {
  const events: InboundEvent[] = [];
  if (payload.object !== "whatsapp_business_account") return events;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      if (change.field === "messages") {
        const names = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name] as const),
        );
        for (const message of value.messages ?? []) {
          events.push({
            kind: "message",
            wabaId: entry.id,
            phoneNumberId,
            customerWaId: message.from,
            customerName: names.get(message.from),
            message,
            receivedAt,
          });
        }
      } else if (change.field === "smb_message_echoes") {
        for (const message of value.message_echoes ?? []) {
          events.push({
            kind: "owner_echo",
            wabaId: entry.id,
            phoneNumberId,
            customerWaId: message.to,
            message,
            receivedAt,
          });
        }
      }
    }
  }
  return events;
}

// X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(app secret, raw body)).
export async function verifySignature(
  rawBody: ArrayBuffer,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = new TextEncoder().encode(
    Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
  const given = new TextEncoder().encode(header.slice("sha256=".length).toLowerCase());
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

const graph = (env: Env, path: string) =>
  `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${path}`;

async function graphPost(env: Env, path: string, body: Record<string, unknown>) {
  if (isOn(env.DEBUG_ROUTES)) {
    // Chats started in /debug/whatsapp are answered there; the rest go to Meta.
    const debug = (await debugWhatsApp(env).graphPost(path, body)) as { handled: boolean; result?: unknown };
    if (debug.handled) return debug.result;
  }
  const res = await fetch(graph(env, path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph POST ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

export function sendText(env: Env, phoneNumberId: string, to: string, body: string) {
  return graphPost(env, `${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body, preview_url: false },
  });
}

// Blue ticks + "typing…" for up to 25 s or until we reply.
export function markReadAndTyping(env: Env, phoneNumberId: string, messageId: string) {
  return graphPost(env, `${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
}

// Media URLs expire after ~5 minutes, so callers download right away.
export async function downloadMedia(
  env: Env,
  mediaId: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (isOn(env.DEBUG_ROUTES) && mediaId.startsWith(DEBUG_MEDIA_PREFIX)) return debugWhatsApp(env).getMedia(mediaId);
  const auth = { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` };
  const metaRes = await fetch(graph(env, mediaId), { headers: auth });
  if (!metaRes.ok) throw new Error(`Graph media ${mediaId} ${metaRes.status}: ${await metaRes.text()}`);
  const { url, mime_type } = (await metaRes.json()) as { url: string; mime_type: string };
  const fileRes = await fetch(url, { headers: auth });
  if (!fileRes.ok) throw new Error(`Media download ${fileRes.status}`);
  return { bytes: await fileRes.arrayBuffer(), mimeType: mime_type };
}
