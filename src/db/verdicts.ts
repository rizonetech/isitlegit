// A case's verdict as the report and the reply show it (D01 T01 §7; migration 0017): the label, a headline, the
// confidence, the reasons and actions, and the path that made it. Written once by the Workflow's `store` step: the same
// view again (a retried or replayed step) answers the stored row, and a different one is a `conflict` that changes
// nothing, so a case never shows two verdicts. Every query's failure is a typed `database` refusal.
import { z } from "zod";
import { ABLATE_FLAGS, type AblateFlag } from "../pipeline/ablate";
import { Verdict } from "./cases";

// A citation marker in running text would let a reader mistake prose for a link to evidence: the evidence ids a reason
// cites are in `evidenceIds`, never in its words.
const noMarker = (text: string) => !/\[E\d+\]/.test(text);
const EVIDENCE_ID = /^E[1-9][0-9]*$/;
// A reason as the report draws it (D07 T03 §2): its words and the evidence it cites, the pill from the first.
export const Reason = z.strictObject({
  text: z.string().max(1000).refine(noMarker, "no [E<n>] marker in a reason's words"),
  evidenceIds: z.array(z.string().regex(EVIDENCE_ID)).min(1).max(10),
});
export type Reason = z.infer<typeof Reason>;
// The floor outcome (D04 T01 §11): the model's verdict, the floor that replaced it, and the evidence that set
// it, exactly as `FloorApplied` in src/agent/floor.ts; null when the floor did not raise the verdict.
export const FloorApplied = z.strictObject({
  from: Verdict,
  to: Verdict,
  evidenceIds: z.array(z.string().regex(EVIDENCE_ID)).min(1).max(10),
  // The floor rule revision that produced the record (D04 T01 §13); absent on records stored before it.
  revision: z.string().min(1).max(40).optional(),
});
export type FloorApplied = z.infer<typeof FloorApplied>;
export const VerdictView = z.object({
  verdict: Verdict,
  headline: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
  reasons: z.array(Reason).max(10),
  actions: z.array(z.string().max(1000)).max(10),
  // One sentence for the reader on what the verdict means (D04 T01 §2); null when none was written.
  meaning: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine(noMarker, "no [E<n>] marker in the meaning")
    .nullable()
    .default(null),
  source: z.enum(["stub", "rules", "agent"]),
  floorApplied: FloorApplied.nullable().default(null),
  // The ablation the verdict was produced under (D04 T01 §14): one of eval's four flags, or absent.
  ablated: z.enum(ABLATE_FLAGS).nullable().optional(),
});
export type VerdictView = z.infer<typeof VerdictView>;
// A stored verdict: a row from before reasons cited evidence reads its plain strings as reasons that cite nothing.
export type StoredVerdict = Omit<VerdictView, "reasons"> & {
  reasons: { text: string; evidenceIds: string[] }[];
  caseId: string;
  createdAt: string;
  // Whether the floor was evaluated for this verdict (D04 T01 §13): `raised` (a floor record is stored),
  // `measured` (stored since the floor outcome was recorded, with no raise), or `unrecorded` (stored
  // before migration 0081, so nothing about the floor was kept). Always set on a read row.
  floorCoverage?: "raised" | "measured" | "unrecorded" | undefined;
};

export type VerdictError = { code: "invalid" | "conflict" | "database"; message: string };
export type VerdictResult = { ok: true; value: StoredVerdict } | { ok: false; error: VerdictError };

type Row = {
  case_id: string;
  verdict: z.infer<typeof Verdict>;
  headline: string;
  confidence: number;
  reasons: string;
  actions: string;
  meaning: string | null;
  source: VerdictView["source"];
  floor_applied: string | null;
  ablated: string | null;
  created_at: string;
};
// The stored floor outcome (D04 T01 §11 and §13): a JSON record is a raise; the JSON null written since
// §13 is a measured no-raise; SQL null is a row stored before the outcome was kept at all.
const floorOf = (
  stored: string | null,
): { floorApplied: FloorApplied | null; floorCoverage: StoredVerdict["floorCoverage"] } =>
  stored === null
    ? { floorApplied: null, floorCoverage: "unrecorded" }
    : stored === "null"
      ? { floorApplied: null, floorCoverage: "measured" }
      : { floorApplied: JSON.parse(stored) as FloorApplied, floorCoverage: "raised" };

