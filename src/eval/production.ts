// What real use looks like (D08 T02 §4): counts from members' own mail since launch, never content and never shown or
// added to the test set. The synthetic populations are left out: the eval organisation's uploads and the demo
// organisation's seeded cases, and anything before launch. A case counts once, whatever evidence it holds; the feedback
// and evidence counts are scoped to the same eligible cases. No query here names a subject, sender, recipient or body.
import {
  BANK_CHANGE_CHECKS,
  EXCLUDED_ORGANISATIONS,
  INVOICE_CHECK_PREFIXES,
  PRODUCTION_SINCE,
  type ProductionCounts,
} from "./report";

export { BANK_CHANGE_CHECKS, EXCLUDED_ORGANISATIONS, INVOICE_CHECK_PREFIXES, PRODUCTION_SINCE, type ProductionCounts };

// The cases that are real use: a member's own (not a counterparty's), after launch, outside the excluded organisations.
const ELIGIBLE = `c.origin IS NULL AND c.created_at >= ?1 AND c.status IN ('done', 'partial') AND c.org_id NOT IN (SELECT id FROM "organization" WHERE name IN (${EXCLUDED_ORGANISATIONS.map((_, i) => `?${i + 2}`).join(", ")})) AND c.org_id NOT IN (SELECT e.org_id FROM eval_results r JOIN cases e ON e.id = r.case_id)`;
const BINDS = [PRODUCTION_SINCE, ...EXCLUDED_ORGANISATIONS];

export const QUERIES = {
  cases: `SELECT COUNT(*) AS n FROM cases c WHERE ${ELIGIBLE}`,
  flagged: `SELECT COUNT(*) AS n FROM cases c WHERE ${ELIGIBLE} AND c.verdict IN ('suspicious', 'malicious')`,
  invoiceFlags: `SELECT COUNT(DISTINCT c.id) AS n FROM cases c JOIN evidence e ON e.case_id = c.id WHERE ${ELIGIBLE} AND (${INVOICE_CHECK_PREFIXES.map((_, i) => `e."check" LIKE ?${EXCLUDED_ORGANISATIONS.length + 2 + i}`).join(" OR ")})`,
  reportedWrong: `SELECT COUNT(DISTINCT f.case_id) AS n FROM feedback f JOIN cases c ON c.id = f.case_id WHERE ${ELIGIBLE}`,
  // The exact median in the database: the count, then the one or two middle durations by offset, so the answer is over
  // every eligible case and the transfer is two numbers whatever the volume.
  verdicts: `SELECT COUNT(*) AS n FROM cases c JOIN case_verdicts v ON v.case_id = c.id WHERE ${ELIGIBLE}`,
  middle: `SELECT CAST(strftime('%s', v.created_at) AS INTEGER) - CAST(strftime('%s', c.created_at) AS INTEGER) AS s FROM cases c JOIN case_verdicts v ON v.case_id = c.id WHERE ${ELIGIBLE} ORDER BY s LIMIT ?${EXCLUDED_ORGANISATIONS.length + 2} OFFSET ?${EXCLUDED_ORGANISATIONS.length + 3}`,
} as const;

export async function productionCounts(db: D1Database): Promise<ProductionCounts> {
  const count = async (sql: string, binds: unknown[] = BINDS) =>
    (
      await db
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const [cases, flagged, invoiceFlags, reportedWrong, verdicts] = await Promise.all([
    count(QUERIES.cases),
    count(QUERIES.flagged),
    count(QUERIES.invoiceFlags, [...BINDS, ...INVOICE_CHECK_PREFIXES.map((p) => `${p}%`)]),
    count(QUERIES.reportedWrong),
    count(QUERIES.verdicts),
  ]);
  // The middle one (odd count) or two (even count) of the sorted durations, so the median is over every eligible case.
  const middle = verdicts
    ? (
        await db
          .prepare(QUERIES.middle)
          .bind(...BINDS, verdicts % 2 ? 1 : 2, Math.floor((verdicts - 1) / 2))
          .all<{ s: number }>()
      ).results.map((r) => r.s)
    : [];
  return {
    since: PRODUCTION_SINCE,
    cases,
    flagged,
    invoiceFlags,
    bankChanges: BANK_CHANGE_CHECKS.length
      ? await count(
          `SELECT COUNT(DISTINCT c.id) AS n FROM cases c JOIN evidence e ON e.case_id = c.id WHERE ${ELIGIBLE} AND e."check" IN (${BANK_CHANGE_CHECKS.map((_, i) => `?${EXCLUDED_ORGANISATIONS.length + 2 + i}`).join(", ")})`,
          [...BINDS, ...BANK_CHANGE_CHECKS],
        )
      : null,
    reportedWrong,
    medianSeconds: middle.length ? middle.reduce((a, b) => a + b, 0) / middle.length : null,
  };
}
