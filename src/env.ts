import type { ChatQueue } from "./chat";

export interface Env {
  CHAT: DurableObjectNamespace<ChatQueue>;

  // Secrets (.dev.vars locally, `wrangler secret put` when deployed)
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  META_ACCESS_TOKEN: string;
  OPENAI_API_KEY: string;

  // Plain vars (wrangler.jsonc)
  GRAPH_API_VERSION: string;
  OPENAI_MODEL: string;
  OPENAI_TRANSCRIBE_MODEL: string;
  DEBOUNCE_MS: string;
  MAX_WAIT_MS: string;
  MAX_INPUT_MESSAGES: string;
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
