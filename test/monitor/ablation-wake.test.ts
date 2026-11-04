import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { PendingAttempt } from "../../src/monitor/ablation-attempts";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { wakeExperiment } from "../../src/monitor/ablation-wake";
import { d1Exec, findBurst } from "../../src/vision/glimmer-minutes";
import { untilWarm, WARMUP_LIMIT_MS, wakeGlimmer } from "../../src/vision/glimmer-wake";
import { makeOrg } from "../trust/helpers";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM glimmer_runtime").run();
});
async function world(response: () => Response | Promise<Response>) {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const m = {
    version: 1,
    kind: "monitor-screening",
    seed: "wake",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    { experimentId: "wake", arm: "full", manifestDigest: await manifestDigest(m), deployment, replayRunId: "full" },
    m,
  );
  let time = Date.now();
  let sends = 0;
  let sleeps = 0;
  const ctx = {
    env: { FIREWORKS_API_KEY: "test", GLIMMER_GATEWAY_URL: "https://gateway.test/v1", CF_AIG_TOKEN: "test" },
    ledger: d1Exec(env.DB),
    burstId: run.monitorRunId,
    calls: 1,
    callSeconds: 20,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps++;
      time += ms;
    },
    fetcher: (async () => {
      sends++;
      return response();
    }) as typeof fetch,
    experiment: wakeExperiment({
      db: env.DB,
      monitorRunId: run.monitorRunId,
      deployment,
      now: () => time,
      jitter: () => 1,
    }),
  };
  return {
    ctx,
    advance: (ms: number) => {
      time += ms;
    },
    counts: () => ({ sends, sleeps }),
  };
}
it("persists a long capacity wait without short sleeps or a replacement wake burst", async () => {
  const w = await world(
    () =>
      new Response(JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP" } }), {
        status: 503,
        headers: { "Retry-After": "300" },
      }),
  );
  await expect(wakeGlimmer(w.ctx)).rejects.toBeInstanceOf(PendingAttempt);
  const original = await findBurst(w.ctx.ledger, w.ctx.burstId);
  expect(original).not.toBeNull();
  w.advance(301000);
  const expired = await wakeGlimmer(w.ctx);
  expect(expired.outcome).toBe("woken");
  expect(w.counts()).toEqual({ sends: 1, sleeps: 0 });
  const after = await findBurst(w.ctx.ledger, w.ctx.burstId);
  expect(after?.wakeAt).toBe(original?.wakeAt);
});
it("keeps an unknown wake reservation and never repeats its send", async () => {
  const w = await world(() => {
    throw new Error("private response secret");
  });
  await expect(wakeGlimmer(w.ctx)).rejects.toBeInstanceOf(PendingAttempt);
  w.advance(301000);
  await expect(wakeGlimmer(w.ctx)).rejects.toBeInstanceOf(PendingAttempt);
  expect(w.counts().sends).toBe(1);
  expect((await findBurst(w.ctx.ledger, w.ctx.burstId))?.settled).toBe(false);
  const data = await env.DB.prepare("SELECT metadata_json FROM monitor_experiment_attempts WHERE monitor_run_id=?")
    .bind(w.ctx.burstId)
    .all();
  expect(JSON.stringify(data.results)).not.toContain("private");
});
it("reuses a genuinely ready probe and keeps one transport per durable attempt", async () => {
  const w = await world(
    () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "p" } }] })),
  );
  expect(await wakeGlimmer(w.ctx)).toMatchObject({ outcome: "woken", first: { outcome: "ready" } });
  expect(await wakeGlimmer(w.ctx)).toMatchObject({ outcome: "woken", first: { outcome: "ready" } });
  expect(w.counts().sends).toBe(1);
});

it("does not settle an unknown wake when an expired warm-up is resumed directly", async () => {
  const w = await world(() => {
    throw new Error("lost after send");
  });
  await expect(wakeGlimmer(w.ctx)).rejects.toBeInstanceOf(PendingAttempt);
  const stored = await findBurst(w.ctx.ledger, w.ctx.burstId);
  if (!stored) throw new Error("missing fixture burst");
  const wakeAt = Date.parse(stored.wakeAt);
  w.advance(301000);
  await expect(
    untilWarm(w.ctx, { id: w.ctx.burstId, wakeAt, deadline: wakeAt + WARMUP_LIMIT_MS }),
  ).rejects.toBeInstanceOf(PendingAttempt);
  expect((await findBurst(w.ctx.ledger, w.ctx.burstId))?.settled).toBe(false);
  expect(w.counts().sends).toBe(1);
});

it("resumes a known capacity wait with the original burst and next attempt identity", async () => {
  let count = 0;
  const w = await world(() =>
    ++count === 1
      ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } })
      : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "p" } }] })),
  );
  await expect(wakeGlimmer(w.ctx)).rejects.toBeInstanceOf(PendingAttempt);
  const original = await findBurst(w.ctx.ledger, w.ctx.burstId);
  await expect(wakeGlimmer(w.ctx)).rejects.toBeInstanceOf(PendingAttempt);
  expect(w.counts().sends).toBe(1);
  w.advance(120001);
  expect(await wakeGlimmer(w.ctx)).toMatchObject({ outcome: "woken", first: { outcome: "ready" } });
  expect(w.counts()).toEqual({ sends: 2, sleeps: 0 });
  expect((await findBurst(w.ctx.ledger, w.ctx.burstId))?.wakeAt).toBe(original?.wakeAt);
  const rows = await env.DB.prepare(
    "SELECT retry_index,status FROM monitor_experiment_attempts WHERE monitor_run_id=? ORDER BY retry_index",
  )
    .bind(w.ctx.burstId)
    .all();
  expect(rows.results).toEqual([
    { retry_index: 0, status: "capacity" },
    { retry_index: 1, status: "complete" },
  ]);
});
