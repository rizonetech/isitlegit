// Evidence (D02 T01 §1; spec 4.3, AGENTS.md "Evidence or nothing"): every fact IsItLegit states rests on one of these
// items, made by a check and stored on its case as `E1`, `E2` in creation order, so the verdict can cite them and a person
// can read them. The id and the `seq` column are the same number (migration 0002): a case's evidence is read by `seq`,
// never by the text id, which sorts E10 before E2.

import { z } from "zod";
// The pipeline's registry through `./index`, so its checks are registered whenever evidence is checked against it.
import { checks } from "./index";
import {
  CHECK_NAME,
  type CheckRegistry,
  familyOf,
  LATER_PRODUCERS,
  type LaterProducer,
  SYSTEM_CHECKS,
} from "./registry";
import type { CheckOutcome, DetectionData } from "./runner";

export { CHECK_NAME, LATER_PRODUCERS, SYSTEM_CHECKS };
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const MAX_SUMMARY_CHARACTERS = 200;
// An item's detail as stored, at most 64 KiB of JSON: far under D1's 2,000,000-byte row and statement limits
// (https://developers.cloudflare.com/d1/platform/limits/), so a check's oversized item is refused inside its own failure
// boundary and never makes the whole list unstorable (D02 T01 §2 round 1).
export const MAX_DETAIL_BYTES = 64 * 1024;
export const MAX_ARTEFACTS = 100;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

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
  detail: z
    .record(z.string(), z.json())
    .refine((detail) => utf8Bytes(JSON.stringify(detail)) <= MAX_DETAIL_BYTES, "a detail of at most 64 KiB"),
  // R2 keys of the artefacts the item rests on.
  artefacts: z.array(z.string().min(1).max(1024)).max(MAX_ARTEFACTS),
});
export type Evidence = z.infer<typeof StoredEvidence>;

// An item as a check makes it: its `check` is a producer in the registry, or one of the runner's own names.
export function evidenceIn(registry: CheckRegistry) {
  return StoredEvidence.extend({
    check: StoredEvidence.shape.check.refine(
      (name) =>
        (SYSTEM_CHECKS as readonly string[]).includes(name) ||
        registry.names().includes(name) ||
        // A later step's item (D02 T01 §5): a name in its family, `walkthrough.chain`.
        (name.includes(".") && (LATER_PRODUCERS as readonly string[]).includes(familyOf(name))),
      "names no registered check",
    ),
  });
}
export const Evidence = evidenceIn(checks);

