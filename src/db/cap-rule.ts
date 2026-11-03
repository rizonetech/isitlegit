// The daily case cap's day and counting rule (D01 T03 §12, D07 T02 §4), pure so every reader counts as admission does:
// the admitting statement (./cases.ts), the usage line and the evaluation runner's allowance check (eval/run.ts).
// SAST is UTC+2 with no daylight saving.
const SAST_OFFSET_MS = 2 * 60 * 60_000;
export const sastDayStart = (now: Date) => {
  const local = now.getTime() + SAST_OFFSET_MS;
  return new Date(local - (local % 86_400_000) - SAST_OFFSET_MS).toISOString();
};

// Which of today's cases use one of the organisation's daily cases (D01 T03 §12): every one except a case whose
// admission failed before its file was stored (its `admit` step failed, RawMissing), which never ran, so the same
// delivery's replacement is admitted on the day's last slot. A condition on `cases` for a query to AND in; the case
// list's "used" count reads it too.
export const COUNTS_TOWARD_CAP =
  "NOT EXISTS (SELECT 1 FROM case_events e WHERE e.case_id = cases.id AND e.step = 'admit' AND e.status = 'failed' AND e.error = 'RawMissing')";

// The member cases an organisation has used since `day` (the SAST day start): counterparty cases never use a member's
// cap (they count against their own two limits). `org` and `day` are the caller's SQL for the two values.
export const MEMBER_CASES_TODAY = (org = "?", day = "?") =>
  `(SELECT COUNT(*) FROM cases WHERE org_id = ${org} AND origin IS NULL AND COALESCE(uploaded_by, '') != 'monitor' AND created_at >= ${day} AND ${COUNTS_TOWARD_CAP})`;

// Monitor investigations have their own allowance (D05 T04 §12): the system uploader's cases,
// bounded per organisation per SAST day at the daily run's own capture bound (50, src/monitor/run.ts),
// so a monitor investigation never uses a member's checking allowance and member traffic never
// starves the monitor. Failed admissions release their slot, as the member cap's do.
export const MONITOR_CASES_PER_DAY = 50;
export const MONITOR_CASES_TODAY = (org = "?", day = "?") =>
  `(SELECT COUNT(*) FROM cases WHERE org_id = ${org} AND uploaded_by = 'monitor' AND created_at >= ${day} AND ${COUNTS_TOWARD_CAP})`;
