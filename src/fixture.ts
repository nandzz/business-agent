// Phase 0 spike: one hard-coded demo business stands in for what will later be
// loaded per phone_number_id from Supabase (connection → profile, calendar
// widget config, My Agent settings, knowledge).
import { defaultCalendarConfig } from "@/features/booking/domain/calendar";
import type { CalendarConfig } from "@/lib/types";

export type Autonomy = "off" | "pending" | "confirm";

export type Business = {
  name: string;
  agentName: string;
  agentIntro: string;
  // null ⇒ the agent works around the clock.
  agentHours: CalendarConfig["availability"] | null;
  autonomy: { newBooking: Autonomy; reschedule: Autonomy; cancel: Autonomy };
  calendar: CalendarConfig;
  existingBookings: { starts_at: string; ends_at: string; staff_id?: string | null }[];
  knowledge: { title: string; body: string }[];
};

const calendar: CalendarConfig = {
  ...defaultCalendarConfig(),
  timezone: "Europe/Rome",
  currency: "eur",
  buffer_min: 10,
  services: [
    { id: "haircut", name: "Haircut", duration_min: 30, price_cents: 2500 },
    { id: "beard", name: "Beard trim", duration_min: 20, price_cents: 1500 },
    { id: "colour", name: "Haircut + colour", duration_min: 90, price_cents: 7000 },
  ],
  availability: {
    tue: [["09:00", "13:00"], ["14:30", "19:00"]],
    wed: [["09:00", "13:00"], ["14:30", "19:00"]],
    thu: [["09:00", "13:00"], ["14:30", "19:00"]],
    fri: [["09:00", "13:00"], ["14:30", "19:00"]],
    sat: [["09:00", "17:00"]],
  },
};

export const DEMO_BUSINESS: Business = {
  name: "Studio Demo Barber",
  agentName: "Nina",
  agentIntro: "the virtual assistant of Studio Demo Barber",
  agentHours: null,
  autonomy: { newBooking: "pending", reschedule: "pending", cancel: "pending" },
  calendar,
  existingBookings: [],
  knowledge: [
    {
      title: "Address and parking",
      body: "Via Roma 12, Milano (MM2 Garibaldi, 5 minutes on foot). Paid street parking; the Garibaldi garage is 200 m away.",
    },
    {
      title: "Opening hours",
      body: "Tuesday to Friday 9:00–13:00 and 14:30–19:00, Saturday 9:00–17:00. Closed Sunday and Monday.",
    },
    {
      title: "Payments",
      body: "Cash, cards and Satispay. No deposit is needed to book.",
    },
    {
      title: "Cancellation policy",
      body: "Free cancellation up to 24 hours before the appointment. Later cancellations or no-shows may be asked to prepay the next booking.",
    },
    {
      title: "Kids",
      body: "Kids' haircut (under 12) is €18, same duration as a normal haircut; book it as Haircut and mention it.",
    },
  ],
};

export function businessFor(_phoneNumberId: string): Business {
  return DEMO_BUSINESS;
}
