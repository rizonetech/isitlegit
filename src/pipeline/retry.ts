// A failed check retried (D01 T01 §17): a case whose run failed before its verdict (`partial`, none stored) runs again
// under a new Workflow instance, at a member's request (the report's "Retry the check", D07 T03 §20).
//
// The previous run must have finished first: `partial` is set before its reply step runs, so a run can still be
// writing (plan review). Then one batch moves the case back to `received` with its new run id, records the retry with
// its member and run, and clears the failed run's evidence and check outcomes; every statement after the move is
// conditioned on the new run id, so of two retries at once only one changes anything. Then the Workflow starts. A start
// that fails is settled by asking for the instance: found, the retry stands; absent, the case is `partial` again and
// the start recorded as failed for that run, so the earlier run's failure is again the case's cause; unknown, the case
// is left for `sweepRetries`, which settles it the same way on the scheduled run, as it does a retry interrupted
// between its batch and its start.
import { getCase } from "../db/cases";

export type RetryRefusal = {
  code: "not_found" | "has_verdict" | "not_failed" | "not_finished" | "not_started" | "start_unknown" | "database";
  message: string;
};
export type RetryResult = { ok: true; runId: string } | { ok: false; error: RetryRefusal };

const refuse = (code: RetryRefusal["code"], message: string): RetryResult => ({ ok: false, error: { code, message } });

// An instance's state: finished (complete, errored or terminated), still going, absent, or not known.
async function instanceState(
  env: Pick<Env, "ANALYSIS">,
  id: string,
): Promise<"finished" | "going" | "absent" | "unknown"> {
  try {
    const { status } = await (await env.ANALYSIS.get(id)).status();
    return status === "complete" || status === "errored" || status === "terminated" ? "finished" : "going";
  } catch (error) {
    return /instance\.not_found/.test((error as Error).message) ? "absent" : "unknown";
  }
}

// Puts a retry whose Workflow never started back: the case `partial` again, if this run still owns it, and the start
// recorded as failed for this run, which makes the earlier run current again.
async function rollBack(
  db: D1Database,
  caseId: string,
  runId: string,
  actor: string | null,
  at: string,
  cause = "WorkflowNotStarted",
) {
  await db.batch([
    db
      .prepare(
        "UPDATE cases SET status = 'partial', updated_at = ? WHERE id = ? AND run_id = ? AND status = 'received'",
      )
      .bind(at, caseId, runId),
    db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, error, actor, run_id) SELECT ?, 'retry', 'failed', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM case_events WHERE case_id = ? AND step = 'retry' AND status = 'failed' AND run_id = ?)",
      )
      .bind(caseId, at, cause, actor, runId, caseId, runId),
  ]);
}

