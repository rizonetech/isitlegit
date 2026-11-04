// Worker-only persistence behind the portable structured helper. Public routes never accept this adapter or its state.
import { z } from "zod";
import type { StructuredContinuation } from "../meta/structured";
import { AttemptFailure, attempt, PendingAttempt } from "./ablation-attempts";
import { Deployment, ExperimentId } from "./ablation-manifest";

const Binding = z.strictObject({
  monitorRunId: ExperimentId,
  operationId: ExperimentId,
  phase: z.enum(["screen", "second-look"]),
  deployment: Deployment,
  deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ordinal: z.union([z.literal(1), z.literal(2)]).optional(),
});
export type StructuredBinding = z.infer<typeof Binding> & { db: D1Database };
export function structuredContinuation(input: StructuredBinding): StructuredContinuation {
  const { db, ...raw } = input;
  const c = Binding.parse(raw);
  return {
    ...c,
    ordinal: c.ordinal ?? 1,
    async assertOwner(owner) {
      if (owner.kind !== "monitor" || owner.run !== c.operationId || owner.step !== c.phase)
        throw new PendingAttempt("conflict");
      const row = await db
        .prepare(
          `SELECT e.deployment FROM monitor_experiment_results r JOIN monitor_experiment_arms a ON a.monitor_run_id=r.monitor_run_id JOIN monitor_experiments e ON e.org_id=a.org_id AND e.experiment_id=a.experiment_id WHERE r.monitor_run_id=? AND r.page_operation_id=?`,
        )
        .bind(c.monitorRunId, c.operationId)
        .first<{ deployment: string }>();
      if (row?.deployment !== c.deployment) throw new PendingAttempt("conflict");
    },
    execute: (ordinal, digest, schema, send) =>
      attempt(
        db,
        {
          monitorRunId: c.monitorRunId,
          operationId: c.operationId,
          phase: c.phase,
          ordinal,
          requestDigest: digest,
          deadline: c.deadline,
        },
        schema,
        send,
      ),
    async verify(call, ordinal, kind, snapshot, failure) {
      const paid = await db
        .prepare(
          `SELECT s.state,s.outcome,s.error_class,a.metadata_json,a.status AS attempt_status FROM model_spend s JOIN monitor_experiment_attempts a ON a.attempt_id=s.id WHERE s.id=? AND s.call_id=? AND s.owner='monitor' AND s.monitor_run=? AND s.step=? AND a.monitor_run_id=? AND a.operation_id=? AND a.phase=? AND a.answer_ordinal=?`,
        )
        .bind(call.reservationId, call.callId, c.operationId, c.phase, c.monitorRunId, c.operationId, c.phase, ordinal)
        .first<{
          state: string;
          outcome: string;
          error_class: string | null;
          metadata_json: string | null;
          attempt_status: string;
        }>();
      let recorded: unknown;
      try {
        recorded = z.strictObject({ value: z.unknown() }).parse(JSON.parse(paid?.metadata_json ?? "null")).value;
      } catch {
        return false;
      }
      return (
        paid?.state === "settled" &&
        paid.attempt_status === "complete" &&
        JSON.stringify(recorded) === JSON.stringify(snapshot) &&
        (kind === "valid" ? paid.outcome === "ok" : paid.error_class === `output-${failure}`)
      );
    },
    failure: (value) => new AttemptFailure(value),
    blocked: () => new PendingAttempt("unknown"),
  };
}
