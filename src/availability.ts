// check_availability's answer: every free time on ONE day, grouped into
// morning / afternoon / evening with a ready-to-show line per group, plus the
// next days that have room when the asked day is full. For several people it
// also plans group options: everyone at the same time with different staff,
// or one right after the other. Slots come from the
// portal's computeSegmentedSlots and the free staff per slot from
// resolveSegmentPlan, the same functions the web booking uses.
import {
  computeSegmentedSlots,
  resolveSegmentPlan,
  todayInZone,
  type ExistingSegmentBusy,
  type ResolvedSegment,
  type ServiceChoice,
} from "@/features/booking/domain/calendar";
import type { CalendarConfig, Location } from "@/lib/types";

// How far ahead to look for other days when the asked day is full.
const LOOKAHEAD_DAYS = 14;
const NEXT_DAYS_SHOWN = 3;
// Bookings must start at least this long from now.
const MIN_LEAD_MINUTES = 60;
// Group options returned for several people, spread over the day.
const GROUP_OPTIONS_SHOWN = 6;
export const MAX_PEOPLE = 6;

export type AvailabilityScope = { location?: Location; timezone: string; staffNames: Map<string, string> };

type DayPart = "morning" | "afternoon" | "evening";

type DaySlot = {
  time: string; // "09:30", business timezone
  start: string; // exact value for create_booking / reschedule_booking
  free_staff: Record<string, string[]> | null; // service name → staff free then
};

type GroupBooking = { time: string; start: string; staff: string[] };

/** One way to fit everyone: a booking per person (same service each). */
type GroupOption = { label: string; together: boolean; bookings: GroupBooking[] };

export type DayAvailability = {
  date: string;
  date_label: string; // "Monday 2 November"
  timezone: string;
  parts: { part: DayPart; times: string; slots: DaySlot[] }[];
  people?: number;
  group_options?: GroupOption[];
  next_free_days?: { date: string; date_label: string }[];
  note: string;
};

type Busy = ExistingSegmentBusy[];

export function dayAvailability(input: {
  cal: CalendarConfig;
  scope: AvailabilityScope;
  choices: ServiceChoice[];
  date: string;
  busy: Busy;
  now: Date;
  people: number;
}): DayAvailability {
  const { cal, scope, choices, date, busy, now, people } = input;
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
  if (people > 1 && onDay.length > 0) {
    result.people = people;
    result.group_options = groupOptions(cal, scope, choices, onDay.map((s) => s.start), busy, people);
    if (result.group_options.length > 0) {
      result.note = "Suggest a few group_options (say who is with whom and when), then make one create_booking per person with that person's name.";
      return result;
    }
  }
  if (parts.length > 0) {
    result.note =
      people > 1
        ? "There is room for one person at a time but no way to fit everyone this day. Say so and offer another day."
        : "Show every time of this day in the standard layout. Offer only these times.";
    return result;
  }
  const otherDays = [...new Set(slots.map((s) => dayOf(s.start)))].filter((d) => d !== date).slice(0, NEXT_DAYS_SHOWN);
  result.next_free_days = otherDays.map((d) => ({ date: d, date_label: dateLabel(d, scope.timezone) }));
  result.note = otherDays.length
    ? "This day is full. Say so and ask if one of next_free_days works."
    : "No free times in the next two weeks. Say so and offer to pass the request to the team.";
  return result;
}

// For each start of the day, place the people one by one: each tries the same
// start as the previous person (with other staff), else right after them.
// Every placement goes through resolveSegmentPlan with the earlier people's
// segments added to busy, so an option is only returned if it really fits.
function groupOptions(
  cal: CalendarConfig,
  scope: AvailabilityScope,
  choices: ServiceChoice[],
  starts: string[],
  busy: Busy,
  people: number,
): GroupOption[] {
  const options: GroupOption[] = [];
  const seen = new Set<string>();
  for (const first of starts) {
    const bookings: GroupBooking[] = [];
    let taken = busy;
    let prev: { start: string; totalMin: number } | null = null;
    for (let i = 0; i < people; i++) {
      const candidates: string[] = prev ? [prev.start, addMinutes(prev.start, prev.totalMin)] : [first];
      const placed = candidates
        .map((start) => ({ start, plan: resolveSegmentPlan({ config: cal, choices, startIso: start, existingBusy: taken, location: scope.location }) }))
        .find((c) => c.plan.ok);
      if (!placed || !placed.plan.ok) break;
      bookings.push({
        time: timeOf(placed.start, scope.timezone),
        start: placed.start,
        staff: placed.plan.segments.map((seg) => staffName(scope, seg.staff_ids[0])).filter((n): n is string => Boolean(n)),
      });
      taken = [...taken, ...segmentsBusy(placed.start, placed.plan.segments)];
      prev = { start: placed.start, totalMin: placed.plan.totalMin };
    }
    if (bookings.length < people) continue;
    const label = [...new Set(bookings.map((b) => b.time))].join(" + ");
    if (seen.has(label)) continue;
    seen.add(label);
    options.push({ label, together: new Set(bookings.map((b) => b.start)).size === 1, bookings });
  }
  return spread(options, GROUP_OPTIONS_SHOWN);
}

// The segments a planned booking occupies, as busy ranges for the next person.
function segmentsBusy(start: string, segments: ResolvedSegment[]): Busy {
  return segments.map((seg) => ({
    staff_id: seg.staff_ids[0] ?? null,
    starts_at: addMinutes(start, seg.offset_min),
    ends_at: addMinutes(start, seg.offset_min + seg.duration_min),
  }));
}

// Pick `n` options evenly across the day instead of the first n in the morning.
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

const addMinutes = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

const staffName = (scope: AvailabilityScope, id: string | undefined) => (id ? (scope.staffNames.get(id) ?? id) : null);

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
