import type { ChatQueue } from "./chat";
import type { DebugWhatsApp } from "./debug-whatsapp";

export interface Env {
  CHAT: DurableObjectNamespace<ChatQueue>;
  // /debug/whatsapp chats (DEBUG_ROUTES=1 only).
  DEBUG_WHATSAPP: DurableObjectNamespace<DebugWhatsApp>;

  // Secrets (.dev.vars locally, `wrangler secret put` when deployed)
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  META_ACCESS_TOKEN: string;
  OPENAI_API_KEY: string;
  // Signs per-call run tokens for mcp-agent (same value as Vault agent_run_token_secret).
  AGENT_RUN_TOKEN_SECRET: string;
  // Signs the portal's /internal/approval-decided pings (same value in the portal).
  AGENT_NOTIFY_SECRET: string;

  // Plain vars (wrangler.jsonc)
  GRAPH_API_VERSION: string;
  MCP_AGENT_URL: string;
  OPENAI_MODEL: string;
  OPENAI_TRANSCRIBE_MODEL: string;
  // Optional: low | medium | high. Empty ⇒ the model's default.
  OPENAI_REASONING_EFFORT: string;
  DEBOUNCE_MS: string;
  MAX_WAIT_MS: string;
  MAX_INPUT_MESSAGES: string;
  // Longest customer message (text or voice transcript) shown to the model.
  MAX_MESSAGE_CHARS: string;
  TAKEOVER_PAUSE_MIN: string;
  DRY_RUN: string;
  DEBUG_ROUTES: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Logs never carry a full phone number / wa_id.
export const maskWaId = (waId: string) => `${waId.slice(0, -4)}••••`;

export const isOn = (value: string | undefined) => value === "1" || value === "true";
