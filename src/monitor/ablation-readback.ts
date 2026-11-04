// Historical reads use persisted tenant ownership, independently of the admission gate. No read starts work.
import { z } from "zod";
import { readExperiment } from "./ablation-store";

const Id = z.string().min(1).max(256);
const Amount = z.number().finite().nonnegative();
const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Attempt = z.strictObject({
  attemptId: Id,
  pageOperationId: Id,
  phase: z.enum(["wake", "loupe", "screen", "second-look"]),
  ordinal: z.union([z.literal(1), z.literal(2)]),
  retryIndex: z.number().int().min(0).max(52),
  status: z.enum(["running", "complete", "capacity", "unknown", "failed"]),
  startedAt: Time,
  deadline: Time,
  nextEligibleAt: Time.nullable(),
});
const Meta = z.strictObject({
  reservationId: Id,
  callId: Id.nullable(),
  pageOperationId: Id,
  step: z.enum(["screen", "second-look"]),
  model: Id,
  state: z.enum(["reserved", "settled", "uncertain"]),
  estimateUsd: Amount,
  actualUsd: Amount.nullable(),
  countedUsd: Amount,
  elapsedMs: Time.nullable(),
  outcome: z.enum(["ok", "error", "refused"]).nullable(),
  costCertainty: z.enum(["measured", "estimated", "none"]).nullable(),
  settledAt: z.string().nullable(),
});
const Loupe = z.strictObject({
  partId: Id,
  reservationId: Id,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deployment: z.string().max(512).nullable(),
  reservedMinutes: Amount,
  usedMinutes: Amount.nullable(),
  countedMinutes: Amount,
  wakeAt: z.string(),
  settledAt: z.string().nullable(),
  reconciled: z.union([z.literal(0), z.literal(1)]),
});

export async function readExperimentReport(db: D1Database, orgId: string, monitorRunId: string) {
  const identity = await readExperiment(db, orgId, monitorRunId);
  if (!identity) return null;
  // Every query repeats the tenant predicate. Neither a caller-supplied operation ID nor a host joins accounting.
  const rows = await db.batch([
    db
      .prepare(
        `SELECT t.attempt_id AS attemptId,t.operation_id AS pageOperationId,t.phase,t.answer_ordinal AS ordinal,t.retry_index AS retryIndex,t.status,t.started_at AS startedAt,t.deadline,t.next_eligible_at AS nextEligibleAt FROM monitor_experiment_attempts t JOIN monitor_experiment_arms a ON a.monitor_run_id=t.monitor_run_id WHERE a.org_id=? AND a.monitor_run_id=? ORDER BY t.started_at,t.attempt_id`,
      )
      .bind(orgId, monitorRunId),
    db
      .prepare(
        `SELECT s.id AS reservationId,s.call_id AS callId,r.page_operation_id AS pageOperationId,s.step,s.model,s.state,s.estimate_usd AS estimateUsd,s.actual_usd AS actualUsd,coalesce(s.actual_usd,s.estimate_usd) AS countedUsd,s.ms AS elapsedMs,s.outcome,s.cost_certainty AS costCertainty,s.settled_at AS settledAt FROM monitor_experiment_results r JOIN model_spend s ON s.owner='monitor' AND s.monitor_run=r.page_operation_id AND s.step IN ('screen','second-look') WHERE r.org_id=? AND r.monitor_run_id=? ORDER BY s.at,s.id`,
      )
      .bind(orgId, monitorRunId),
    db
      .prepare(
        `SELECT g.id AS partId,g.reservation_id AS reservationId,g.day,g.deployment,g.reserved_minutes AS reservedMinutes,g.used_minutes AS usedMinutes,coalesce(g.used_minutes,g.reserved_minutes) AS countedMinutes,g.wake_at AS wakeAt,g.settled_at AS settledAt,g.reconciled FROM glimmer_runtime g JOIN monitor_experiment_arms a ON a.monitor_run_id=g.reservation_id WHERE a.org_id=? AND a.monitor_run_id=? ORDER BY g.day,g.id`,
      )
      .bind(orgId, monitorRunId),
  ]);
  if (rows.length !== 3 || rows.some((row) => !row.success)) throw new Error("monitor readback unavailable");
  return {
    ...identity,
    attempts: (rows[0]?.results ?? []).map((row) => Attempt.parse(row)),
    accounting: {
      meta: (rows[1]?.results ?? []).map((row) => Meta.parse(row)),
      // Daily parts of one arm reservation, never copied into each page's cost.
      loupe: (rows[2]?.results ?? []).map((row) => Loupe.parse(row)),
    },
  };
}
