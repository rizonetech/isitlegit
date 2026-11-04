import { isDateValue } from "../../db/case-filters";

export type CalendarDraft = { year: string; month: string; quarter: string; invalid: boolean };

export function calendarDraft(now: Date): CalendarDraft {
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return {
    year: String(sast.getUTCFullYear()),
    month: String(sast.getUTCMonth() + 1),
    quarter: String(Math.floor(sast.getUTCMonth() / 3) + 1),
    invalid: false,
  };
}

// Calendar choices are a transient form command, never a second persisted date filter.
export function calendarRequest(
  params: URLSearchParams,
): null | { draft: CalendarDraft; range: { from: string; to: string } | null } {
  if (!params.has("calendar")) return null;
  const action = params.get("calendar");
  const draft: CalendarDraft = {
    year: params.get("calendar_year") ?? "",
    month: params.get("calendar_month") ?? "",
    quarter: params.get("calendar_quarter") ?? "",
    invalid: true,
  };
  const refused = { draft, range: null };
  if (
    params.getAll("calendar").length !== 1 ||
    (action !== "month" && action !== "quarter") ||
    params.getAll("calendar_year").length !== 1 ||
    !/^\d{4}$/.test(draft.year)
  )
    return refused;
  const selected = action === "month" ? draft.month : draft.quarter;
  if (
    params.getAll(`calendar_${action}`).length !== 1 ||
    !(action === "month" ? /^(?:[1-9]|1[0-2])$/ : /^[1-4]$/).test(selected)
  )
    return refused;
  const month = action === "month" ? Number(selected) : (Number(selected) - 1) * 3 + 1;
  const endMonth = month + (action === "quarter" ? 2 : 0);
  const from = `${draft.year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(Number(draft.year), endMonth, 0)).getUTCDate();
  const to = `${draft.year}-${String(endMonth).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  if (!isDateValue(from) || !isDateValue(to)) return refused;
  return { draft: { ...draft, invalid: false }, range: { from, to } };
}
