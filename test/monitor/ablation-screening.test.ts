import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { d1Budget } from "../../src/meta/budget";
import { PendingAttempt } from "../../src/monitor/ablation-attempts";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { structuredContinuation } from "../../src/monitor/ablation-structured";
import { secondLook } from "../../src/monitor/second-look";
import { d1Exec } from "../../src/vision/glimmer-minutes";
import { openGlimmer, screenPage } from "../../src/vision/screen";
import { fakeJpeg } from "../fixtures/jpeg";
import { makeOrg } from "../trust/helpers";

const page = {
  host: "candidate.example",
  text: "Fictional sign-in page",
  image: fakeJpeg(640, 480),
  mode: "image" as const,
  nonce: "0123456789abcdef0123456789abcdef",
};
const good = (confidence = 0.9) =>
  new Response(
    JSON.stringify({
      id: "response-1",
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
                has_login_form: true,
                has_payment_form: false,
                lure: true,
                lure_type: "credential",
                confidence,
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );
async function context(phase: "screen" | "second-look", fetcher: typeof fetch) {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const m = {
    version: 1,
    kind: "monitor-screening",
    seed: "screen",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    {
      experimentId: "screen",
      arm: "no-screening",
      manifestDigest: await manifestDigest(m),
      deployment,
      replayRunId: "no-screening",
    },
    m,
  );
  const operationId = run.pages[0]?.pageOperationId;
  if (!operationId) throw new Error("missing fixture");
  return {
    run,
    operationId,
    spark: {
      env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
      budget: d1Budget(env.DB, { caller: "monitor" }),
      waitUntil: () => {},
      fetch: fetcher,
      continuation: structuredContinuation({
        db: env.DB,
        monitorRunId: run.monitorRunId,
        operationId,
        phase,
        deployment,
        deadline: run.sparkDeadline,
      }),
    },
  };
}
async function ablated(run: string) {
  return openGlimmer({
    env: {},
    ledger: d1Exec(env.DB),
    burstId: run,
    calls: 1,
    callSeconds: 20,
    ablateFlag: async () => "no-screening",
  });
}
it("exposes durable second-look capacity to orchestration rather than swallowing it", async () => {
  let calls = 0;
  const c = await context("second-look", (async () => {
    calls++;
    return new Response("busy", { status: 429, headers: { "Retry-After": "300" } });
  }) as typeof fetch);
  await expect(secondLook(page, c.operationId, c.spark)).rejects.toBeInstanceOf(PendingAttempt);
  expect(calls).toBe(1);
});
it("keeps second-look request identity stable on validated replay", async () => {
  let calls = 0;
  const c = await context("second-look", (async () => {
    calls++;
    return good();
  }) as typeof fetch);
  expect(await secondLook(page, c.operationId, c.spark)).toMatchObject({ verdict: "confirmed" });
  expect(await secondLook(page, c.operationId, c.spark)).toMatchObject({ verdict: "confirmed" });
  expect(calls).toBe(1);
});
it("keeps two uncertainty passes separate, and both replay from their own paid results", async () => {
  let calls = 0;
  const c = await context("screen", (async () => {
    calls++;
    return good(calls === 1 ? 0.5 : 0.9);
  }) as typeof fetch);
  const session = await ablated(c.run.monitorRunId);
  const first = await screenPage(page, session, c.spark, c.operationId);
  expect(first).toMatchObject({ ok: true, tier: "spark-second" });
  expect(calls).toBe(2);
  expect(await screenPage(page, session, c.spark, c.operationId)).toEqual(first);
  expect(calls).toBe(2);
});
it("exposes a pending screening attempt without resending or reporting a finished failure", async () => {
  let calls = 0;
  const c = await context("screen", (async () => {
    calls++;
    return new Response("busy", { status: 429 });
  }) as typeof fetch);
  await expect(screenPage(page, await ablated(c.run.monitorRunId), c.spark, c.operationId)).rejects.toBeInstanceOf(
    PendingAttempt,
  );
  expect(calls).toBe(1);
});
