// D03 T04 §32: promoting a gate-passing Loupe version, recovering a failed promotion, and rolling back.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkInferenceKey, createBody, type Deployment, reserveWake } from "../../scripts/glimmer/deploy.ts";
import { type Client, type Deps, promote, readActive, rollback } from "../../scripts/glimmer/promote.ts";
import type { Active } from "../../src/vision/glimmer-caps.ts";
import type { Exec } from "../../src/vision/glimmer-minutes.ts";

const V10: Active = { version: "1.0", deployment: "isitlegit-loupe", previous: null };
const MIGRATION = readFileSync(join(import.meta.dirname, "../../src/db/migrations/0056_glimmer_runtime.sql"), "utf-8");
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
      if (writes++ === 0) writeFileSync(file, "{ torn");
      else real(file, value);
    };
    const restored = await promote("1.1", deps({ write: corruptFirst }));
    expect(restored).toMatchObject({ outcome: "failed", serving: "1.0", detail: expect.stringContaining("restored") });
    expect(active()).toEqual(V10);
    delete remote["isitlegit-loupe-1-1"];
    const neverReadable = await promote("1.1", deps({ write: (file) => writeFileSync(file, "{ torn") }));
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
