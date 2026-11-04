import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  captureDigest,
  manifestDigest,
  modelVersions,
  settingsDigest,
  sha256,
} from "../../src/monitor/ablation-manifest";
import { reconcileExperimentAttempt } from "../../src/monitor/ablation-reconcile";
import { runExperiment } from "../../src/monitor/ablation-run";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { fakeJpeg } from "../fixtures/jpeg";
import { makeOrg } from "../trust/helpers";

const bytes = (s: string) => new TextEncoder().encode(s);
const answer = {
  brand: null,
  has_login_form: true,
  has_payment_form: false,
  lure: false,
  lure_type: "none",
  confidence: 0.9,
};
const sparkResponse = () =>
  new Response(
    JSON.stringify({
      id: "response-1",
      object: "response",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );
const loupeResponse = (value: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(value) } }] }));
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM glimmer_runtime").run();
});
async function fixture(parked = false) {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const image = fakeJpeg(640, 480),
    text = bytes(parked ? "" : "A fictional login page");
  const signals = bytes(
    JSON.stringify({
      text: parked ? "" : "A fictional login page",
      inputs: parked ? 0 : 1,
      passwords: parked ? 0 : 1,
      forms: parked ? 0 : 1,
      iframes: 0,
      components: 0,
      hidden: 0,
    }),
  );
  const capture = {
    version: 1,
    pageId: "p1",
    provenanceDigest: "3".repeat(64),
    capturedAt: "2026-11-04T00:00:00.000Z",
    originalUrl: "https://candidate.example/start",
    finalUrl: "https://landing.example/",
    redirects: ["https://landing.example/"],
    screenshotSha256: await sha256(image),
    textSha256: await sha256(text),
    signalsSha256: await sha256(signals),
  };
  const digest = await captureDigest(capture);
  const manifest = {
    version: 1,
    kind: "monitor-screening",
    seed: "runner",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: digest, labelDigest: "2".repeat(64) }],
  };
  const md = await manifestDigest(manifest);
  const objects: Record<string, Uint8Array> = {
    [`eval/monitor-captures/${digest}.json`]: bytes(JSON.stringify(capture)),
    [`eval/monitor-objects/${capture.screenshotSha256}.jpg`]: image,
    [`eval/monitor-objects/${capture.textSha256}.txt`]: text,
    [`eval/monitor-objects/${capture.signalsSha256}.json`]: signals,
    [`eval/monitor-manifests/${md}.json`]: bytes(JSON.stringify(manifest)),
    "eval/monitor-registry.json": bytes(JSON.stringify({ version: 1, deployment, manifests: [md] })),
  };
  for (const [key, value] of Object.entries(objects)) await env.ARTEFACTS.put(key, value);
  const admitted = async (arm: "full" | "no-screening") =>
    admitExperiment(
      env.DB,
      org,
      { experimentId: "runner", arm, manifestDigest: md, deployment, replayRunId: arm },
      manifest,
    );
  return {
    org,
    admitted,
    runtime: {
      ...env,
      COMMIT_SHA: deployment,
      EVAL_ORG_ID: org,
      META_API_KEY: "test",
      CF_AIG_TOKEN: "test",
      META_GATEWAY_URL: "https://gateway.test/v1",
      FIREWORKS_API_KEY: "test",
      GLIMMER_GATEWAY_URL: "https://gateway.test/v1",
    },
  };
}
it("executes identical captures with actual adapters, skips Loupe in no-screening, and never repeats a completed arm", async () => {
  const w = await fixture();
  const full = await w.admitted("full"),
    ablated = await w.admitted("no-screening");
  let loupe = 0,
    spark = 0;
  const requests: string[] = [];
  const transports = {
    loupe: (async (_url, init) => {
      requests.push(String(init?.body));
      return loupeResponse(++loupe === 1 ? "p" : answer);
    }) as typeof fetch,
    spark: (async (_url, init) => {
      requests.push(String(init?.body));
      spark++;
      return sparkResponse();
    }) as typeof fetch,
  };
  expect(await runExperiment(w.runtime, w.org, full.monitorRunId, transports)).toMatchObject({
    status: "complete",
    pages: [{ checkpoint: { screen: { tier: "glimmer" } } }],
  });
  expect(loupe).toBe(2);
  expect(spark).toBe(0);
  expect(await runExperiment(w.runtime, w.org, ablated.monitorRunId, transports)).toMatchObject({
    status: "complete",
    pages: [{ checkpoint: { screen: { tier: "spark", ablated: "no-screening" } } }],
  });
  await runExperiment(w.runtime, w.org, ablated.monitorRunId, transports);
  expect(loupe).toBe(2);
  expect(spark).toBe(1);
  expect(requests.at(-1)).toContain("candidate.example");
  expect(requests.at(-1)).not.toContain("landing.example");
  expect((await env.DB.prepare("SELECT count(*) AS n FROM monitor_runs").first<{ n: number }>())?.n).toBe(0);
});
it("parks both arms without a model call or runtime reservation", async () => {
  const w = await fixture(true);
  let sends = 0;
  const never = (async () => {
    sends++;
    throw new Error("unexpected");
  }) as typeof fetch;
  for (const arm of ["full", "no-screening"] as const) {
    const run = await w.admitted(arm);
    expect(await runExperiment(w.runtime, w.org, run.monitorRunId, { loupe: never, spark: never })).toMatchObject({
      status: "complete",
      pages: [{ checkpoint: { parked: { reason: "empty" } } }],
      accounting: { meta: [], loupe: [] },
    });
  }
  expect(sends).toBe(0);
});
it("holds an unknown paid operation and refuses both automatic repetition and disabled new work", async () => {
  const w = await fixture();
  const run = await w.admitted("no-screening");
  let sends = 0;
  const spark = (async () => {
    sends++;
    throw new Error("lost response");
  }) as typeof fetch;
  await expect(runExperiment(w.runtime, w.org, run.monitorRunId, { spark })).rejects.toThrow();
  await expect(runExperiment(w.runtime, w.org, run.monitorRunId, { spark })).rejects.toThrow();
  expect(sends).toBe(1);
  const full = await w.admitted("full");
  await expect(runExperiment({ ...w.runtime, EVAL_ORG_ID: "" }, w.org, full.monitorRunId, { spark })).rejects.toThrow();
  expect(sends).toBe(1);
});
it("retains completed screening after a lost second look, then closes only against canonical settlement", async () => {
  const w = await fixture();
  const run = await w.admitted("full");
  let loupe = 0,
    spark = 0;
  const transports = {
    loupe: (async () =>
      loupeResponse(++loupe === 1 ? "p" : { ...answer, lure: true, lure_type: "credential" })) as typeof fetch,
    spark: (async () => {
      spark++;
      throw new Error("lost second look");
    }) as typeof fetch,
  };
  await expect(runExperiment(w.runtime, w.org, run.monitorRunId, transports)).rejects.toThrow();
  const lost = await env.DB.prepare(
    "SELECT attempt_id FROM monitor_experiment_attempts WHERE monitor_run_id=? AND phase='second-look'",
  )
    .bind(run.monitorRunId)
    .first<{ attempt_id: string }>();
  if (!lost) throw new Error("missing attempt");
  // Synthetic canonical settlement, standing in for separately verified provider evidence. The reconciliation API cannot assert a cost.
  await env.DB.prepare(
    "UPDATE model_spend SET state='settled',actual_usd=estimate_usd,settled_at='2026-11-04T00:00:00Z' WHERE id=?",
  )
    .bind(lost.attempt_id)
    .run();
  await reconcileExperimentAttempt(env.DB, { orgId: w.org, userId: "owner", role: "owner" }, run.monitorRunId, {
    attemptId: lost.attempt_id,
    reservationIds: [lost.attempt_id],
  });
  // The future authenticated resume boundary must establish the original Workflow is stopped before this transition.
  await env.DB.prepare("UPDATE monitor_experiment_arms SET status='waiting' WHERE monitor_run_id=?")
    .bind(run.monitorRunId)
    .run();
  const result = await runExperiment(w.runtime, w.org, run.monitorRunId, transports);
  expect(result).toMatchObject({
    status: "complete",
    pages: [
      {
        checkpoint: {
          screen: { tier: "glimmer" },
          secondLook: { verdict: "unavailable", reason: "experiment-unrecoverable" },
        },
      },
    ],
  });
  expect(loupe).toBe(2);
  expect(spark).toBe(1);
  expect(result?.accounting.loupe.every((part) => part.settledAt !== null)).toBe(true);
});
