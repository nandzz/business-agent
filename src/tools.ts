// The agent's tools. Reads and writes go through mcp-agent (agent_api.*), which
// scopes everything to the business number and the customer of this chat.
// Slot math runs here with the portal's own calendar.ts, exactly like the web
// booking routes: availability from computeSegmentedSlots, the booking plan
// from resolveSegmentPlan. The business and customer come from the verified
// webhook via ToolContext, never from the model's arguments.
import type { FunctionTool } from "openai/resources/responses/responses";
import {
  computeSegmentedSlots,
  resolveSegmentPlan,
  todayInZone,
  type ServiceChoice,
} from "@/features/booking/domain/calendar";
import type { CalendarConfig, CalendarService, Location } from "@/lib/types";
import type { AgentContext } from "./context";
import type { Env } from "./env";
import { callAgentTool, type AgentScope } from "./mcp";
import { serviceMenu } from "./menu";

export type ToolContext = {
  env: Env;
  scope: AgentScope;
  agent: AgentContext;
  customerName?: string;
  now: Date;
};

const nullable = (type: string, description?: string) => ({ type: [type, "null"], ...(description && { description }) });

export const TOOL_DEFS: FunctionTool[] = [
  {
    type: "function",
    name: "search_knowledge",
    description:
      "Search the business's knowledge (address, hours, prices, policies, FAQs). Use it before answering any factual question about the business.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What the customer wants to know" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_services",
    description:
      "The service menu: per location (with location_id) and category, each service with id, ready-to-show duration, price (only when the business shows prices) and the staff who can do it. prices_shown=false means prices are hidden.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "check_availability",
    description:
      "Free start times for one or more services booked together. Dates are in the business's timezone (YYYY-MM-DD).",
    parameters: {
      type: "object",
      properties: {
        service_ids: { type: "array", items: { type: "string" } },
        location_id: nullable("string", "Required when the business has locations"),
        staff_id: nullable("string", "Only when the customer asked for a specific person"),
        from_date: nullable("string", "First day to check; null = today"),
        days: nullable("integer", "How many days to check (1–14); null = 7"),
      },
      required: ["service_ids", "location_id", "staff_id", "from_date", "days"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "my_bookings",
    description:
      "The customer's upcoming bookings (with booking_id): the ones made in this chat and any other booking at this business under their WhatsApp number (web or made by the business).",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "create_booking",
    description:
      "Book for the customer in this chat. Only call it AFTER the customer explicitly said yes to a summary of service, day and time.",
    parameters: {
      type: "object",
      properties: {
        service_ids: { type: "array", items: { type: "string" } },
        location_id: nullable("string"),
        staff_id: nullable("string"),
        start: { type: "string", description: "Slot start exactly as returned by check_availability" },
        customer_name: nullable("string", "The name the customer gave for the booking"),
      },
      required: ["service_ids", "location_id", "staff_id", "start", "customer_name"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "reschedule_booking",
    description:
      "Move one of the customer's bookings (from my_bookings) to a new start from check_availability. Only after the customer explicitly said yes.",
    parameters: {
      type: "object",
      properties: { booking_id: { type: "string" }, start: { type: "string" } },
      required: ["booking_id", "start"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "cancel_booking",
    description: "Cancel one of the customer's bookings (from my_bookings). Only after the customer explicitly said yes.",
    parameters: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "hand_off",
    description:
      "Pass the conversation to the owner: business matters you can't handle yourself (complaints, refunds, sensitive or unclear requests about the business, questions the knowledge doesn't cover). Never for off-topic requests: decline those yourself.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const fmtSlot = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

type Scope = { location?: Location; services: CalendarService[]; staffNames: Map<string, string>; timezone: string };

// The services/staff/timezone a booking draws from: one location, or the
// top-level config when the business has none.
function bookingScope(cal: CalendarConfig, locationId: string | null): Scope | { error: string } {
  if (cal.locations.length > 0) {
    const location = cal.locations.find((l) => l.id === locationId);
    if (!location) return { error: "location_id required: pick one from list_services" };
    return {
      location,
      services: location.services,
      staffNames: new Map(location.staff.map((s) => [s.id, s.name])),
      timezone: location.timezone || cal.timezone,
    };
  }
  return { services: cal.services, staffNames: new Map(cal.staff.map((s) => [s.id, s.name])), timezone: cal.timezone };
}

function choicesFor(scope: Scope, serviceIds: unknown, staffId: unknown): ServiceChoice[] | { error: string } {
  const ids = Array.isArray(serviceIds) ? serviceIds.map(String).slice(0, 10) : [];
  if (ids.length === 0) return { error: "service_ids required" };
  const choices: ServiceChoice[] = [];
  for (const id of ids) {
    const service = scope.services.find((s) => s.id === id);
    if (!service) return { error: `unknown service_id ${id}` };
    choices.push({ service, staffId: typeof staffId === "string" && staffId ? staffId : undefined });
  }
  return choices;
}

async function busyFor(tc: ToolContext, scope: Scope, fromDate: string, days: number, excludeBookingId?: string) {
  const from = new Date(new Date(`${fromDate}T00:00:00Z`).getTime() - 86_400_000).toISOString();
  const to = new Date(new Date(`${fromDate}T00:00:00Z`).getTime() + (days + 2) * 86_400_000).toISOString();
  const busy = await callAgentTool(tc.env, tc.scope, "busy", {
    from,
    to,
    location_id: scope.location?.id ?? null,
    exclude_booking_id: excludeBookingId ?? null,
  });
  return Array.isArray(busy) ? busy : [];
}

// Plan one booking at `start`, re-checked against live bookings.
async function planAt(tc: ToolContext, cal: CalendarConfig, scope: Scope, choices: ServiceChoice[], start: string, excludeBookingId?: string) {
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return { ok: false as const, reason: "INVALID_START" };
  const day = todayInZone(scope.timezone, startDate);
  const busy = await busyFor(tc, scope, day, 1, excludeBookingId);
  return resolveSegmentPlan({
    config: cal,
    choices,
    startIso: startDate.toISOString(),
    existingBusy: busy,
    location: scope.location,
  });
}

type MyBooking = { booking_id: string; service_ids: string[]; location_id: string | null; starts_at: string };

export async function executeTool(name: string, args: Record<string, unknown>, tc: ToolContext): Promise<unknown> {
  const cal = tc.agent.calendar;
  const noBooking = { error: "online booking is not available for this business; offer to hand off" };
  switch (name) {
    case "search_knowledge":
      return callAgentTool(tc.env, tc.scope, "search_knowledge", { query: String(args.query ?? "") });

    case "list_services":
      return cal ? serviceMenu(cal) : noBooking;

    case "check_availability": {
      if (!cal) return noBooking;
      const scope = bookingScope(cal, (args.location_id as string) ?? null);
      if ("error" in scope) return scope;
      const choices = choicesFor(scope, args.service_ids, args.staff_id);
      if ("error" in choices) return choices;
      const days = Math.min(14, Math.max(1, Number(args.days ?? 7) || 7));
      const fromDate =
        typeof args.from_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.from_date)
          ? args.from_date
          : todayInZone(scope.timezone, tc.now);
      const busy = await busyFor(tc, scope, fromDate, days);
      const slots = computeSegmentedSlots({
        config: cal,
        choices,
        fromDate,
        days,
        existingBusy: busy,
        now: tc.now,
        minLeadMinutes: 60,
        location: scope.location,
      });
      return {
        timezone: scope.timezone,
        total: slots.length,
        slots: slots.slice(0, 16).map((s) => ({ start: s.start, label: fmtSlot(s.start, scope.timezone) })),
      };
    }

    case "my_bookings":
      return callAgentTool(tc.env, tc.scope, "my_bookings");

    case "create_booking": {
      if (!cal) return noBooking;
      if (tc.agent.autonomy.new_booking === "off") return { error: "booking through chat is disabled; offer to hand off" };
      const scope = bookingScope(cal, (args.location_id as string) ?? null);
      if ("error" in scope) return scope;
      const choices = choicesFor(scope, args.service_ids, args.staff_id);
      if ("error" in choices) return choices;
      const plan = await planAt(tc, cal, scope, choices, String(args.start ?? ""));
      if (!plan.ok) return { error: plan.reason, note: "That time is no longer free: check_availability again and offer other times." };
      const result = (await callAgentTool(tc.env, tc.scope, "create_booking", {
        service_ids: choices.map((c) => c.service.id),
        starts_at: new Date(String(args.start)).toISOString(),
        location_id: scope.location?.id ?? null,
        staff_id: (args.staff_id as string) || null,
        customer_name: (args.customer_name as string) || tc.customerName || null,
        segments: plan.segments,
        locale: null,
      })) as { status?: string; staff?: string | null; error?: string };
      return withNote(result, scope.timezone, String(args.start));
    }

    case "reschedule_booking": {
      if (!cal) return noBooking;
      if (tc.agent.autonomy.reschedule === "off") return { error: "changes through chat are disabled; offer to hand off" };
      const mine = ((await callAgentTool(tc.env, tc.scope, "my_bookings")) as MyBooking[]) ?? [];
      const booking = mine.find((b) => b.booking_id === args.booking_id);
      if (!booking) return { error: "BOOKING_NOT_FOUND", note: "Use my_bookings to find the booking." };
      const scope = bookingScope(cal, booking.location_id);
      if ("error" in scope) return scope;
      const choices = choicesFor(scope, booking.service_ids, null);
      if ("error" in choices) return choices;
      const plan = await planAt(tc, cal, scope, choices, String(args.start ?? ""), booking.booking_id);
      if (!plan.ok) return { error: plan.reason, note: "That time is not free: check_availability again and offer other times." };
      const result = (await callAgentTool(tc.env, tc.scope, "reschedule_booking", {
        booking_id: booking.booking_id,
        starts_at: new Date(String(args.start)).toISOString(),
        segments: plan.segments,
      })) as { status?: string; error?: string };
      return withNote(result, scope.timezone, String(args.start));
    }

    case "cancel_booking": {
      if (tc.agent.autonomy.cancel === "off") return { error: "cancelling through chat is disabled; offer to hand off" };
      const result = (await callAgentTool(tc.env, tc.scope, "cancel_booking", { booking_id: String(args.booking_id ?? "") })) as {
        status?: string;
      };
      return withNote(result);
    }

    case "hand_off":
      // The free-text reason goes to the owner's activity feed, not to logs.
      await callAgentTool(tc.env, tc.scope, "hand_off", { reason: String(args.reason ?? "") });
      return { ok: true, note: "Tell the customer someone from the business will reply soon." };

    default:
      return { error: `unknown tool ${name}` };
  }
}

// What the model should tell the customer for each outcome.
function withNote(result: { status?: string; error?: string }, timezone?: string, start?: string) {
  const when = timezone && start ? fmtSlot(start, timezone) : undefined;
  switch (result?.status) {
    case "confirmed":
      return { ...result, when, note: "Tell the customer it is confirmed." };
    case "cancelled":
      return { ...result, note: "Tell the customer it is cancelled." };
    case "pending_owner_approval":
      return { ...result, when, note: "Tell the customer the request was sent and the business will confirm shortly. Do not say it is confirmed." };
    case "not_allowed":
      return { ...result, note: "This isn't possible through chat: offer to hand off to the business." };
    default:
      return result;
  }
}
