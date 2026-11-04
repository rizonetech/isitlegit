import type { WorkflowStep } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { runExperiment } from "../../src/monitor/ablation-run";
import { type ExperimentSteps, runExperimentWorkflow } from "../../src/monitor/ablation-workflow";
import { monitorFixture } from "./ablation-fixture";

// Compile against the actual platform interface without importing a live Workflow or changing its shared entrypoint.
const compatible = (step: WorkflowStep): ExperimentSteps => step;
void compatible;
afterEach(() => vi.restoreAllMocks());
function steps() {
  const cache = new Map<string, Awaited<ReturnType<ExperimentSteps["do"]>>>();
  const sleeps: number[] = [];
  const configurations: unknown[] = [];
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const step: ExperimentSteps = {
    async do(name, config, run) {
      configurations.push(config);
      const prior = cache.get(name);
      if (prior) return prior;
      const value = await run();
      cache.set(name, value);
      return value;
    },
    async sleepUntil(_name, until) {
      sleeps.push(until);
      now = Math.max(now, until);
    },
  };
  return { step, sleeps, configurations };
}
const response = () =>
  new Response(
    JSON.stringify({
      id: "synthetic-response",
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
it("durably sleeps through actual capacity failure and replays cached Workflow steps without resending", async () => {
  const w = await monitorFixture();
  const arm = await w.admitted("no-screening");
  const s = steps();
  const start = Date.now();
  let sends = 0;
  const execute: typeof runExperiment = (env, org, id) =>
    runExperiment(env, org, id, {
      spark: (async () => {
        return ++sends === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "300" } }) : response();
      }) as typeof fetch,
    });
  const input = { orgId: w.org, experimentRunId: arm.monitorRunId };
  expect(await runExperimentWorkflow(w.runtime, s.step, input, execute)).toMatchObject({ status: "complete" });
  expect(sends).toBe(2);
  expect(s.sleeps).toHaveLength(1);
  expect(s.sleeps[0]).toBeGreaterThan(start + 300000);
  await runExperimentWorkflow(w.runtime, s.step, input, execute);
  expect(sends).toBe(2);
  expect(s.configurations.every((c) => (c as { retries: { limit: number } }).retries.limit === 0)).toBe(true);
});
it("holds an unknown paid send without a short Workflow retry or sleep", async () => {
  const w = await monitorFixture();
  const arm = await w.admitted("no-screening");
  const s = steps();
  let sends = 0;
  const execute: typeof runExperiment = (env, org, id) =>
    runExperiment(env, org, id, {
      spark: (async () => {
        sends++;
        throw new Error("lost response");
      }) as typeof fetch,
    });
  const input = { orgId: w.org, experimentRunId: arm.monitorRunId };
  await expect(runExperimentWorkflow(w.runtime, s.step, input, execute)).rejects.toThrow("monitor experiment held");
  await expect(runExperimentWorkflow(w.runtime, s.step, input, execute)).rejects.toThrow("monitor experiment held");
  expect(sends).toBe(1);
  expect(s.sleeps).toEqual([]);
});

it("bounds a longer Retry-After by immutable arm expiry and never sends another answer", async () => {
  const w = await monitorFixture();
  const arm = await w.admitted("no-screening");
  const s = steps();
  let sends = 0;
  const execute: typeof runExperiment = (env, org, id) =>
    runExperiment(env, org, id, {
      spark: (async () => {
        sends++;
        return new Response("busy", { status: 429, headers: { "retry-after": "172800" } });
      }) as typeof fetch,
    });
  await expect(
    runExperimentWorkflow(w.runtime, s.step, { orgId: w.org, experimentRunId: arm.monitorRunId }, execute),
  ).rejects.toThrow("monitor experiment held");
  expect(sends).toBe(1);
  expect(s.sleeps).toEqual([arm.sparkDeadline]);
});
it("holds a generic wake503 without retry or fallback", async () => {
  const w = await monitorFixture();
  const arm = await w.admitted("full");
  const s = steps();
  const start = Date.now();
  let loupe = 0,
    spark = 0;
  const execute: typeof runExperiment = (env, org, id) =>
    runExperiment(env, org, id, {
      loupe: (async () => {
        loupe++;
        return new Response("busy", { status: 503, headers: { "retry-after": "3600" } });
      }) as typeof fetch,
      spark: (async () => {
        spark++;
        return response();
      }) as typeof fetch,
    });
  // Only the exact capacity body is retryable; a generic503 remains unknown and cannot fall back.
  await expect(
    runExperimentWorkflow(w.runtime, s.step, { orgId: w.org, experimentRunId: arm.monitorRunId }, execute),
  ).rejects.toThrow("monitor experiment held");
  expect(loupe).toBe(1);
  expect(spark).toBe(0);
  expect(s.sleeps).toEqual([]);
  expect(Date.now()).toBe(start);
});

it("ends a known wake capacity wait at the original255second deadline and falls back without another burst", async () => {
  const w = await monitorFixture();
  const arm = await w.admitted("full");
  const s = steps();
  const start = Date.now();
  let loupe = 0,
    spark = 0;
  const execute: typeof runExperiment = (env, org, id) =>
    runExperiment(env, org, id, {
      loupe: (async () => {
        loupe++;
        return new Response(JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP" } }), {
          status: 503,
          headers: { "retry-after": "3600" },
        });
      }) as typeof fetch,
      spark: (async () => {
        spark++;
        return response();
      }) as typeof fetch,
    });
  expect(
    await runExperimentWorkflow(w.runtime, s.step, { orgId: w.org, experimentRunId: arm.monitorRunId }, execute),
  ).toMatchObject({ status: "complete" });
  expect(loupe).toBe(1);
  expect(spark).toBe(1);
  expect(s.sleeps).toEqual([start + 255000]);
});
