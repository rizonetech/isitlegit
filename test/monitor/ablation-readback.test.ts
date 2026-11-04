import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { readExperimentReport } from "../../src/monitor/ablation-readback";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { makeOrg } from "../trust/helpers";

async function fixture(versions = modelVersions()) {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const manifest = {
    version: 1,
    kind: "monitor-screening",
    seed: "readback",
    deployment,
    modelVersions: versions,
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    {
      experimentId: "readback",
      arm: "full",
      manifestDigest: await manifestDigest(manifest),
      deployment,
      replayRunId: "full",
    },
    manifest,
  );
  const operation = run.pages[0]?.pageOperationId;
  if (!operation) throw new Error("fixture missing operation");
  return { org, run, operation };
}
it("reads persisted ownership without an admission setting and excludes another tenant", async () => {
  const { org, run } = await fixture();
  expect(await readExperimentReport(env.DB, org, run.monitorRunId)).toMatchObject({
    monitorRunId: run.monitorRunId,
    pages: [{ experimentCaseId: "e1" }],
    accounting: { meta: [], loupe: [] },
    attempts: [],
  });
  expect(await readExperimentReport(env.DB, await makeOrg(), run.monitorRunId)).toBeNull();
});
it("retains unknown charges and opaque attempt linkage without exposing stored answer metadata", async () => {
  const { org, run, operation } = await fixture();
  await env.DB.prepare(
    `INSERT INTO monitor_experiment_attempts(attempt_id,monitor_run_id,operation_id,phase,answer_ordinal,retry_index,request_digest,status,started_at,deadline,metadata_json) VALUES('attempt-r',?,?,'screen',1,0,?,'unknown',1,255000,?)`,
  )
    .bind(run.monitorRunId, operation, "3".repeat(64), JSON.stringify({ private: "must-not-leak" }))
    .run();
  await env.DB.prepare(
    `INSERT INTO model_spend(id,at,day,source,caller,model,estimate_usd,state,owner,monitor_run,step,call_id) VALUES('attempt-r','2026-11-04T00:00:00Z','2026-11-04','worker','monitor','model-version',0.25,'uncertain','monitor',?,'screen','call-r')`,
  )
    .bind(operation)
    .run();
  await env.DB.prepare(
    `INSERT INTO model_spend(id,at,day,source,caller,model,estimate_usd,state,owner,monitor_run,step) VALUES('foreign-r','2026-11-04T00:00:00Z','2026-11-04','worker','monitor','other',99,'reserved','monitor','other-operation','screen')`,
  ).run();
  const result = await readExperimentReport(env.DB, org, run.monitorRunId);
  expect(result?.attempts).toMatchObject([{ attemptId: "attempt-r", status: "unknown", pageOperationId: operation }]);
  expect(result?.accounting.meta).toMatchObject([
    {
      reservationId: "attempt-r",
      callId: "call-r",
      state: "uncertain",
      estimateUsd: 0.25,
      actualUsd: null,
      countedUsd: 0.25,
    },
  ]);
  expect(result?.accounting.meta).toHaveLength(1);
  await env.DB.prepare("UPDATE model_spend SET actual_usd=0 WHERE id='attempt-r'").run();
  expect((await readExperimentReport(env.DB, org, run.monitorRunId))?.accounting.meta[0]?.countedUsd).toBe(0.25);
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
  expect(JSON.stringify(result)).not.toContain("screen_nonce");
});
it("reports the arm burst once with its daily parts and preserves unknown minutes", async () => {
  const { org, run } = await fixture();
  for (const [i, day] of ["2026-11-04", "2026-11-05"].entries()) {
    await env.DB.prepare(
      `INSERT INTO glimmer_runtime(id,reservation_id,day,source,caller,purpose,wake_at,reserved_minutes) VALUES(?,? ,?,'worker','monitor','experiment','2026-11-04T21:59:00Z',2)`,
    )
      .bind(`readback-${i}`, run.monitorRunId, day)
      .run();
  }
  const result = await readExperimentReport(env.DB, org, run.monitorRunId);
  expect(result?.accounting.loupe).toHaveLength(2);
  expect(result?.accounting.loupe.map((p) => p.countedMinutes)).toEqual([2, 2]);
  expect(result?.accounting.loupe.every((p) => p.reservationId === run.monitorRunId && p.usedMinutes === null)).toBe(
    true,
  );
});
it("returns validated stored results and refuses corrupt persisted fields", async () => {
  const { org, run, operation } = await fixture();
  const checkpoint = {
    version: 1,
    startedAt: 1,
    screenedAt: 2,
    parked: { reason: "empty" },
    screen: null,
    secondLook: null,
    finishedAt: 2,
  };
  await env.DB.prepare(
    "UPDATE monitor_experiment_results SET result_json=?,status='complete' WHERE page_operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), operation)
    .run();
  expect((await readExperimentReport(env.DB, org, run.monitorRunId))?.pages[0]).toMatchObject({ checkpoint });
  await env.DB.prepare("UPDATE monitor_experiment_results SET result_json=? WHERE page_operation_id=?")
    .bind(JSON.stringify({ ...checkpoint, privateText: "must-not-leak" }), operation)
    .run();
  await expect(readExperimentReport(env.DB, org, run.monitorRunId)).rejects.toThrow();
});

it("retains exact admitted model revisions and settings in historical readback", async () => {
  const versions = { loupe: "historical-loupe-revision", spark: "historical-spark-revision" };
  const { org, run } = await fixture(versions);
  expect(await readExperimentReport(env.DB, org, run.monitorRunId)).toMatchObject({
    modelVersions: versions,
    settingsDigest: await settingsDigest("a".repeat(40)),
  });
  await expect(
    env.DB.prepare("UPDATE monitor_experiments SET model_versions_json=? WHERE org_id=?")
      .bind(JSON.stringify(modelVersions()), org)
      .run(),
  ).rejects.toThrow();
});
