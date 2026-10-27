import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type Checks, type Deployment, runRollback, type Wrangler } from "../../scripts/rollback.ts";

// scripts/rollback.ts against stand-ins for wrangler and the Worker (D00 T01 §10): it chooses the right version, refuses
// before changing anything when it cannot, proves what serves afterwards, stays inside its deadline, and on every
// failure says whether the deployment changed.
const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-rollback-${process.pid}`);
const REJECTED = join(DIR, "rejected.json");
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

// Versions a (commit A), b and b2 (commit B, b2 a secret-only republish), c (commit C, active).
const COMMITS: Record<string, string> = { a: "A".repeat(40), b: "B".repeat(40), b2: "B".repeat(40), c: "C".repeat(40) };
const deployment = (version: string, at: number): Deployment => ({
  created_on: new Date(at).toISOString(),
  versions: [{ version_id: version, percentage: 100 }],
});
const HISTORY = [deployment("a", 1), deployment("b", 2), deployment("b2", 3), deployment("c", 4)];

function stage(active = "c", overrides: Partial<Wrangler> = {}) {
  const state = { active, rollbacks: [] as string[] };
  const wrangler: Wrangler = {
    activeVersion: async () => state.active,
    deployments: async () => HISTORY,
    commitOf: async (version) => COMMITS[version] ?? null,
    rollback: async (version) => {
      state.rollbacks.push(version);
      state.active = version;
    },
    ...overrides,
  };
  return { state, wrangler };
}
const passing = (state: { active: string }): Checks => ({
  health: async () => ({ commit: COMMITS[state.active] as string }),
  smoke: async () => ({ ok: true, lines: ["smoke passed"] }),
});
const fast = () => new Promise((r) => setTimeout(r, 10));
const run = (wrangler: Wrangler, checks: Checks, extra: Partial<Parameters<typeof runRollback>[0]> = {}) =>
  runRollback({ reason: "test", wrangler, checks, rejectedFile: REJECTED, waitMs: 2_000, pause: fast, ...extra });

describe("scripts/rollback.ts", () => {
  it("by default chooses the newest earlier version with another commit, rolls back, verifies, and records the version it left", async () => {
    const { state, wrangler } = stage("c");
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: true, changed: "yes" });
    expect(state.rollbacks).toEqual(["b2"]);
    expect(outcome.lines).toContain(`chosen: b2 (commit ${COMMITS.b})`);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual(["c"]);
  });

  it("skips a secret-only republish of the active commit", async () => {
    // c2 is c's code with another secret (a smoke-token rotation): rolling back to c would change nothing.
    const commits: Record<string, string> = { ...COMMITS, c2: COMMITS.c as string };
    const { state, wrangler } = stage("c2", {
      deployments: async () => [...HISTORY, deployment("c2", 5)],
      commitOf: async (version) => commits[version] ?? null,
    });
    const outcome = await run(wrangler, {
      ...passing(state),
      health: async () => ({ commit: commits[state.active] as string }),
    });
    expect(outcome.ok).toBe(true);
    expect(state.rollbacks).toEqual(["b2"]);
  });

  it("does not choose a rejected version again on a retry", async () => {
    // C was rolled back to B (b2 serves), and B proved broken too: the retry must not pick C again.
    writeFileSync(REJECTED, JSON.stringify(["c"]));
    const { state, wrangler } = stage("b2");
    const outcome = await run(wrangler, passing(state));
    expect(state.rollbacks).toEqual(["a"]);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8")).sort()).toEqual(["b2", "c"]);
  });

  it("rolls back to an explicit target, even past the default", async () => {
    const { state, wrangler } = stage("c");
    const outcome = await run(wrangler, passing(state), { target: "a" });
    expect(outcome.ok).toBe(true);
    expect(state.rollbacks).toEqual(["a"]);
  });

  it("refuses before changing anything when nothing is eligible, the target is gone or already active", async () => {
    writeFileSync(REJECTED, JSON.stringify(["a", "b", "b2"]));
    const none = stage("c");
    const nothing = await run(none.wrangler, passing(none.state));
    expect(nothing).toMatchObject({ ok: false, changed: "no" });
    expect(nothing.lines.at(-1)).toMatch(/no earlier version .* redeploy a known-good commit/);
    const gone = stage("c");
    const expired = await run(gone.wrangler, passing(gone.state), { target: "z" });
    expect(expired.lines.at(-1)).toMatch(/version z is gone/);
    expect(await run(gone.wrangler, passing(gone.state), { target: "c" })).toMatchObject({ ok: false, changed: "no" });
    expect([...none.state.rollbacks, ...gone.state.rollbacks]).toEqual([]);
  });

  it("fails on a wrong or missing /health and on a failed smoke check, saying the deployment changed", async () => {
    for (const checks of [
      (s: { active: string }) => ({ ...passing(s), health: async () => ({ commit: "D".repeat(40) }) }),
      (s: { active: string }) => ({ ...passing(s), health: async () => ({ error: "HTTP 500" }) }),
      (s: { active: string }) => ({ ...passing(s), smoke: async () => ({ ok: false, lines: ["BROWSER failed"] }) }),
    ]) {
      const { state, wrangler } = stage("c");
      const outcome = await run(wrangler, checks(state));
      expect(outcome).toMatchObject({ ok: false, changed: "yes" });
    }
  });

  it("waits while Cloudflare's locations still serve the old commit, then verifies", async () => {
    const { state, wrangler } = stage("c");
    let asks = 0;
    const checks: Checks = {
      ...passing(state),
      health: async () => ({ commit: ++asks < 3 ? (COMMITS.c as string) : (COMMITS[state.active] as string) }),
    };
    const outcome = await run(wrangler, checks);
    expect(outcome.ok).toBe(true);
    expect(asks).toBe(3);
  });

  it("fails when another version serves after the rollback or after the checks", async () => {
    const { state, wrangler } = stage("c", {
      rollback: async () => {
        // The rollback call returned but did not take effect.
      },
    });
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines.at(-1)).toBe("rollback: c serves all traffic, not b2");
    const moved = stage("c");
    const checks: Checks = {
      ...passing(moved.state),
      smoke: async () => {
        moved.state.active = "a";
        return { ok: true, lines: [] };
      },
    };
    expect((await run(moved.wrangler, checks)).lines.at(-1)).toBe(
      "rollback: a serves all traffic after the checks, not b2",
    );
  });

  it("reports a stalled wrangler call within its deadline, with the deployment state it can read", async () => {
    const { state, wrangler } = stage("c", {
      rollback: () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("wrangler rollback did not finish before the deadline")), 300),
        ),
    });
    const started = Date.now();
    const outcome = await run(wrangler, passing(state), { waitMs: 500 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines).toContain("active after the failure: c");
  });

  it("calls a deployment it cannot read back uncertain", async () => {
    let reads = 0;
    const { state, wrangler } = stage("c", {
      activeVersion: async () => {
        if (++reads > 1) throw new Error("status unavailable");
        return "c";
      },
    });
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: false, changed: "uncertain" });
  });

  it("says the deployment state is uncertain when interrupted, then stops its commands", async () => {
    // The script's own notice and cleanup, in a real process, interrupted while it waits.
    const program = `import("./scripts/rollback.ts").then(async (r) => { const s = await import("./scripts/smoke.ts");
      s.installSignalCleanup(); r.registerInterruptNotice(); setTimeout(() => {}, 20000); });`;
    const child = spawn(process.execPath, ["-e", program], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Long enough for the module to load and the listeners to be in place.
    await new Promise((r) => setTimeout(r, 1_500));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(stderr).toContain("rollback: interrupted; whether the deployment changed is uncertain");
  }, 15_000);
});
