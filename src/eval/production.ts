// What real use looks like (D08 T02 §4): counts from members' own mail since launch, never content and never shown or
// added to the test set. The synthetic populations are left out: the eval organisation's uploads and the demo
// organisation's seeded cases, and anything before launch. A case counts once, whatever evidence it holds; the feedback
// and evidence counts are scoped to the same eligible cases. No query here names a subject, sender, recipient or body.
export const PRODUCTION_SINCE = "2026-10-26T22:00:00.000Z"; // 27 October 2026, 00:00 SAST
// The organisations that are not real use: the eval organisation (D08 T02 §7) and the demo organisation (D07 T07).
export const EXCLUDED_ORGANISATIONS = ["IsItLegit Eval", "Fynbos Freight"] as const;
// Evidence of an invoice or a payment document that carries a finding (the PDF forensics' checks, D06 T02).
export const INVOICE_CHECK_PREFIXES = ["document.forensics."] as const;
// The checks that name a changed bank account: none is registered yet, so the count says "not counted" rather than 0.
export const BANK_CHANGE_CHECKS: readonly string[] = [];

export type ProductionCounts = {
  since: string;
  cases: number;
  flagged: number;
  invoiceFlags: number;
  bankChanges: number | null;
  reportedWrong: number;
  medianSeconds: number | null;
};

// The cases that are real use: a member's own (not a counterparty's), after launch, outside the excluded organisations.
const ELIGIBLE = `c.origin IS NULL AND c.created_at >= ?1 AND c.status IN ('done', 'partial') AND c.org_id NOT IN (SELECT id FROM "organization" WHERE name IN (${EXCLUDED_ORGANISATIONS.map((_, i) => `?${i + 2}`).join(", ")}))`;
const BINDS = [PRODUCTION_SINCE, ...EXCLUDED_ORGANISATIONS];

export const QUERIES = {
  cases: `SELECT COUNT(*) AS n FROM cases c WHERE ${ELIGIBLE}`,
  flagged: `SELECT COUNT(*) AS n FROM cases c WHERE ${ELIGIBLE} AND c.verdict IN ('suspicious', 'malicious')`,
  invoiceFlags: `SELECT COUNT(DISTINCT c.id) AS n FROM cases c JOIN evidence e ON e.case_id = c.id WHERE ${ELIGIBLE} AND (${INVOICE_CHECK_PREFIXES.map((_, i) => `e."check" LIKE ?${EXCLUDED_ORGANISATIONS.length + 2 + i}`).join(" OR ")})`,
  reportedWrong: `SELECT COUNT(DISTINCT f.case_id) AS n FROM feedback f JOIN cases c ON c.id = f.case_id WHERE ${ELIGIBLE}`,
  seconds: `SELECT CAST(strftime('%s', v.created_at) AS INTEGER) - CAST(strftime('%s', c.created_at) AS INTEGER) AS s FROM cases c JOIN case_verdicts v ON v.case_id = c.id WHERE ${ELIGIBLE} ORDER BY s LIMIT 100000`,
} as const;

const median = (v: number[]) => {
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
};

export async function productionCounts(db: D1Database): Promise<ProductionCounts> {
  const count = async (sql: string, binds: unknown[] = BINDS) =>
    (
      await db
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const [cases, flagged, invoiceFlags, reportedWrong, seconds] = await Promise.all([
    count(QUERIES.cases),
    count(QUERIES.flagged),
    count(QUERIES.invoiceFlags, [...BINDS, ...INVOICE_CHECK_PREFIXES.map((p) => `${p}%`)]),
    count(QUERIES.reportedWrong),
    db
      .prepare(QUERIES.seconds)
      .bind(...BINDS)
      .all<{ s: number }>(),
  ]);
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
    medianSeconds: median(seconds.results.map((r) => r.s)),
  };
}
