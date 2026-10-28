import { z } from "zod";
import { ulid } from "./ulid";

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
  createdAt: string;
  updatedAt: string;
};

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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const Id = z.string().min(1).max(200);
const Ids = z.object({ orgId: Id, id: Id });
const NewCase = z.object({ orgId: Id, channel: Channel, headersAvailable: z.boolean() });
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

// The organisation's daily case cap (D07 T02 §4; design spec section 11): cases since 00:00 SAST against
// `org_limits.daily_cases`, 50 when the organisation has no row. SAST is UTC+2 with no daylight saving.
export const DEFAULT_DAILY_CASES = 50;
const SAST_OFFSET_MS = 2 * 60 * 60_000;
export const sastDayStart = (now: Date) => {
  const local = now.getTime() + SAST_OFFSET_MS;
  return new Date(local - (local % 86_400_000) - SAST_OFFSET_MS).toISOString();
};

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
      id: ulid(),
      org_id: parsed.data.orgId,
      channel: parsed.data.channel,
      status: "received",
      verdict: null,
      headers_available: parsed.data.headersAvailable ? 1 : 0,
      created_at: at,
      updated_at: at,
    };
    const inserted = await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM cases WHERE org_id = ? AND created_at >= ?) < COALESCE((SELECT daily_cases FROM org_limits WHERE org_id = ?), ?)",
      )
      .bind(
        row.id,
        row.org_id,
        row.channel,
        row.status,
        row.verdict,
        row.headers_available,
        row.created_at,
        row.updated_at,
        row.org_id,
        sastDayStart(now),
        row.org_id,
        DEFAULT_DAILY_CASES,
      )
      .run();
    if (inserted.meta.changes !== 1) return fail("capped", "the organisation's daily case limit is reached");
    return { ok: true, value: toCase(row) };
  });
}

export async function createCase(db: D1Database, input: z.input<typeof NewCase>): Promise<CaseResult<Case>> {
  const parsed = NewCase.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return guarded(async () => {
    const now = new Date().toISOString();
    const row: Row = {
      id: ulid(),
      org_id: parsed.data.orgId,
      channel: parsed.data.channel,
      status: "received",
      verdict: null,
      headers_available: parsed.data.headersAvailable ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.org_id,
        row.channel,
        row.status,
        row.verdict,
        row.headers_available,
        row.created_at,
        row.updated_at,
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
