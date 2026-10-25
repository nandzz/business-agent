// The agent's tools. In the spike they run against the demo fixture; later each
// becomes a call to the Agent MCP (agent_* RPCs). The business and customer come
// from the verified webhook via ToolContext, never from the model's arguments.
import type { FunctionTool } from "openai/resources/responses/responses";
import { computeAvailableSlots, todayInZone } from "@/features/booking/domain/calendar";
import { maskWaId } from "./env";
import type { Business } from "./fixture";

export type ToolContext = {
  business: Business;
  customerWaId: string;
  customerName?: string;
  now: Date;
};

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
    description: "List the bookable services with their id, duration and price.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "check_availability",
    description:
      "Free start times for one service. Dates are in the business's timezone (YYYY-MM-DD).",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        from_date: { type: ["string", "null"], description: "First day to check; null = today" },
        days: { type: ["integer", "null"], description: "How many days to check (1–14); null = 7" },
      },
      required: ["service_id", "from_date", "days"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "create_booking",
    description:
      "Book a service for the customer in this chat. Only call it AFTER the customer explicitly said yes to a summary of service, day and time.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        start: { type: "string", description: "Slot start exactly as returned by check_availability" },
        customer_name: { type: ["string", "null"] },
      },
      required: ["service_id", "start", "customer_name"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "hand_off",
    description:
      "Pass the conversation to the owner: sensitive, unclear or off-topic requests, complaints, refunds, anything you can't answer from the knowledge.",
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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const { business } = ctx;
  const tz = business.calendar.timezone;
  switch (name) {
    case "search_knowledge": {
      const words = String(args.query ?? "")
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2);
      const scored = business.knowledge
        .map((k) => {
          const hay = `${k.title} ${k.body}`.toLowerCase();
          return { k, score: words.filter((w) => hay.includes(w)).length };
        })
        .sort((a, b) => b.score - a.score);
      // Tiny corpus: return everything, best match first, so the model can
      // still answer when keywords miss (real version = embeddings search).
      return scored.map(({ k }) => k);
    }
    case "list_services":
      return business.calendar.services.map((s) => ({
        id: s.id,
        name: s.name,
        duration_min: s.duration_min,
        price: s.price_cents == null ? null : `€${(s.price_cents / 100).toFixed(2)}`,
      }));
    case "check_availability": {
      const service = business.calendar.services.find((s) => s.id === args.service_id);
      if (!service) return { error: "unknown service_id" };
      const days = Math.min(14, Math.max(1, Number(args.days ?? 7) || 7));
      const fromDate =
        typeof args.from_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.from_date)
          ? args.from_date
          : todayInZone(tz, ctx.now);
      const slots = computeAvailableSlots({
        config: business.calendar,
        service,
        fromDate,
        days,
        existingBookings: business.existingBookings,
        now: ctx.now,
        minLeadMinutes: 60,
      });
      return {
        timezone: tz,
        total: slots.length,
        slots: slots.slice(0, 16).map((s) => ({ start: s.start, label: fmtSlot(s.start, tz) })),
      };
    }
    case "create_booking": {
      const service = business.calendar.services.find((s) => s.id === args.service_id);
      if (!service) return { error: "unknown service_id" };
      const mode = business.autonomy.newBooking;
      if (mode === "off") return { error: "booking through chat is disabled; offer to hand off" };
      // Spike: nothing is persisted. Later: create_booking_tx via the Agent MCP.
      console.log(
        JSON.stringify({
          evt: "booking_simulated",
          mode,
          customer: maskWaId(ctx.customerWaId),
          service_id: service.id,
          start: String(args.start),
        }),
      );
      return {
        status: mode === "pending" ? "pending_owner_approval" : "confirmed",
        service: service.name,
        when: fmtSlot(String(args.start), tz),
        note:
          mode === "pending"
            ? "Tell the customer the request was sent and the business will confirm shortly."
            : "Tell the customer the booking is confirmed.",
      };
    }
    case "hand_off":
      // Spike: log only. Later: activity feed + owner alert (email/Twilio/in-app).
      // The free-text reason stays out of logs (it can quote the customer);
      // it will go to the owner's activity feed instead.
      console.log(JSON.stringify({ evt: "hand_off", customer: maskWaId(ctx.customerWaId) }));
      return { ok: true, note: "Tell the customer someone from the business will reply soon." };
    default:
      return { error: `unknown tool ${name}` };
  }
}
