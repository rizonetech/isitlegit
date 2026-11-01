// The words of a check's outcome summary (D02 T01 §7): what a check saw, without its own label (the report draws
// "<check words>: <summary>"), within MAX_OUTCOME_SUMMARY characters. Built from counts, fixed phrases and the names a
// check's own card already shows, never from the message's text; the runner checks every summary again before storing.
import { MAX_OUTCOME_SUMMARY } from "./registry";

const fits = (text: string) => Array.from(text).length <= MAX_OUTCOME_SUMMARY;

// "<n> <one>" or "<n> <many>".
export const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// `lead` and as many of `names` as fit, the rest counted: "1, to a.example", "7, to a.example, b.example and 5 more";
// when not one name fits, `none` (the lead with the count of names).
export function fitted(lead: string, names: readonly string[], none: string): string {
  for (let shown = names.length; shown >= 1; shown--) {
    const rest = names.length - shown;
    const text = `${lead}${names.slice(0, shown).join(", ")}${rest ? ` and ${rest} more` : ""}`;
    if (fits(text)) return text;
  }
  return none;
}

// How long ago a date was, from the day it was read: in days under two months, months under two years, then years.
export function agoOf(date: string, from: string): string | null {
  const days = Math.floor((Date.parse(from) - Date.parse(date)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days < 60) return counted(days, "day", "days");
  if (days < 730) return counted(Math.floor(days / 30), "month", "months");
  return counted(Math.floor(days / 365), "year", "years");
}
