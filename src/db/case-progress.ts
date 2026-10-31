// A case's recorded step events for the report's progress (D07 T03 §4): every attempt in the order recorded
// (`case_events`, migration 0001; written by src/pipeline/events.ts), scoped to a case the caller has already read in
// its organisation. Reduced to steps by src/web/pages/report-progress.ts.
import type { ReplySend } from "../web/pages/report-live";
import type { StepEvent } from "../web/pages/report-progress";

export async function readCaseEvents(db: D1Database, caseId: string): Promise<StepEvent[]> {
  const rows = await db
    .prepare("SELECT step, status, started_at AS startedAt, ms, error FROM case_events WHERE case_id = ? ORDER BY id")
    .bind(caseId)
    .all<StepEvent>();
  return rows.results;
}

// How the case's reply mail stands (`mail_sends`, written by src/mail): the latest reply's status, or null when none
// was attempted (an upload, or a case that ended before its reply).
export async function readReplySend(db: D1Database, caseId: string): Promise<ReplySend | null> {
  const row = await db
    .prepare(
      "SELECT status FROM mail_sends WHERE case_id = ? AND kind = 'reply' ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(caseId)
    .first<{ status: ReplySend }>();
  return row?.status ?? null;
}
