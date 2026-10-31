// The Cases list's filters and page shapes (D07 T04 §1), with no database in them, so the page and its browser tests
// read them as the route does: the query string's filters, each bad value its default, and one page of cases.
import { z } from "zod";

export const PAGE_SIZE = 25;
export const VERDICTS = ["all", "malicious", "suspicious", "safe"] as const;
export const CHANNELS = ["all", "email", "upload"] as const;
export const PERIODS = ["7", "30", "90", "all"] as const;

export const CaseFilters = z.object({
  verdict: z.enum(VERDICTS),
  channel: z.enum(CHANNELS),
  period: z.enum(PERIODS),
  page: z.number().int().min(1).max(100_000),
});
export type CaseFilters = z.infer<typeof CaseFilters>;
export const DEFAULT_FILTERS: CaseFilters = { verdict: "all", channel: "all", period: "30", page: 1 };

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
  };
}

export type ListedCase = {
  id: string;
  channel: "email" | "upload";
  sourceKind: "mail" | "document" | "image" | "audio";
  status: "received" | "running" | "done" | "partial";
  verdict: "safe" | "suspicious" | "malicious" | null;
  createdAt: string;
  // The member's name, else the forwarder's address; null for an upload (no uploader is stored yet).
  checkedBy: string | null;
};
export type CasePage = {
  cases: ListedCase[];
  // The page served: the one asked for, or the last when that is past the end.
  page: number;
  pages: number;
  matching: number;
  total: number;
};
export type ListResult =
  | { ok: true; value: CasePage }
  | { ok: false; error: { code: "invalid" | "database"; message: string } };
