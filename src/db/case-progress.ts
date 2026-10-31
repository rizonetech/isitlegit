// A case's recorded step events for the report's progress (D07 T03 §4): its current run's attempts in the order
// recorded (`case_events`, migration 0001; written by src/pipeline/events.ts), scoped to a case the caller has already
// read in its organisation. Reduced to steps by src/web/pages/report-progress.ts. A retried case (D01 T01 §17) shows
// its new run alone, never the failed run's failure or start time beside it, and a retry whose start failed drops out,
// so the run before it is current again (D07 T03 §20); the `retry` rows are the retry's bookkeeping, not a step.

import type { ReplySend } from "../web/pages/report-live";
import type { StepEvent } from "../web/pages/report-progress";
import { CURRENT_RUN } from "./cases";

export async function readCaseEvents(db: D1Database, caseId: string): Promise<StepEvent[]> {
  const rows = await db
    .prepare(
      `SELECT step, status, started_at AS startedAt, ms, error FROM case_events WHERE case_id = ? AND step != 'retry' AND ${CURRENT_RUN} ORDER BY id`,
    )
    .bind(caseId, caseId)
    .all<StepEvent>();
  return rows.results;
}

// How the run's reply mail stands (`mail_sends`, written by src/mail): the reply sent under the run's own key
// (`reply:<run id>`, the case id for its first run, as src/pipeline/analysis-workflow.ts names it), or null when none
// was attempted (an upload, a case that ended before its reply, or a retried run that has not reached it yet).
export async function readReplySend(db: D1Database, caseId: string, run: string): Promise<ReplySend | null> {
  const row = await db
    .prepare("SELECT status FROM mail_sends WHERE case_id = ? AND kind = 'reply' AND send_key = ?")
    .bind(caseId, `reply:${run}`)
    .first<{ status: ReplySend }>();
  return row?.status ?? null;
}
