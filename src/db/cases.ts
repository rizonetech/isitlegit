import { z } from "zod";
import { dailyCapBinds, dailyCapSql } from "../auth/plan-sql";
import { ADDRESS_LIMIT, HEADER_TEXT_LIMIT } from "../intake/original-header";
import { searchText } from "./search-fold";
import { isUlid, ulid } from "./ulid";

// The case store's typed queries (D01 T01 §1). Every member-facing read and change names the organisation and matches
// it in SQL, so another organisation's case reads as missing and is never changed; the one lookup by id alone,
// `getCaseForPipeline`, is for the analysis workflow, which holds no member session. Refusals come back as values, and a
// refused change leaves the row as it was. A successful change is one statement that returns the row as stored, so the
// answer is never an earlier read with one field patched. Case ids are ULIDs (`./ulid`), which the artefact store
// requires. A database failure comes back as a `database` refusal, not an exception.
//
// The lifecycle ties status and verdict together: a verdict is written only while the case is `running`, and a case
// finishes `done` only once it has one (`partial` may finish without). So the pipeline finishes a case with
// `setVerdict` then `setStatus("done")`, and either call repeated after the case finished the same way is a no-op that
// answers the stored row, which makes a retried workflow step safe; repeated with a different verdict it is refused.

export const Channel = z.enum(["email", "upload"]);
export const CaseStatus = z.enum(["received", "running", "done", "partial"]);
// What the case was made from (migration 0018): a forward or an uploaded message is `mail`.
export const SourceKind = z.enum(["mail", "document", "image", "audio"]);
export type SourceKind = z.infer<typeof SourceKind>;
export const Verdict = z.enum(["safe", "suspicious", "malicious"]);
export type Channel = z.infer<typeof Channel>;
export type CaseStatus = z.infer<typeof CaseStatus>;
export type Verdict = z.infer<typeof Verdict>;

export type Case = {
  id: string;
  orgId: string;
  channel: Channel;
  status: CaseStatus;
  verdict: Verdict | null;
  headersAvailable: boolean;
  // The admitted envelope sender of an email case, whom the reply goes to, and the forward's Message-ID it threads on
  // (D01 T01 §3); null for an upload.
  forwardedBy: string | null;
  messageId: string | null;
  // The member who uploaded an upload case (D01 T03 §11), their user id; null on an email case.
  uploadedBy: string | null;
  // What an uploaded file claimed to be (D02 T04 §4): its own name and the media type submitted with it; null on an
  // email case and on an upload stored before these were kept.
  uploadName: string | null;
  uploadMediaType: string | null;
  // The case's current Workflow run (D01 T01 §17): null for its first, whose instance id is the case id.
  runId: string | null;
  sourceKind: SourceKind;
  // The checked original's subject and sender for the report header (D01 T01 §16), decoded, one line and bounded by
  // `originalHeaderOf`; null for a document, image or audio upload, an inline forward, or a case not yet parsed.
  originalSubject: string | null;
  originalFromName: string | null;
  originalFromAddress: string | null;
  // What a case is beyond its transport (D05 T02 §1): "counterparty" for a non-member's forward claiming a protected
  // business, whose case it then is; null for a member's own case.
  origin: "counterparty" | null;
  createdAt: string;
  updatedAt: string;
};

// The counterparty limits (D05 T02 §1; spec 2a): checks a day from one forwarder, and about one protected business.
export const COUNTERPARTY_PER_SENDER = 5;
export const COUNTERPARTY_PER_IDENTITY = 50;

export type CaseError = { code: "invalid" | "not_found" | "transition" | "database" | "capped"; message: string };
export type CaseResult<T> = { ok: true; value: T } | { ok: false; error: CaseError };

// The only moves a case makes: picked up by the pipeline, then finished whole or in part.
const NEXT: Record<CaseStatus, CaseStatus[]> = {
  received: ["running"],
  running: ["done", "partial"],
  done: [],
  partial: [],
};

