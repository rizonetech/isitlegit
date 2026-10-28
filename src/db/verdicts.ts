// A case's verdict as the report and the reply show it (D01 T01 §7; migration 0017): the label, a headline, the
// confidence, the reasons and actions, and the path that made it. Written once by the Workflow's `store` step: the same
// view again (a retried or replayed step) answers the stored row, and a different one is a `conflict` that changes
// nothing, so a case never shows two verdicts. Every query's failure is a typed `database` refusal.
import { z } from "zod";
import { Verdict } from "./cases";

export const VerdictView = z.object({
  verdict: Verdict,
  headline: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(1000)).max(10),
  actions: z.array(z.string().max(1000)).max(10),
  source: z.enum(["stub", "rules", "agent"]),
});
export type VerdictView = z.infer<typeof VerdictView>;
export type StoredVerdict = VerdictView & { caseId: string; createdAt: string };

export type VerdictError = { code: "invalid" | "conflict" | "database"; message: string };
export type VerdictResult = { ok: true; value: StoredVerdict } | { ok: false; error: VerdictError };

type Row = {
  case_id: string;
  verdict: z.infer<typeof Verdict>;
  headline: string;
  confidence: number;
  reasons: string;
  actions: string;
  source: VerdictView["source"];
  created_at: string;
};
const toVerdict = (row: Row): StoredVerdict => ({
  caseId: row.case_id,
  verdict: row.verdict,
  headline: row.headline,
  confidence: row.confidence,
  reasons: JSON.parse(row.reasons),
  actions: JSON.parse(row.actions),
  source: row.source,
  createdAt: row.created_at,
});
const fail = (code: VerdictError["code"], message: string): { ok: false; error: VerdictError } => ({
  ok: false,
  error: { code, message },
});
const same = (a: VerdictView, b: VerdictView) =>
  a.verdict === b.verdict &&
  a.headline === b.headline &&
  a.confidence === b.confidence &&
  a.source === b.source &&
  JSON.stringify(a.reasons) === JSON.stringify(b.reasons) &&
  JSON.stringify(a.actions) === JSON.stringify(b.actions);

export async function saveVerdict(
  db: D1Database,
  caseId: string,
  view: z.input<typeof VerdictView>,
): Promise<VerdictResult> {
  const parsed = VerdictView.safeParse(view);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  if (!caseId) return fail("invalid", "a verdict needs its case id");
  const v = parsed.data;
  try {
    await db
      .prepare(
        "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (case_id) DO NOTHING",
      )
      .bind(
        caseId,
        v.verdict,
        v.headline,
        v.confidence,
        JSON.stringify(v.reasons),
        JSON.stringify(v.actions),
        v.source,
        new Date().toISOString(),
      )
      .run();
    const row = await db.prepare("SELECT * FROM case_verdicts WHERE case_id = ?").bind(caseId).first<Row>();
    if (!row) return fail("database", `the verdict for ${caseId} was not stored`);
    const stored = toVerdict(row);
    return same(stored, v)
      ? { ok: true, value: stored }
      : fail("conflict", `case ${caseId} already has another verdict`);
  } catch (error) {
    return fail("database", (error as Error).message);
  }
}

export async function getVerdict(db: D1Database, caseId: string): Promise<VerdictResult | null> {
  try {
    const row = await db.prepare("SELECT * FROM case_verdicts WHERE case_id = ?").bind(caseId).first<Row>();
    return row ? { ok: true, value: toVerdict(row) } : null;
  } catch (error) {
    return fail("database", (error as Error).message);
  }
}

// The Workflow's `store` step: the verdict row and the case's verdict label in one D1 batch, both written only while
// the case is `running`, so the two never disagree (the final review: written apart, a failure between them left a
// verdict row beside a case with none). Read back after: the same view and label again (a retried or replayed step,
// the case perhaps finished since) answer the stored row; another view is a `conflict`; a case not running and without
// this verdict is a `transition`.
export async function storeVerdict(
  db: D1Database,
  orgId: string,
  caseId: string,
  view: z.input<typeof VerdictView>,
): Promise<VerdictResult | { ok: false; error: { code: "transition"; message: string } }> {
  const parsed = VerdictView.safeParse(view);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  if (!caseId || !orgId) return fail("invalid", "a verdict needs its case and organisation");
  const v = parsed.data;
  const now = new Date().toISOString();
  const running = "SELECT 1 FROM cases WHERE id = ? AND org_id = ? AND status = 'running'";
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${running}) ON CONFLICT (case_id) DO NOTHING`,
        )
        .bind(
          caseId,
          v.verdict,
          v.headline,
          v.confidence,
          JSON.stringify(v.reasons),
          JSON.stringify(v.actions),
          v.source,
          now,
          caseId,
          orgId,
        ),
      db
        .prepare(`UPDATE cases SET verdict = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'running'`)
        .bind(v.verdict, now, caseId, orgId),
    ]);
    const row = await db.prepare("SELECT * FROM case_verdicts WHERE case_id = ?").bind(caseId).first<Row>();
    const label = await db
      .prepare("SELECT verdict FROM cases WHERE id = ? AND org_id = ?")
      .bind(caseId, orgId)
      .first<{ verdict: string | null }>();
    if (row && !same(toVerdict(row), v)) return fail("conflict", `case ${caseId} already has another verdict`);
    if (!row || label?.verdict !== v.verdict)
      return { ok: false, error: { code: "transition", message: `case ${caseId} is not running with this verdict` } };
    return { ok: true, value: toVerdict(row) };
  } catch (error) {
    return fail("database", (error as Error).message);
  }
}
