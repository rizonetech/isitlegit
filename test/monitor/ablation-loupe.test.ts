import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { d1Budget } from "../../src/meta/budget";
import { PendingAttempt } from "../../src/monitor/ablation-attempts";
import { loupeExperiment } from "../../src/monitor/ablation-loupe";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { wakeExperiment } from "../../src/monitor/ablation-wake";
import { d1Exec, findBurst } from "../../src/vision/glimmer-minutes";
import { closeGlimmer, openGlimmer, screenPage } from "../../src/vision/screen";
import { fakeJpeg } from "../fixtures/jpeg";
import { makeOrg } from "../trust/helpers";

const page = {
  host: "candidate.example",
  text: "Fictional sign-in",
  image: fakeJpeg(640, 480),
  mode: "image" as const,
  nonce: "0123456789abcdef0123456789abcdef",
};
const answer = {
  brand: null,
  has_login_form: true,
  has_payment_form: false,
  lure: true,
  lure_type: "credential",
  confidence: 0.9,
};
const good = (value: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(value) } }] }));
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM glimmer_runtime").run();
});
async function world(response: () => Response) {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const m = {
    version: 1,
    kind: "monitor-screening",
    seed: "loupe",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    { experimentId: "loupe", arm: "full", manifestDigest: await manifestDigest(m), deployment, replayRunId: "full" },
    m,
  );
  const operationId = run.pages[0]?.pageOperationId;
  if (!operationId) throw new Error("missing fixture");
  let sends = 0;
  const binding = { db: env.DB, monitorRunId: run.monitorRunId, deployment };
  const ctx = {
    env: { FIREWORKS_API_KEY: "test", GLIMMER_GATEWAY_URL: "https://gateway.test/v1", CF_AIG_TOKEN: "test" },
    ledger: d1Exec(env.DB),
    burstId: run.monitorRunId,
    calls: 1,
    callSeconds: 20,
    fetcher: (async () => (++sends === 1 ? good("p") : response())) as typeof fetch,
    experiment: wakeExperiment(binding),
  };
  const session = await openGlimmer(ctx, loupeExperiment(binding));
  return {
    ctx,
    session,
    operationId,
    sends: () => sends,
    spark: { env: {}, budget: d1Budget(env.DB, { caller: "monitor" }), waitUntil: () => {} },
  };
}
it("journals a validated Loupe answer and never repeats it on resume", async () => {
  const w = await world(() => good(answer));
  const first = await screenPage(page, w.session, w.spark, w.operationId);
  expect(first).toMatchObject({ ok: true, tier: "glimmer" });
  expect(await screenPage(page, w.session, w.spark, w.operationId)).toEqual(first);
  expect(w.sends()).toBe(2);
});
it("holds an unknown inference and refuses to settle its burst", async () => {
  const w = await world(() => {
    throw new Error("private unknown response");
  });
  await expect(screenPage(page, w.session, w.spark, w.operationId)).rejects.toBeInstanceOf(PendingAttempt);
  await expect(screenPage(page, w.session, w.spark, w.operationId)).rejects.toBeInstanceOf(PendingAttempt);
  expect(w.sends()).toBe(2);
  expect(await closeGlimmer(w.session)).toMatchObject({ ok: false });
  expect((await findBurst(w.ctx.ledger, w.ctx.burstId))?.settled).toBe(false);
});
it("persists inference capacity without falling through to unaccounted work", async () => {
  const w = await world(() => new Response("busy", { status: 429, headers: { "Retry-After": "300" } }));
  await expect(screenPage(page, w.session, w.spark, w.operationId)).rejects.toBeInstanceOf(PendingAttempt);
  expect(w.sends()).toBe(2);
});
