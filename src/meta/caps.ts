// The Meta Model API caps (design spec section 11, the operator's decision of 2026-10-26; D03 T01 §2): US$250 in all and
// US$50 a day, with US$30 of the total held back for the demo and judging days, when it may be spent. Changed only by a
// commit: the guard (src/meta/budget.ts), the local callers (scripts/lib/meta-budget.ts) and the admin spend view
// (D07 T05 §2) read these and no other copy.
export const TOTAL_CAP_USD = 250;
export const DAY_CAP_USD = 50;
export const RESERVE_USD = 30;
// Coordinator-authorized 4 November 2026: finite judging headroom through finals on 9 November; usage retained.
// SAST dates (src/meta/day.ts) on which the reserve may be spent.
export const RESERVE_DAYS: readonly string[] = [
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
];

// The total a day may bring spend up to: the whole cap on a reserve day, the cap less the reserve on any other.
export const totalLimitFor = (day: string) =>
  RESERVE_DAYS.includes(day) ? TOTAL_CAP_USD : TOTAL_CAP_USD - RESERVE_USD;

// Which cap refused a reservation, from the day's and the total's counted spend before it, the longer-lived first, so
// the member is never told to come back tomorrow when tomorrow is refused too: the total cap; the reserve (a total within
// the cap but into the held-back US$30 on another day); then the day cap (D03 T01 §2 completion review).
// Null when no cap refuses it on this read: a settlement landed between the refused reservation and the read, and the
// caller tries the reservation again rather than name a cap that did not refuse it (round 1).
export function refusingCap(daySpentUsd: number, totalSpentUsd: number, estimateUsd: number, day: string) {
  const total = totalSpentUsd + estimateUsd;
  if (total > TOTAL_CAP_USD) return "total" as const;
  if (!RESERVE_DAYS.includes(day) && total > TOTAL_CAP_USD - RESERVE_USD) return "reserve" as const;
  return daySpentUsd + estimateUsd > DAY_CAP_USD ? ("day" as const) : null;
}

// A cap's event, the operator alert's identity: the day for the day cap (a new day is a new event), and the cap's own
// amount for the reserve and the total (raising either is a commit, and a new event).
export function capEvent(cap: "day" | "total" | "reserve", day: string): string {
  if (cap === "day") return `budget:day:${day}`;
  return cap === "reserve" ? `budget:reserve:${TOTAL_CAP_USD - RESERVE_USD}` : `budget:total:${TOTAL_CAP_USD}`;
}
