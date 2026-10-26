// One agent run: instructions + the chat's recent turns → tool loop on the
// OpenAI Responses API → reply text. Stateless: everything it needs is passed in.
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { Env } from "./env";
import { NO_REPLY, buildInstructions } from "./prompt";
import { cleanReply } from "./reply";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools";

const MAX_ROUNDS = 5;

export type Turn = { role: "customer" | "agent" | "owner"; text: string; at: number };

export type AgentResult = {
  text: string | null;
  tools: { name: string; ms: number; error?: boolean }[];
  inputTokens: number;
  outputTokens: number;
};

function toInput(turns: Turn[]): ResponseInputItem[] {
  return turns.map((t) =>
    t.role === "customer"
      ? { role: "user", content: t.text }
      : { role: "assistant", content: t.role === "owner" ? `(owner) ${t.text}` : t.text },
  );
}

export async function runAgent(
  env: Env,
  ctx: ToolContext,
  turns: Turn[],
  opts: { firstContact: boolean; resumed: boolean; update?: string },
): Promise<AgentResult> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const items: ResponseInputItem[] = toInput(turns);
  if (opts.update) items.push({ role: "developer", content: `Business update: ${opts.update}` });
  const result: AgentResult = { text: null, tools: [], inputTokens: 0, outputTokens: 0 };
  const system = buildInstructions({ agent: ctx.agent, customerName: ctx.customerName, now: ctx.now, ...opts });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.responses.create({
      model: env.OPENAI_MODEL,
      instructions: system,
      input: items,
      tools: TOOL_DEFS,
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
      items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
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
