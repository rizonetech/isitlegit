// Evidence (D02 T01 §1; spec 4.3, AGENTS.md "Evidence or nothing"): every fact IsItLegit states rests on one of these
// items, made by a check and stored on its case as `E1`, `E2` in creation order, so the verdict can cite them and a person
// can read them. The id and the `seq` column are the same number (migration 0002): a case's evidence is read by `seq`,
// never by the text id, which sorts E10 before E2.
import { z } from "zod";
// The pipeline's registry through `./index`, so its checks are registered whenever evidence is checked against it.
import { checks } from "./index";
import { CHECK_NAME, type CheckRegistry, SYSTEM_CHECKS } from "./registry";

export { CHECK_NAME, SYSTEM_CHECKS };
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const MAX_SUMMARY_CHARACTERS = 200;

// An item as stored: its `check` was a registered producer's when it was written, so a read checks the name's form only
// (a check renamed later still reads back).
export const StoredEvidence = z.strictObject({
  id: z.string().regex(/^E[1-9][0-9]*$/),
  check: z.string().regex(CHECK_NAME),
  severity: z.enum(SEVERITIES),
  // Plain words, one line: no control characters or markup, at most 200 characters (not UTF-16 units).
  summary: z
    .string()
    .min(1)
    .refine((text) => Array.from(text).length <= MAX_SUMMARY_CHARACTERS, "at most 200 characters")
    .refine((text) => !Array.from(text).some(unplain), "plain words on one line"),
  detail: z.record(z.string(), z.json()),
  // R2 keys of the artefacts the item rests on.
  artefacts: z.array(z.string().min(1)),
});
export type Evidence = z.infer<typeof StoredEvidence>;

// An item as a check makes it: its `check` is a producer in the registry, or one of the runner's own names.
export function evidenceIn(registry: CheckRegistry) {
  return StoredEvidence.extend({
    check: StoredEvidence.shape.check.refine(
      (name) => (SYSTEM_CHECKS as readonly string[]).includes(name) || registry.names().includes(name),
      "names no registered check",
    ),
  });
}
export const Evidence = evidenceIn(checks);

// A control character, a format character (zero-width and bidirectional controls), a line or paragraph separator, or
// markup: a summary that copies hostile text can neither break its line nor reorder what the report shows (final review).
const UNPLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
function unplain(character: string): boolean {
  return UNPLAIN.test(character);
}
// What a check returns: the item before the store numbers it.
export type EvidenceDraft = Omit<Evidence, "id">;

export class EvidenceRefused extends TypeError {
  override name = "EvidenceRefused";
}

// Numbers the list and checks every item, all before anything is written: a list with one bad item stores nothing.
export function numbered(items: EvidenceDraft[], registry: CheckRegistry = checks): Evidence[] {
  const schema = registry === checks ? Evidence : evidenceIn(registry);
  return items.map((item, i) => {
    const parsed = schema.safeParse({ ...item, id: `E${i + 1}` });
    if (!parsed.success)
      throw new EvidenceRefused(`evidence item ${i + 1} is malformed: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}

// Replaces the case's evidence with this list, in one batch: its delete and its inserts commit together, so a retried
// step stores the same list once and a failure leaves the previous list whole.
export async function saveEvidence(
  db: D1Database,
  caseId: string,
  items: EvidenceDraft[],
  registry: CheckRegistry = checks,
  now: () => Date = () => new Date(),
): Promise<Evidence[]> {
  const list = numbered(items, registry);
  const at = now().toISOString();
  await db.batch([
    db.prepare("DELETE FROM evidence WHERE case_id = ?").bind(caseId),
    ...list.map((e, i) =>
      db
        .prepare(
          `INSERT INTO evidence (case_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          caseId,
          e.id,
          i + 1,
          e.check,
          e.severity,
          e.summary,
          JSON.stringify(e.detail),
          JSON.stringify(e.artefacts),
          at,
        ),
    ),
  ]);
  return list;
}

type EvidenceRow = {
  id: string;
  check: string;
  severity: string;
  summary: string;
  detail_json: string;
  artefact_keys_json: string;
};

// The case's evidence in its order.
export async function readEvidence(db: D1Database, caseId: string): Promise<Evidence[]> {
  const rows = await db
    .prepare(
      `SELECT id, "check", severity, summary, detail_json, artefact_keys_json FROM evidence WHERE case_id = ? ORDER BY seq`,
    )
    .bind(caseId)
    .all<EvidenceRow>();
  return rows.results.map((row) =>
    StoredEvidence.parse({
      id: row.id,
      check: row.check,
      severity: row.severity,
      summary: row.summary,
      detail: JSON.parse(row.detail_json),
      artefacts: JSON.parse(row.artefact_keys_json),
    }),
  );
}
