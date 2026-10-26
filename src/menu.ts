// The service menu list_services hands the model: ready-to-show labels, grouped
// by location and category. Prices are included only when the booking settings
// show them (show_prices), so the model can't share a price the owner hid.
import type { CalendarCategory, CalendarConfig, CalendarService } from "@/lib/types";

type MenuStaff = { id: string; name: string };

type MenuService = {
  /** Position to show, counted across the location's groups (1, 2, 3, …). */
  n: number;
  id: string;
  name: string;
  /** "30 min", "1 h", "1 h 30 min". */
  duration: string;
  /** Present only when the business shows prices and the service has one. */
  price?: string;
  staff: MenuStaff[];
};

/** category null ⇒ the business uses no categories: list without a heading. */
type MenuGroup = { category: string | null; services: MenuService[] };

export type ServiceMenu = {
  /** false ⇒ the business hides prices: never mention or guess one. */
  prices_shown: boolean;
  locations: { location_id: string | null; name: string | null; address: string | null; groups: MenuGroup[] }[];
};

export function serviceMenu(cal: CalendarConfig): ServiceMenu {
  const scopes =
    cal.locations.length > 0
      ? cal.locations
          .filter((l) => l.services.length > 0)
          .map((l) => ({ id: l.id, name: l.name, address: l.address ?? null, services: l.services, staff: l.staff, categories: l.categories ?? [] }))
      : [{ id: null, name: null, address: null, services: cal.services, staff: cal.staff, categories: cal.categories ?? [] }];

  return {
    prices_shown: cal.show_prices,
    locations: scopes.map((s) => ({
      location_id: s.id,
      name: s.name,
      address: s.address,
      groups: numbered(groupByCategory(s.services, s.categories), (service, n) => menuService(service, n, s.staff, cal)),
    })),
  };
}

function numbered(
  groups: { category: string | null; services: CalendarService[] }[],
  toItem: (s: CalendarService, n: number) => MenuService,
): MenuGroup[] {
  let n = 0;
  return groups.map((g) => ({ category: g.category, services: g.services.map((s) => toItem(s, ++n)) }));
}

function menuService(s: CalendarService, n: number, staff: MenuStaff[], cal: CalendarConfig): MenuService {
  const eligible = s.staff_ids?.length ? staff.filter((p) => s.staff_ids!.includes(p.id)) : staff;
  return {
    n,
    id: s.id,
    name: s.name,
    duration: formatDuration(s.duration_min),
    ...(cal.show_prices && s.price_cents != null && { price: formatPrice(s.price_cents, cal.currency) }),
    staff: eligible.map((p) => ({ id: p.id, name: p.name })),
  };
}

// Categories in the owner's order, then uncategorized services last under
// "Other" (or with no heading when nothing is categorized).
function groupByCategory(services: CalendarService[], categories: CalendarCategory[]) {
  const known = new Set(categories.map((c) => c.id));
  const groups = categories
    .map((c) => ({ category: c.name as string | null, services: services.filter((s) => s.category_id === c.id) }))
    .filter((g) => g.services.length > 0);
  const rest = services.filter((s) => !s.category_id || !known.has(s.category_id));
  if (rest.length > 0) groups.push({ category: groups.length > 0 ? "Other" : null, services: rest });
  return groups;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// "25 €", "12,50 €": the owner's currency, whole amounts without decimals.
function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
