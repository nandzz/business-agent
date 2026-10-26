// One Durable Object per chat (business number × customer). It debounces a
// burst of messages into one agent run and guarantees a chat is never processed
// twice at once (a DO runs one alarm at a time). It keeps the last turns as the
// model's working context; the conversation of record lives in Supabase
// (agent_messages, written through mcp-agent).
import { DurableObject } from "cloudflare:workers";
import { replyTurn, runAgent, transcribe, trimTurns, type Turn } from "./agent";
import { describeApproval, type ApprovalView } from "./approvals";
import { loadContext, type AgentContext } from "./context";
import { intVar, isOn, maskWaId, type Env } from "./env";
import { callAgentTool, type AgentScope } from "./mcp";
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
  // The business's takeover pause, remembered from the last run's context.
  takeoverPauseMin?: number;
  // Owner decisions waiting for the takeover pause to end before we tell the customer.
  pendingApprovals?: string[];
  // Why the last batch got no reply (shown in /debug/whatsapp); cleared on a run.
  lastSkip?: { reason: string; at: number };
  // The batch of a run that hasn't finished. Kept until the run's turns are
  // saved: if the run dies (deploy, eviction, crash) the watchdog alarm runs
  // it again, so a customer message is never silently dropped.
  inflight?: { batch: Pending[]; attempts: number };
};

type LoggedMessage = { direction: "in" | "out" | "owner"; kind: "text" | "voice" | "other"; body: string; wamid?: string; at: number };

