// Client for mcp-agent (Supabase edge function). The worker is its only client:
// OpenAI never sees this URL or a token. Each tool call gets its own run token,
// HMAC-signed with AGENT_RUN_TOKEN_SECRET, naming the tool, the business number
// and the customer from the verified webhook, single-use and valid ≤60 s. The
// database verifies it (agent_private.verify_run_token).
import type { Env } from "./env";

const TOKEN_TTL_S = 45;

export type AgentScope = { phoneNumberId: string; customerWaId: string };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function mintRunToken(secret: string, scope: AgentScope, tool: string, now = Date.now()): Promise<string> {
  const claims = {
    pn: scope.phoneNumberId,
    wa: scope.customerWaId,
    tool,
    n: crypto.randomUUID(),
    exp: Math.floor(now / 1000) + TOKEN_TTL_S,
  };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${payload}`));
  return `v1.${payload}.${b64url(new Uint8Array(sig))}`;
}

export class AgentMcpError extends Error {}

export async function callAgentTool(
  env: Env,
  scope: AgentScope,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!env.MCP_AGENT_URL || !env.AGENT_RUN_TOKEN_SECRET) throw new AgentMcpError("mcp-agent not configured");
  const token = await mintRunToken(env.AGENT_RUN_TOKEN_SECRET, scope, tool);
  const res = await fetch(env.MCP_AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = (await res.json().catch(() => null)) as
    | { result?: { structuredContent?: unknown }; error?: { message?: string } }
    | null;
  if (!res.ok || !body || body.error) {
    throw new AgentMcpError(`mcp-agent ${tool} failed: ${res.status} ${body?.error?.message ?? ""}`.trim());
  }
  return body.result?.structuredContent;
}
