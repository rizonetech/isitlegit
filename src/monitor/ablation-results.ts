// Validated page checkpoints. Completed screening survives a later second-look interruption.
import { z } from "zod";
import { LURE_TYPES, PageAnswer } from "../vision/page-screen";
import { MonitorIdentityConflict } from "./ablation-store";

const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Reason = z.string().min(1).max(128);
const Call = z.strictObject({ callId: z.string().min(1).max(256), logId: z.string().max(256).nullable() });
const GlimmerReason = z.enum([
  "ablated",
  "not_configured",
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
]);
export const ScreenResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    screen: PageAnswer.safeExtend({ screener: z.enum(["glimmer", "spark"]) }),
    glimmer_reason: GlimmerReason.nullable(),
    spark_call: Call.nullable(),
    tier: z.enum(["glimmer", "spark", "spark-second"]),
    escalation: z.enum(["loupe-unsure", "spark-unsure"]).nullable(),
    spark_calls: z.array(Call).max(2),
    ablated: z.literal("no-screening").optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    glimmer_reason: GlimmerReason,
    spark_reason: Reason,
    spark_calls: z.array(Call).max(2),
    ablated: z.literal("no-screening").optional(),
  }),
]);
const Second = z.union([
  z.strictObject({
    verdict: z.enum(["confirmed", "declined"]),
    lureType: z.enum(LURE_TYPES),
    callId: z.string().min(1).max(256),
    logId: z.string().max(256).nullable(),
  }),
  z.strictObject({ verdict: z.literal("unavailable"), reason: Reason }),
]);
export const PageCheckpoint = z
  .strictObject({
    version: z.literal(1),
    startedAt: Time,
    screenedAt: Time,
    parked: z.strictObject({ reason: Reason }).nullable(),
    screen: ScreenResult.nullable(),
    secondLook: Second.nullable(),
    finishedAt: Time.nullable(),
  })
  .superRefine((r, ctx) => {
    const needsSecond = !!(r.screen?.ok && r.screen.screen.screener === "glimmer" && r.screen.screen.lure);
    const screen = r.screen;
    if (
      screen?.ok &&
      ((screen.tier === "glimmer") !== (screen.screen.screener === "glimmer") ||
        (screen.ablated !== undefined &&
          (screen.screen.screener === "glimmer" || screen.glimmer_reason !== "ablated")) ||
        (screen.tier === "glimmer" && (screen.spark_call !== null || screen.spark_calls.length !== 0)) ||
        (screen.tier !== "glimmer" &&
          (screen.spark_call === null ||
            screen.spark_calls.length === 0 ||
            JSON.stringify(screen.spark_call) !== JSON.stringify(screen.spark_calls.at(-1)))))
    )
      ctx.addIssue({ code: "custom", message: "inconsistent monitor attribution" });
    if (
      (r.parked === null) === (r.screen === null) ||
      r.screenedAt < r.startedAt ||
      (r.finishedAt !== null && r.finishedAt < r.screenedAt) ||
      (r.secondLook !== null && !needsSecond) ||
      (r.finishedAt !== null && needsSecond && r.secondLook === null)
    )
      ctx.addIssue({ code: "custom", message: "invalid monitor checkpoint" });
  });
export type PageCheckpoint = z.infer<typeof PageCheckpoint>;

export async function readPageCheckpoint(
  db: D1Database,
  orgId: string,
  monitorRunId: string,
  operationId: string,
): Promise<PageCheckpoint | null> {
  const row = await db
    .prepare(
      "SELECT result_json FROM monitor_experiment_results WHERE org_id=? AND monitor_run_id=? AND page_operation_id=?",
    )
    .bind(orgId, monitorRunId, operationId)
    .first<{ result_json: string | null }>();
  if (!row) throw new MonitorIdentityConflict();
  return row.result_json === null ? null : PageCheckpoint.parse(JSON.parse(row.result_json));
}
export async function savePageCheckpoint(
  db: D1Database,
  orgId: string,
  monitorRunId: string,
  operationId: string,
  input: PageCheckpoint,
): Promise<void> {
  const next = PageCheckpoint.parse(input);
  const prior = await readPageCheckpoint(db, orgId, monitorRunId, operationId);
  const json = JSON.stringify(next);
  const old = prior === null ? null : JSON.stringify(prior);
  if (old === json) return;
  // A successor may only append second-look/final timing to the same recorded screen. It cannot revise an answer.
  if (
    prior &&
    (prior.finishedAt !== null ||
      JSON.stringify({ ...prior, secondLook: null, finishedAt: null }) !==
        JSON.stringify({ ...next, secondLook: null, finishedAt: null }) ||
      (prior.secondLook !== null && JSON.stringify(prior.secondLook) !== JSON.stringify(next.secondLook)))
  )
    throw new MonitorIdentityConflict();
  if (json.length > 16384) throw new MonitorIdentityConflict();
  const status = next.finishedAt === null ? "running" : next.screen?.ok === false ? "failed" : "complete";
  const result = await db
    .prepare(
      "UPDATE monitor_experiment_results SET result_json=?,status=? WHERE org_id=? AND monitor_run_id=? AND page_operation_id=? AND result_json IS ?",
    )
    .bind(json, status, orgId, monitorRunId, operationId, old)
    .run();
  if (result.meta.changes !== 1) {
    const actual = await readPageCheckpoint(db, orgId, monitorRunId, operationId);
    if (JSON.stringify(actual) !== json) throw new MonitorIdentityConflict();
  }
}
