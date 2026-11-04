import { z } from "zod";
import { DEPLOYED, TAIL_MINUTES } from "../vision/glimmer-caps";
import { pageAnswerSchema } from "../vision/page-screen";
import type { ScreeningExperiment } from "../vision/screen";
import { AttemptFailure, attempt, PendingAttempt } from "./ablation-attempts";
import { Deployment, ExperimentId, sha256 } from "./ablation-manifest";

const Answer = z.union([
  z.strictObject({ answer: pageAnswerSchema(DEPLOYED.version) }),
  z.strictObject({
    reason: z.enum([
      "ablated",
      "not_configured",
      "disabled",
      "refused",
      "burst_closed",
      "out_of_window",
      "warming",
      "deployment_missing",
      "unauthorized",
      "bad_answer",
      "error",
      "timeout",
      "unsure",
      "schema",
    ]),
  }),
]);
export function loupeExperiment(c: {
  db: D1Database;
  monitorRunId: string;
  deployment: string;
  now?: () => number;
  jitter?: () => number;
}): ScreeningExperiment {
  ExperimentId.parse(c.monitorRunId);
  Deployment.parse(c.deployment);
  return {
    async infer(operationId, body, deadline, send) {
      const owned = await c.db
        .prepare(
          `SELECT e.deployment,a.arm FROM monitor_experiment_results r JOIN monitor_experiment_arms a ON a.monitor_run_id=r.monitor_run_id JOIN monitor_experiments e ON e.org_id=a.org_id AND e.experiment_id=a.experiment_id WHERE r.monitor_run_id=? AND r.page_operation_id=?`,
        )
        .bind(c.monitorRunId, operationId)
        .first<{ deployment: string; arm: string }>();
      if (owned?.deployment !== c.deployment || owned.arm !== "full") throw new PendingAttempt("conflict");
      const reservation = await c.db
        .prepare(
          "SELECT min(wake_at) AS wakeAt,sum(reserved_minutes) AS minutes,max(settled_at) AS settled FROM glimmer_runtime WHERE reservation_id=?",
        )
        .bind(c.monitorRunId)
        .first<{ wakeAt: string | null; minutes: number | null; settled: string | null }>();
      if (!reservation?.wakeAt || reservation.minutes === null || reservation.settled)
        throw new PendingAttempt("conflict");
      const reservedUntil = Date.parse(reservation.wakeAt) + (reservation.minutes - TAIL_MINUTES) * 60000;
      if (!Number.isSafeInteger(deadline) || deadline > reservedUntil + 1) throw new PendingAttempt("conflict");
      const down = await c.db
        .prepare(
          `SELECT metadata_json FROM monitor_experiment_attempts WHERE monitor_run_id=? AND phase='loupe' AND status='complete' AND json_extract(metadata_json,'$.value.reason') IN ('deployment_missing','unauthorized') LIMIT 1`,
        )
        .bind(c.monitorRunId)
        .first<{ metadata_json: string }>();
      if (down) return Answer.parse(JSON.parse(down.metadata_json).value);
      const digest = await sha256(new TextEncoder().encode(JSON.stringify({ deployment: c.deployment, body })));
      try {
        return await attempt(
          c.db,
          {
            monitorRunId: c.monitorRunId,
            operationId,
            phase: "loupe",
            ordinal: 1,
            requestDigest: digest,
            deadline: Math.min(deadline, Math.floor(reservedUntil)),
          },
          Answer,
          async ({ attemptId }) => {
            const result = await send(attemptId);
            if ("reason" in result && result.failure) throw new AttemptFailure(result.failure);
            return Answer.parse(result);
          },
          { ...(c.now ? { now: c.now } : {}), ...(c.jitter ? { jitter: c.jitter } : {}) },
        );
      } catch (error) {
        if (error instanceof PendingAttempt && error.state === "expired") return { reason: "out_of_window" };
        throw error;
      }
    },
    async settlementAllowed() {
      const held = await c.db
        .prepare(
          "SELECT 1 FROM monitor_experiment_attempts WHERE monitor_run_id=? AND phase IN ('wake','loupe') AND status IN ('running','unknown') LIMIT 1",
        )
        .bind(c.monitorRunId)
        .first();
      return !held;
    },
  };
}
