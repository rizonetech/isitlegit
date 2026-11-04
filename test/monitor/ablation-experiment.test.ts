import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { reconcileExperimentAttempt } from "../../src/monitor/ablation-reconcile";
import { runExperiment } from "../../src/monitor/ablation-run";

import { monitorFixture as fixture } from "./ablation-fixture";

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
    pages: [
      {
        checkpoint: { screen: { tier: "glimmer" } },
        screeningContribution: { exercised: true, reason: "loupe-screen" },
      },
    ],
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
      pages: [
        { checkpoint: { parked: { reason: "empty" } }, screeningContribution: { exercised: false, reason: "parked" } },
      ],
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
    status: "failed",
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

it("records a reconciled lost initial screen as failed and continues untouched pages without replay", async () => {
  const w = await fixture(false, undefined, 2);
  const run = await w.admitted("no-screening");
  let sends = 0;
  const spark = (async () => {
    sends++;
    if (sends === 1) throw new Error("lost initial screen");
    return sparkResponse();
  }) as typeof fetch;
  await expect(runExperiment(w.runtime, w.org, run.monitorRunId, { spark })).rejects.toThrow();
  const lost = await env.DB.prepare(
    "SELECT attempt_id FROM monitor_experiment_attempts WHERE monitor_run_id=? AND phase='screen'",
  )
    .bind(run.monitorRunId)
    .first<{ attempt_id: string }>();
  if (!lost) throw new Error("missing attempt");
  // Synthetic settled provider evidence; the reconciliation endpoint cannot set charges.
  await env.DB.prepare(
    "UPDATE model_spend SET state='settled',actual_usd=estimate_usd,settled_at='2026-11-04T00:00:00Z' WHERE id=?",
  )
    .bind(lost.attempt_id)
    .run();
  await reconcileExperimentAttempt(env.DB, { orgId: w.org, userId: "owner", role: "owner" }, run.monitorRunId, {
    attemptId: lost.attempt_id,
    reservationIds: [lost.attempt_id],
  });
  // Model the authenticated stopped-Workflow resume transition, not an automatic retry.
  await env.DB.prepare("UPDATE monitor_experiment_arms SET status='waiting' WHERE monitor_run_id=?")
    .bind(run.monitorRunId)
    .run();
  const result = await runExperiment(w.runtime, w.org, run.monitorRunId, { spark });
  expect(result).toMatchObject({
    status: "failed",
    pages: [
      { checkpoint: { screen: null, unrecoverable: "screen" }, screeningContribution: { exercised: false } },
      {
        checkpoint: { screen: { ok: true, tier: "spark" } },
        screeningContribution: { exercised: false, reason: "ablated" },
      },
    ],
  });
  expect(sends).toBe(2);
  await runExperiment(w.runtime, w.org, run.monitorRunId, { spark });
  expect(sends).toBe(2);
});
it("retains a reconciled lost Loupe answer as unmeasured and screens the next page without a replacement burst", async () => {
  const w = await fixture(false, undefined, 2);
  const run = await w.admitted("full");
  let loupe = 0,
    spark = 0;
  const transports = {
    loupe: (async () => {
      if (++loupe === 1) return loupeResponse("p");
      throw new Error("lost inference");
    }) as typeof fetch,
    spark: (async () => {
      spark++;
      return sparkResponse();
    }) as typeof fetch,
  };
  await expect(runExperiment(w.runtime, w.org, run.monitorRunId, transports)).rejects.toThrow();
  const lost = await env.DB.prepare(
    "SELECT attempt_id FROM monitor_experiment_attempts WHERE monitor_run_id=? AND phase='loupe'",
  )
    .bind(run.monitorRunId)
    .first<{ attempt_id: string }>();
  if (!lost) throw new Error("missing inference");
  // Canonical, synthetic provider settlement. Only the owning ledger can establish the charge.
  await env.DB.prepare(
    "UPDATE glimmer_runtime SET used_minutes=reserved_minutes,settled_at='2026-11-04T00:00:00Z',reconciled=1 WHERE reservation_id=?",
  )
    .bind(run.monitorRunId)
    .run();
  await reconcileExperimentAttempt(env.DB, { orgId: w.org, userId: "owner", role: "owner" }, run.monitorRunId, {
    attemptId: lost.attempt_id,
    reservationIds: [run.monitorRunId],
  });
  await env.DB.prepare("UPDATE monitor_experiment_arms SET status='waiting' WHERE monitor_run_id=?")
    .bind(run.monitorRunId)
    .run();
  const result = await runExperiment(w.runtime, w.org, run.monitorRunId, transports);
  expect(result).toMatchObject({
    status: "failed",
    pages: [
      { checkpoint: { screen: null, unrecoverable: "loupe" }, screeningContribution: { exercised: false } },
      {
        checkpoint: { screen: { tier: "spark" } },
        screeningContribution: { exercised: false, reason: "fallback-only" },
      },
    ],
  });
  expect(loupe).toBe(2);
  expect(spark).toBe(1);
  expect(
    result?.accounting.loupe.every((part) => part.reconciled === 1 && part.usedMinutes === part.reservedMinutes),
  ).toBe(true);
});
