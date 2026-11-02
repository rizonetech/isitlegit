// D03 T04 §32: promoting a gate-passing Loupe version, recovering a failed promotion, and rolling back.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkInferenceKey, createBody, type Deployment, reserveWake } from "../../scripts/glimmer/deploy.ts";
import {
  BUDGET_MINUTES,
  type Client,
  type Deps,
  promote,
  type ReleaseDeps,
  readActive,
  release,
  report,
  rollback,
  writeJson,
} from "../../scripts/glimmer/promote.ts";
import { screenThroughWorker } from "../../scripts/smoke.ts";
import type { Active } from "../../src/vision/glimmer-caps.ts";
import { type Exec, ledgerStatus, reserveBurst, settleBurst } from "../../src/vision/glimmer-minutes.ts";

const V10: Active = { version: "1.0", deployment: "isitlegit-loupe", previous: null };
const MIGRATION = ["0056_glimmer_runtime.sql", "0064_glimmer_runtime_deployment.sql"]
  .map((file) => readFileSync(join(import.meta.dirname, "../../src/db/migrations", file), "utf-8"))
  .join("\n");
const completion = JSON.stringify({ choices: [{ message: { content: "p" }, finish_reason: "length" }] });

describe("promoting a Loupe version (§32)", () => {
  let dir: string;
  let activeFile: string;
  let stateFile: string;
  let calls: string[];
  let remote: Record<string, Deployment>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glimmer-promote-"));
    activeFile = join(dir, "active.json");
    stateFile = join(dir, "promotion.json");
    writeFileSync(activeFile, `${JSON.stringify(V10)}\n`);
    calls = [];
    remote = { "isitlegit-loupe": ready("1.0") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ready(version: string, over: Partial<Deployment> = {}): Deployment {
    return {
      ...createBody(version),
      state: "READY",
      replicaCount: 0,
      acceleratorType: "NVIDIA_H200_141GB",
      acceleratorCount: 1,
      ...over,
    } as Deployment;
  }
  const client = (
    deployment: string,
    over: { ensure?: () => Promise<void>; wait?: () => Promise<void>; shape?: Partial<Deployment> } = {},
  ): Client => ({
    status: async () => remote[deployment] ?? null,
    async ensure(version) {
      calls.push(`ensure ${deployment}`);
      await over.ensure?.();
      const created = !remote[deployment];
      remote[deployment] ??= ready(version, over.shape);
      return { created, deployment: remote[deployment] as Deployment };
    },
    async waitReady() {
      calls.push(`ready ${deployment}`);
      await over.wait?.();
      return remote[deployment] as Deployment;
    },
  });
  const deps = (
    over: Partial<Deps> & { gate?: Deps["gate"]; probe?: Deps["probe"]; client?: Parameters<typeof client>[1] } = {},
  ): Deps => ({
    activeFile,
    stateFile,
    gate: (version, previous) => {
      calls.push(`gate ${version} ${previous}`);
      return { verdict: "promote", detail: "promote" };
    },
    deployments: (deployment) => client(deployment, over.client),
    probe: async (version, deployment) => {
      calls.push(`probe ${version} ${deployment}`);
    },
    ...over,
  });
  const active = () => readActive(activeFile);
  const state = () => JSON.parse(readFileSync(stateFile, "utf-8")) as { status: string; detail?: string };

  it("refuses before changing anything: the gate, an active version, a record that disagrees, a damaged file", async () => {
    const before = readFileSync(activeFile, "utf-8");
    const unchanged = () => {
      expect(readFileSync(activeFile, "utf-8")).toBe(before);
      expect(readdirSync(dir)).toEqual(["active.json"]);
      expect(calls.filter((c) => /^(ensure|probe|ready)/.test(c))).toEqual([]);
    };
    for (const verdict of ["keep", "missing"] as const) {
      const result = await promote("1.1", deps({ gate: () => ({ verdict, detail: `${verdict}: no` }) }));
      expect(result).toMatchObject({ outcome: "refused", serving: "1.0", detail: expect.stringContaining("the gate") });
      unchanged();
    }
    expect(await promote("1.0", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("already"),
    });
    expect(await promote("one", deps())).toMatchObject({ outcome: "refused" });
    // The record says 1.0 on isitlegit-loupe, but the deployment serves another model, or is gone.
    remote["isitlegit-loupe"] = ready("1.5");
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("disagrees"),
    });
    delete remote["isitlegit-loupe"];
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("not there"),
    });
    unchanged();
    writeFileSync(activeFile, "{ broken");
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("cannot be read"),
    });
    writeFileSync(activeFile, JSON.stringify({ version: 1 }));
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("damaged"),
    });
  });

  it("promotes: the gate runs against the verified previous version, the active file is written last and read back", async () => {
    const result = await promote("1.1", deps());
    expect(result).toMatchObject({
      outcome: "promoted",
      version: "1.1",
      deployment: "isitlegit-loupe-1-1",
      model: "accounts/rizonetech/models/isitlegit-loupe-1-1#accounts/rizonetech/deployments/isitlegit-loupe-1-1",
      previous: { version: "1.0", deployment: "isitlegit-loupe" },
    });
    expect(calls).toEqual([
      "gate 1.1 1.0",
      "ensure isitlegit-loupe-1-1",
      "ready isitlegit-loupe-1-1",
      "probe 1.1 isitlegit-loupe-1-1",
    ]);
    expect(active()).toEqual({
      version: "1.1",
      deployment: "isitlegit-loupe-1-1",
      previous: { version: "1.0", deployment: "isitlegit-loupe" },
    });
    expect(state().status).toBe("promoted");
    // A later promotion compares against the version now active, not against 1.0.
    calls.length = 0;
    await promote("1.2", deps());
    expect(calls[0]).toBe("gate 1.2 1.1");
    expect(active()).toMatchObject({ version: "1.2", previous: { version: "1.1", deployment: "isitlegit-loupe-1-1" } });
  });

  it("leaves the previous version serving when a step fails, records why, and a fresh run finishes it once", async () => {
    const unchanged = () => expect(active()).toEqual(V10);
    const boom = (message: string) => async () => {
      throw new Error(message);
    };
    const steps: [string, Partial<Deps> & { client?: Parameters<typeof client>[1] }, "failed" | "refused"][] = [
      ["a lost API response", { client: { ensure: boom("POST did not answer within 60 s") } }, "failed"],
      [
        "a readiness timeout",
        { client: { wait: boom("isitlegit-loupe-1-1 is still CREATING after 45 minutes") } },
        "failed",
      ],
      ["wrong settings", { client: { shape: { minReplicaCount: 2 } } }, "failed"],
      ["the wrong GPU", { client: { shape: { acceleratorType: "NVIDIA_A100_80GB" } } }, "refused"],
      [
        "a probe that gets no completion",
        { probe: boom("the deployment answered 200 with something that is no completion") },
        "failed",
      ],
      [
        "an exhausted allowance",
        { probe: boom("refused: a key-check wake of up to 10.5 minutes: average-minutes") },
        "refused",
      ],
    ];
    for (const [why, over, outcome] of steps) {
      delete remote["isitlegit-loupe-1-1"];
      const result = await promote("1.1", deps(over));
      expect(result, why).toMatchObject({ outcome, serving: "1.0" });
      unchanged();
      expect(state(), why).toMatchObject({ status: "failed" });
    }
    // A fresh invocation with everything healthy completes it, and the active file changes exactly once.
    delete remote["isitlegit-loupe-1-1"];
    expect(await promote("1.1", deps())).toMatchObject({ outcome: "promoted" });
    expect(active().version).toBe("1.1");
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("already"),
    });
  });

  it("recovers a promotion killed mid-way, from its record, in a fresh process", async () => {
    // Killed during the probe: the record says promoting, the active file is still 1.0, the new deployment exists.
    writeFileSync(
      stateFile,
      JSON.stringify({ status: "promoting", target: { ...V10, version: "1.1" }, previous: V10, at: "t" }),
    );
    remote["isitlegit-loupe-1-1"] = ready("1.1");
    expect(await promote("1.1", deps())).toMatchObject({ outcome: "promoted" });
    expect(active().version).toBe("1.1");
    expect(state().status).toBe("promoted");
    // Killed after the active file was written but before the record was: a later run sees the target active and says so.
    writeFileSync(stateFile, JSON.stringify({ status: "promoting", target: active(), previous: V10, at: "t" }));
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("already"),
    });
    expect(state().status).toBe("promoted");
  });

  it("restores the previous file when the active write does not read back, and reports unresolved when it cannot", async () => {
    const real = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value)}\n`);
    let writes = 0;
    const corruptFirst = (file: string, value: unknown) => {
      if (file === activeFile && writes++ === 0) writeFileSync(file, "{ torn");
      else real(file, value);
    };
    const restored = await promote("1.1", deps({ write: corruptFirst }));
    expect(restored).toMatchObject({ outcome: "failed", serving: "1.0", detail: expect.stringContaining("restored") });
    expect(active()).toEqual(V10);
    delete remote["isitlegit-loupe-1-1"];
    const neverReadable = await promote(
      "1.1",
      deps({ write: (file, value) => (file === activeFile ? writeFileSync(file, "{ torn") : real(file, value)) }),
    );
    expect(neverReadable).toMatchObject({
      outcome: "unresolved",
      recovery: expect.stringContaining('"version":"1.0"'),
    });
    expect(neverReadable).not.toHaveProperty("serving");
    expect(JSON.stringify(neverReadable)).not.toMatch(/is serving|now serving/);
  });

  it("rolls back to the recorded previous deployment by the same checks, and only to that", async () => {
    expect(await rollback(deps())).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("no recorded previous"),
    });
    await promote("1.1", deps());
    calls.length = 0;
    // The previous deployment must still read back as that version.
    remote["isitlegit-loupe"] = ready("1.5");
    expect(await rollback(deps())).toMatchObject({
      outcome: "refused",
      serving: "1.1",
      detail: expect.stringContaining("serves"),
    });
    delete remote["isitlegit-loupe"];
    expect(await rollback(deps())).toMatchObject({ outcome: "refused", detail: expect.stringContaining("not there") });
    remote["isitlegit-loupe"] = ready("1.0", { state: "DELETED" });
    expect(await rollback(deps())).toMatchObject({ outcome: "refused", detail: expect.stringContaining("DELETED") });
    expect(active().version).toBe("1.1");
    // A probe that fails leaves 1.1 active.
    remote["isitlegit-loupe"] = ready("1.0");
    const failed = await rollback(
      deps({
        probe: async () => {
          throw new Error("no completion");
        },
      }),
    );
    expect(failed).toMatchObject({ outcome: "failed", serving: "1.1" });
    expect(active().version).toBe("1.1");
    // The rollback itself: no forward gate, 1.0 active again with nothing to return to.
    calls.length = 0;
    const back = await rollback(deps());
    expect(back).toMatchObject({ outcome: "promoted", version: "1.0", deployment: "isitlegit-loupe", previous: null });
    expect(calls.some((c) => c.startsWith("gate"))).toBe(false);
    expect(calls).toContain("probe 1.0 isitlegit-loupe");
    expect(active()).toEqual(V10);
  });

  // Completion review: a probe on the other version's deployment runs a second GPU, so its time is never shared.
  it("shares runtime only between bursts on the same deployment, whatever their purposes", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    const exec: Exec = async ({ sql, params }) => {
      const statement = db.prepare(sql);
      if (/^\s*SELECT/i.test(sql)) return { rows: statement.all(...params) as Record<string, unknown>[], changes: 0 };
      return { rows: [], changes: Number(statement.run(...params).changes) };
    };
    const T = Date.parse("2026-11-01T08:00:00Z");
    const burst = async (
      id: string,
      purpose: string,
      deployment: string | undefined,
      startMin: number,
      answerMin: number,
    ) => {
      const at = new Date(T + startMin * 60_000);
      await reserveBurst(exec, {
        id,
        at,
        source: "local",
        caller: "deploy.ts",
        purpose,
        minutes: 20,
        ...(deployment ? { deployment } : {}),
      });
      await settleBurst(exec, id, { lastAnswerAt: new Date(T + answerMin * 60_000) });
    };
    const used = async (id: string) =>
      Number(
        (
          await exec({
            sql: "SELECT sum(used_minutes) AS m FROM glimmer_runtime WHERE reservation_id = ?1",
            params: [id],
          })
        ).rows[0]?.m,
      );
    // The serving burst on 1.0: 4 minutes and the 6-minute tail, 0 to 10.
    await burst("serving", "monitor", "isitlegit-loupe", 0, 4);
    // A warm-up on 1.1 (not a promotion at all) inside it: another GPU, so its 2 to 10 is charged in full.
    await burst("other", "warm-up", "isitlegit-loupe-1-1", 2, 4);
    expect(await used("serving")).toBeCloseTo(10, 1);
    expect(await used("other")).toBeCloseTo(8, 1);
    // A second burst on 1.1 shares the first one's time, and adds nothing inside it.
    await burst("other-again", "key-check", "isitlegit-loupe-1-1", 3, 4);
    expect(await used("other-again")).toBeCloseTo(0, 1);
    // A burst on 1.0 with no deployment recorded (a row from before the column) is 1.0: it shares the serving burst's time.
    await burst("legacy", "key-check", undefined, 1, 4);
    expect(await used("legacy")).toBeCloseTo(0, 1);
    // An interrupted settlement is completed by the same rule, per deployment.
    expect((await ledgerStatus(exec, new Date(T))).settled).toBeCloseTo(18, 1);
  });

  it("refuses when the promotion record cannot be written first, and reports one lost after the switch beside it", async () => {
    // A record path under a file: the first write fails, so nothing is changed.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "x");
    const refused = await promote("1.1", deps({ stateFile: join(blocked, "promotion.json") }));
    expect(refused).toMatchObject({ outcome: "refused", detail: expect.stringContaining("nothing was changed") });
    expect(calls.filter((c) => c.startsWith("ensure"))).toEqual([]);
    expect(active()).toEqual(V10);
    // A record that fails only after the switch: promoted, with the lost record named.
    const result = await promote(
      "1.1",
      deps({
        write: (file, value) => {
          if (file === stateFile && (value as { status: string }).status === "promoted") throw new Error("ENOSPC");
          writeJson(file, value);
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "promoted", journal: expect.stringContaining("ENOSPC") });
    expect(active().version).toBe("1.1");
  });

  it("says what is and is not switched, and how production gets it", async () => {
    const result = await promote("1.1", deps());
    expect(result).toMatchObject({
      production: "not switched until the Worker is deployed",
      next: expect.stringContaining("docs/operations.md"),
    });
    expect(JSON.stringify(result)).not.toContain("pnpm deploy");
    // A later run that finds the target already active still says how to finish.
    expect(await promote("1.1", deps())).toMatchObject({
      outcome: "refused",
      next: expect.stringContaining("smoke.ts"),
    });
  });

  it("records the time of each stage against the minutes budget", async () => {
    let t = Date.parse("2026-11-01T08:00:00Z");
    // Each clock read advances: start, prepared, probed, switched.
    const steps = [0, 90_000, 150_000, 150_500];
    let i = 0;
    const clockAt = () => new Date(t + (steps[Math.min(i++, steps.length - 1)] as number));
    const quick = await promote("1.1", deps({ now: clockAt }));
    expect(quick).toMatchObject({
      outcome: "promoted",
      timings: {
        prepare_ms: 90_000,
        probe_ms: 60_000,
        switch_ms: 500,
        total_ms: 150_500,
        budget_minutes: BUDGET_MINUTES,
        within_budget: true,
      },
    });
    // A slow provider shows as outside the budget; nothing is weakened to hide it.
    writeFileSync(activeFile, `${JSON.stringify(V10)}\n`);
    delete remote["isitlegit-loupe-1-1"];
    i = 0;
    t = 0;
    steps.splice(0, steps.length, 0, 5 * 60_000, 9 * 60_000, 9 * 60_000);
    const slow = await promote("1.1", deps({ now: clockAt }));
    expect(slow).toMatchObject({ outcome: "promoted", timings: { within_budget: false } });
  });

  it("keeps the unresolved outcome and its recovery in the command's output when the active file cannot be read", () => {
    writeFileSync(activeFile, "{ torn");
    const out = report(
      { outcome: "unresolved", detail: "not known", recovery: `write ${JSON.stringify(V10)} to ${activeFile}` },
      activeFile,
    );
    expect(out.code).toBe(1);
    const parsed = JSON.parse(out.text) as { outcome: string; recovery: string; active: string };
    expect(parsed.outcome).toBe("unresolved");
    expect(parsed.recovery).toContain('"version":"1.0"');
    expect(parsed.active).toContain("cannot be read");
  });

  describe("killed for real", () => {
    const run = async (mode: "probe" | "journal", until: () => boolean) => {
      const child = spawn(
        process.execPath,
        [join(import.meta.dirname, "fixtures/killed-promotion.ts"), mode, activeFile, stateFile],
        {
          stdio: "ignore",
        },
      );
      const exited = new Promise((done) => child.once("exit", done));
      for (let tries = 0; tries < 200 && !until(); tries++) await new Promise((done) => setTimeout(done, 100));
      expect(until()).toBe(true);
      child.kill("SIGKILL");
      await exited;
    };
    const status = () => (existsSync(stateFile) ? state().status : null);

    it("a process killed during the probe leaves 1.0 active, and a fresh run promotes", async () => {
      await run("probe", () => status() === "promoting");
      expect(active()).toEqual(V10);
      expect(await promote("1.1", deps())).toMatchObject({ outcome: "promoted" });
      expect(state().status).toBe("promoted");
    }, 30_000);

    it("a process killed after the active file was written is finished by the next run, which says how to deploy", async () => {
      await run("journal", () => existsSync(activeFile) && active().version === "1.1");
      expect(state().status).toBe("promoting");
      expect(await promote("1.1", deps())).toMatchObject({
        outcome: "refused",
        next: expect.stringContaining("smoke.ts"),
      });
      expect(state().status).toBe("promoted");
    }, 30_000);
  });

  describe("with the real probe through the shared minutes ledger", () => {
    const ledger = (): Exec => {
      const db = new DatabaseSync(":memory:");
      db.exec(MIGRATION);
      return async ({ sql, params }) => {
        const statement = db.prepare(sql);
        if (/^\s*SELECT/i.test(sql)) return { rows: statement.all(...params) as Record<string, unknown>[], changes: 0 };
        return { rows: [], changes: Number(statement.run(...params).changes) };
      };
    };
    const NOW = Date.parse("2026-11-01T08:00:00Z");
    const probeWith =
      (exec: Exec, fetcher: (url: string, init: RequestInit) => Promise<Response>) =>
      (version: string, deployment: string) =>
        checkInferenceKey(
          version,
          "key",
          fetcher,
          120_000,
          async () => {},
          () => NOW,
          exec,
          () => {},
          join(dir, "wakes"),
          deployment,
        );
    const answers =
      (body = completion, status = 200) =>
      async (_url: string, init: RequestInit) =>
        init.method === "PATCH" ? new Response("{}", { status: 403 }) : new Response(body, { status });

    it("promotes on a valid completion and settles the wake it spent", async () => {
      const exec = ledger();
      expect(await promote("1.1", deps({ probe: probeWith(exec, answers()) }))).toMatchObject({ outcome: "promoted" });
      const rows = (await exec({ sql: "SELECT purpose, used_minutes, settled_at FROM glimmer_runtime", params: [] }))
        .rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: "key-check" });
      expect(rows[0]?.settled_at).not.toBeNull();
    });

    it("fails on an HTTP success that is no completion, and settles anyway", async () => {
      const exec = ledger();
      const result = await promote("1.1", deps({ probe: probeWith(exec, answers("{}")) }));
      expect(result).toMatchObject({ outcome: "failed", serving: "1.0" });
      expect(active()).toEqual(V10);
      const rows = (await exec({ sql: "SELECT settled_at FROM glimmer_runtime", params: [] })).rows;
      expect(rows[0]?.settled_at).not.toBeNull();
    });

    it("refuses with nothing sent when the allowance is spent or the ledger cannot be reached", async () => {
      const exec = ledger();
      // 90 minutes are all the days so far allow; a wake of 8 more is refused before any request.
      await reserveWake(exec, "monitor", 90, new Date(NOW), join(dir, "wakes"));
      let sent = 0;
      const counting = async (url: string, init: RequestInit) => {
        sent++;
        return answers()(url, init);
      };
      expect(await promote("1.1", deps({ probe: probeWith(exec, counting) }))).toMatchObject({
        outcome: "refused",
        serving: "1.0",
      });
      const down: Exec = async () => {
        throw new Error("D1 unavailable");
      };
      delete remote["isitlegit-loupe-1-1"];
      expect(await promote("1.1", deps({ probe: probeWith(down, counting) }))).toMatchObject({ outcome: "refused" });
      expect(sent).toBe(0);
      expect(active()).toEqual(V10);
    });
  });
});

// Every consumer of the version derives from the one active file.
describe("the active file is the one source of the served version (§32)", () => {
  afterEach(() => {
    vi.doUnmock("../../src/vision/glimmer-active.json");
    vi.resetModules();
  });
  it("is consistent with the caps the repository ships", async () => {
    const caps = await import("../../src/vision/glimmer-caps.ts");
    expect(caps.DEPLOYED_VERSION).toBe(caps.ACTIVE.version);
    expect(caps.DEPLOYMENT).toBe(caps.deploymentFor(caps.ACTIVE.version));
    expect(caps.DEPLOYED_MODEL).toBe(caps.targetOf(caps.ACTIVE.version, caps.ACTIVE.deployment).model);
  });
  it("moves the wake, the screening request and the recovery command together", async () => {
    vi.resetModules();
    vi.doMock("../../src/vision/glimmer-active.json", () => ({
      default: {
        version: "1.1",
        deployment: "isitlegit-loupe-1-1",
        previous: { version: "1.0", deployment: "isitlegit-loupe" },
      },
    }));
    const caps = await import("../../src/vision/glimmer-caps.ts");
    const wake = await import("../../src/vision/glimmer-request.ts");
    const screen = await import("../../src/vision/screen-request.ts");
    const named = "isitlegit-loupe-1-1#accounts/rizonetech/deployments/isitlegit-loupe-1-1";
    expect(caps.DEPLOYED_MODEL).toContain(named);
    const env = { FIREWORKS_API_KEY: "k", GLIMMER_GATEWAY_URL: "https://gateway.example/v1" };
    expect(JSON.parse(String(wake.oneTokenRequest(env).init.body)).model).toContain(named);
    expect(screen.glimmerBody({ messages: [] }).model).toContain(named);
    expect(caps.recoveryCommand(caps.DEPLOYED_VERSION)).toBe("node scripts/glimmer/deploy.ts ensure 1.1");
  });
});

describe("releasing to production (§36)", () => {
  let t = Date.parse("2026-11-02T08:00:00Z");
  const stages: string[] = [];
  const deps = (over: Partial<ReleaseDeps> = {}): ReleaseDeps => ({
    commit: "a".repeat(40),
    activeVersion: "1.1",
    preflight: async () => void stages.push("preflight"),
    servingState: async () => "worker-v1",
    deployWorker: async () => {
      stages.push("prepare");
      t += 60_000;
    },
    waitHealth: async () => {
      stages.push("activation");
      t += 30_000;
    },
    smoke: async () => {
      stages.push("probe");
      t += 20_000;
    },
    screenFixture: async () => {
      stages.push("screen");
      t += 10_000;
      return { screener: "glimmer", version: "1.1" };
    },
    now: () => new Date(t),
    ...over,
  });
  beforeEach(() => {
    t = Date.parse("2026-11-02T08:00:00Z");
    stages.length = 0;
  });

  it("releases with each stage timed separately against the budget", async () => {
    const result = await release(deps());
    expect(result).toMatchObject({
      outcome: "released",
      version: "1.1",
      timings: { prepare_ms: 60_000, activation_ms: 30_000, probe_ms: 20_000, screen_ms: 10_000, within_budget: true },
    });
    expect(stages).toEqual(["preflight", "prepare", "activation", "probe", "screen"]);
  });

  it("refuses at preflight before any deploy", async () => {
    const result = await release(
      deps({
        preflight: async () => {
          throw new Error("remote migrations are pending");
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "refused", stage: "preflight", serving: "unchanged" });
    expect(stages).not.toContain("prepare");
  });

  it("stops at the failed stage and says what is serving: changed, unchanged, uncertain", async () => {
    let serving = "worker-v1";
    const changed = await release(
      deps({
        servingState: async () => serving,
        deployWorker: async () => {
          serving = "worker-v2";
        },
        waitHealth: async () => {
          throw new Error("/health did not report the commit");
        },
      }),
    );
    expect(changed).toMatchObject({ outcome: "failed", stage: "activation", serving: "changed" });
    expect(stages).not.toContain("probe");
    const unchanged = await release(
      deps({
        deployWorker: async () => {
          throw new Error("wrangler deploy failed");
        },
      }),
    );
    expect(unchanged).toMatchObject({ outcome: "failed", stage: "prepare", serving: "unchanged" });
    let reads = 0;
    const uncertain = await release(
      deps({
        servingState: async () => {
          if (++reads > 1) throw new Error("wrangler cannot be read");
          return "worker-v1";
        },
        deployWorker: async () => {
          throw new Error("wrangler deploy lost its answer");
        },
      }),
    );
    expect(uncertain).toMatchObject({ outcome: "failed", stage: "prepare", serving: "uncertain" });
    expect(JSON.stringify(uncertain)).toContain("docs/operations.md");
  });

  it("fails when the deployed Worker serves the fixture by Spark or by another version", async () => {
    expect(await release(deps({ screenFixture: async () => ({ screener: "spark", version: "1.1" }) }))).toMatchObject({
      outcome: "failed",
      stage: "screen",
      detail: expect.stringContaining("spark"),
    });
    expect(await release(deps({ screenFixture: async () => ({ screener: "glimmer", version: "1.0" }) }))).toMatchObject(
      {
        outcome: "failed",
        stage: "screen",
        detail: expect.stringContaining("1.0"),
      },
    );
  });

  it("reports the budget expiring during a stage as a failure at that stage", async () => {
    const result = await release(
      deps({
        deployWorker: async () => {
          t += (BUDGET_MINUTES + 1) * 60_000;
        },
      }),
    );
    expect(result).toMatchObject({
      outcome: "failed",
      stage: "prepare",
      detail: expect.stringContaining("budget expired"),
    });
    expect(stages).not.toContain("activation");
  });

  it("reads the SCREEN check back from the deployed Worker's answer", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ checks: { SCREEN: "ok glimmer 1.1" } }), { status: 200 })) as typeof fetch;
    await expect(screenThroughWorker("https://worker.example", "t", fetcher)).resolves.toEqual({
      screener: "glimmer",
      version: "1.1",
    });
    const broken = (async () =>
      new Response(JSON.stringify({ checks: { SCREEN: "screening failed: error/model" } }), {
        status: 503,
      })) as typeof fetch;
    await expect(screenThroughWorker("https://worker.example", "t", broken)).rejects.toThrow("SCREEN");
    const absent = (async () => new Response(JSON.stringify({ checks: {} }), { status: 200 })) as typeof fetch;
    await expect(screenThroughWorker("https://worker.example", "t", absent)).rejects.toThrow("absent");
  });
});
