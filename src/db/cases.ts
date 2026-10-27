import { z } from "zod";

// The case store's typed queries (D01 T01 §1). Every member-facing read and change names the organisation and matches
// it in SQL, so another organisation's case reads as missing and is never changed; the one lookup by id alone,
// `getCaseForPipeline`, is for the analysis workflow, which holds no member session. Refusals come back as values, and a
// refused change leaves the row as it was.

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

export type CaseError = { code: "invalid" | "not_found" | "transition"; message: string };
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
const NewCase = z.object({ orgId: Id, channel: Channel, headersAvailable: z.boolean() });
const fail = (code: CaseError["code"], message: string): { ok: false; error: CaseError } => ({
  ok: false,
  error: { code, message },
});
const invalid = (error: z.ZodError) => fail("invalid", error.issues.map((i) => i.message).join("; "));

export async function createCase(db: D1Database, input: z.input<typeof NewCase>): Promise<CaseResult<Case>> {
  const parsed = NewCase.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
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
}

export async function getCase(db: D1Database, orgId: string, id: string): Promise<CaseResult<Case>> {
  const ids = z.object({ orgId: Id, id: Id }).safeParse({ orgId, id });
  if (!ids.success) return invalid(ids.error);
  const row = await db.prepare("SELECT * FROM cases WHERE id = ? AND org_id = ?").bind(id, orgId).first<Row>();
  return row ? { ok: true, value: toCase(row) } : fail("not_found", `no case ${id} in this organisation`);
}

// The analysis workflow's lookup: trusted, internal, by id alone. Never call it with an id a member supplied.
export async function getCaseForPipeline(db: D1Database, id: string): Promise<CaseResult<Case>> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return invalid(parsed.error);
  const row = await db.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<Row>();
  return row ? { ok: true, value: toCase(row) } : fail("not_found", `no case ${id}`);
}

export async function setStatus(
  db: D1Database,
  orgId: string,
  id: string,
  status: CaseStatus,
): Promise<CaseResult<Case>> {
  const parsed = CaseStatus.safeParse(status);
  if (!parsed.success) return invalid(parsed.error);
  const current = await getCase(db, orgId, id);
  if (!current.ok) return current;
  const from = current.value.status;
  if (!NEXT[from].includes(parsed.data)) return fail("transition", `a case cannot go from ${from} to ${parsed.data}`);
  // The status read above is part of the condition, so a change made meanwhile is refused rather than overwritten.
  const now = new Date().toISOString();
  const changed = await db
    .prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = ?")
    .bind(parsed.data, now, id, orgId, from)
    .run();
  if (changed.meta.changes !== 1) return fail("transition", `case ${id} changed while moving from ${from}`);
  return { ok: true, value: { ...current.value, status: parsed.data, updatedAt: now } };
}

export async function setVerdict(
  db: D1Database,
  orgId: string,
  id: string,
  verdict: Verdict,
): Promise<CaseResult<Case>> {
  const parsed = Verdict.safeParse(verdict);
  if (!parsed.success) return invalid(parsed.error);
  const current = await getCase(db, orgId, id);
  if (!current.ok) return current;
  const now = new Date().toISOString();
  const changed = await db
    .prepare("UPDATE cases SET verdict = ?, updated_at = ? WHERE id = ? AND org_id = ?")
    .bind(parsed.data, now, id, orgId)
    .run();
  if (changed.meta.changes !== 1) return fail("not_found", `no case ${id} in this organisation`);
  return { ok: true, value: { ...current.value, verdict: parsed.data, updatedAt: now } };
}
