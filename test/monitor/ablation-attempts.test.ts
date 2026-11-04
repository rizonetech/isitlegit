import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AttemptFailure, attempt, PendingAttempt, retryAt } from "../../src/monitor/ablation-attempts";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { makeOrg } from "../trust/helpers";

const Result = z.strictObject({ ready: z.boolean() });
async function owner() {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const m = {
    version: 1,
    kind: "monitor-screening",
    seed: "attempt",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    { experimentId: "attempt", arm: "full", manifestDigest: await manifestDigest(m), deployment, replayRunId: "full" },
    m,
  );
  return {
    monitorRunId: run.monitorRunId,
    operationId: run.monitorRunId,
    phase: "wake" as const,
    ordinal: 1 as const,
    requestDigest: "3".repeat(64),
    deadline: 255000,
  };
}
describe("durable monitor transport claims", () => {
  it("serializes concurrent calls and returns validated completed state without another transport", async () => {
    const input = await owner();
    let calls = 0;
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = attempt(
      env.DB,
      input,
      Result,
      async () => {
        calls++;
        entered();
        await gate;
        return { ready: true };
      },
      { now: () => 0, jitter: () => 1 },
    );
    await started;
    await expect(
      attempt(
        env.DB,
        input,
        Result,
        async () => {
          calls++;
          return { ready: true };
        },
        { now: () => 1, jitter: () => 1 },
      ),
    ).rejects.toBeInstanceOf(PendingAttempt);
    release();
    expect(await first).toEqual({ ready: true });
    expect(
      await attempt(
        env.DB,
        input,
        Result,
        async () => {
          calls++;
          return { ready: false };
        },
        { now: () => 10, jitter: () => 1 },
      ),
    ).toEqual({ ready: true });
    expect(calls).toBe(1);
  });
  it("retains an unknown send and blocks every restart", async () => {
    const input = await owner();
    let calls = 0;
    const send = async () => {
      calls++;
      throw new Error("private untrusted message");
    };
    await expect(attempt(env.DB, input, Result, send, { now: () => 0, jitter: () => 1 })).rejects.toBeInstanceOf(
      PendingAttempt,
    );
    await expect(attempt(env.DB, input, Result, send, { now: () => 200000, jitter: () => 1 })).rejects.toBeInstanceOf(
      PendingAttempt,
    );
    expect(calls).toBe(1);
    const row = await env.DB.prepare(
      "SELECT status,metadata_json FROM monitor_experiment_attempts WHERE monitor_run_id=?",
    )
      .bind(input.monitorRunId)
      .first<{ status: string; metadata_json: string }>();
    expect(row?.status).toBe("unknown");
    expect(row?.metadata_json).not.toContain("private");
  });
  it("persists capacity cadence and refuses a retry outside the original255second window", async () => {
    const input = await owner();
    let calls = 0;
    const send = async () => {
      calls++;
      throw new AttemptFailure({ kind: "capacity", status: 429, retryAfterMs: 300000 });
    };
    await expect(attempt(env.DB, input, Result, send, { now: () => 0, jitter: () => 1 })).rejects.toBeInstanceOf(
      PendingAttempt,
    );
    await expect(attempt(env.DB, input, Result, send, { now: () => 300001, jitter: () => 1 })).rejects.toBeInstanceOf(
      PendingAttempt,
    );
    expect(calls).toBe(1);
    const row = await env.DB.prepare(
      "SELECT deadline,next_eligible_at FROM monitor_experiment_attempts WHERE monitor_run_id=?",
    )
      .bind(input.monitorRunId)
      .first<{ deadline: number; next_eligible_at: number }>();
    expect(row).toEqual({ deadline: 255000, next_eligible_at: 300001 });
  });
  it("rejects fingerprint drift before replaying cached work", async () => {
    const input = await owner();
    await attempt(env.DB, input, Result, async () => ({ ready: true }), { now: () => 0, jitter: () => 1 });
    await expect(
      attempt(env.DB, { ...input, requestDigest: "4".repeat(64) }, Result, async () => ({ ready: true }), {
        now: () => 1,
        jitter: () => 1,
      }),
    ).rejects.toThrow();
  });
  it("uses full long cadence and positive jitter", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => retryAt(0, i, 0, 1))).toEqual([
      120001, 300001, 600001, 1200001, 1800001, 3600001, 7200001, 14400001,
    ]);
    expect(retryAt(0, 0, 500000, 1)).toBe(500001);
  });
});

it("rechecks the absolute deadline after the durable claim before any transport", async () => {
  const input = await owner();
  let ticks = 0;
  let sends = 0;
  await expect(
    attempt(
      env.DB,
      input,
      Result,
      async () => {
        sends++;
        return { ready: true };
      },
      { now: () => (ticks++ === 0 ? 0 : 255000), jitter: () => 1 },
    ),
  ).rejects.toBeInstanceOf(PendingAttempt);
  expect(sends).toBe(0);
});