type Row = {
  id: string;
  org_id: string;
  channel: Channel;
  status: CaseStatus;
  verdict: Verdict | null;
  headers_available: number;
  forwarded_by: string | null;
  message_id: string | null;
  uploaded_by: string | null;
  upload_name: string | null;
  upload_media_type: string | null;
  run_id?: string | null;
  source_kind: SourceKind;
  original_subject: string | null;
  original_from_name: string | null;
  original_from_address: string | null;
  origin?: "counterparty" | null;
  created_at: string;
  updated_at: string;
};
const toCase = (row: Row): Case => ({
  id: row.id,
  orgId: row.org_id,
  channel: row.channel,
  status: row.status,
  verdict: row.verdict,
  headersAvailable: row.headers_available === 1,
  forwardedBy: row.forwarded_by,
  messageId: row.message_id,
  uploadedBy: row.uploaded_by,
  uploadName: row.upload_name ?? null,
  uploadMediaType: row.upload_media_type ?? null,
  runId: row.run_id ?? null,
  sourceKind: row.source_kind,
  originalSubject: row.original_subject,
  originalFromName: row.original_from_name,
  originalFromAddress: row.original_from_address,
  origin: row.origin ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const Id = z.string().min(1).max(200);
const Ids = z.object({ orgId: Id, id: Id });
const NewCase = z
  .object({
    orgId: Id,
    channel: Channel,
    headersAvailable: z.boolean(),
    forwardedBy: z.string().trim().toLowerCase().email().max(254).nullish(),
    // RFC 5322 caps a header line at 998 characters.
    messageId: z.string().min(1).max(998).nullish(),
    sourceKind: SourceKind.default("mail"),
    // A counterparty case (D05 T02 §1): an email case with the forwarder it answers.
    origin: z.literal("counterparty").nullish(),
    // The uploading member's user id: required on an upload case, refused on an email case (D01 T03 §11).
    uploadedBy: Id.nullish(),
    // What the uploaded file claimed to be (D02 T04 §4), exactly as sent (completion review: a trimmed name is not the
    // name the member sent); the comparison normalises what it compares. An empty claim is no claim.
    uploadName: z
      .string()
      .max(255)
      .nullish()
      .transform((v) => v || null),
    uploadMediaType: z
      .string()
      .max(255)
      .nullish()
      .transform((v) => v || null),
    // A caller that must record the id before the case exists (the email intake's claim, D01 T01 §3) chooses it.
    id: z.string().refine(isUlid, "a case id is a ULID").optional(),
  })
  .refine((c) => (c.channel === "upload") === !!c.uploadedBy, {
    message: "an upload case names its uploader, and an email case none",
  })
  .refine((c) => c.channel === "upload" || (!c.uploadName && !c.uploadMediaType), {
    message: "only an upload case carries what its file claimed to be",
  })
  .refine((c) => !c.origin || (c.channel === "email" && !!c.forwardedBy), {
    message: "a counterparty case is an email case that names its forwarder",
  });
const fail = (code: CaseError["code"], message: string): { ok: false; error: CaseError } => ({
  ok: false,
  error: { code, message },
});
const invalid = (error: z.ZodError) => fail("invalid", error.issues.map((i) => i.message).join("; "));
// Every query's failure (a missing table, an unreachable database) as a typed refusal.
async function guarded<T>(work: () => Promise<CaseResult<T>>): Promise<CaseResult<T>> {
  try {
    return await work();
  } catch (error) {
    return fail("database", (error as Error).message);
  }
}

// The organisation's daily case cap (D07 T02 §4; design spec section 11): cases since 00:00 SAST against its cap by plan
// (D07 T08 §8: `dailyCapSql` in src/auth/plan-sql.ts, the operator's override first), read in the admitting statement.
// SAST is UTC+2 with no daylight saving.
export { DEFAULT_DAILY_CASES } from "../auth/plan-sql";

// The cap's day and counting rule live in ./cap-rule (pure, so the evaluation runner counts as admission does).
import { COUNTS_TOWARD_CAP, MEMBER_CASES_TODAY, sastDayStart } from "./cap-rule";

export { COUNTS_TOWARD_CAP, MEMBER_CASES_TODAY, sastDayStart };

// The only way the email and upload paths create a case: one statement inserts it only while the organisation is under
// its daily cap, so two arrivals for the last slot cannot both get in. A refused case is not created (`capped`); the
// caller answers it (the email path's daily notice, the upload's 429).
export async function admitCase(
  db: D1Database,
  input: z.input<typeof NewCase>,
  now = new Date(),
): Promise<CaseResult<Case>> {
  const parsed = NewCase.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    const at = now.toISOString();
    const row: Row = {
      id: parsed.data.id ?? ulid(),
      org_id: parsed.data.orgId,
      channel: parsed.data.channel,
      status: "received",
      verdict: null,
      headers_available: parsed.data.headersAvailable ? 1 : 0,
      forwarded_by: parsed.data.forwardedBy ?? null,
      message_id: parsed.data.messageId ?? null,
      uploaded_by: parsed.data.uploadedBy ?? null,
      upload_name: parsed.data.uploadName ?? null,
      upload_media_type: parsed.data.uploadMediaType ?? null,
      source_kind: parsed.data.sourceKind,
      origin: parsed.data.origin ?? null,
      original_subject: null,
      original_from_name: null,
      original_from_address: null,
      created_at: at,
      updated_at: at,
    };
    // Room for the case in one statement with its insert, so two arrivals for the last slot cannot both get in. A member's
    // case counts against its organisation's cap, which counterparty cases never use; a counterparty case counts against
    // its own two limits, per forwarder and per protected business, so neither traffic can exhaust the other (D05 T02
    // §1). Both are counted from the cases themselves, so a duplicate takes no slot and an undone admission (its case
    // deleted) gives its slot back.
    const day = sastDayStart(now);
    const counterparty = row.origin === "counterparty";
    const room = counterparty
      ? `(SELECT COUNT(*) FROM cases WHERE origin = 'counterparty' AND forwarded_by = ? AND created_at >= ? AND ${COUNTS_TOWARD_CAP}) < ?
         AND (SELECT COUNT(*) FROM cases WHERE org_id = ? AND origin = 'counterparty' AND created_at >= ? AND ${COUNTS_TOWARD_CAP}) < ?`
      : `${MEMBER_CASES_TODAY()} < ${dailyCapSql()}`;
    // A member's cap is its plan's (D07 T08 §8, `dailyCapSql`), read in the same statement.
    const roomArgs = counterparty
      ? [row.forwarded_by, day, COUNTERPARTY_PER_SENDER, row.org_id, day, COUNTERPARTY_PER_IDENTITY]
      : [row.org_id, day, ...dailyCapBinds(row.org_id, now)];
    const inserted = await db
      .prepare(
        `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, forwarded_by, message_id, uploaded_by, upload_name, upload_media_type, source_kind, origin, created_at, updated_at, search_text) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${room} AND NOT EXISTS (SELECT 1 FROM "organization" WHERE id = ? AND "closedAt" IS NOT NULL) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        row.id,
        row.org_id,
        row.channel,
        row.status,
        row.verdict,
        row.headers_available,
        row.forwarded_by,
        row.message_id,
        row.uploaded_by,
        row.upload_name,
        row.upload_media_type,
        row.source_kind,
        row.origin ?? null,
        row.created_at,
        row.updated_at,
        // The Cases list's search (D07 T04 §7): what is known at arrival, the upload's name.
        searchText({ uploadName: row.upload_name }),
        ...roomArgs,
        row.org_id,
      )
      .run();
    if (inserted.meta.changes !== 1) {
      // A caller-chosen id already admitted (a retry) is answered with that case, never as capped.
      if (parsed.data.id) {
        const existing = await db
          .prepare("SELECT * FROM cases WHERE id = ? AND org_id = ?")
          .bind(row.id, row.org_id)
          .first<Row>();
        if (existing) return { ok: true, value: toCase(existing) };
      }
      return fail("capped", "the organisation's daily case limit is reached");
    }
    return { ok: true, value: toCase(row) };
  });
}

export async function createCase(db: D1Database, input: z.input<typeof NewCase>): Promise<CaseResult<Case>> {
  const parsed = NewCase.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    const now = new Date().toISOString();
    const row: Row = {
      id: parsed.data.id ?? ulid(),
      org_id: parsed.data.orgId,
      channel: parsed.data.channel,
      status: "received",
      verdict: null,
      headers_available: parsed.data.headersAvailable ? 1 : 0,
      forwarded_by: parsed.data.forwardedBy ?? null,
      message_id: parsed.data.messageId ?? null,
      uploaded_by: parsed.data.uploadedBy ?? null,
      upload_name: parsed.data.uploadName ?? null,
      upload_media_type: parsed.data.uploadMediaType ?? null,
      source_kind: parsed.data.sourceKind,
      original_subject: null,
      original_from_name: null,
      original_from_address: null,
      created_at: now,
      updated_at: now,
    };
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, forwarded_by, message_id, uploaded_by, upload_name, upload_media_type, source_kind, created_at, updated_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.org_id,
        row.channel,
        row.status,
        row.verdict,
        row.headers_available,
        row.forwarded_by,
        row.message_id,
        row.uploaded_by,
        row.upload_name,
        row.upload_media_type,
        row.source_kind,
        row.created_at,
        row.updated_at,
        // The Cases list's search (D07 T04 §7): what is known at arrival, the upload's name.
        searchText({ uploadName: row.upload_name }),
      )
      .run();
    return { ok: true, value: toCase(row) };
  });
}

export async function getCase(db: D1Database, orgId: string, id: string): Promise<CaseResult<Case>> {
  const ids = Ids.safeParse({ orgId, id });
  if (!ids.success) return invalid(ids.error);
  return guarded(async () => {
    const row = await db.prepare("SELECT * FROM cases WHERE id = ? AND org_id = ?").bind(id, orgId).first<Row>();
    return row ? { ok: true, value: toCase(row) } : fail("not_found", `no case ${id} in this organisation`);
  });
}

// The analysis workflow's lookup: trusted, internal, by id alone. Never call it with an id a member supplied.
export async function getCaseForPipeline(db: D1Database, id: string): Promise<CaseResult<Case>> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    const row = await db.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<Row>();
    return row ? { ok: true, value: toCase(row) } : fail("not_found", `no case ${id}`);
  });
}

// Which statuses a case may move to `status` from.
const FROM = (status: CaseStatus) => (Object.keys(NEXT) as CaseStatus[]).filter((from) => NEXT[from].includes(status));
const FINISHED: CaseStatus[] = ["done", "partial"];

// Why a move matched no row, read after it: the case is missing (or another organisation's), it already has the status
// asked for (a repeated finish, answered with the stored row), or its status or missing verdict refuses the move. A
// change made between the two statements can only make this answer stale, never change the row wrongly.
async function afterStatusMiss(
  db: D1Database,
  orgId: string,
  id: string,
  status: CaseStatus,
): Promise<CaseResult<Case>> {
  const current = await getCase(db, orgId, id);
  if (!current.ok) return current;
  const c = current.value;
  if (c.status === status && FINISHED.includes(status)) return current;
  if (status === "done" && c.status === "running" && c.verdict === null)
    return fail("transition", `case ${id} cannot finish done without a verdict`);
  return fail("transition", `a case cannot go from ${c.status} to ${status}`);
}

// A case admitted whose delivery never got its file stored, ended `partial` in one statement a caller commits with its
// failure event and its claim's change (D01 T03 §12): never started, it goes from `received` straight to `partial`, so
// no interruption can leave it `running` with no Workflow. Matches nothing once the case has moved on.
export function unstartedPartial(db: D1Database, orgId: string, id: string, at = new Date()): D1PreparedStatement {
  return db
    .prepare("UPDATE cases SET status = 'partial', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'received'")
    .bind(at.toISOString(), id, orgId);
}

export async function setStatus(
  db: D1Database,
  orgId: string,
  id: string,
  status: CaseStatus,
): Promise<CaseResult<Case>> {
  const ids = Ids.safeParse({ orgId, id });
  if (!ids.success) return invalid(ids.error);
  const parsed = CaseStatus.safeParse(status);
  if (!parsed.success) return invalid(parsed.error);
  const to = parsed.data;
  return guarded(async () => {
    const from = FROM(to);
    if (from.length === 0) return afterStatusMiss(db, orgId, id, to);
    // The allowed previous statuses, and for `done` a verdict, are part of the condition: one statement moves and
    // checks.
    const row = await db
      .prepare(
        `UPDATE cases SET status = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status IN (${from.map(() => "?").join(", ")})${to === "done" ? " AND verdict IS NOT NULL" : ""} RETURNING *`,
      )
      .bind(to, new Date().toISOString(), id, orgId, ...from)
      .first<Row>();
    return row ? { ok: true, value: toCase(row) } : afterStatusMiss(db, orgId, id, to);
  });
}

// Whether the original's headers came with the forward (D01 T01 §4), written by the pipeline by case id once it has
// read the message: the email path admits every case with 0 because it reads no MIME. Only a case still `received`
// or `running` changes; a finished one (`done`, `partial`) is a `transition` refusal and stays as it was.
export async function setHeadersAvailable(db: D1Database, id: string, available: boolean): Promise<CaseResult<Case>> {
  const parsed = z.object({ id: Id, available: z.boolean() }).safeParse({ id, available });
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    const row = await db
      .prepare(
        "UPDATE cases SET headers_available = ?, updated_at = ? WHERE id = ? AND status IN ('received', 'running') RETURNING *",
      )
      .bind(available ? 1 : 0, new Date().toISOString(), id)
      .first<Row>();
    if (row) return { ok: true, value: toCase(row) };
    const existing = await db.prepare("SELECT status FROM cases WHERE id = ?").bind(id).first<{ status: string }>();
    return existing
      ? fail("transition", `a ${existing.status} case keeps its header state`)
      : fail("not_found", "no such case");
  });
}

// The original's subject and sender (D01 T01 §16), written by the parse step before the summary is stored, so a re-driven
// case, which returns early once its summary exists, already has them; only while the case is being analysed.
export async function setOriginalHeader(
  db: D1Database,
  id: string,
  header: { subject: string | null; fromName: string | null; fromAddress: string | null },
): Promise<CaseResult<Case>> {
  const text = z.string().min(1).max(HEADER_TEXT_LIMIT).nullable();
  const parsed = z
    .object({ id: Id, subject: text, fromName: text, fromAddress: z.string().min(3).max(ADDRESS_LIMIT).nullable() })
    .safeParse({ id, ...header });
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    // The search text folds the upload's name too (an uploaded .eml has both), which never changes after arrival.
    const named = await db
      .prepare("SELECT upload_name FROM cases WHERE id = ?")
      .bind(id)
      .first<{ upload_name: string | null }>();
    const folded = searchText({ ...header, uploadName: named?.upload_name ?? null });
    const row = await db
      .prepare(
        "UPDATE cases SET original_subject = ?, original_from_name = ?, original_from_address = ?, search_text = ?, updated_at = ? WHERE id = ? AND status IN ('received', 'running') RETURNING *",
      )
      .bind(header.subject, header.fromName, header.fromAddress, folded, new Date().toISOString(), id)
      .first<Row>();
    if (row) return { ok: true, value: toCase(row) };
    const existing = await db.prepare("SELECT status FROM cases WHERE id = ?").bind(id).first<{ status: string }>();
    return existing
      ? fail("transition", `a ${existing.status} case keeps its original's header`)
      : fail("not_found", "no such case");
  });
}

// The events of a case's current run (D01 T01 §17): those after its latest retry whose run started (a `retry`/`started`
// event with no `retry`/`failed` event for the same run), all of them when it was never retried. Each failed start is
// paired with its own attempt, so a failed later attempt never hides an earlier one that ran (plan review). A condition
// on `case_events.id`, bound to the case id once.
export const CURRENT_RUN = `id > COALESCE((SELECT MAX(s.id) FROM case_events s WHERE s.case_id = ? AND s.step = 'retry' AND s.status = 'started' AND NOT EXISTS (SELECT 1 FROM case_events f WHERE f.case_id = s.case_id AND f.step = 'retry' AND f.status = 'failed' AND f.run_id = s.run_id)), 0)`;

// A partial case whose analysis finished (its verdict stored) and failed only after it, delivering its reply or
// finishing, completed once that verdict reached the member (D01 T02 §8 final review). The one move out of `partial`:
// any failure before the verdict, or a case with no verdict, keeps it partial.
export async function completeStored(db: D1Database, orgId: string, id: string): Promise<CaseResult<Case>> {
  const ids = Ids.safeParse({ orgId, id });
  if (!ids.success) return invalid(ids.error);
  return guarded(async () => {
    const row = await db
      .prepare(
        // The current run's failures only (D01 T01 §17): a retried run is not held back by the run it replaced.
        `UPDATE cases SET status = 'done', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'partial' AND verdict IS NOT NULL AND NOT EXISTS (SELECT 1 FROM case_events WHERE case_id = ? AND status = 'failed' AND step NOT IN ('reply', 'finish') AND ${CURRENT_RUN}) RETURNING *`,
      )
      .bind(new Date().toISOString(), id, orgId, id, id)
      .first<Row>();
    if (row) return { ok: true, value: toCase(row) };
    return fail("transition", `case ${id} is not a partial case that failed only after its verdict`);
  });
}

export async function setVerdict(
  db: D1Database,
  orgId: string,
  id: string,
  verdict: Verdict,
): Promise<CaseResult<Case>> {
  const ids = Ids.safeParse({ orgId, id });
  if (!ids.success) return invalid(ids.error);
  const parsed = Verdict.safeParse(verdict);
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    const row = await db
      .prepare(
        "UPDATE cases SET verdict = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'running' RETURNING *",
      )
      .bind(parsed.data, new Date().toISOString(), id, orgId)
      .first<Row>();
    if (row) return { ok: true, value: toCase(row) };
    const current = await getCase(db, orgId, id);
    if (!current.ok) return current;
    const c = current.value;
    if (FINISHED.includes(c.status) && c.verdict === parsed.data) return current;
    return fail(
      "transition",
      FINISHED.includes(c.status)
        ? `case ${id} finished with verdict ${c.verdict ?? "none"}; it cannot change to ${parsed.data}`
        : `a verdict is written while a case is running; this one is ${c.status}`,
    );
  });
}
