// Mock WhatsApp for local testing (MOCK_WHATSAPP=1, never in prod). The worker
// runs unchanged: /mock/api/* turns what you type in the /mock page into signed,
// Meta-shaped webhooks, and the Graph calls the worker makes (send text, read +
// typing, media download) land in the MockWhatsApp Durable Object instead of
// graph.facebook.com. Everything else (OpenAI, mcp-agent, Supabase) is real.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { WaMessage, WebhookPayload } from "./meta";
import { MOCK_PAGE } from "./mock-page";

type Direction = "in" | "out" | "owner";

export type MockMessage = {
  seq: number;
  wamid: string;
  direction: Direction;
  kind: "text" | "voice";
  body: string;
  // Inbound only: sent → read (blue ticks) once the worker marks it read.
  status: "sent" | "read";
  at: number;
};

const TYPING_MS = 25_000;
const KEEP_PER_CHAT = 300;
// SQLite-backed DO values are capped at 2 MB; a minute of opus is ~100 KB.
const MAX_MEDIA_BYTES = 1_900_000;

const newWamid = () => `wamid.MOCK${crypto.randomUUID().replaceAll("-", "")}`;

export class MockWhatsApp extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        wamid TEXT NOT NULL, pn TEXT NOT NULL, wa TEXT NOT NULL,
        direction TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat ON messages (pn, wa, seq);
      CREATE TABLE IF NOT EXISTS typing (pn TEXT NOT NULL, wa TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (pn, wa));
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
    `);
  }

  record(pn: string, wa: string, direction: Direction, kind: MockMessage["kind"], body: string, wamid = newWamid()): string {
    this.sql.exec(
      "INSERT INTO messages (wamid, pn, wa, direction, kind, body, status, at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
      wamid, pn, wa, direction, kind, body, Date.now(),
    );
    if (direction !== "in") this.sql.exec("DELETE FROM typing WHERE pn = ? AND wa = ?", pn, wa);
    this.sql.exec(
      "DELETE FROM messages WHERE pn = ? AND wa = ? AND seq <= (SELECT seq FROM messages WHERE pn = ? AND wa = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      pn, wa, pn, wa, KEEP_PER_CHAT,
    );
    return wamid;
  }

  // The worker's Graph POSTs, answered the way Meta would.
  graphPost(path: string, body: Record<string, unknown>): unknown {
    const pn = path.split("/")[0];
    if (body.status === "read" && typeof body.message_id === "string") {
      const row = this.sql.exec<{ wa: string }>("SELECT wa FROM messages WHERE wamid = ? AND pn = ?", body.message_id, pn).toArray()[0];
      if (row) {
        // WhatsApp marks everything up to that message as read.
        this.sql.exec(
          "UPDATE messages SET status = 'read' WHERE pn = ? AND wa = ? AND direction = 'in' AND seq <= (SELECT seq FROM messages WHERE wamid = ?)",
          pn, row.wa, body.message_id,
        );
        if (body.typing_indicator) {
          this.sql.exec("INSERT OR REPLACE INTO typing (pn, wa, until) VALUES (?, ?, ?)", pn, row.wa, Date.now() + TYPING_MS);
        }
      }
      return { success: true };
    }
    const text = (body.text as { body?: string } | undefined)?.body;
    if (body.type === "text" && typeof body.to === "string" && text) {
      return { messaging_product: "whatsapp", messages: [{ id: this.record(pn, body.to, "out", "text", text) }] };
    }
    throw new Error(`mock graph: unsupported POST ${path}`);
  }

  putMedia(bytes: ArrayBuffer, mime: string): string {
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("voice note too large");
    const id = `mockmedia${crypto.randomUUID().replaceAll("-", "")}`;
    this.sql.exec("INSERT INTO media (id, mime, bytes) VALUES (?, ?, ?)", id, mime, bytes);
    return id;
  }

  getMedia(id: string): { bytes: ArrayBuffer; mimeType: string } {
    const row = this.sql.exec<{ mime: string; bytes: ArrayBuffer }>("SELECT mime, bytes FROM media WHERE id = ?", id).toArray()[0];
    if (!row) throw new Error(`mock media ${id} not found`);
    return { bytes: row.bytes, mimeType: row.mime };
  }

  chat(pn: string, wa: string): { messages: MockMessage[]; typing: boolean } {
    const messages = this.sql
      .exec<MockMessage>("SELECT seq, wamid, direction, kind, body, status, at FROM messages WHERE pn = ? AND wa = ? ORDER BY seq", pn, wa)
      .toArray();
    const typing = this.sql.exec<{ until: number }>("SELECT until FROM typing WHERE pn = ? AND wa = ?", pn, wa).toArray()[0];
    return { messages, typing: Boolean(typing && typing.until > Date.now()) };
  }

  reset(pn: string, wa: string) {
    this.sql.exec("DELETE FROM messages WHERE pn = ? AND wa = ?", pn, wa);
    this.sql.exec("DELETE FROM typing WHERE pn = ? AND wa = ?", pn, wa);
  }
}

export const mockPhone = (env: Env) => env.MOCK.getByName("mock");

type Deliver = (raw: ArrayBuffer, signature: string) => Promise<Response>;

// /mock routes. `deliver` is the real webhook handler.
export async function handleMock(request: Request, env: Env, url: URL, deliver: Deliver, chatName: (pn: string, wa: string) => string): Promise<Response> {
  if (url.pathname === "/mock" && request.method === "GET") {
    return new Response(MOCK_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const pn = url.searchParams.get("pn") ?? "";
  const wa = url.searchParams.get("wa") ?? "";
  if (!/^[\w-]{1,64}$/.test(pn) || !/^\d{6,15}$/.test(wa)) return Response.json({ error: "bad pn or wa" }, { status: 400 });
  const phone = mockPhone(env);

  if (url.pathname === "/mock/api/chat" && request.method === "GET") {
    const [chat, state] = await Promise.all([phone.chat(pn, wa), env.CHAT.getByName(chatName(pn, wa)).inspect()]);
    return Response.json({
      ...chat,
      pausedUntil: state?.pausedUntil ?? 0,
      pending: state?.pending.length ?? 0,
      now: Date.now(),
    });
  }

  if (url.pathname === "/mock/api/send" && request.method === "POST") {
    const { text, as, name } = (await request.json()) as { text?: string; as?: "customer" | "owner"; name?: string };
    const body = text?.trim();
    if (!body) return Response.json({ error: "empty" }, { status: 400 });
    const owner = as === "owner";
    const wamid = await phone.record(pn, wa, owner ? "owner" : "in", "text", body);
    const message: WaMessage = { id: wamid, from: owner ? "" : wa, timestamp: unixNow(), type: "text", text: { body } };
    return sign(env, deliver, webhookFor(pn, wa, name, message, owner));
  }

  if (url.pathname === "/mock/api/voice" && request.method === "POST") {
    const mime = request.headers.get("content-type") || "audio/webm";
    const mediaId = await phone.putMedia(await request.arrayBuffer(), mime);
    const wamid = await phone.record(pn, wa, "in", "voice", mediaId);
    const message: WaMessage = { id: wamid, from: wa, timestamp: unixNow(), type: "audio", audio: { id: mediaId, mime_type: mime, voice: true } };
    return sign(env, deliver, webhookFor(pn, wa, url.searchParams.get("name") ?? undefined, message, false));
  }

  if (url.pathname === "/mock/api/media" && request.method === "GET") {
    const media = await phone.getMedia(url.searchParams.get("id") ?? "");
    return new Response(media.bytes, { headers: { "content-type": media.mimeType } });
  }

  if (url.pathname === "/mock/api/reset" && request.method === "POST") {
    await Promise.all([phone.reset(pn, wa), env.CHAT.getByName(chatName(pn, wa)).reset()]);
    return Response.json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

const unixNow = () => String(Math.floor(Date.now() / 1000));

function webhookFor(pn: string, wa: string, name: string | undefined, message: WaMessage, owner: boolean): WebhookPayload {
  const metadata = { display_phone_number: "15550000000", phone_number_id: pn };
  const value = owner
    ? { messaging_product: "whatsapp" as const, metadata, message_echoes: [{ ...message, from: metadata.display_phone_number, to: wa }] }
    : { messaging_product: "whatsapp" as const, metadata, contacts: [{ wa_id: wa, profile: { name: name || "Test Customer" } }], messages: [message] };
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "MOCK_WABA_ID", changes: [{ field: owner ? "smb_message_echoes" : "messages", value }] }],
  };
}

// Signed with META_APP_SECRET like Meta does, so the real signature check runs.
async function sign(env: Env, deliver: Deliver, payload: WebhookPayload): Promise<Response> {
  if (!env.META_APP_SECRET) return Response.json({ error: "META_APP_SECRET missing in .dev.vars (any value works with the mock)" }, { status: 500 });
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const res = await deliver(raw.buffer as ArrayBuffer, "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join(""));
  return Response.json({ webhook: res.status }, { status: res.ok ? 200 : 502 });
}
