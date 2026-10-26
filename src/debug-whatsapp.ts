// Debug WhatsApp (DEBUG_ROUTES=1, never in prod): a WhatsApp-like page at
// /debug/whatsapp for talking to the agent without Meta. The worker runs
// unchanged: what you type becomes a Meta-shaped webhook, signed with
// META_APP_SECRET and fed to the real /webhook handler, and the replies the
// worker sends for chats started here land in the DebugWhatsApp Durable Object
// instead of graph.facebook.com. Real chats (from Meta) still go to Meta.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { WaMessage, WebhookPayload } from "./meta";
import { DEBUG_PAGE } from "./debug-page";

type Direction = "in" | "out" | "owner";

export type DebugMessage = {
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
export const DEBUG_MEDIA_PREFIX = "debugmedia";

const newWamid = () => `wamid.DEBUG${crypto.randomUUID().replaceAll("-", "")}`;

export class DebugWhatsApp extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chats (pn TEXT NOT NULL, wa TEXT NOT NULL, PRIMARY KEY (pn, wa));
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

  record(pn: string, wa: string, direction: Direction, kind: DebugMessage["kind"], body: string, wamid = newWamid()): string {
    this.sql.exec("INSERT OR IGNORE INTO chats (pn, wa) VALUES (?, ?)", pn, wa);
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

  // A Graph POST from the worker. Answered the way Meta would when it belongs
  // to a chat started here; { handled: false } sends it on to Meta.
  graphPost(path: string, body: Record<string, unknown>): { handled: boolean; result?: unknown } {
    const pn = path.split("/")[0];
    if (body.status === "read" && typeof body.message_id === "string") {
      const row = this.sql.exec<{ wa: string; seq: number }>("SELECT wa, seq FROM messages WHERE wamid = ? AND pn = ?", body.message_id, pn).toArray()[0];
      if (!row) return { handled: false };
      // WhatsApp marks everything up to that message as read.
      this.sql.exec("UPDATE messages SET status = 'read' WHERE pn = ? AND wa = ? AND direction = 'in' AND seq <= ?", pn, row.wa, row.seq);
      if (body.typing_indicator) {
        this.sql.exec("INSERT OR REPLACE INTO typing (pn, wa, until) VALUES (?, ?, ?)", pn, row.wa, Date.now() + TYPING_MS);
      }
      return { handled: true, result: { success: true } };
    }
    const to = typeof body.to === "string" ? body.to : "";
    if (!this.sql.exec("SELECT 1 FROM chats WHERE pn = ? AND wa = ?", pn, to).toArray().length) return { handled: false };
    const text = (body.text as { body?: string } | undefined)?.body;
    if (body.type !== "text" || !text) throw new Error(`debug whatsapp: unsupported POST ${path}`);
    return { handled: true, result: { messaging_product: "whatsapp", messages: [{ id: this.record(pn, to, "out", "text", text) }] } };
  }

  putMedia(bytes: ArrayBuffer, mime: string): string {
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("voice note too large");
    const id = `${DEBUG_MEDIA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
    this.sql.exec("INSERT INTO media (id, mime, bytes) VALUES (?, ?, ?)", id, mime, bytes);
    return id;
  }

  getMedia(id: string): { bytes: ArrayBuffer; mimeType: string } {
    const row = this.sql.exec<{ mime: string; bytes: ArrayBuffer }>("SELECT mime, bytes FROM media WHERE id = ?", id).toArray()[0];
    if (!row) throw new Error(`debug media ${id} not found`);
    return { bytes: row.bytes, mimeType: row.mime };
  }

  chat(pn: string, wa: string): { messages: DebugMessage[]; typing: boolean } {
    const messages = this.sql
      .exec<DebugMessage>("SELECT seq, wamid, direction, kind, body, status, at FROM messages WHERE pn = ? AND wa = ? ORDER BY seq", pn, wa)
      .toArray();
    const typing = this.sql.exec<{ until: number }>("SELECT until FROM typing WHERE pn = ? AND wa = ?", pn, wa).toArray()[0];
    return { messages, typing: Boolean(typing && typing.until > Date.now()) };
  }

  reset(pn: string, wa: string) {
    this.sql.exec("DELETE FROM messages WHERE pn = ? AND wa = ?", pn, wa);
    this.sql.exec("DELETE FROM typing WHERE pn = ? AND wa = ?", pn, wa);
  }
}

export const debugWhatsApp = (env: Env) => env.DEBUG_WHATSAPP.getByName("debug");

type Deliver = (raw: ArrayBuffer, signature: string) => Promise<Response>;

// /debug/whatsapp routes. `deliver` is the real webhook handler.
export async function handleDebugWhatsApp(
  request: Request,
  env: Env,
  url: URL,
  deliver: Deliver,
  chatName: (pn: string, wa: string) => string,
): Promise<Response> {
  if (url.pathname === "/debug/whatsapp" && request.method === "GET") {
    return new Response(DEBUG_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const pn = url.searchParams.get("pn") ?? "";
  const wa = url.searchParams.get("wa") ?? "";
  if (!/^[\w-]{1,64}$/.test(pn) || !/^\d{6,15}$/.test(wa)) return Response.json({ error: "bad pn or wa" }, { status: 400 });
  const phone = debugWhatsApp(env);
  const api = url.pathname.slice("/debug/whatsapp/api/".length);

  if (api === "chat" && request.method === "GET") {
    const [chat, state] = await Promise.all([phone.chat(pn, wa), env.CHAT.getByName(chatName(pn, wa)).inspect()]);
    return Response.json({
      ...chat,
      pausedUntil: state?.pausedUntil ?? 0,
      pending: state?.pending.length ?? 0,
      lastSkip: state?.lastSkip ?? null,
      dryRun: env.DRY_RUN === "1" || env.DRY_RUN === "true",
      now: Date.now(),
    });
  }

  if (api === "send" && request.method === "POST") {
    const { text, as, name } = (await request.json()) as { text?: string; as?: "customer" | "owner"; name?: string };
    const body = text?.trim();
    if (!body) return Response.json({ error: "empty" }, { status: 400 });
    const owner = as === "owner";
    const wamid = await phone.record(pn, wa, owner ? "owner" : "in", "text", body);
    const message: WaMessage = { id: wamid, from: wa, timestamp: unixNow(), type: "text", text: { body } };
    return signAndDeliver(env, deliver, webhookFor(pn, wa, name, message, owner));
  }

  if (api === "voice" && request.method === "POST") {
    const mime = request.headers.get("content-type") || "audio/webm";
    const mediaId = await phone.putMedia(await request.arrayBuffer(), mime);
    const wamid = await phone.record(pn, wa, "in", "voice", mediaId);
    const message: WaMessage = { id: wamid, from: wa, timestamp: unixNow(), type: "audio", audio: { id: mediaId, mime_type: mime, voice: true } };
    return signAndDeliver(env, deliver, webhookFor(pn, wa, url.searchParams.get("name") ?? undefined, message, false));
  }

  if (api === "media" && request.method === "GET") {
    const media = await phone.getMedia(url.searchParams.get("id") ?? "");
    return new Response(media.bytes, { headers: { "content-type": media.mimeType } });
  }

  if (api === "reset" && request.method === "POST") {
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
    entry: [{ id: "DEBUG_WABA_ID", changes: [{ field: owner ? "smb_message_echoes" : "messages", value }] }],
  };
}

// Signed with META_APP_SECRET the way Meta signs, so the real check runs.
async function signAndDeliver(env: Env, deliver: Deliver, payload: WebhookPayload): Promise<Response> {
  if (!env.META_APP_SECRET) return Response.json({ error: "META_APP_SECRET missing in .dev.vars (any value works here)" }, { status: 500 });
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const res = await deliver(raw.buffer as ArrayBuffer, "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join(""));
  return Response.json({ webhook: res.status }, { status: res.ok ? 200 : 502 });
}
