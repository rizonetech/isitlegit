import { z } from "zod";
import { d1Exec, findBurst } from "../vision/glimmer-minutes";
import { type Answer, WARMUP_LIMIT_MS, type WakeCtx } from "../vision/glimmer-wake";
import { AttemptFailure, attempt, PendingAttempt } from "./ablation-attempts";
import { Deployment, ExperimentId, sha256 } from "./ablation-manifest";

const Reply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("final"),
    outcome: z.discriminatedUnion("outcome", [
      z.strictObject({ outcome: z.literal("deployment_missing"), notice: z.literal("not_configured") }),
      z.strictObject({ outcome: z.literal("unauthorized"), status: z.number().int().min(100).max(599) }),
      z.strictObject({ outcome: z.literal("bad_answer"), status: z.number().int().min(100).max(599) }),
    ]),
  }),
]);
export function wakeExperiment(c: {
  db: D1Database;
  monitorRunId: string;
  deployment: string;
  now?: () => number;
  jitter?: () => number;
}): NonNullable<WakeCtx["experiment"]> {
  ExperimentId.parse(c.monitorRunId);
  Deployment.parse(c.deployment);
  return {
    async assertOwner() {
      const row = await c.db
        .prepare(
          `SELECT a.arm,e.deployment FROM monitor_experiment_arms a JOIN monitor_experiments e ON e.org_id=a.org_id AND e.experiment_id=a.experiment_id WHERE a.monitor_run_id=?`,
        )
        .bind(c.monitorRunId)
        .first<{ arm: string; deployment: string }>();
      if (row?.arm !== "full" || row.deployment !== c.deployment) throw new PendingAttempt("conflict");
    },
    async probe(burst, body, send): Promise<Answer> {
      const ledger = await findBurst(d1Exec(c.db), c.monitorRunId);
      if (
        !ledger ||
        ledger.settled ||
        burst.id !== c.monitorRunId ||
        burst.wakeAt !== Date.parse(ledger.wakeAt) ||
        burst.deadline !== burst.wakeAt + WARMUP_LIMIT_MS
      )
        throw new PendingAttempt("conflict");
      const digest = await sha256(new TextEncoder().encode(JSON.stringify({ deployment: c.deployment, body })));
      try {
        return await attempt(
          c.db,
          {
            monitorRunId: c.monitorRunId,
            operationId: c.monitorRunId,
            phase: "wake",
            ordinal: 1,
            requestDigest: digest,
            deadline: burst.deadline,
          },
          Reply,
          async ({ attemptId }) => {
            const answer = await send(attemptId);
            if (answer.kind === "retry")
              throw new AttemptFailure(
                answer.capacity
                  ? {
                      kind: "capacity",
                      ...(answer.status !== undefined ? { status: answer.status } : {}),
                      ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
                    }
                  : { kind: "unknown" },
              );
            return Reply.parse(answer);
          },
          { ...(c.now ? { now: c.now } : {}), ...(c.jitter ? { jitter: c.jitter } : {}) },
        );
      } catch (error) {
        // A known expired capacity window ends Loupe use. Unknown sends are checked before expiry by the durable claim.
        if (error instanceof PendingAttempt && error.state === "expired") return { kind: "retry", why: "warming" };
        throw error;
      }
    },
  };
}