// A control character, a format character (zero-width and bidirectional controls), a line or paragraph separator, or
// markup: a summary that copies hostile text can neither break its line nor reorder what the report shows (final review).
const UNPLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
export function unplain(character: string): boolean {
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

// A case's current run (D01 T01 §19), as `retryCase` names runs: a retry's `cases.run_id`, else the case id, the first
// run's Workflow instance id. Read inside each statement, so a row is written and read under the run the case is on.
const CURRENT_RUN_OF = "(SELECT COALESCE(run_id, id) FROM cases WHERE id = ?)";
const CURRENT_RUN_ROW = "(SELECT COALESCE(run_id, id) AS run FROM cases WHERE id = ?)";

// Replaces the current run's evidence with this list, in one batch: its delete and its inserts commit together, so a
// retried step stores the same list once and a failure leaves the previous list whole. An earlier run's rows are kept,
// as that attempt's (D01 T01 §19).
// Rows to an insert: D1 binds at most 100 parameters to a statement (https://developers.cloudflare.com/d1/platform/limits/),
// ten a row, so nine rows a statement keep a long list to a few statements.
const ROWS_PER_INSERT = 9;
// Thirteen parameters a row since §8's examined set: seven rows a statement stay under D1's hundred.
export const OUTCOMES_PER_INSERT = 7;

export async function saveEvidence(
  db: D1Database,
  caseId: string,
  items: EvidenceDraft[],
  registry: CheckRegistry = checks,
  now: () => Date = () => new Date(),
  // Each check's outcome (D02 T01 §3), replacing the case's in the same batch; without it the outcomes stay as they are.
  outcomes?: readonly CheckOutcome[],
  // The Worker version that ran them (D02 T01 §4, `CF_VERSION_METADATA.id`), stored on each outcome; null when unknown.
  revision: string | null = null,
  // The data they judged by (D02 T01 §6, the brand table's revision and source), stored on each outcome; null when unknown.
  data: DetectionData | null = null,
  // Writes that must commit with this evidence or not at all (D02 T06 §9's reputation results), in this batch.
  extraWrites: readonly D1PreparedStatement[] = [],
): Promise<Evidence[]> {
  const list = numbered(items, registry);
  const at = now().toISOString();
  const inserts: D1PreparedStatement[] = [];
  for (let start = 0; start < list.length; start += ROWS_PER_INSERT) {
    const rows = list.slice(start, start + ROWS_PER_INSERT);
    inserts.push(
      db
        .prepare(
          `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer)
           VALUES ${rows.map(() => `(?, ${CURRENT_RUN_OF}, ?, ?, ?, ?, ?, ?, ?, ?, 'checks')`).join(", ")}`,
        )
        .bind(
          ...rows.flatMap((e, i) => [
            caseId,
            caseId,
            e.id,
            start + i + 1,
            e.check,
            e.severity,
            e.summary,
            JSON.stringify(e.detail),
            JSON.stringify(e.artefacts),
            at,
          ]),
        ),
    );
  }
  const outcomeWrites: D1PreparedStatement[] = [];
  if (outcomes) {
    outcomeWrites.push(
      db.prepare(`DELETE FROM check_outcomes WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF}`).bind(caseId, caseId),
    );
    for (let start = 0; start < outcomes.length; start += OUTCOMES_PER_INSERT) {
      const rows = outcomes.slice(start, start + OUTCOMES_PER_INSERT);
      outcomeWrites.push(
        db
          .prepare(
            `INSERT INTO check_outcomes (case_id, run_id, check_name, seq, outcome, reason, findings, revision, summary, data_revision, data_id, data_source, examined)
             VALUES ${rows.map(() => `(?, ${CURRENT_RUN_OF}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).join(", ")}`,
          )
          .bind(
            ...rows.flatMap((o, i) => [
              caseId,
              caseId,
              o.check,
              start + i + 1,
              o.outcome,
              o.reason,
              o.findings,
              revision,
              o.summary ?? null,
              data?.revision ?? null,
              data?.id ?? null,
              data?.source ?? null,
              o.examined ? JSON.stringify(o.examined) : null,
            ]),
          ),
      );
    }
  }
  // Only the checks' own rows are replaced (D02 T01 §5): a later step's items in this run (written only if the checks
  // write again in the same run) are moved after the new list in their order, never deleted. They are lifted clear of
  // the checks' numbers first (relative to the checks' last `seq`, read from rows this statement does not change), then
  // set down after the new list, each row on its own, so no step meets `UNIQUE (case_id, run_id, seq)`.
  const later = `case_id = ? AND run_id = ${CURRENT_RUN_OF} AND producer IS NOT NULL AND producer <> 'checks'`;
  await db.batch([
    db
      .prepare(
        `UPDATE evidence SET seq = ${LIFT} + seq - (SELECT COALESCE(MAX(c.seq), 0) FROM evidence c WHERE c.case_id = evidence.case_id
           AND c.run_id = evidence.run_id AND (c.producer IS NULL OR c.producer = 'checks')),
         id = 'E' || (${LIFT} + seq - (SELECT COALESCE(MAX(c.seq), 0) FROM evidence c WHERE c.case_id = evidence.case_id
           AND c.run_id = evidence.run_id AND (c.producer IS NULL OR c.producer = 'checks')))
         WHERE ${later}`,
      )
      .bind(caseId, caseId),
    db
      .prepare(
        `DELETE FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF} AND (producer IS NULL OR producer = 'checks')`,
      )
      .bind(caseId, caseId),
    ...inserts,
    db
      .prepare(
        // The count is cast: D1 may bind a JavaScript number as a real, and `'E' || 16.0` is not `E16`.
        `UPDATE evidence SET seq = CAST(? AS INTEGER) + seq - ${LIFT}, id = 'E' || (CAST(? AS INTEGER) + seq - ${LIFT}) WHERE ${later} AND seq > ${LIFT}`,
      )
      .bind(list.length, list.length, caseId, caseId),
    ...outcomeWrites,
    ...extraWrites,
  ]);
  return list;
}

// Where a later step's rows wait while the checks' list is rewritten: past any real number (a run holds at most
// MAX_CHECKS times MAX_ITEMS_PER_CHECK checks' items and a bounded few from each later step).
const LIFT = 1_000_000;

// Adds a later step's items to the case's current run (D02 T01 §5), after every other item of the run, replacing only
// this producer's earlier items there (a retried step stores its list once; an empty list removes them). Every item is
// checked first: an unknown producer, an item outside the producer's family or a malformed item is `EvidenceRefused`
// and nothing is written. One batch: the delete and the inserts commit together, so a failure leaves the run as it was.
export type VerificationPublication = { orgId: string; runId: string; state: "requested" | "unavailable" };

export async function addEvidence(
  db: D1Database,
  caseId: string,
  producer: LaterProducer,
  items: EvidenceDraft[],
  now: () => Date = () => new Date(),
  fence?: () => boolean,
  fenceAt?: number,
  publication?: VerificationPublication,
): Promise<Evidence[]> {
  if (!(LATER_PRODUCERS as readonly string[]).includes(producer))
    throw new EvidenceRefused(
      `${String(producer).slice(0, 40)} is not a later producer (${LATER_PRODUCERS.join(", ")})`,
    );
  const list = numbered(items);
  for (const [i, item] of list.entries())
    if (familyOf(item.check) !== producer || !item.check.includes("."))
      throw new EvidenceRefused(`evidence item ${i + 1} is not in ${producer}'s family: ${item.check}`);
  if (
    publication &&
    (producer !== "verification" ||
      !publication.orgId ||
      !publication.runId ||
      !["requested", "unavailable"].includes(publication.state) ||
      list.length !== 1 ||
      list[0]?.check !== (publication.state === "requested" ? "verification.requested" : "verification.not_requested"))
  )
    throw new EvidenceRefused("invalid verification publication context");
  // Every statement uses the same captured owner/run. No awaited preflight can protect a write
  // against a rerun, ownership transfer or reply that reaches D1 first.
  const publicationSql = publication
    ? `EXISTS (SELECT 1 FROM cases c WHERE c.id = ? AND c.org_id = ? AND COALESCE(c.run_id,c.id) = ?)
    AND NOT EXISTS (SELECT 1 FROM verifications v WHERE v.case_id = ? AND v.answer IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.case_id = ? AND e.run_id = ? AND e."check" = 'verification.answered')
    AND ${
      publication.state === "requested"
        ? "EXISTS (SELECT 1 FROM verifications v WHERE v.case_id = ? AND v.org_id = ? AND v.source_run = ? AND v.sent_at IS NOT NULL)"
        : "NOT EXISTS (SELECT 1 FROM verifications v WHERE v.case_id = ? AND v.org_id = ? AND v.source_run = ? AND v.sent_at IS NOT NULL)"
    }`
    : "";
  const publicationBind = publication
    ? [
        caseId,
        publication.orgId,
        publication.runId,
        caseId,
        caseId,
        publication.runId,
        caseId,
        publication.orgId,
        publication.runId,
      ]
    : [];
  const at = now().toISOString();
  // The positions this producer already holds: a rewrite that carries its earlier items back (the agent's tools,
  // a walk statement beside its findings) keeps their numbers, so an Evidence ID already issued never moves when
  // another producer wrote after them. New items take the run's next numbers after every row already there.
  const held = (
    await db
      .prepare(
        `SELECT seq FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF} AND producer = ? ORDER BY seq`,
      )
      .bind(caseId, caseId, producer)
      .all<{ seq: number }>()
  ).results.map((r) => r.seq);
  // The caller's fence is re-read here, after the awaited sequence read and immediately before the
  // batch: a caller that expired while the store was answering (a step whose timeout statement is
  // being written) gets no write over that statement, and the empty result says so.
  if (fence?.()) return [];
  // The same deadline inside the batch's own SQL, evaluated as each statement executes: a batch
  // that only reaches the database after it (delayed in flight while the caller's timeout statement
  // committed) deletes and inserts nothing.
  const nowMs = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const conditions = [fenceAt === undefined ? "" : `${nowMs} < ?`, publicationSql].filter(Boolean).join(" AND ");
  const onTime = conditions ? ` WHERE ${conditions}` : "";
  const stillOnTime = conditions ? ` AND ${conditions}` : "";
  const deadlineBind = [...(fenceAt === undefined ? [] : [fenceAt]), ...publicationBind];
  const inserts = list.map((e, i) => {
    const seq = held[i];
    if (seq !== undefined)
      return db
        .prepare(
          `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer)
           SELECT ?, r.run, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM ${CURRENT_RUN_ROW} r${onTime}`,
        )
        .bind(
          caseId,
          `E${seq}`,
          seq,
          e.check,
          e.severity,
          e.summary,
          JSON.stringify(e.detail),
          JSON.stringify(e.artefacts),
          at,
          producer,
          caseId,
          ...deadlineBind,
        );
    return db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer)
         SELECT ?, r.run, 'E' || (n.top + 1), n.top + 1, ?, ?, ?, ?, ?, ?, ?
         FROM ${CURRENT_RUN_ROW} r, (SELECT COALESCE(MAX(seq), 0) AS top FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF}) n${onTime}`,
      )
      .bind(
        caseId,
        e.check,
        e.severity,
        e.summary,
        JSON.stringify(e.detail),
        JSON.stringify(e.artefacts),
        at,
        producer,
        caseId,
        caseId,
        caseId,
        ...deadlineBind,
      );
  });
  const published = await db.batch([
    db
      .prepare(`DELETE FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF} AND producer = ?${stillOnTime}`)
      .bind(caseId, caseId, producer, ...deadlineBind),
    ...inserts,
    ...(publication
      ? [
          db
            .prepare("SELECT id FROM evidence WHERE case_id = ? AND run_id = ? AND producer = ? ORDER BY seq")
            .bind(caseId, publication.runId, producer),
        ]
      : []),
  ]);
  if (publication) {
    // D1's batch is one transaction: return only rows inserted here, never a later async read
    // that could misreport a skipped write as successful and acknowledge lost evidence.
    if (inserts.some((_, i) => published[i + 1]?.meta.changes !== 1)) return [];
    const rows = published[published.length - 1]?.results as { id: string }[];
    return list.map((e, i) => {
      const row = rows[i];
      if (!row) throw new EvidenceRefused("verification publication read-back is missing");
      return { ...e, id: row.id };
    });
  }
  // A batch that executed late wrote nothing (the SQL above), whatever its statements report.
  if (fenceAt !== undefined && Date.now() > fenceAt) return [];
  const ids = (await evidenceProducers(db, caseId)).filter((p) => p.producer === producer).map((p) => p.id);
  return list.map((e, i) => ({ ...e, id: ids[i] ?? e.id }));
}

// The run's items' producers in their order (D02 T01 §5): the current run's unless `run` names another, as
// `readEvidence`; a row written before producers were stored (null) is the checks'.
export async function evidenceProducers(
  db: D1Database,
  caseId: string,
  run: string | null = null,
): Promise<{ id: string; producer: string }[]> {
  const rows = await db
    .prepare(
      `SELECT id, COALESCE(producer, 'checks') AS producer FROM evidence WHERE case_id = ? AND run_id = COALESCE(?, ${CURRENT_RUN_OF}) ORDER BY seq`,
    )
    .bind(caseId, run, caseId)
    .all<{ id: string; producer: string }>();
  return rows.results;
}

// The case's check outcomes as stored, in the order they ran (D02 T01 §3), read from the rows alone: a check the
// registry no longer has still reads. Null for a case checked before outcomes were stored (or not checked yet), which
// is not a case whose checks found nothing (plan review): every run stores at least one row, one per registered check.
// The current run's, unless `run` names another (D01 T01 §19: an earlier attempt's, kept apart).
export async function readCheckOutcomes(
  db: D1Database,
  caseId: string,
  run: string | null = null,
): Promise<CheckOutcome[] | null> {
  const rows = await db
    .prepare(
      `SELECT check_name, outcome, reason, findings, revision, summary, data_revision, data_id, data_source, examined FROM check_outcomes WHERE case_id = ? AND run_id = COALESCE(?, ${CURRENT_RUN_OF}) ORDER BY seq`,
    )
    .bind(caseId, run, caseId)
    .all<{
      check_name: string;
      outcome: CheckOutcome["outcome"];
      reason: string | null;
      findings: number;
      revision: string | null;
      summary: string | null;
      data_revision: string | null;
      data_id: string | null;
      data_source: "kv" | "bundled" | null;
      examined: string | null;
    }>();
  if (!rows.results.length) return null;
  // The revision only when stored (D02 T01 §4), so an outcome from before reads as it always did.
  return rows.results.map((r) => ({
    check: r.check_name,
    outcome: r.outcome,
    reason: r.reason,
    findings: r.findings,
    ...(r.revision ? { revision: r.revision } : {}),
    // The summary only when stored (D02 T01 §7), so an outcome without one reads as it always did.
    ...(r.summary ? { summary: r.summary } : {}),
    // The data they judged by only when stored (D02 T01 §6): a row from before reads as it always did, never as today's table.
    ...(r.data_revision && r.data_id && r.data_source
      ? { data: { revision: r.data_revision, id: r.data_id, source: r.data_source } }
      : {}),
    // What a clean check examined only when stored (D02 T01 §8): a null or malformed column reads as none
    // stored, never as an examined empty set.
    ...(() => {
      const examined = parseExamined(r.examined);
      return examined ? { examined } : {};
    })(),
  }));
}

// The stored examined set, validated against its bound contract (D02 T01 §8): `{targets, omitted}` with
// at most 50 string targets of at most 255 characters, the whole at most 8,000 bytes, else none stored.
function parseExamined(text: string | null): CheckOutcome["examined"] | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const { targets, omitted } = value as Record<string, unknown>;
    if (!Array.isArray(targets) || targets.length > 50) return null;
    if (!targets.every((t) => typeof t === "string" && Array.from(t).length <= 255)) return null;
    if (typeof omitted !== "number" || !Number.isInteger(omitted) || omitted < 0) return null;
    if (new TextEncoder().encode(text).length > 8_000) return null;
    return { targets: targets as string[], omitted };
  } catch {
    return null;
  }
}

type EvidenceRow = {
  id: string;
  check: string;
  severity: string;
  summary: string;
  detail_json: string;
  artefact_keys_json: string;
};

// The case's evidence in its order: the current run's, unless `run` names another (D01 T01 §19).
export async function readEvidence(db: D1Database, caseId: string, run: string | null = null): Promise<Evidence[]> {
  const rows = await db
    .prepare(
      `SELECT id, "check", severity, summary, detail_json, artefact_keys_json FROM evidence WHERE case_id = ? AND run_id = COALESCE(?, ${CURRENT_RUN_OF}) ORDER BY seq`,
    )
    .bind(caseId, run, caseId)
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
