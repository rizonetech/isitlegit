// A case's recorded step events for the report's progress (D07 T03 §4): every attempt in the order recorded
// (`case_events`, migration 0001; written by src/pipeline/events.ts), scoped to a case the caller has already read in
// its organisation. Reduced to steps by src/web/pages/report-progress.ts.
import type { StepEvent } from "../web/pages/report-progress";

export async function readCaseEvents(db: D1Database, caseId: string): Promise<StepEvent[]> {
  const rows = await db
    .prepare("SELECT step, status, started_at AS startedAt, ms, error FROM case_events WHERE case_id = ? ORDER BY id")
    .bind(caseId)
    .all<StepEvent>();
  return rows.results;
}
