// The Meta Model API caps (design spec section 11, the operator's decision of 2026-10-26; D03 T01 §2): US$120 in all and
// US$15 a day, with US$30 of the total held back for the demo and judging days, when it may be spent. Changed only by a
// commit: the guard (src/meta/budget.ts), the local callers (scripts/lib/meta-budget.ts) and the admin spend view
// (D07 T05 §2) read these and no other copy.
export const TOTAL_CAP_USD = 120;
export const DAY_CAP_USD = 15;
export const RESERVE_USD = 30;
// SAST dates (src/meta/day.ts) on which the reserve may be spent.
export const RESERVE_DAYS: readonly string[] = ["2026-11-03", "2026-11-04"];

// The total a day may bring spend up to: the whole cap on a reserve day, the cap less the reserve on any other.
export const totalLimitFor = (day: string) =>
  RESERVE_DAYS.includes(day) ? TOTAL_CAP_USD : TOTAL_CAP_USD - RESERVE_USD;

// Which cap refused a reservation, from the day's and the total's counted spend before it: the day cap; the reserve (a
// total within the cap but into the held-back US$30 on another day); or the total cap itself.
export function refusingCap(daySpentUsd: number, totalSpentUsd: number, estimateUsd: number, day: string) {
  if (daySpentUsd + estimateUsd > DAY_CAP_USD) return "day" as const;
  const total = totalSpentUsd + estimateUsd;
  return total <= TOTAL_CAP_USD && !RESERVE_DAYS.includes(day) && total > TOTAL_CAP_USD - RESERVE_USD
    ? ("reserve" as const)
    : ("total" as const);
}
