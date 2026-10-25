// One Durable Object per chat (business number × customer). It debounces a
// burst of messages into one agent run and guarantees a chat is never processed
// twice at once (a DO runs one alarm at a time). In the spike it also keeps the
// last turns; later those live in Supabase and this only holds the queue.
import { DurableObject } from "cloudflare:workers";
import { minutesOf, todayInZone, weekdayOf } from "@/features/booking/domain/calendar";
import { runAgent, transcribe, type Turn } from "./agent";
import { intVar, isOn, maskWaId, type Env } from "./env";
import { businessFor, type Business } from "./fixture";
import { downloadMedia, markReadAndTyping, sendText, type InboundEvent, type WaMessage } from "./meta";

type Pending = { message: WaMessage; receivedAt: number };

type ChatState = {
  phoneNumberId: string;
  customerWaId: string;
  customerName?: string;
  pending: Pending[];
  turns: Turn[];
  seenIds: string[];
  pausedUntil: number;
  // Set when the owner typed in the chat; the next run may stay silent.
  ownerTookOver: boolean;
};

const SEEN_KEEP = 100;

export class ChatQueue extends DurableObject<Env> {
  private async load(): Promise<ChatState | undefined> {
    return this.ctx.storage.get<ChatState>("state");
  }

  private save(state: ChatState) {
    return this.ctx.storage.put("state", state);
  }

  async ingest(event: InboundEvent): Promise<void> {
    const state: ChatState = (await this.load()) ?? {
      phoneNumberId: event.phoneNumberId,
      customerWaId: event.customerWaId,
      pending: [],
      turns: [],
      seenIds: [],
      pausedUntil: 0,
      ownerTookOver: false,
    };
    // Meta redelivers webhooks; drop anything already handled.
    if (state.seenIds.includes(event.message.id)) return;
    state.seenIds = [...state.seenIds, event.message.id].slice(-SEEN_KEEP);

    const now = Date.now();
    if (event.kind === "owner_echo") {
      const text = messageText(event.message);
      if (text) state.turns.push({ role: "owner", text, at: now });
      state.pausedUntil = now + intVar(this.env.TAKEOVER_PAUSE_MIN, 5) * 60_000;
      state.ownerTookOver = true;
      await this.save(state);
      if (state.pending.length) await this.ctx.storage.setAlarm(state.pausedUntil);
      return;
    }

    if (event.customerName) state.customerName = event.customerName;
    state.pending.push({ message: event.message, receivedAt: event.receivedAt });
    await this.save(state);

    // Debounce: wait DEBOUNCE_MS after the latest message, but never more than
    // MAX_WAIT_MS after the first one still waiting.
    const debounce = intVar(this.env.DEBOUNCE_MS, 3000);
    const maxWait = intVar(this.env.MAX_WAIT_MS, 8000);
    const firstAt = state.pending[0].receivedAt;
    const fireAt = Math.max(now + 50, Math.min(now + debounce, firstAt + maxWait), state.pausedUntil);
    await this.ctx.storage.setAlarm(fireAt);
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state || state.pending.length === 0) return;
    const now = Date.now();
    if (now < state.pausedUntil) {
      await this.ctx.storage.setAlarm(state.pausedUntil);
      return;
    }

    const business = businessFor(state.phoneNumberId);
    if (!withinAgentHours(business, new Date(now))) {
      // Outside working hours the agent stays silent; the owner answers.
      console.log(JSON.stringify({ evt: "outside_hours", chat: chatKey(state) }));
      state.pending = [];
      await this.save(state);
      return;
    }

    // Take the batch out first: messages arriving mid-run wait for the next alarm.
    const batch = state.pending;
    const firstContact = !state.turns.some((t) => t.role === "agent");
    const resumed = state.ownerTookOver;
    state.pending = [];
    state.ownerTookOver = false;
    await this.save(state);

    const timings: Record<string, number> = {};
    const dryRun = isOn(this.env.DRY_RUN);
    const maxTurns = intVar(this.env.MAX_INPUT_MESSAGES, 20);
    const newTurns: Turn[] = [];
    try {
      const last = batch[batch.length - 1].message;
      if (!dryRun) {
        markReadAndTyping(this.env, state.phoneNumberId, last.id).catch((err) =>
          console.warn(JSON.stringify({ evt: "typing_failed", err: String(err) })),
        );
      }

      const t0 = Date.now();
      for (const { message } of batch) {
        newTurns.push({ role: "customer", text: await this.customerText(message), at: now });
      }
      timings.transcribe_ms = Date.now() - t0;

      const turns = [...state.turns, ...newTurns].slice(-maxTurns);

      const t1 = Date.now();
      const result = await runAgent(
        this.env,
        { business, customerWaId: state.customerWaId, customerName: state.customerName, now: new Date(now) },
        turns,
        { firstContact, resumed },
      );
      timings.llm_ms = Date.now() - t1;

      const t2 = Date.now();
      if (result.text) {
        if (dryRun) console.log(JSON.stringify({ evt: "dry_run_reply", to: maskWaId(state.customerWaId), text: result.text }));
        else await sendText(this.env, state.phoneNumberId, state.customerWaId, result.text);
        turns.push({ role: "agent", text: result.text, at: Date.now() });
      }
      timings.send_ms = Date.now() - t2;

      // Persist the turns, merging with anything that arrived during the run.
      const fresh = (await this.load()) ?? state;
      fresh.turns = turns.slice(-maxTurns);
      await this.save(fresh);

      console.log(
        JSON.stringify({
          evt: "agent_run",
          chat: chatKey(state),
          messages: batch.length,
          replied: Boolean(result.text),
          // From the moment our webhook got the first message to the reply sent:
          // the <10 s target. Includes the debounce wait.
          total_ms: Date.now() - batch[0].receivedAt,
          ...timings,
          tools: result.tools,
          model: this.env.OPENAI_MODEL,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
        }),
      );
    } catch (err) {
      console.error(JSON.stringify({ evt: "agent_run_failed", chat: chatKey(state), err: String(err), ...timings }));
      // Keep what the customer said so the next run still has the context.
      const fresh = (await this.load()) ?? state;
      fresh.turns = [...fresh.turns, ...newTurns].slice(-maxTurns);
      await this.save(fresh);
    }
  }

  private async customerText(message: WaMessage): Promise<string> {
    if (message.type === "audio" && message.audio) {
      try {
        const media = await downloadMedia(this.env, message.audio.id);
        return `[voice note] ${await transcribe(this.env, media.bytes, media.mimeType)}`;
      } catch (err) {
        console.error(JSON.stringify({ evt: "transcribe_failed", err: String(err) }));
        return "[voice note that could not be transcribed]";
      }
    }
    return messageText(message) ?? `[sent a ${message.type} message]`;
  }

  // Local debugging only (DEBUG_ROUTES=1).
  async inspect(): Promise<ChatState | null> {
    return (await this.load()) ?? null;
  }
}

function messageText(m: WaMessage): string | null {
  return (
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    null
  );
}

const chatKey = (s: { phoneNumberId: string; customerWaId: string }) =>
  `${s.phoneNumberId}:${maskWaId(s.customerWaId)}`;

function withinAgentHours(business: Business, now: Date): boolean {
  if (!business.agentHours) return true;
  const tz = business.calendar.timezone;
  const windows = business.agentHours[weekdayOf(todayInZone(tz, now))] ?? [];
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const m = minutesOf(hhmm);
  return windows.some(([start, end]) => m >= minutesOf(start) && m < minutesOf(end));
}
