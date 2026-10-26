import OpenAI from "openai";
import type { Env } from "./env";

// The customer's question as a vector for semantic knowledge search: the same
// model the portal embeds the business's documents with. null ⇒ the search
// falls back to the whole public knowledge.
export async function embed(env: Env, text: string): Promise<number[] | null> {
  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const res = await client.embeddings.create({ model: env.OPENAI_EMBEDDING_MODEL, input: text.slice(0, 2000) });
    return res.data[0]?.embedding ?? null;
  } catch (err) {
    console.error(JSON.stringify({ evt: "embed_failed", err: String(err).slice(0, 200) }));
    return null;
  }
}
