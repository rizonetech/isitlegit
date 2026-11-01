// A case's recorded step events for the report's progress (D07 T03 §4): one run's attempts in the order
// recorded (`case_events`, migration 0001; written by src/pipeline/events.ts), scoped to a case the caller has already
// read in its organisation. Reduced to steps by src/web/pages/report-progress.ts. A retried case (D01 T01 §17) shows
// its new run alone, never the failed run's failure or start time beside it, and a retry whose start failed drops out,
// so the run before it is current again (D07 T03 §20); the `retry` rows are the retry's bookkeeping, not a step.

import type { ReplySend } from "../web/pages/report-live";
import type { StepEvent } from "../web/pages/report-progress";

export async function readCaseEvents(db: D1Database, caseId: string, run: string): Promise<StepEvent[]> {
  // Pinned to the run the caller captured with the case (not whichever run is current when this executes), so one
  // response never joins one run's lifecycle to another's steps if a retry lands between the reads (completion
  // review): from that run's own `retry` start to the next retry's start; the first run, from the beginning. A run
  // never retried has no start of its own, so it reads from the beginning too.
  const rows = await db
    .prepare(
      `WITH lo AS (SELECT COALESCE((SELECT MAX(id) FROM case_events WHERE case_id = ? AND step = 'retry' AND status = 'started' AND run_id = ?), 0) AS id)
       SELECT step, status, started_at AS startedAt, ms, error FROM case_events
       WHERE case_id = ? AND step != 'retry' AND id > (SELECT id FROM lo)
         AND id < COALESCE((SELECT MIN(id) FROM case_events WHERE case_id = ? AND step = 'retry' AND status = 'started' AND id > (SELECT id FROM lo)), 9007199254740991)
       ORDER BY id`,
    )
    .bind(caseId, run, caseId, caseId)
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
