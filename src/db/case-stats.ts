// The Cases list's weekly stats (D07 T04 §2; design/SPEC.md M1, board `Cases` stats panel): an organisation's cases by
// the week they arrived in, Monday 00:00 to Monday 00:00 SAST (ISO 8601 weeks). A case belongs to its arrival week
// whatever its state: every arrival is checked; a done or partial case's stored verdict counts in that verdict; one with
// none (received, running, or a partial case that never reached one) is unfinished; and the median time to verdict runs
// from arrival (`cases.created_at`) to the stored verdict (`case_verdicts.created_at`), even when that came the next week.
// Every read is scoped by the organisation, and nothing here reads a message's content.
import type { WeekCounts, WeeklyStats } from "./case-filters";
import { sastDayStart } from "./cases";

export type { WeekCounts, WeeklyStats } from "./case-filters";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// The Monday 00:00 SAST at or before `now`, as an ISO instant.
export function weekStart(now: Date): string {
  const today = Date.parse(sastDayStart(now));
  // getUTCDay of the SAST date: 2026-10-26 00:00 SAST is 2026-10-25T22:00Z, so shift into SAST before reading the day.
  const sastWeekday = new Date(today + 2 * 3_600_000).getUTCDay();
  const sinceMonday = (sastWeekday + 6) % 7;
  return new Date(today - sinceMonday * DAY_MS).toISOString();
}

type Row = { id: string; created_at: string; verdict: string | null; status: string; decided_at: string | null };

// The middle value; the mean of the middle two for an even count.
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

// The counts of the `weeks` weeks ending with the one holding `now`, newest first, from one scoped read.
export async function weeklyCounts(db: D1Database, orgId: string, now: Date, weeks: number): Promise<WeekCounts[]> {
  const current = Date.parse(weekStart(now));
  const from = new Date(current - (weeks - 1) * WEEK_MS).toISOString();
  const rowsStatement = db
    .prepare(
      `SELECT c.id, c.created_at, c.verdict, c.status, v.created_at AS decided_at
       FROM cases c LEFT JOIN case_verdicts v ON v.case_id = c.id
       WHERE c.org_id = ? AND c.created_at >= ?`,
    )
    .bind(orgId, from);
  const out: WeekCounts[] = Array.from({ length: weeks }, (_, i) => ({
    weekStart: new Date(current - i * WEEK_MS).toISOString(),
    checked: 0,
    malicious: 0,
    suspicious: 0,
    safe: 0,
    unfinished: 0,
    kinds: { phishing: 0, invoice: 0, impersonation: 0 },
    medianSecondsToVerdict: null,
  }));
  // Threat kinds (D07 T04 §18): each flagged case of a week takes at most one kind, from positive evidence on
  // its current run alone, in invoice, impersonation, phishing order. The flags are read in SQL, one row per
  // flagged case, so no evidence detail crosses into the Worker. A flagged case with none of these (a
  // malware-only case) counts in no kind, so the kinds need not sum to the week's flagged total.
  const flaggedStatement = db
    .prepare(
      `SELECT c.id, c.created_at,
           EXISTS (SELECT 1 FROM evidence e WHERE e.case_id = c.id AND e.run_id = COALESCE(c.run_id, c.id)
             AND (e."check" = 'invoice.detected'
               OR (e."check" = 'document.type' AND json_extract(e.detail_json, '$.type') = 'invoice'))) AS inv,
           EXISTS (SELECT 1 FROM evidence e WHERE e.case_id = c.id AND e.run_id = COALESCE(c.run_id, c.id)
             AND ((e."check" = 'domain.lookalike' AND e.severity IN ('medium', 'high'))
               OR (e."check" = 'vision.brand_domain_mismatch' AND json_extract(e.detail_json, '$.confirmed') = 1))) AS imp,
           EXISTS (SELECT 1 FROM evidence e WHERE e.case_id = c.id AND e.run_id = COALESCE(c.run_id, c.id)
             AND e."check" IN ('link.credential_form', 'link.card_form', 'link.lure_button', 'walkthrough.credential_target')) AS ph
         FROM cases c
         WHERE c.org_id = ? AND c.created_at >= ? AND c.status IN ('done', 'partial')
           AND c.verdict IN ('malicious', 'suspicious')`,
    )
    .bind(orgId, from);
  // One batch, one snapshot: the totals and the kinds can never disagree about a case decided mid-read.
  const [rowsResult, flaggedResult] = await db.batch([rowsStatement, flaggedStatement]);
  const rows = (rowsResult?.results ?? []) as Row[];
  const flaggedRows = (flaggedResult?.results ?? []) as {
    id: string;
    created_at: string;
    inv: number;
    imp: number;
    ph: number;
  }[];
  const times: number[][] = out.map(() => []);
  // Weeks are counted in milliseconds from the oldest Monday, never by SQLite's floating julianday, so a case at
  // Monday 00:00:00.000 SAST is that week's.
  const fromMs = Date.parse(from);
  for (const row of rows) {
    const arrived = Date.parse(row.created_at);
    const index = weeks - 1 - Math.floor((arrived - fromMs) / WEEK_MS);
    const week = out[index];
    if (!week) continue;
    week.checked++;
    const decided = (row.status === "done" || row.status === "partial") && row.verdict;
    if (decided && (row.verdict === "malicious" || row.verdict === "suspicious" || row.verdict === "safe"))
      week[row.verdict]++;
    else week.unfinished++;
    const seconds = row.decided_at ? (Date.parse(row.decided_at) - arrived) / 1000 : null;
    if (seconds !== null && seconds >= 0) times[index]?.push(seconds);
  }
  out.forEach((week, i) => {
    const m = median(times[i] ?? []);
    week.medianSecondsToVerdict = m === null ? null : Math.round(m);
  });
  for (const row of flaggedRows) {
    const kind = row.inv === 1 ? "invoice" : row.imp === 1 ? "impersonation" : row.ph === 1 ? "phishing" : null;
    if (!kind) continue;
    const index = weeks - 1 - Math.floor((Date.parse(row.created_at) - fromMs) / WEEK_MS);
    const week = out[index];
    if (week) week.kinds[kind]++;
  }
  return out;
}

export async function weeklyStats(db: D1Database, orgId: string, now = new Date()): Promise<WeeklyStats> {
  const [thisWeek, lastWeek] = await weeklyCounts(db, orgId, now, 2);
  return { thisWeek: thisWeek as WeekCounts, lastWeekChecked: lastWeek?.checked ?? 0 };
}

// The CSV of the last 12 weeks' counts, newest first: counts only, never a subject, sender or file name.
export const CSV_WEEKS = 12;
export const CSV_HEADER = "week_start,checked,malicious,suspicious,safe,unfinished,median_seconds_to_verdict";
export function countsCsv(weeks: WeekCounts[]): string {
  const lines = weeks.map((w) =>
    [
      sastDate(w.weekStart),
      w.checked,
      w.malicious,
      w.suspicious,
      w.safe,
      w.unfinished,
      w.medianSecondsToVerdict ?? "",
    ].join(","),
  );
  return `${[CSV_HEADER, ...lines].join("\r\n")}\r\n`;
}

// The SAST calendar date a week starts on ("2026-10-26"), the reader's own date rather than the UTC instant.
function sastDate(iso: string): string {
  return new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().slice(0, 10);
}
