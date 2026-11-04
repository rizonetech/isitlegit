// Bookkeeping only. Canonical settled ledgers may close a lost response, never authorize its replay or invent success.
import { z } from "zod";
import { ExperimentId } from "./ablation-manifest";
import { MonitorIdentityConflict } from "./ablation-store";

export const ReconcileRequest = z.strictObject({
  attemptId: ExperimentId,
  reservationIds: z.array(ExperimentId).length(1),
});
const Audit = z.strictObject({
  kind: z.literal("failed"),
  reconciliation: z.strictObject({
    actorId: z.string().min(1).max(128),
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reservationIds: z.array(ExperimentId).length(1),
    priorStatus: z.enum(["running", "unknown"]),
  }),
});
export class MonitorReconciliationRefused extends Error {
  constructor() {
    super("monitor reconciliation refused");
    this.name = "MonitorReconciliationRefused";
  }
}
export async function reconcileExperimentAttempt(
  db: D1Database,
  principal: { orgId: string; userId: string; role: string },
  monitorRunId: string,
  input: unknown,
  now = Date.now(),
) {
  if (principal.role !== "owner" && principal.role !== "admin") throw new MonitorReconciliationRefused();
  const request = ReconcileRequest.parse(input);
  const row = await db
    .prepare(
      `SELECT t.operation_id,t.phase,t.status,t.metadata_json FROM monitor_experiment_attempts t JOIN monitor_experiment_arms a ON a.monitor_run_id=t.monitor_run_id WHERE a.org_id=? AND a.monitor_run_id=? AND t.attempt_id=?`,
    )
    .bind(principal.orgId, monitorRunId, request.attemptId)
    .first<{ operation_id: string; phase: string; status: string; metadata_json: string | null }>();
  if (!row) throw new MonitorReconciliationRefused();
  const loupe = row.phase === "wake" || row.phase === "loupe";
  const expected = loupe ? monitorRunId : request.attemptId;
  if (request.reservationIds[0] !== expected) throw new MonitorIdentityConflict();
  if (row.status === "failed") {
    let prior: z.infer<typeof Audit>;
    try {
      prior = Audit.parse(JSON.parse(row.metadata_json ?? "null"));
    } catch {
      throw new MonitorIdentityConflict();
    }
    if (JSON.stringify(prior.reconciliation.reservationIds) !== JSON.stringify(request.reservationIds))
      throw new MonitorIdentityConflict();
    return prior.reconciliation;
  }
  if (row.status !== "running" && row.status !== "unknown") throw new MonitorIdentityConflict();
  const audit = Audit.parse({
    kind: "failed",
    reconciliation: {
      actorId: principal.userId,
      at: now,
      reservationIds: request.reservationIds,
      priorStatus: row.status,
    },
  });
  const metadata = JSON.stringify(audit);
  // The immutable attempt owns one Meta reservation, or the arm's single Loupe burst. Unknown/missing ledger rows fail closed.
  const proof = loupe
    ? `EXISTS(SELECT 1 FROM glimmer_runtime g WHERE g.reservation_id=monitor_experiment_attempts.monitor_run_id) AND NOT EXISTS(SELECT 1 FROM glimmer_runtime g WHERE g.reservation_id=monitor_experiment_attempts.monitor_run_id AND (g.settled_at IS NULL OR g.used_minutes IS NULL OR g.reconciled!=1))`
    : `EXISTS(SELECT 1 FROM model_spend s WHERE s.id=monitor_experiment_attempts.attempt_id AND s.owner='monitor' AND s.monitor_run=monitor_experiment_attempts.operation_id AND s.step=monitor_experiment_attempts.phase AND s.state='settled' AND s.actual_usd IS NOT NULL AND s.call_id IS NOT NULL AND s.settled_at IS NOT NULL)`;
  const updated = await db
    .prepare(
      `UPDATE monitor_experiment_attempts SET status='failed',metadata_json=? WHERE attempt_id=? AND monitor_run_id=? AND status=? AND metadata_json IS ? AND ${proof} AND EXISTS(SELECT 1 FROM monitor_experiment_arms a WHERE a.monitor_run_id=monitor_experiment_attempts.monitor_run_id AND a.org_id=?)`,
    )
    .bind(metadata, request.attemptId, monitorRunId, row.status, row.metadata_json, principal.orgId)
    .run();
  if (updated.meta.changes !== 1) throw new MonitorIdentityConflict();
  return audit.reconciliation;
}

export async function reconciledSecondLook(
  db: D1Database,
  monitorRunId: string,
  operationId: string,
): Promise<boolean> {
  const rows = await db
    .prepare(
      "SELECT metadata_json FROM monitor_experiment_attempts WHERE monitor_run_id=? AND operation_id=? AND phase='second-look' AND status='failed'",
    )
    .bind(monitorRunId, operationId)
    .all<{ metadata_json: string | null }>();
  return rows.results.some((row) => {
    try {
      return Audit.safeParse(JSON.parse(row.metadata_json ?? "null")).success;
    } catch {
      return false;
    }
  });
}
