// "This verdict is wrong" (D07 T03 §6; migration 0045): one row per member per case. A second send replaces the
// member's choice and note in the same row, so it is the same feedback (and sends no second notice). A row's
// `notified_at` is set only once its operator notice has gone (src/web/pages/feedback.tsx), so a notice is never lost.
import { ulid } from "./ulid";

export type FeedbackKind = "false_alarm" | "missed";
export type Feedback = {
  id: string;
  caseId: string;
  userId: string;
  kind: FeedbackKind;
  note: string | null;
  providers: string[];
  createdAt: string;
  updatedAt: string;
  notifiedAt: string | null;
};
type Row = {
  id: string;
  case_id: string;
  user_id: string;
  kind: FeedbackKind;
  note: string | null;
  providers_json: string;
  created_at: string;
  updated_at: string;
  notified_at: string | null;
};
const toFeedback = (row: Row): Feedback => ({
  id: row.id,
  caseId: row.case_id,
  userId: row.user_id,
  kind: row.kind,
  note: row.note,
  providers: JSON.parse(row.providers_json) as string[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  notifiedAt: row.notified_at,
});

// Saves the member's feedback on a case, replacing an earlier one of theirs, and answers the stored row.
export async function saveFeedback(
  db: D1Database,
  input: { caseId: string; userId: string; kind: FeedbackKind; note: string | null; providers: string[] },
): Promise<Feedback> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `INSERT INTO feedback (id, case_id, user_id, kind, note, providers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (case_id, user_id) DO UPDATE SET kind = excluded.kind, note = excluded.note,
         providers_json = excluded.providers_json, updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(ulid(), input.caseId, input.userId, input.kind, input.note, JSON.stringify(input.providers), now, now)
    .first<Row>();
  if (!row) throw new Error("the feedback was not stored");
  return toFeedback(row);
}

// Takes the member's feedback on a case back (D07 T03 §21): the row is deleted, which removes it from the operator's
// waiting notices and the providers' false-alarm lists at once. Answers whether a row went (a second press: none).
export async function withdrawFeedback(db: D1Database, caseId: string, userId: string): Promise<boolean> {
  const done = await db.prepare("DELETE FROM feedback WHERE case_id = ? AND user_id = ?").bind(caseId, userId).run();
  return (done.meta.changes ?? 0) > 0;
}

// Whether a feedback row is still there: the notice about it is not sent once its member has taken it back.
export async function feedbackStillThere(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS there FROM feedback WHERE id = ?").bind(id).first()) !== null;
}

export async function readFeedback(db: D1Database, caseId: string, userId: string): Promise<Feedback | null> {
  const row = await db
    .prepare("SELECT * FROM feedback WHERE case_id = ? AND user_id = ?")
    .bind(caseId, userId)
    .first<Row>();
  return row ? toFeedback(row) : null;
}

// Feedback whose notice has not gone yet, never tried first, then the least recently tried, at most `limit` (the
// cron's batch): a notice that stays uncertain moves to the back each time it is tried, so it cannot hold the batch.
export async function waitingNotices(db: D1Database, limit = 20): Promise<Feedback[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM feedback WHERE notified_at IS NULL ORDER BY notice_tried_at IS NOT NULL, notice_tried_at, created_at LIMIT ?",
    )
    .bind(limit)
    .all<Row>();
  return rows.results.map(toFeedback);
}

export async function markTried(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE feedback SET notice_tried_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
}

export async function markNotified(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE feedback SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
    .bind(new Date().toISOString(), id)
    .run();
}

// How many feedback rows there are for the operator's queue (D07 T08 §5 reads and settles them; until it has a settled
// state, every row is waiting).
export async function feedbackWaiting(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>();
  return row?.n ?? 0;
}
