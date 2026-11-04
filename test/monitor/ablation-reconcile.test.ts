import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { z } from "zod";
import { attempt } from "../../src/monitor/ablation-attempts";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { reconcileExperimentAttempt } from "../../src/monitor/ablation-reconcile";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { makeOrg } from "../trust/helpers";

async function fixture(phase: "screen" | "wake" = "screen") {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const manifest = {
    version: 1,
    kind: "monitor-screening",
    seed: "reconcile",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    {
      experimentId: "reconcile",
      arm: "full",
      manifestDigest: await manifestDigest(manifest),
      deployment,
      replayRunId: "full",
    },
    manifest,
  );
  const operationId = phase === "wake" ? run.monitorRunId : run.pages[0]?.pageOperationId;
  if (!operationId) throw new Error("fixture");
  const context = {
    monitorRunId: run.monitorRunId,
    operationId,
    phase,
    ordinal: 1 as const,
    requestDigest: "3".repeat(64),
    deadline: 100000,
  };
  let id = "";
  await expect(
    attempt(
      env.DB,
      context,
      z.strictObject({ ready: z.boolean() }),
      async ({ attemptId }) => {
        id = attemptId;
        throw new Error("lost");
      },
      { now: () => 1 },
    ),
  ).rejects.toThrow();
  const principal = { orgId: org, userId: "owner-1", role: "owner" };
  return {
    run,
    context,
    id,
    principal,
    request: { attemptId: id, reservationIds: [phase === "wake" ? run.monitorRunId : id] },
  };
}
it("requires owning owner/admin and canonical terminal accounting; lost response stays failed and cannot resend", async () => {
  const w = await fixture();
  await expect(reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, w.request)).rejects.toThrow();
  await env.DB.prepare(
    `INSERT INTO model_spend(id,at,day,source,caller,model,estimate_usd,state,owner,monitor_run,step,call_id) VALUES(?,'2026-11-04T00:00:00Z','2026-11-04','worker','monitor','model-version',0.25,'uncertain','monitor',?,'screen','call-1')`,
  )
    .bind(w.id, w.context.operationId)
    .run();
  await expect(reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, w.request)).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE model_spend SET state='settled',actual_usd=0.25,settled_at='2026-11-04T00:00:01Z' WHERE id=?",
  )
    .bind(w.id)
    .run();
  await expect(
    reconcileExperimentAttempt(env.DB, { ...w.principal, role: "member" }, w.run.monitorRunId, w.request),
  ).rejects.toThrow();
  await expect(
    reconcileExperimentAttempt(env.DB, { ...w.principal, orgId: await makeOrg() }, w.run.monitorRunId, w.request),
  ).rejects.toThrow();
  await expect(
    reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, { ...w.request, reservationIds: ["foreign"] }),
  ).rejects.toThrow();
  const first = await reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, w.request, 3);
  expect(await reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, w.request, 4)).toEqual(first);
  let sends = 0;
  await expect(
    attempt(
      env.DB,
      w.context,
      z.strictObject({ ready: z.boolean() }),
      async () => {
        sends++;
        return { ready: true };
      },
      { now: () => 5 },
    ),
  ).rejects.toThrow();
  expect(sends).toBe(0);
  expect(await env.DB.prepare("SELECT state,actual_usd FROM model_spend WHERE id=?").bind(w.id).first()).toEqual({
    state: "settled",
    actual_usd: 0.25,
  });
});
it("keeps a Loupe attempt held until every daily burst part is settled and reconciled", async () => {
  const w = await fixture("wake");
  for (const day of ["2026-11-04", "2026-11-05"])
    await env.DB.prepare(
      `INSERT INTO glimmer_runtime(id,reservation_id,day,source,caller,purpose,wake_at,reserved_minutes) VALUES(?, ?,?,'worker','monitor','experiment','2026-11-04T21:59:00Z',2)`,
    )
      .bind(`${w.id}-${day}`, w.run.monitorRunId, day)
      .run();
  await env.DB.prepare(
    "UPDATE glimmer_runtime SET settled_at='2026-11-04T22:01:00Z',used_minutes=1,reconciled=1 WHERE reservation_id=? AND day='2026-11-04'",
  )
    .bind(w.run.monitorRunId)
    .run();
  await expect(reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, w.request)).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE glimmer_runtime SET settled_at='2026-11-04T22:01:00Z',used_minutes=1,reconciled=1 WHERE reservation_id=?",
  )
    .bind(w.run.monitorRunId)
    .run();
  expect(await reconcileExperimentAttempt(env.DB, w.principal, w.run.monitorRunId, w.request, 5)).toMatchObject({
    actorId: "owner-1",
    at: 5,
    reservationIds: [w.run.monitorRunId],
  });
});
