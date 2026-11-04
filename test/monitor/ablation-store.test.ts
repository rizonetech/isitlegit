import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { admitExperiment, readExperiment } from "../../src/monitor/ablation-store";
import { makeOrg } from "../trust/helpers";

async function inputs() {
  const deployment = "a".repeat(40);
  const manifest = {
    version: 1 as const,
    kind: "monitor-screening" as const,
    seed: "test",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  return {
    manifest,
    request: {
      experimentId: "experiment-1",
      arm: "full" as const,
      manifestDigest: await manifestDigest(manifest),
      deployment,
      replayRunId: "arm-full",
    },
  };
}
describe("durable monitor experiment identity", () => {
  it("concurrent identical admissions retain one run and one page operation identity", async () => {
    const org = await makeOrg();
    const { manifest, request } = await inputs();
    const [a, b] = await Promise.all([
      admitExperiment(env.DB, org, request, manifest),
      admitExperiment(env.DB, org, request, manifest),
    ]);
    expect(a.monitorRunId).toBe(b.monitorRunId);
    expect(a.pages[0]?.pageOperationId).toBe(b.pages[0]?.pageOperationId);
    expect(a.status).toBe("pending");
    expect(await readExperiment(env.DB, await makeOrg(), a.monitorRunId)).toBeNull();
  });
  it("keeps arms distinct and refuses changed replay/manifest without partial writes", async () => {
    const org = await makeOrg();
    const { manifest, request } = await inputs();
    const a = await admitExperiment(env.DB, org, request, manifest);
    await expect(admitExperiment(env.DB, org, { ...request, replayRunId: "different" }, manifest)).rejects.toThrow();
    const b = await admitExperiment(
      env.DB,
      org,
      { ...request, arm: "no-screening", replayRunId: "other-arm" },
      manifest,
    );
    expect(b.monitorRunId).not.toBe(a.monitorRunId);
    expect(b.pages[0]?.pageOperationId).not.toBe(a.pages[0]?.pageOperationId);
    const changed = { ...manifest, seed: "changed" };
    await expect(
      admitExperiment(env.DB, org, { ...request, manifestDigest: await manifestDigest(changed) }, changed),
    ).rejects.toThrow();
    expect(await readExperiment(env.DB, org, a.monitorRunId)).toEqual(a);
    await expect(admitExperiment(env.DB, org, { ...request, experimentId: "another" }, manifest)).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT experiment_id FROM monitor_experiments WHERE org_id=?").bind(org).all(),
    ).toMatchObject({ results: [{ experiment_id: "experiment-1" }] });
  });
  it("database constraints reject identity mutation and ordinary organization retention cascades", async () => {
    const org = await makeOrg();
    const { manifest, request } = await inputs();
    const run = await admitExperiment(env.DB, org, request, manifest);
    await expect(
      env.DB.prepare("UPDATE monitor_experiment_results SET page_operation_id='changed' WHERE monitor_run_id=?")
        .bind(run.monitorRunId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE monitor_experiment_pages SET label_digest=? WHERE org_id=?")
        .bind("f".repeat(64), org)
        .run(),
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM organization WHERE id=?").bind(org).run();
    expect(await readExperiment(env.DB, org, run.monitorRunId)).toBeNull();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM monitor_experiment_results WHERE monitor_run_id=?")
          .bind(run.monitorRunId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
});
