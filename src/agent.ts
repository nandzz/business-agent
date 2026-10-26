// One agent run: instructions + the chat's recent turns → tool loop on the
// OpenAI Responses API → reply text. Stateless: everything it needs is passed in.
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { Env } from "./env";
import { NO_REPLY, buildInstructions } from "./prompt";
import { cleanReply } from "./reply";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools";

// Group bookings take a check plus one create_booking per person. The last
// round allows no tools, so a run always ends with a reply.
const MAX_ROUNDS = 8;

// The tool calls a reply was built on, kept with that reply so the next run
// still has the ids, exact start values and availability it showed the customer.
export type ToolTrace = { name: string; args: string; output: string };

export type Turn = { role: "customer" | "agent" | "owner"; text: string; at: number; tools?: ToolTrace[] };

// Tool memory stays on the last few replies only, capped, so the chat state
// stays well under the Durable Object value limit.
const TOOL_MEMORY_REPLIES = 2;
const TOOL_OUTPUT_CHARS = 6000;
const TOOL_MEMORY_CHARS = 16000;

export type AgentResult = {
  text: string | null;
  tools: { name: string; ms: number; error?: boolean }[];
  // What the reply was built on, to store with it (see ToolTrace).
  memory: ToolTrace[];
  inputTokens: number;
  outputTokens: number;
};

function toInput(turns: Turn[]): ResponseInputItem[] {
  return turns.flatMap((t, i): ResponseInputItem[] => {
    if (t.role === "customer") return [{ role: "user", content: t.text }];
    // Replayed as the calls that came before this reply (no item ids: they are
    // new items to the API, so no reasoning item is required with them).
    const calls = (t.tools ?? []).flatMap((c, j): ResponseInputItem[] => [
      { type: "function_call", call_id: `mem_${i}_${j}`, name: c.name, arguments: c.args },
      { type: "function_call_output", call_id: `mem_${i}_${j}`, output: c.output },
    ]);
    return [...calls, { role: "assistant", content: t.role === "owner" ? `(owner) ${t.text}` : t.text }];
  });
}

/** The last `max` turns, with tool memory only on the most recent replies. */
export function trimTurns(turns: Turn[], max: number): Turn[] {
  let replies = 0;
  return turns
    .slice(-max)
    .reverse()
    .map((t) => (t.tools && (t.role !== "agent" || ++replies > TOOL_MEMORY_REPLIES) ? { ...t, tools: undefined } : t))
    .reverse();
}

// The newest calls win when a run's tool output is too big to keep whole.
function toMemory(traces: ToolTrace[]): ToolTrace[] | undefined {
  const kept: ToolTrace[] = [];
  let size = 0;
  for (const t of [...traces].reverse()) {
    const output = t.output.length > TOOL_OUTPUT_CHARS ? `${t.output.slice(0, TOOL_OUTPUT_CHARS)}…[cut]` : t.output;
    size += output.length + t.args.length;
    if (size > TOOL_MEMORY_CHARS) break;
    kept.unshift({ ...t, output });
  }
  return kept.length ? kept : undefined;
}

/** The reply turn to store for a finished run. */
export const replyTurn = (result: AgentResult): Turn => ({
  role: "agent",
  text: result.text ?? "",
  at: Date.now(),
  tools: toMemory(result.memory),
});

export async function runAgent(
  env: Env,
  ctx: ToolContext,
  turns: Turn[],
  opts: { firstContact: boolean; resumed: boolean; update?: string },
): Promise<AgentResult> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const items: ResponseInputItem[] = toInput(turns);
  if (opts.update) items.push({ role: "developer", content: `Business update: ${opts.update}` });
  const result: AgentResult = { text: null, tools: [], memory: [], inputTokens: 0, outputTokens: 0 };
  const system = buildInstructions({ agent: ctx.agent, customerName: ctx.customerName, now: ctx.now, ...opts });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.responses.create({
      model: env.OPENAI_MODEL,
      instructions: system,
      input: items,
      tools: TOOL_DEFS,
      ...(round === MAX_ROUNDS - 1 && { tool_choice: "none" as const }),
      // Nothing kept on OpenAI's side; reasoning state travels encrypted in the
      // items we send back.
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(env.OPENAI_REASONING_EFFORT && {
        reasoning: { effort: env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high" },
      }),
    });
    result.inputTokens += res.usage?.input_tokens ?? 0;
    result.outputTokens += res.usage?.output_tokens ?? 0;

    const calls = res.output.filter((o) => o.type === "function_call");
    if (calls.length === 0) {
      const text = res.output_text.trim();
      result.text = text && text !== NO_REPLY ? cleanReply(text) : null;
      return result;
    }
    items.push(...(res.output as ResponseInputItem[]));
    for (const call of calls) {
      const t0 = Date.now();
      let output: unknown;
      try {
        output = await executeTool(call.name, JSON.parse(call.arguments || "{}"), ctx);
      } catch (err) {
        output = { error: String(err) };
      }
      // Failed tool calls are logged with the error only (no arguments: they can carry customer data).
      const error = (output as { error?: unknown } | null)?.error;
      if (error) console.warn(JSON.stringify({ evt: "tool_error", tool: call.name, error: String(error).slice(0, 300) }));
      result.tools.push({ name: call.name, ms: Date.now() - t0, ...(error ? { error: true } : {}) });
      const serialized = JSON.stringify(output) ?? "null";
      result.memory.push({ name: call.name, args: call.arguments || "{}", output: serialized });
      items.push({ type: "function_call_output", call_id: call.call_id, output: serialized });
    }
  }
  throw new Error(`agent did not finish in ${MAX_ROUNDS} rounds`);
}

export async function transcribe(env: Env, bytes: ArrayBuffer, mimeType: string): Promise<string> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  // WhatsApp voice notes are audio/ogg (opus). The spike sends them as-is to
  // measure whether repackaging is really needed.
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.split("/")[1]?.split(";")[0] || "bin";
  const file = new File([bytes], `voice.${ext}`, { type: mimeType.split(";")[0] });
  const res = await client.audio.transcriptions.create({ file, model: env.OPENAI_TRANSCRIBE_MODEL });
  return res.text.trim();
}
