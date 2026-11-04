// Experimental scheduling is separate from daily discovery, its short retries and its publication side effects.
import { z } from "zod";
import { PendingAttempt } from "./ablation-attempts";
import { ExperimentId } from "./ablation-manifest";
import { runExperiment } from "./ablation-run";
import { readExperiment } from "./ablation-store";

export const ExperimentParams = z.strictObject({
  orgId: z.string().min(1).max(128),
  experimentRunId: ExperimentId,
});
const Pass = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("waiting"), until: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ status: z.literal("complete") }),
  z.strictObject({ status: z.literal("failed") }),
]);
type Pass = z.infer<typeof Pass>;
export interface ExperimentSteps {
  do(
    name: string,
    config: { retries: { limit: 0; delay: "1 second" }; timeout: "30 minutes" },
    run: () => Promise<Pass>,
  ): Promise<Pass>;
  sleepUntil(name: string, timestamp: number): Promise<void>;
}

export async function runExperimentWorkflow(
  env: Env,
  step: ExperimentSteps,
  input: unknown,
  execute: typeof runExperiment = runExperiment,
) {
  const params = ExperimentParams.parse(input);
  for (let iteration = 0; ; iteration++) {
    const result = Pass.parse(
      await step.do(
        `experiment-pass-${iteration}`,
        { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" },
        async () => {
          try {
            const report = await execute(env, params.orgId, params.experimentRunId);
            if (report?.status !== "complete" && report?.status !== "failed")
              throw new Error("monitor experiment incomplete");
            return { status: report.status };
          } catch (error) {
            if (!(error instanceof PendingAttempt) || error.state !== "capacity" || error.nextEligibleAt === null)
              throw new Error("monitor experiment held");
            const run = await readExperiment(env.DB, params.orgId, params.experimentRunId);
            if (run?.status !== "waiting") throw new Error("monitor experiment held");
            // Use the persisted latest attempt, never a fresh backoff computed on Workflow replay.
            const capacity = await env.DB.prepare(
              `SELECT min(t.deadline) AS deadline FROM monitor_experiment_attempts t WHERE t.monitor_run_id=? AND t.status='capacity' AND t.next_eligible_at=? AND NOT EXISTS(SELECT 1 FROM monitor_experiment_attempts n WHERE n.monitor_run_id=t.monitor_run_id AND n.operation_id=t.operation_id AND n.phase=t.phase AND n.answer_ordinal=t.answer_ordinal AND n.retry_index>t.retry_index)`,
            )
              .bind(params.experimentRunId, error.nextEligibleAt)
              .first<{ deadline: number | null }>();
            if (capacity?.deadline === null || capacity?.deadline === undefined)
              throw new Error("monitor experiment held");
            // Wake at the original expiry if a longer capacity wait outlives it. The adapter then refuses another send.
            const until = Math.min(error.nextEligibleAt, capacity.deadline, run.sparkDeadline);
            if (!Number.isSafeInteger(until) || until <= Date.now()) throw new Error("monitor experiment held");
            return { status: "waiting", until };
          }
        },
      ),
    );
    if (result.status === "complete") return { monitorRunId: params.experimentRunId, status: "complete" as const };
    if (result.status === "failed") throw new Error("monitor experiment failed");
    await step.sleepUntil(`experiment-capacity-${iteration}`, result.until);
  }
}
