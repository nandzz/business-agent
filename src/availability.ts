// check_availability's answer: every free time on ONE day, grouped into
// morning / afternoon / evening with a ready-to-show line per group, plus the
// next days that have room when the asked day is full. Slots come from the
// portal's computeSegmentedSlots and the free staff per slot from
// resolveSegmentPlan, the same functions the web booking uses.
import { computeSegmentedSlots, resolveSegmentPlan, todayInZone, type ServiceChoice } from "@/features/booking/domain/calendar";
import type { CalendarConfig, Location } from "@/lib/types";

// How far ahead to look for other days when the asked day is full.
const LOOKAHEAD_DAYS = 14;
const NEXT_DAYS_SHOWN = 3;
// Bookings must start at least this long from now.
const MIN_LEAD_MINUTES = 60;

export type AvailabilityScope = { location?: Location; timezone: string; staffNames: Map<string, string> };

type DayPart = "morning" | "afternoon" | "evening";

type DaySlot = {
  time: string; // "09:30", business timezone
  start: string; // exact value for create_booking / reschedule_booking
  free_staff: Record<string, string[]> | null; // service name → staff free then
};

export type DayAvailability = {
  date: string;
  date_label: string; // "Monday 2 November"
  timezone: string;
  parts: { part: DayPart; times: string; slots: DaySlot[] }[];
  next_free_days?: { date: string; date_label: string }[];
  note: string;
};

type Busy = Parameters<typeof computeSegmentedSlots>[0]["existingBusy"];

export function dayAvailability(input: {
  cal: CalendarConfig;
  scope: AvailabilityScope;
  choices: ServiceChoice[];
  date: string;
  busy: Busy;
  now: Date;
}): DayAvailability {
  const { cal, scope, choices, date, busy, now } = input;
  const slots = computeSegmentedSlots({
    config: cal,
    choices,
    fromDate: date,
    days: LOOKAHEAD_DAYS + 1,
    existingBusy: busy,
    now,
    minLeadMinutes: MIN_LEAD_MINUTES,
    location: scope.location,
  });
  const dayOf = (iso: string) => todayInZone(scope.timezone, new Date(iso));
  const onDay = slots.filter((s) => dayOf(s.start) === date);

  const parts = (["morning", "afternoon", "evening"] as const)
    .map((part) => {
      const daySlots = onDay
        .filter((s) => partOf(timeOf(s.start, scope.timezone)) === part)
        .map((s) => ({
          time: timeOf(s.start, scope.timezone),
          start: s.start,
          free_staff: freeStaffAt(cal, scope, choices, s.start, busy),
        }));
      return { part, times: daySlots.map((s) => s.time).join(" · "), slots: daySlots };
    })
    .filter((p) => p.slots.length > 0);

  const result: DayAvailability = { date, date_label: dateLabel(date, scope.timezone), timezone: scope.timezone, parts, note: "" };
  if (parts.length > 0) {
    result.note = "Show every time of this day in the standard layout. Offer only these times.";
    return result;
  }
  const otherDays = [...new Set(slots.map((s) => dayOf(s.start)))].filter((d) => d !== date).slice(0, NEXT_DAYS_SHOWN);
  result.next_free_days = otherDays.map((d) => ({ date: d, date_label: dateLabel(d, scope.timezone) }));
  result.note = otherDays.length
    ? "This day is full. Say so and ask if one of next_free_days works."
    : "No free times in the next two weeks. Say so and offer to pass the request to the team.";
  return result;
}

// Who is free at a slot: staff names per service (empty list ⇒ no staff needed).
function freeStaffAt(cal: CalendarConfig, scope: AvailabilityScope, choices: ServiceChoice[], start: string, busy: Busy) {
  const plan = resolveSegmentPlan({ config: cal, choices, startIso: start, existingBusy: busy, location: scope.location });
  if (!plan.ok) return null;
  return Object.fromEntries(plan.segments.map((seg) => [seg.name, seg.staff_ids.map((id) => scope.staffNames.get(id) ?? id)]));
}

const partOf = (time: string): DayPart => (time < "12:00" ? "morning" : time < "18:00" ? "afternoon" : "evening");

const timeOf = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

// Noon UTC keeps the calendar date stable in any business timezone.
const dateLabel = (date: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00Z`));
