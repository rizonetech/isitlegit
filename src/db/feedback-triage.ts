// Operator triage of "this verdict is wrong" reports (D07 T08 §5): the New, Triaged and Closed tabs of the
// feedback queue, the triage note, Close and Reopen. All state lives in the section's own migration columns
// (`triage`, `triage_note`, `triaged_updated_at`); `src/db/feedback.ts` (D07 T03 §6, the app lane's) is never edited.
// A member edit after triage reopens the item: the effective state is new whenever the row changed after it was
// triaged, so an operator never closes a complaint they have not seen. An operator POST carries the `updated_at` it
// rendered, and a mismatch is refused instead of overwriting the member's newer words.
import { ulid } from "./ulid";

export type Triage = "new" | "triaged" | "closed";
export type TriageRow = {
  id: string;
  caseId: string;
  userId: string;
  kind: "false_alarm" | "missed";
  note: string | null;
  providers: string[];
  createdAt: string;
  updatedAt: string;
  triage: Triage;
  triageNote: string | null;
};
type Row = {
  id: string;
  case_id: string;
  user_id: string;
  kind: "false_alarm" | "missed";
  note: string | null;
  providers_json: string;
  created_at: string;
  updated_at: string;
  triage: Triage;
  triage_note: string | null;
};
// A row changed after it was triaged reads as new: the operator's note is kept, but the state is not.
const effective = (triage: Triage, updatedAt: string, triagedAt: string | null): Triage =>
  triage !== "new" && triagedAt !== null && updatedAt !== triagedAt ? "new" : triage;
const toTriage = (row: Row & { triaged_updated_at: string | null }): TriageRow => ({
  id: row.id,
  caseId: row.case_id,
  userId: row.user_id,
  kind: row.kind,
  note: row.note,
  providers: JSON.parse(row.providers_json) as string[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  triage: effective(row.triage, row.updated_at, row.triaged_updated_at),
  triageNote: row.triage_note,
});

// The queue counts, with member-edited rows back in new.
export async function triageCounts(db: D1Database): Promise<Record<Triage, number>> {
  const rows = await db
    .prepare(
      "SELECT triage, updated_at, triaged_updated_at, COUNT(*) AS n FROM feedback GROUP BY triage, updated_at, triaged_updated_at",
    )
    .all<{ triage: Triage; updated_at: string; triaged_updated_at: string | null; n: number }>();
  const counts: Record<Triage, number> = { new: 0, triaged: 0, closed: 0 };
  for (const row of rows.results) counts[effective(row.triage, row.updated_at, row.triaged_updated_at)] += row.n;
  return counts;
}

// One page of the queue in one state, newest first; page 0 is the first 50. The tab is matched in SQL so a page
// is full whenever the tab has rows left: a row changed after it was triaged reads as new, and only an unchanged
// triaged or closed row reads as settled.
const TAB_MATCH: Record<Triage, string> = {
  new: "(triage = 'new' OR (triaged_updated_at IS NOT NULL AND updated_at != triaged_updated_at))",
  triaged: "(triage = 'triaged' AND updated_at = triaged_updated_at)",
  closed: "(triage = 'closed' AND updated_at = triaged_updated_at)",
};
export async function listTriage(db: D1Database, triage: Triage, page = 0): Promise<TriageRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM feedback WHERE ${TAB_MATCH[triage]} ORDER BY created_at DESC LIMIT 50 OFFSET ?`)
    .bind(page * 50)
    .all<Row & { triaged_updated_at: string | null }>();
  return rows.results.map(toTriage);
}

// Save the operator's note and move the item: triaged from new, closed staying closed keeps its note. Answers the
// stored row, or null when the row is gone or changed under the operator: the POST carries the `updated_at` it
// rendered, and a mismatch refuses instead of overwriting.
export async function saveTriageNote(
  db: D1Database,
  input: { id: string; note: string | null; knownUpdatedAt: string },
): Promise<TriageRow | null> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE feedback SET triage_note = ?, triaged_updated_at = ?,
         triage = CASE WHEN triage = 'new' THEN 'triaged' ELSE triage END,
         updated_at = ?
       WHERE id = ? AND updated_at = ? RETURNING *`,
    )
    .bind(input.note, now, now, input.id, input.knownUpdatedAt)
    .first<Row & { triaged_updated_at: string | null }>();
  return row ? toTriage(row) : null;
}

// Close the item (the verdict was right) or reopen it to triaged, recording when. Like the note, the move is
// refused when the row is gone or changed under the operator.
export async function moveTriage(
  db: D1Database,
  input: { id: string; to: "triaged" | "closed"; knownUpdatedAt: string },
): Promise<TriageRow | null> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      "UPDATE feedback SET triage = ?, triaged_updated_at = ?, updated_at = ? WHERE id = ? AND updated_at = ? RETURNING *",
    )
    .bind(input.to, now, now, input.id, input.knownUpdatedAt)
    .first<Row & { triaged_updated_at: string | null }>();
  return row ? toTriage(row) : null;
}

// A fresh id for tests and callers that mint rows outside the member flow.
export const newTriageId = () => ulid();