export async function retryCase(
  db: D1Database,
  env: Pick<Env, "ANALYSIS">,
  orgId: string,
  caseId: string,
  memberId: string,
  now: () => Date = () => new Date(),
  // The new run's id: letters and digits only (a reply's send key is `reply:` and these), random, so two retries at once
  // that both read the case cannot name the same run.
  newRunId: () => string = () => `${caseId}R${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
): Promise<RetryResult> {
  const found = await getCase(db, orgId, caseId);
  if (!found.ok)
    return found.error.code === "not_found" || found.error.code === "invalid"
      ? refuse("not_found", "no such case")
      : refuse("database", found.error.message);
  if (found.value.verdict !== null) return refuse("has_verdict", "the case has a verdict, so it has nothing to retry");
  if (found.value.status !== "partial")
    return refuse("not_failed", "the case is not a failed check (it is still running, or retried already)");
  // The run that failed must have stopped writing before another starts.
  const previous = await instanceState(env, found.value.runId ?? caseId);
  if (previous === "going" || previous === "unknown")
    return refuse("not_finished", "the check that failed is still finishing; try again in a moment");
  const runId = newRunId();
  const at = now().toISOString();
  const ours = "EXISTS (SELECT 1 FROM cases WHERE id = ? AND run_id = ?)";
  let moved: D1Result<{ id: string }>;
  try {
    [moved] = (await db.batch([
      db
        .prepare(
          // Fenced to the run whose finish was checked (completion review): a retry that waited on a run another
          // retry has since replaced changes nothing.
          "UPDATE cases SET status = 'received', run_id = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'partial' AND verdict IS NULL AND run_id IS ? RETURNING id",
        )
        .bind(runId, at, caseId, orgId, found.value.runId),
      db
        .prepare(
          `INSERT INTO case_events (case_id, step, status, started_at, actor, run_id) SELECT ?, 'retry', 'started', ?, ?, ? WHERE ${ours}`,
        )
        .bind(caseId, at, memberId, runId, caseId, runId),
      db.prepare(`DELETE FROM evidence WHERE case_id = ? AND ${ours}`).bind(caseId, caseId, runId),
      db.prepare(`DELETE FROM check_outcomes WHERE case_id = ? AND ${ours}`).bind(caseId, caseId, runId),
    ])) as [D1Result<{ id: string }>];
  } catch (error) {
    return refuse("database", (error as Error).message);
  }
  // Another retry, or the case's own change, moved it first.
  if (!moved.results.length) return refuse("not_failed", "the case was retried or changed meanwhile");
  try {
    await env.ANALYSIS.create({ id: runId, params: { caseId } });
  } catch {
    // The create may have succeeded with its answer lost: the instance decides.
    const state = await instanceState(env, runId);
    if (state === "finished" || state === "going") return { ok: true, runId };
    if (state === "unknown")
      return refuse("start_unknown", "whether the check started again is not known yet; it is settled shortly");
    try {
      await rollBack(db, caseId, runId, memberId, now().toISOString());
    } catch {
      // Left `received` with its run: `sweepRetries` settles it (completion review).
      return refuse("start_unknown", "whether the check started again is not known yet; it is settled shortly");
    }
    return refuse("not_started", "the check could not be started again");
  }
  return { ok: true, runId };
}

// A retry left `received` past this long without its run having moved it (its start interrupted, or its answer lost)
// is settled by the scheduled run.
export const RETRY_SETTLE_MS = 5 * 60 * 1000;

// Settles retries whose start was never confirmed: each `received` case with a run id older than RETRY_SETTLE_MS is
// looked up by its run, those looked at longest ago first, each marked as looked at so the next sweep reaches others
// (completion review: fifty unresolved rows hid the rest). An instance still going is left to run; one absent is rolled
// back; one that ended without moving its case (its run stopped before the admit step could) is rolled back too, as
// `WorkflowEnded`; an unknown answer, or a row whose settling fails, is left for the next sweep and the others go on.
export async function sweepRetries(
  db: D1Database,
  env: Pick<Env, "ANALYSIS">,
  now: () => Date = () => new Date(),
): Promise<{ settled: number; running: number; unknown: number; errors: number }> {
  const at = now();
  const before = new Date(at.getTime() - RETRY_SETTLE_MS).toISOString();
  const stale = await db
    .prepare(
      "SELECT id, run_id FROM cases WHERE status = 'received' AND run_id IS NOT NULL AND updated_at < ? ORDER BY coalesce(run_checked_at, '') , updated_at LIMIT 50",
    )
    .bind(before)
    .all<{ id: string; run_id: string }>();
  const counts = { settled: 0, running: 0, unknown: 0, errors: 0 };
  for (const { id, run_id } of stale.results) {
    try {
      await db.prepare("UPDATE cases SET run_checked_at = ? WHERE id = ?").bind(at.toISOString(), id).run();
      const state = await instanceState(env, run_id);
      if (state === "absent" || state === "finished") {
        await rollBack(
          db,
          id,
          run_id,
          null,
          now().toISOString(),
          state === "absent" ? "WorkflowNotStarted" : "WorkflowEnded",
        );
        counts.settled++;
      } else if (state === "unknown") counts.unknown++;
      else counts.running++;
    } catch {
      counts.errors++;
    }
  }
  return counts;
}
