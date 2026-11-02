// The Cases list's filters and page shapes (D07 T04 §1), with no database in them, so the page and its browser tests
// read them as the route does: the query string's filters, each bad value its default, and one page of cases.
import { z } from "zod";

export const PAGE_SIZE = 25;
export const VERDICTS = ["all", "malicious", "suspicious", "safe"] as const;
export const CHANNELS = ["all", "email", "upload"] as const;
export const PERIODS = ["7", "30", "90", "all"] as const;
// The longest search kept (D07 T04 §7): longer words are cut, never refused, so a pasted subject still searches.
export const SEARCH_LIMIT = 100;

// A real calendar date as `YYYY-MM-DD`, or "" for unset (D07 T04 §8): a hand-typed `2026-02-30` is no date.
export const isDateValue = (v: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
};

export const CaseFilters = z.object({
  verdict: z.enum(VERDICTS),
  channel: z.enum(CHANNELS),
  period: z.enum(PERIODS),
  page: z.number().int().min(1).max(100_000),
  // Search by sender or subject (D07 T04 §7), as typed: trimmed, inner space made one; "" is no search.
  q: z.string().refine((v) => Array.from(v).length <= SEARCH_LIMIT, `at most ${SEARCH_LIMIT} characters`),
  // A chosen date range (D07 T04 §8): SAST calendar days, both ends inclusive; "" is unset, and setting either
  // date makes the range the date filter in place of the period.
  from: z.string().refine((v) => v === "" || isDateValue(v), "a real date or empty"),
  to: z.string().refine((v) => v === "" || isDateValue(v), "a real date or empty"),
  // Who checked (D07 T04 §10): a member's user id, or "" for everyone. Any id is kept as typed; the list's
  // clause matches nothing for one who is not a member of the organisation, so a bad value narrows, never widens.
  checker: z.string().max(200),
});
export type CaseFilters = z.infer<typeof CaseFilters>;
export const DEFAULT_FILTERS: CaseFilters = {
  verdict: "all",
  channel: "all",
  period: "30",
  page: 1,
  q: "",
  from: "",
  to: "",
  checker: "",
};

// The filters a query string asks for, each bad or missing value its default (a link typed by hand, an old bookmark).
export function filtersFrom(query: URLSearchParams): CaseFilters {
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = query.get(name);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  };
  const page = Number(query.get("page"));
  return {
    verdict: pick("verdict", VERDICTS, DEFAULT_FILTERS.verdict),
    channel: pick("channel", CHANNELS, DEFAULT_FILTERS.channel),
    period: pick("period", PERIODS, DEFAULT_FILTERS.period),
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
    q: searchFrom(query.get("q")),
    from: dateFrom(query.get("from")),
    to: dateFrom(query.get("to")),
    checker: (query.get("checker") ?? "").slice(0, 200),
  };
}

// A date from the address, kept as typed when it is a real date and unset otherwise (D07 T04 §8). A reversed pair
// is kept as typed too: the page names it and offers the swap, so inputs, address and results never disagree.
export function dateFrom(value: string | null): string {
  return value !== null && isDateValue(value) ? value : "";
}

// The date bounds a query named but did not give as real dates ("From", "To"), so the page can say they were left
// out instead of silently widening the range (D07 T04 §8, completion review G4).
export function ignoredDates(query: URLSearchParams): string[] {
  return [
    ...(query.get("from") && !isDateValue(query.get("from") ?? "") ? ["From"] : []),
    ...(query.get("to") && !isDateValue(query.get("to") ?? "") ? ["To"] : []),
  ];
}

// Whether the query asked for was longer than the search keeps (D07 T04 §14): the page says so, rather than quietly
// searching less than was typed (a closing quote cut off would otherwise turn a phrase into separate words).
export function searchTooLong(value: string | null): boolean {
  return Array.from((value ?? "").replace(/\s+/g, " ").trim()).length > SEARCH_LIMIT;
}

// The search words as kept: space runs made one, trimmed, cut to the limit by code point (never half a surrogate pair).
export function searchFrom(value: string | null): string {
  return Array.from((value ?? "").replace(/\s+/g, " ").trim())
    .slice(0, SEARCH_LIMIT)
    .join("")
    .trim();
}

export type ListedCase = {
  id: string;
  channel: "email" | "upload";
  sourceKind: "mail" | "document" | "image" | "audio";
  status: "received" | "running" | "done" | "partial";
  verdict: "safe" | "suspicious" | "malicious" | null;
  createdAt: string;
  // Who checked it (D07 T04 §7): the forwarding or uploading member's name, else their address; "Former member" for an
  // uploader no longer in the organisation; null when nothing is recorded (an upload from before migration 0039).
  checkedBy: string | null;
  // What the row is named by (D07 T04 §7): the original's subject and sender (D01 T01 §16), an upload's file name and
  // type (D02 T04 §4), each null when not stored.
  subject: string | null;
  senderName: string | null;
  senderAddress: string | null;
  uploadName: string | null;
  uploadMediaType: string | null;
};
export type CasePage = {
  cases: ListedCase[];
  // The page served: the one asked for, or the last when that is past the end.
  page: number;
  pages: number;
  matching: number;
  total: number;
  // The query had more than MAX_TERMS search terms, and only the first were used (D07 T04 §14).
  searchCut?: boolean;
};
export type ListResult =
  | { ok: true; value: CasePage }
  | { ok: false; error: { code: "invalid" | "database"; message: string } };

// The weekly stats panel's numbers (D07 T04 §2), computed in ./case-stats.ts.
export type WeekCounts = {
  weekStart: string;
  checked: number;
  malicious: number;
  suspicious: number;
  safe: number;
  unfinished: number;
  // Null when no case that arrived that week has a verdict.
  medianSecondsToVerdict: number | null;
};

export type WeeklyStats = {
  thisWeek: WeekCounts;
  lastWeekChecked: number;
};