const toVerdict = (row: Row): StoredVerdict => ({
  caseId: row.case_id,
  verdict: row.verdict,
  headline: row.headline,
  confidence: row.confidence,
  reasons: (JSON.parse(row.reasons) as (string | { text: string; evidenceIds: string[] })[]).map((reason) =>
    typeof reason === "string" ? { text: reason, evidenceIds: [] } : reason,
  ),
  actions: JSON.parse(row.actions),
  meaning: row.meaning,
  source: row.source,
  ...floorOf(row.floor_applied),
  // A legacy row's SQL null, and anything outside eval's four flags, reads as absent.
  ablated: (ABLATE_FLAGS as readonly string[]).includes(row.ablated ?? "") ? (row.ablated as AblateFlag) : null,
  createdAt: row.created_at,
});
const fail = (code: VerdictError["code"], message: string): { ok: false; error: VerdictError } => ({
  ok: false,
  error: { code, message },
});
const same = (a: Omit<StoredVerdict, "caseId" | "createdAt">, b: VerdictView) =>
  a.verdict === b.verdict &&
  a.headline === b.headline &&
  a.confidence === b.confidence &&
  a.meaning === b.meaning &&
  a.source === b.source &&
  a.ablated === (b.ablated ?? null) &&
  JSON.stringify(a.floorApplied) === JSON.stringify(b.floorApplied) &&
  JSON.stringify(a.reasons) === JSON.stringify(b.reasons) &&
  JSON.stringify(a.actions) === JSON.stringify(b.actions);

// A reason cites evidence the case has: every id it names is in the case's current run. A reason that cites nothing, or
// a stray id, would point a reader at nothing.
async function citesUnknown(db: D1Database, caseId: string, v: VerdictView): Promise<string | null> {
  const ids = [...new Set(v.reasons.flatMap((reason) => reason.evidenceIds))];
  if (!ids.length) return null;
  const marks = ids.map(() => "?").join(", ");
  const have = await db
    .prepare(
      `SELECT id FROM evidence WHERE case_id = ? AND run_id = (SELECT COALESCE(run_id, id) FROM cases WHERE id = ?) AND id IN (${marks})`,
    )
    .bind(caseId, caseId, ...ids)
    .all<{ id: string }>();
  const found = new Set(have.results.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  return missing.length ? `a reason cites evidence the case does not have: ${missing.slice(0, 5).join(", ")}` : null;
}

// A newly stored raise must name its floor rule revision (D04 T01 §13); records stored before revisions
// were named are read, never written, so the schema itself keeps the field optional.
const unnamedRevision = (v: VerdictView): VerdictResult | null =>
  v.floorApplied && !v.floorApplied.revision
    ? fail("invalid", "a floor record names no rule revision")
    : null;

export async function saveVerdict(
  db: D1Database,
  caseId: string,
  view: z.input<typeof VerdictView>,
): Promise<VerdictResult> {
  const parsed = VerdictView.safeParse(view);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const unnamed = unnamedRevision(parsed.data);
  if (unnamed) return unnamed;
  if (!caseId) return fail("invalid", "a verdict needs its case id");
  const v = parsed.data;
  try {
    const unknown = await citesUnknown(db, caseId, v);
    if (unknown) return fail("invalid", unknown);
    await db
      .prepare(
        "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, meaning, source, floor_applied, ablated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (case_id) DO NOTHING",
      )
      .bind(
        caseId,
        v.verdict,
        v.headline,
        v.confidence,
        JSON.stringify(v.reasons),
        JSON.stringify(v.actions),
        v.meaning,
        v.source,
        // A no-raise verdict stores the JSON null, so its floor reads as measured, never unrecorded (§13).
        JSON.stringify(v.floorApplied ?? null),
        v.ablated ?? null,
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
  const unnamed = unnamedRevision(parsed.data);
  if (unnamed) return unnamed;
  if (!caseId || !orgId) return fail("invalid", "a verdict needs its case and organisation");
  const v = parsed.data;
  const now = new Date().toISOString();
  const running = "SELECT 1 FROM cases WHERE id = ? AND org_id = ? AND status = 'running'";
  try {
    const unknown = await citesUnknown(db, caseId, v);
    if (unknown) return fail("invalid", unknown);
    await db.batch([
      db
        .prepare(
          `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, meaning, source, floor_applied, ablated, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${running}) ON CONFLICT (case_id) DO NOTHING`,
        )
        .bind(
          caseId,
          v.verdict,
          v.headline,
          v.confidence,
          JSON.stringify(v.reasons),
          JSON.stringify(v.actions),
          v.meaning,
          v.source,
          JSON.stringify(v.floorApplied ?? null),
          v.ablated ?? null,
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
