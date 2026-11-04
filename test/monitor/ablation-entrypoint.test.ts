import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { readExperimentReport } from "../../src/monitor/ablation-readback";
import { reconcileExperimentAttempt } from "../../src/monitor/ablation-reconcile";
import { monitorFixture } from "./ablation-fixture";

const org = "monitor-experiment-fixture";
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM organization WHERE id=?").bind(org).run();
});
async function fixture() {
  await env.DB.prepare('INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)')
    .bind(org, "Fictional monitor experiment", org, new Date().toISOString())
    .run();
  const w = await monitorFixture(false, org, 1, env.COMMIT_SHA);
  const arm = await w.admitted("no-screening");
  return { ...w, arm };
}
function response() {
  return new Response(
    JSON.stringify({
      id: "synthetic-monitor",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                brand: null,
                has_login_form: true,
                has_payment_form: false,
                lure: false,
                lure_type: "none",
                confidence: 0.9,
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
it("dispatches the actual Monitor Workflow into immutable experimental screening, with no ordinary run", async () => {
  const w = await fixture();
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (!url.endsWith("/responses")) throw new Error("unexpected network operation");
    return response();
  });
  const instance = await introspectWorkflowInstance(env.MONITOR, w.arm.monitorRunId);
  try {
    await env.MONITOR.create({
      id: w.arm.monitorRunId,
      params: { orgId: org, experimentRunId: w.arm.monitorRunId },
    });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ monitorRunId: w.arm.monitorRunId, status: "complete" });
    expect(calls).toHaveLength(1);
    expect(await readExperimentReport(env.DB, org, w.arm.monitorRunId)).toMatchObject({
      status: "complete",
      pages: [{ checkpoint: { screen: { tier: "spark", ablated: "no-screening" } } }],
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM monitor_runs WHERE org_id=?").bind(org).first()).toEqual({
      n: 0,
    });
  } finally {
    await instance.dispose();
  }
});
it("keeps actual Workflow restart from replaying a reconciled lost paid response", async () => {
  const w = await fixture();
  let sends = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    sends++;
    throw new Error("lost response");
  });
  const instance = await introspectWorkflowInstance(env.MONITOR, w.arm.monitorRunId);
  try {
    const workflow = await env.MONITOR.create({
      id: w.arm.monitorRunId,
      params: { orgId: org, experimentRunId: w.arm.monitorRunId },
    });
    await instance.waitForStatus("errored");
    expect(sends).toBe(1);
    const lost = await env.DB.prepare(
      "SELECT attempt_id FROM monitor_experiment_attempts WHERE monitor_run_id=? AND phase='screen'",
    )
      .bind(w.arm.monitorRunId)
      .first<{ attempt_id: string }>();
    if (!lost) throw new Error("missing paid attempt");
    // Synthetic canonical provider settlement, not an assertion made by the reconciliation endpoint.
    await env.DB.prepare("UPDATE model_spend SET state='settled',actual_usd=estimate_usd,settled_at=? WHERE id=?")
      .bind(new Date().toISOString(), lost.attempt_id)
      .run();
    await reconcileExperimentAttempt(env.DB, { orgId: org, userId: "owner", role: "owner" }, w.arm.monitorRunId, {
      attemptId: lost.attempt_id,
      reservationIds: [lost.attempt_id],
    });
    await env.DB.prepare("UPDATE monitor_experiment_arms SET status='waiting' WHERE monitor_run_id=?")
      .bind(w.arm.monitorRunId)
      .run();
    await workflow.restart();
    await instance.waitForStatus("errored");
    expect(sends).toBe(1);
    expect(await readExperimentReport(env.DB, org, w.arm.monitorRunId)).toMatchObject({
      status: "failed",
      pages: [{ checkpoint: { screen: null, unrecoverable: "screen" } }],
    });
  } finally {
    await instance.dispose();
  }
});
it("rejects mismatched Workflow identity and mixed ordinary/experimental payloads before any operation", async () => {
  const w = await fixture();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected");
  });
  for (const mixed of [false, true]) {
    const id = mixed ? w.arm.monitorRunId : `wrong-${crypto.randomUUID()}`;
    const instance = await introspectWorkflowInstance(env.MONITOR, id);
    try {
      await env.MONITOR.create({
        id,
        params: { orgId: org, experimentRunId: w.arm.monitorRunId, ...(mixed ? { day: "2026-11-04" } : {}) },
      });
      await instance.waitForStatus("errored");
    } finally {
      await instance.dispose();
    }
  }
  expect(spy).not.toHaveBeenCalled();
  expect(await readExperimentReport(env.DB, org, w.arm.monitorRunId)).toMatchObject({
    status: "pending",
    attempts: [],
  });
});
