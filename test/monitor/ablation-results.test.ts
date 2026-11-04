import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { PageCheckpoint, readPageCheckpoint, savePageCheckpoint } from "../../src/monitor/ablation-results";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { makeOrg } from "../trust/helpers";

async function fixture() {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const manifest = {
    version: 1,
    kind: "monitor-screening",
    seed: "results",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    {
      experimentId: "results",
      arm: "full",
      manifestDigest: await manifestDigest(manifest),
      deployment,
      replayRunId: "full",
    },
    manifest,
  );
  const operation = run.pages[0]?.pageOperationId;
  if (!operation) throw new Error("fixture missing operation");
  const key = [env.DB, org, run.monitorRunId, operation] as const;
  return { key, org, run, operation };
}
const screen = (): PageCheckpoint => ({
  version: 1,
  startedAt: 1,
  screenedAt: 2,
  parked: null,
  screen: {
    ok: true,
    screen: {
      brand: null,
      has_login_form: true,
      has_payment_form: false,
      lure: true,
      lure_type: "credential",
      confidence: 0.9,
      screener: "glimmer",
    },
    glimmer_reason: null,
    spark_call: null,
    tier: "glimmer",
    escalation: null,
    spark_calls: [],
  },
  secondLook: null,
  finishedAt: null,
});
it("retains the first screen across interruption and only appends a second-look result", async () => {
  const { key } = await fixture();
  const first = screen();
  await savePageCheckpoint(...key, first);
  expect(await readPageCheckpoint(...key)).toEqual(first);
  const done = { ...first, secondLook: { verdict: "unavailable" as const, reason: "output-invalid" }, finishedAt: 3 };
  await savePageCheckpoint(...key, done);
  await savePageCheckpoint(...key, done);
  expect(await readPageCheckpoint(...key)).toEqual(done);
  await expect(savePageCheckpoint(...key, { ...done, finishedAt: 4 })).rejects.toThrow();
  await expect(savePageCheckpoint(...key, first)).rejects.toThrow();
});
it("refuses a changed screen, forged tenant and malformed persisted answer", async () => {
  const { key, run, operation } = await fixture();
  await savePageCheckpoint(...key, screen());
  await expect(savePageCheckpoint(...key, { ...screen(), screenedAt: 3 })).rejects.toThrow();
  await expect(readPageCheckpoint(env.DB, await makeOrg(), run.monitorRunId, operation)).rejects.toThrow();
  await env.DB.prepare("UPDATE monitor_experiment_results SET result_json=? WHERE page_operation_id=?")
    .bind(JSON.stringify({ ...screen(), arbitrary: "bad" }), operation)
    .run();
  await expect(readPageCheckpoint(...key)).rejects.toThrow();
});
it("serializes competing initial results without losing the winning screen", async () => {
  const { key } = await fixture();
  const outcomes = await Promise.allSettled([
    savePageCheckpoint(...key, screen()),
    savePageCheckpoint(...key, { ...screen(), screenedAt: 3 }),
  ]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect([2, 3]).toContain((await readPageCheckpoint(...key))?.screenedAt);
});
it("refuses false completion before required second look and mutually inconsistent page states", () => {
  expect(PageCheckpoint.safeParse({ ...screen(), finishedAt: 3 }).success).toBe(false);
  expect(PageCheckpoint.safeParse({ ...screen(), parked: { reason: "empty" } }).success).toBe(false);
  expect(PageCheckpoint.safeParse({ ...screen(), screenedAt: 0 }).success).toBe(false);
});
it("rejects a mismatched screener attribution and a falsely ablated Loupe result", () => {
  const value = screen();
  if (!value.screen?.ok) throw new Error("fixture");
  expect(PageCheckpoint.safeParse({ ...value, screen: { ...value.screen, tier: "spark" } }).success).toBe(false);
  expect(PageCheckpoint.safeParse({ ...value, screen: { ...value.screen, ablated: "no-screening" } }).success).toBe(
    false,
  );
});

it("keeps unrecoverable responses distinct from model answers and refuses mixed or unfinished failure records", async () => {
  const { key } = await fixture();
  const failed = { ...screen(), screen: null, unrecoverable: "screen" as const, finishedAt: 3 };
  await savePageCheckpoint(...key, failed);
  expect(await readPageCheckpoint(...key)).toEqual(failed);
  expect(PageCheckpoint.safeParse({ ...failed, screen: screen().screen }).success).toBe(false);
  expect(PageCheckpoint.safeParse({ ...failed, parked: { reason: "empty" } }).success).toBe(false);
  expect(PageCheckpoint.safeParse({ ...failed, finishedAt: null }).success).toBe(false);
  expect(PageCheckpoint.safeParse({ ...failed, unrecoverable: "arbitrary" }).success).toBe(false);
  await expect(savePageCheckpoint(...key, { ...screen(), finishedAt: 3 })).rejects.toThrow();
});