const SEEN_KEEP = 100;
// A run still unfinished after this is presumed dead and the alarm retries it.
const RUN_WATCHDOG_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
// After this many failed runs of the same batch the chat goes to the owner.
const MAX_RUN_ATTEMPTS = 3;

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
      const pauseMin = state.takeoverPauseMin ?? intVar(this.env.TAKEOVER_PAUSE_MIN, 5);
      state.pausedUntil = now + pauseMin * 60_000;
      this.ctx.waitUntil(
        this.logMessages(state, [
          { direction: "owner", kind: text ? "text" : "other", body: text ?? `[${event.message.type}]`, wamid: event.message.id, at: now },
        ]),
      );
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
    if (!state) return;
    const now = Date.now();
    if (now < state.pausedUntil) {
      if (state.pending.length || state.inflight || state.pendingApprovals?.length) await this.ctx.storage.setAlarm(state.pausedUntil);
      return;
    }
    // Owner decisions deferred by a takeover pause.
    const deferred = state.pendingApprovals ?? [];
    if (deferred.length) {
      state.pendingApprovals = [];
      await this.save(state);
      for (const id of deferred) await this.approvalDecided(state.phoneNumberId, state.customerWaId, id);
      // Those runs saved new turns: continue from fresh state.
      return this.alarm();
    }
    if (state.pending.length === 0 && !state.inflight) return;

    let agent: AgentContext | null;
    try {
      agent = await loadContext(this.env, scopeOf(state));
    } catch (err) {
      // Supabase unreachable: keep the messages and retry shortly.
      console.error(JSON.stringify({ evt: "context_failed", chat: chatKey(state), err: String(err) }));
      await this.ctx.storage.setAlarm(now + 30_000);
      return;
    }
    // Not a connected number or agent switched off: stay silent and leave the
    // chat to the owner. Messages are still recorded.
    if (!agent || !agent.enabled) {
      const reason = agent ? "agent_disabled" : "not_connected";
      console.log(JSON.stringify({ evt: reason, chat: chatKey(state) }));
      const skipped = [...(state.inflight?.batch ?? []), ...state.pending];
      state.pending = [];
      state.inflight = undefined;
      state.lastSkip = { reason, at: now };
      await this.save(state);
      if (agent) await this.logMessages(state, skipped.map((p) => inboundLog(p.message, messageText(p.message) ?? `[${p.message.type}]`, p.receivedAt)));
      return;
    }
    state.takeoverPauseMin = agent.takeoverPauseMin;

    const maxTurns = intVar(this.env.MAX_INPUT_MESSAGES, 20);
    // A batch whose run died goes first, together with anything newer.
    const batch = [...(state.inflight?.batch ?? []), ...state.pending];
    const attempt = (state.inflight?.attempts ?? 0) + 1;
    if (attempt > MAX_RUN_ATTEMPTS) {
      // Every run of this batch died before finishing (a crash, not an error we caught).
      state.pending = [];
      state.inflight = undefined;
      await this.save(state);
      const texts = batch.map((p) => messageText(p.message) ?? `[sent a ${p.message.type} message]`);
      await this.giveUp(
        texts.map((text) => ({ role: "customer" as const, text, at: now })),
        batch.map((p, i) => inboundLog(p.message, texts[i], p.receivedAt)),
        maxTurns,
      );
      return;
    }

    // Take the batch out of pending (messages arriving mid-run wait for the
    // next alarm) but keep it as inflight until its turns are saved.
    const firstContact = agent.firstContact && !state.turns.some((t) => t.role === "agent");
    const resumed = state.ownerTookOver;
    state.pending = [];
    state.inflight = { batch, attempts: attempt };
    state.ownerTookOver = false;
    state.lastSkip = undefined;
    await this.save(state);
    // Watchdog: fires only if this run never finishes. A message arriving
    // mid-run replaces it with an earlier alarm, which retries just the same.
    await this.ctx.storage.setAlarm(now + RUN_WATCHDOG_MS);

    const timings: Record<string, number> = {};
    const dryRun = isOn(this.env.DRY_RUN);
    const maxChars = intVar(this.env.MAX_MESSAGE_CHARS, 1024);
    const newTurns: Turn[] = [];
    const logged: LoggedMessage[] = [];
    let replied = false;
    try {
      const last = batch[batch.length - 1].message;
      if (!dryRun) {
        markReadAndTyping(this.env, state.phoneNumberId, last.id).catch((err) =>
          console.warn(JSON.stringify({ evt: "typing_failed", err: String(err) })),
        );
      }

      const t0 = Date.now();
      for (const { message, receivedAt } of batch) {
        const text = await this.customerText(message);
        // Over-long messages never reach the model: it only learns the limit was hit.
        const tooLong = text.length > maxChars;
        newTurns.push({ role: "customer", text: tooLong ? `[message too long: ${text.length} characters, limit ${maxChars}]` : text, at: now });
        logged.push(inboundLog(message, tooLong ? `${text.slice(0, maxChars)}…` : text, receivedAt));
      }
      timings.transcribe_ms = Date.now() - t0;

      const turns = [...state.turns, ...newTurns].slice(-maxTurns);

      const t1 = Date.now();
      const result = await runAgent(
        this.env,
        { env: this.env, scope: scopeOf(state), agent, customerName: state.customerName, now: new Date(now) },
        turns,
        { firstContact, resumed },
      );
      timings.llm_ms = Date.now() - t1;

      const t2 = Date.now();
      if (result.text) {
        const wamid = await this.sendReply(state, result.text);
        replied = true;
        const reply = replyTurn(result);
        turns.push(reply);
        newTurns.push(reply);
        logged.push({ direction: "out", kind: "text", body: result.text, wamid, at: Date.now() });
      }
      timings.send_ms = Date.now() - t2;

      // Persist the turns, merging with anything that arrived during the run.
      const fresh = (await this.load()) ?? state;
      fresh.turns = trimTurns(turns, maxTurns);
      fresh.inflight = undefined;
      await this.save(fresh);
      await this.clearWatchdog(fresh);
      await this.logMessages(state, logged);

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
      console.error(JSON.stringify({ evt: "agent_run_failed", chat: chatKey(state), attempt, err: String(err), ...timings }));
      // Retry the same batch shortly, unless the customer already got a reply
      // (a retry would answer twice) or it keeps failing.
      if (!replied && attempt < MAX_RUN_ATTEMPTS) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        return;
      }
      const fresh = (await this.load()) ?? state;
      fresh.inflight = undefined;
      await this.save(fresh);
      if (!replied) return this.giveUp(newTurns, logged, maxTurns);
      // Answered but failed afterwards: keep the context like a normal run.
      fresh.turns = trimTurns([...fresh.turns, ...newTurns], maxTurns);
      await this.save(fresh);
      await this.clearWatchdog(fresh);
      await this.logMessages(state, logged);
    }
  }

  // The batch could not be answered: keep what the customer said so the next
  // run still has it, and pass the chat to the owner instead of going silent.
  private async giveUp(newTurns: Turn[], logged: LoggedMessage[], maxTurns: number) {
    const state = await this.load();
    if (!state) return;
    state.turns = trimTurns([...state.turns, ...newTurns], maxTurns);
    await this.save(state);
    await this.clearWatchdog(state);
    await this.logMessages(state, logged);
    try {
      await callAgentTool(this.env, scopeOf(state), "hand_off", {
        reason: "The assistant could not answer the customer's last message because of a technical error. Please reply in the chat.",
      });
    } catch (err) {
      console.error(JSON.stringify({ evt: "hand_off_failed", chat: chatKey(state), err: String(err) }));
    }
  }

  // Drop the run's watchdog alarm unless something else is waiting for one.
  private async clearWatchdog(state: ChatState) {
    if (state.pending.length || state.inflight || state.pendingApprovals?.length) return;
    await this.ctx.storage.deleteAlarm();
  }

  // Sends the reply to the customer (or only logs it with DRY_RUN=1); returns its wamid.
  private async sendReply(state: ChatState, text: string): Promise<string | undefined> {
    if (isOn(this.env.DRY_RUN)) {
      console.log(JSON.stringify({ evt: "dry_run_reply", to: maskWaId(state.customerWaId), text }));
      return undefined;
    }
    const res = (await sendText(this.env, state.phoneNumberId, state.customerWaId, text)) as { messages?: { id: string }[] };
    return res.messages?.[0]?.id;
  }

  // Best effort: a failed log never blocks or repeats a reply.
  private async logMessages(state: ChatState, messages: LoggedMessage[]) {
    if (messages.length === 0) return;
    try {
      await callAgentTool(this.env, scopeOf(state), "log_messages", { messages, customer_name: state.customerName ?? null });
    } catch (err) {
      console.error(JSON.stringify({ evt: "log_messages_failed", chat: chatKey(state), err: String(err) }));
    }
  }

  // The owner decided a pending request in Nandzz: read the outcome (scoped to
  // this chat) and tell the customer in the conversation's language.
  async approvalDecided(phoneNumberId: string, customerWaId: string, approvalId: string): Promise<void> {
    const state: ChatState = (await this.load()) ?? {
      phoneNumberId,
      customerWaId,
      pending: [],
      turns: [],
      seenIds: [],
      pausedUntil: 0,
      ownerTookOver: false,
    };
    const scope = scopeOf(state);
    const approval = (await callAgentTool(this.env, scope, "get_approval", { approval_id: approvalId })) as ApprovalView;
    const update = approval && !approval.error ? describeApproval(approval) : null;
    if (!update) return;
    const agent = await loadContext(this.env, scope);
    // Same gates as a normal run.
    if (!agent || !agent.enabled) {
      console.log(JSON.stringify({ evt: "approval_not_sent", chat: chatKey(state), reason: agent ? "agent_disabled" : "not_connected" }));
      return;
    }
    if (Date.now() < state.pausedUntil) {
      // The owner is talking in this chat: tell the customer once the pause ends.
      state.pendingApprovals = [...new Set([...(state.pendingApprovals ?? []), approvalId])].slice(-20);
      await this.save(state);
      await this.ctx.storage.setAlarm(state.pausedUntil);
      return;
    }

    const t0 = Date.now();
    const result = await runAgent(
      this.env,
      { env: this.env, scope, agent, customerName: state.customerName, now: new Date() },
      state.turns,
      { firstContact: false, resumed: false, update },
    );
    if (!result.text) return;
    const wamid = await this.sendReply(state, result.text);

    const fresh = (await this.load()) ?? state;
    fresh.turns = trimTurns([...fresh.turns, replyTurn(result)], intVar(this.env.MAX_INPUT_MESSAGES, 20));
    await this.save(fresh);
    await this.logMessages(fresh, [{ direction: "out", kind: "text", body: result.text, wamid, at: Date.now() }]);
    console.log(
      JSON.stringify({
        evt: "approval_notified",
        chat: chatKey(state),
        status: approval.status,
        total_ms: Date.now() - t0,
        tools: result.tools,
      }),
    );
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

  // Forget this chat's working context (owner deleted the conversation or
  // disconnected the number; also the Debug WhatsApp reset).
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
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

const scopeOf = (s: ChatState): AgentScope => ({ phoneNumberId: s.phoneNumberId, customerWaId: s.customerWaId });

const inboundLog = (m: WaMessage, text: string, at: number): LoggedMessage => ({
  direction: "in",
  kind: m.type === "audio" ? "voice" : m.type === "text" ? "text" : "other",
  body: text,
  wamid: m.id,
  at,
});
