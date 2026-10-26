// What the agent knows about the business for one run, loaded from Supabase via
// mcp-agent (agent_api.get_context). The business is resolved from the verified
// phone_number_id inside the database, never chosen here.
import { normalizeCalendarConfig } from "@/features/booking/domain/calendar";
import type { AvailabilityWindows, CalendarConfig } from "@/lib/types";
import type { Env } from "./env";
import { callAgentTool, type AgentScope } from "./mcp";

export type Autonomy = "off" | "pending" | "confirm";

export type AgentContext = {
  businessName: string;
  enabled: boolean;
  agentName: string;
  agentIntro: string;
  autonomy: { new_booking: Autonomy; reschedule: Autonomy; cancel: Autonomy };
  // null ⇒ the agent works around the clock.
  agentHours: AvailabilityWindows | null;
  takeoverPauseMin: number;
  // null ⇒ no bookable calendar (widget off or not in the plan): answer only.
  calendar: CalendarConfig | null;
  timezone: string;
  firstContact: boolean;
};

type Raw = {
  error?: string;
  business: { name: string };
  settings: {
    enabled: boolean;
    agent_name: string;
    agent_intro: string;
    autonomy: AgentContext["autonomy"];
    agent_hours: AvailabilityWindows | null;
    takeover_pause_min: number;
  };
  calendar: unknown | null;
  thread: { first_contact: boolean };
};

// null when the number isn't an active connection.
export async function loadContext(env: Env, scope: AgentScope): Promise<AgentContext | null> {
  const raw = (await callAgentTool(env, scope, "get_context")) as Raw;
  if (raw?.error === "agent_not_connected") return null;
  if (!raw?.settings) throw new Error(`get_context: ${raw?.error ?? "empty"}`);
  const calendar = raw.calendar ? normalizeCalendarConfig(raw.calendar) : null;
  return {
    businessName: raw.business.name,
    enabled: raw.settings.enabled,
    agentName: raw.settings.agent_name,
    agentIntro: raw.settings.agent_intro || `the virtual assistant of ${raw.business.name}`,
    autonomy: raw.settings.autonomy,
    agentHours: raw.settings.agent_hours,
    takeoverPauseMin: raw.settings.takeover_pause_min,
    calendar,
    timezone: calendar?.timezone || "Europe/Rome",
    firstContact: raw.thread.first_contact,
  };
}
