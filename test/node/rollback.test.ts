import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Checks,
  checksFor,
  type Deployment,
  deployVersion,
  parseRollbackArgs,
  runRollback,
  SecretsChanged,
  type Serving,
  type Wrangler,
} from "../../scripts/rollback.ts";

// scripts/rollback.ts against stand-ins for wrangler and the Worker (D00 T01 §10): it chooses the right version, refuses
// before changing anything when it cannot, proves what serves afterwards, stays inside its deadline, and on every
// failure says whether the deployment changed.
const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-rollback-${process.pid}`);
const REJECTED = join(DIR, "rejected.json");
const servers: Server[] = [];
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  for (const server of servers) server.close();
});
// A local stand-in answering each request with `handle`.
async function serve(
  handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
) {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
const rejected = (versions: string[], commits: string[] = []) => JSON.stringify({ versions, commits });
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
// Upload numbers: later versions are higher.
const NUMBERS: Record<string, number> = { a: 1, b: 2, b2: 3, c: 4, c1: 3, c2: 4 };
const viewOf =
  (commits: Record<string, string>, numbers: Record<string, number> = NUMBERS) =>
  async (version: string) =>
    commits[version] ? { commit: commits[version] as string, number: numbers[version] ?? 0 } : null;

const all = (version: string): Serving => [{ version_id: version, percentage: 100 }];
function stage(active = "c", overrides: Partial<Wrangler> = {}) {
  const state = { active, rollbacks: [] as string[], split: undefined as Serving | undefined };
  const wrangler: Wrangler = {
    deployment: async () => state.split ?? all(state.active),
    deployments: async () => HISTORY,
    view: viewOf(COMMITS),
    rollback: async (version) => {
      state.rollbacks.push(version);
      state.active = version;
      state.split = undefined;
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
  runRollback({
    reason: "test",
    wrangler,
    checks,
    rejectedFile: REJECTED,
    waitMs: 2_000,
    pause: fast,
    // Commits A, B, C follow one another in history.
    isAncestor: async (older, newer) => (older[0] as string) < (newer[0] as string),
    ...extra,
  });

describe("scripts/rollback.ts", () => {
  it("by default chooses the newest earlier version with another commit, rolls back, verifies, and records the version it left", async () => {
    const { state, wrangler } = stage("c");
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: true, changed: "yes" });
    expect(state.rollbacks).toEqual(["b2"]);
    expect(outcome.lines).toContain(`chosen: b2 (commit ${COMMITS.b})`);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: ["c"], commits: [COMMITS.c] });
  });

  it("skips a secret-only republish of the active commit", async () => {
    // c2 is c's code with another secret (a smoke-token rotation): rolling back to c would change nothing.
    const commits: Record<string, string> = { ...COMMITS, c2: COMMITS.c as string };
    const { state, wrangler } = stage("c2", {
      deployments: async () => [...HISTORY, deployment("c2", 5)],
      view: viewOf(commits, { ...NUMBERS, c2: 5 }),
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
    writeFileSync(REJECTED, rejected(["c"], [COMMITS.c as string]));
    const { state, wrangler } = stage("b2");
    const outcome = await run(wrangler, passing(state));
    expect(state.rollbacks).toEqual(["a"]);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({
      versions: ["c", "b2"],
      commits: [COMMITS.c, COMMITS.b],
    });
  });

  it("does not go back to a rejected commit through another version of it", async () => {
    // History a, b, c1, c2 where c1 and c2 are one commit (a secret republish). Rolling back from c2 to b rejects
    // commit C; when b proves broken too, the retry must choose a, not c1.
    const commits: Record<string, string> = { ...COMMITS, c1: COMMITS.c as string, c2: COMMITS.c as string };
    const history = [deployment("a", 1), deployment("b", 2), deployment("c1", 3), deployment("c2", 4)];
    const state = { active: "c2", rollbacks: [] as string[] };
    const wrangler: Wrangler = {
      deployment: async () => all(state.active),
      deployments: async () => history,
      view: viewOf(commits),
      rollback: async (version) => {
        state.rollbacks.push(version);
        state.active = version;
      },
    };
    const checks: Checks = {
      health: async () => ({ commit: commits[state.active] as string }),
      smoke: async () => ({ ok: true, lines: [] }),
    };
    expect((await run(wrangler, checks)).ok).toBe(true);
    expect((await run(wrangler, checks)).ok).toBe(true);
    expect(state.rollbacks).toEqual(["b", "a"]);
  });

  it("records the version it leaves on a rollback, and nothing on a roll-forward, which clears its target", async () => {
    const { state, wrangler } = stage("c");
    const back = await run(wrangler, passing(state));
    expect(back.lines).toContain(
      `recorded: c (commit ${COMMITS.c}) as rolled away from, in ${REJECTED}; delete it once a good deploy is live`,
    );
    const forward = await run(wrangler, passing(state), { target: "c" });
    expect(forward.ok).toBe(true);
    expect(forward.lines).toContain(`recorded: nothing (a roll-forward); c is cleared from ${REJECTED} once verified`);
    // The good version b2 that the roll-forward left is still eligible for the next rollback.
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: [], commits: [] });
    const again = await run(wrangler, passing(state));
    expect(again.lines).toContain(`chosen: b2 (commit ${COMMITS.b})`);
  });

  it("refuses a split deployment without --to before any deployment call, naming the split", async () => {
    const { state, wrangler } = stage("c");
    state.split = [
      { version_id: "c", percentage: 90 },
      { version_id: "b2", percentage: 10 },
    ];
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines.at(-2)).toBe(
      "rollback: a split deployment serves (c 90%, b2 10%); name the version to restore with --to (docs/operations.md)",
    );
    expect(state.rollbacks).toEqual([]);
  });

  it("restores a named version from a split, either side or older, recording every other serving version", async () => {
    for (const target of ["c", "b2", "a"]) {
      rmSync(REJECTED, { force: true });
      const { state, wrangler } = stage("c");
      state.split = [
        { version_id: "c", percentage: 90 },
        { version_id: "b2", percentage: 10 },
      ];
      const outcome = await run(wrangler, passing(state), { target });
      expect(outcome).toMatchObject({ ok: true, changed: "yes" });
      expect(outcome.lines[0]).toBe(`split: c 90% (commit ${COMMITS.c}), b2 10% (commit ${COMMITS.b})`);
      expect(state.rollbacks).toEqual([target]);
      if (target === "c")
        expect(outcome.lines).toContain(
          `recorded: b2 (commit ${COMMITS.b}) as rolled away from, in ${REJECTED}; delete it once a good deploy is live`,
        );
      const record = JSON.parse(readFileSync(REJECTED, "utf-8"));
      expect(record.versions).toEqual(["c", "b2"].filter((v) => v !== target));
      expect(record.commits).toEqual([COMMITS.c, COMMITS.b].filter((c) => c !== COMMITS[target]));
    }
  });

  it("says when a version it leaves shares the target's commit, which stays eligible", async () => {
    const commits: Record<string, string> = { ...COMMITS, c2: COMMITS.c as string };
    const { state, wrangler } = stage("c", { view: viewOf(commits, { ...NUMBERS, c2: 5 }) });
    state.split = [
      { version_id: "c", percentage: 90 },
      { version_id: "c2", percentage: 10 },
    ];
    const outcome = await run(
      wrangler,
      { ...passing(state), health: async () => ({ commit: COMMITS.c as string }) },
      { target: "c" },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toContain(
      `recorded: c2 (its commit is the target's, so only the version) as rolled away from, in ${REJECTED}; delete it once a good deploy is live`,
    );
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: ["c2"], commits: [] });
  });

  it("reports every exit after the deployment call against the latest deployment", async () => {
    const original = (): Serving => [
      { version_id: "c", percentage: 90 },
      { version_id: "b2", percentage: 10 },
    ];
    // Something restores the original split during the smoke check: the run fails, and nothing changed overall.
    const restored = stage("c");
    restored.state.split = original();
    const outcome = await run(
      restored.wrangler,
      {
        ...passing(restored.state),
        smoke: async () => {
          restored.state.split = original();
          return { ok: true, lines: [] };
        },
      },
      { target: "a" },
    );
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines.at(-2)).toBe(
      "rollback: after the checks, the deployment is split (c 90%, b2 10%), not a at 100%",
    );
    // A /health failure reads the deployment again: still the target is yes, the original back is no.
    for (const [restore, expected] of [
      [false, "yes"],
      [true, "no"],
    ] as const) {
      const failing = stage("c");
      failing.state.split = original();
      const result = await run(
        failing.wrangler,
        {
          ...passing(failing.state),
          health: async () => {
            if (restore) failing.state.split = original();
            return { error: "HTTP 500" };
          },
        },
        { target: "a", waitMs: 400 },
      );
      expect(result).toMatchObject({ ok: false, changed: expected });
    }
    // Unreadable after the checks: uncertain.
    let reads = 0;
    const blind = stage("c", {
      deployment: async () => {
        if (++reads > 3) throw new Error("status unavailable");
        return reads <= 2 ? original() : all("a");
      },
    });
    expect(await run(blind.wrangler, passing(blind.state), { target: "a" })).toMatchObject({
      ok: false,
      changed: "uncertain",
    });
  });

  it("prints its help offline, changing nothing", async () => {
    expect(parseRollbackArgs(["--help"])).toEqual({ help: true });
    const record = join(DIR, "help-record.json");
    const child = spawn(process.execPath, ["scripts/rollback.ts", "--help"], {
      cwd: ROOT,
      env: { PATH: "", ROLLBACK_RECORD: record },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    expect(await new Promise((resolve) => child.on("exit", resolve))).toBe(0);
    for (const words of [
      "--to <version id>",
      "wrangler deployments status",
      "split deployment",
      "deployment changed: no | yes | uncertain",
    ])
      expect(stdout).toContain(words);
    expect(existsSync(record)).toBe(false);
  }, 15_000);

  it("refuses when the deployment changes while it prepares, before writing or deploying anything", async () => {
    let reads = 0;
    const { state, wrangler } = stage("c", {
      deployment: async () =>
        ++reads === 1
          ? all("c")
          : [
              { version_id: "c", percentage: 90 },
              { version_id: "b2", percentage: 10 },
            ],
    });
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines.at(-2)).toMatch(
      /the deployment changed while this run was preparing \(c, now c 90%, b2 10%\)/,
    );
    expect(state.rollbacks).toEqual([]);
    expect(existsSync(REJECTED)).toBe(false);
  });

  it("clears a roll-forward's target only once it is verified", async () => {
    writeFileSync(REJECTED, rejected(["c"], [COMMITS.c as string]));
    const refused = stage("b2", {
      rollback: async () => {
        throw new SecretsChanged(["SMOKE_TOKEN"]);
      },
    });
    expect(await run(refused.wrangler, passing(refused.state), { target: "c" })).toMatchObject({
      ok: false,
      changed: "no",
    });
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: ["c"], commits: [COMMITS.c] });
    const failing = stage("b2");
    await run(
      failing.wrangler,
      { ...passing(failing.state), smoke: async () => ({ ok: false, lines: [] }) },
      { target: "c" },
    );
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: ["c"], commits: [COMMITS.c] });
    const good = stage("b2");
    const outcome = await run(good.wrangler, passing(good.state), { target: "c" });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toContain(`cleared: c (commit ${COMMITS.c}) from ${REJECTED}`);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: [], commits: [] });
  });

  it("refuses a status or a record that is not well formed", async () => {
    for (const bad of [[], [{ version_id: "c", percentage: 50 }], [{ version_id: "", percentage: 100 }]]) {
      const { state, wrangler } = stage("c", { deployment: async () => bad as Serving });
      const outcome = await run(wrangler, passing(state), { target: "a" });
      expect(outcome).toMatchObject({ ok: false, changed: "no" });
      expect(outcome.lines.at(-2)).toMatch(/not a whole deployment/);
      expect(state.rollbacks).toEqual([]);
    }
    writeFileSync(REJECTED, JSON.stringify({ versions: [123], commits: [null] }));
    const damaged = stage("c");
    expect(await run(damaged.wrangler, passing(damaged.state))).toMatchObject({ ok: false, changed: "no" });
    expect(damaged.state.rollbacks).toEqual([]);
  });

  it("reads a version listed at 0% beside one at 100% as a single version, in either order", async () => {
    // History a, b, b2 (commit B), c (commit C); c serves, b2 is listed at 0%. Whichever comes first, the active
    // commit is C, so the default choice is b2 (commit B), the newest other code.
    for (const order of [
      [
        { version_id: "c", percentage: 100 },
        { version_id: "b2", percentage: 0 },
      ],
      [
        { version_id: "b2", percentage: 0 },
        { version_id: "c", percentage: 100 },
      ],
    ]) {
      rmSync(REJECTED, { force: true });
      const { state, wrangler } = stage("c");
      state.split = order;
      const outcome = await run(wrangler, passing(state));
      expect(outcome.ok).toBe(true);
      expect(outcome.lines[0]).toBe(`active: c (commit ${COMMITS.c})`);
      expect(state.rollbacks).toEqual(["b2"]);
    }
    // The reviewer's case: [b at 0%, c2 at 100%] with c2 a republish of c1's commit must go back to b, not c1.
    const commits: Record<string, string> = {
      b: COMMITS.b as string,
      c1: COMMITS.c as string,
      c2: COMMITS.c as string,
    };
    const history = [deployment("b", 1), deployment("c1", 2), deployment("c2", 3)];
    const { state, wrangler } = stage("c2", {
      view: viewOf(commits, { b: 1, c1: 2, c2: 3 }),
      deployments: async () => history,
    });
    state.split = [
      { version_id: "b", percentage: 0 },
      { version_id: "c2", percentage: 100 },
    ];
    rmSync(REJECTED, { force: true });
    const outcome = await run(wrangler, {
      ...passing(state),
      health: async () => ({ commit: commits[state.active] as string }),
    });
    expect(outcome.ok).toBe(true);
    expect(state.rollbacks).toEqual(["b"]);
  });

  it("judges a roll-forward by the code, not the upload number", async () => {
    // a2 is commit A uploaded again after c: the highest number, older code. Restoring it is a rollback that records c.
    const commits: Record<string, string> = { ...COMMITS, a2: COMMITS.a as string };
    const { state, wrangler } = stage("c", { view: viewOf(commits, { ...NUMBERS, a2: 9 }) });
    const outcome = await run(
      wrangler,
      { ...passing(state), health: async () => ({ commit: commits[state.active] as string }) },
      { target: "a2" },
    );
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8"))).toEqual({ versions: ["c"], commits: [COMMITS.c] });
  });

  it("says a target without a COMMIT_SHA cannot be proven, rather than calling it gone", async () => {
    const { state, wrangler } = stage("c", {
      view: async (version) => (version === "x" ? { commit: null, number: 7 } : viewOf(COMMITS)(version)),
    });
    const outcome = await run(wrangler, passing(state), { target: "x" });
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines.at(-2)).toMatch(/version x carries no COMMIT_SHA/);
  });

  it("pins the smoke check to the version it restored", async () => {
    const { state, wrangler } = stage("c");
    let pinned: string | undefined;
    await run(wrangler, {
      ...passing(state),
      smoke: async (_commit, version) => {
        pinned = version;
        return { ok: true, lines: [] };
      },
    });
    expect(pinned).toBe("b2");
  });

  it("records nothing when the named version is newer than every serving version", async () => {
    const { state, wrangler } = stage("b");
    state.split = [
      { version_id: "b", percentage: 90 },
      { version_id: "b2", percentage: 10 },
    ];
    const outcome = await run(wrangler, passing(state), { target: "c" });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toContain(`recorded: nothing (a roll-forward); c is cleared from ${REJECTED} once verified`);
    // Newer than one side only: a rollback relative to the newer side, so both others are recorded.
    rmSync(REJECTED, { force: true });
    const mixed = stage("a");
    mixed.state.split = [
      { version_id: "a", percentage: 90 },
      { version_id: "c", percentage: 10 },
    ];
    const back = await run(mixed.wrangler, passing(mixed.state), { target: "b2" });
    expect(back.ok).toBe(true);
    expect(JSON.parse(readFileSync(REJECTED, "utf-8")).versions).toEqual(["a", "c"]);
  });

  it("judges a split's change by the whole deployment: intact is no, moved is yes, unreadable is uncertain", async () => {
    const split = (): Serving => [
      { version_id: "c", percentage: 90 },
      { version_id: "b2", percentage: 10 },
    ];
    // Refused (changed secrets): the split is intact.
    const refused = stage("c", {
      rollback: async () => {
        throw new SecretsChanged(["SMOKE_TOKEN"]);
      },
    });
    refused.state.split = split();
    expect(await run(refused.wrangler, passing(refused.state), { target: "a" })).toMatchObject({
      ok: false,
      changed: "no",
    });
    // The call failed after Cloudflare moved the percentages: changed, and not the target at 100%.
    const moved = stage("c", {
      rollback: async () => {
        moved.state.split = [
          { version_id: "c", percentage: 50 },
          { version_id: "b2", percentage: 50 },
        ];
        throw new Error("connection reset");
      },
    });
    moved.state.split = split();
    const outcome = await run(moved.wrangler, passing(moved.state), { target: "a" });
    expect(outcome).toMatchObject({ ok: false, changed: "yes" });
    expect(outcome.lines).toContain("active after the failure: c 50%, b2 50%");
    // Still split after the call returned: a failure that says so.
    const stuck = stage("c", { rollback: async () => {} });
    stuck.state.split = split();
    const still = await run(stuck.wrangler, passing(stuck.state), { target: "a" });
    expect(still).toMatchObject({ ok: false, changed: "no" });
    expect(still.lines.at(-2)).toBe("rollback: the deployment is split (c 90%, b2 10%), not a at 100%");
    // Unreadable after a failed call.
    let reads = 0;
    const blind = stage("c", {
      deployment: async () => {
        if (++reads > 2) throw new Error("status unavailable");
        return split();
      },
      rollback: async () => {
        throw new Error("connection reset");
      },
    });
    expect(await run(blind.wrangler, passing(blind.state), { target: "a" })).toMatchObject({
      ok: false,
      changed: "uncertain",
    });
  });

  it("rolls back to an explicit target, even past the default", async () => {
    const { state, wrangler } = stage("c");
    const outcome = await run(wrangler, passing(state), { target: "a" });
    expect(outcome.ok).toBe(true);
    expect(state.rollbacks).toEqual(["a"]);
  });

  it("refuses before changing anything when nothing is eligible, the target is gone or already active", async () => {
    writeFileSync(REJECTED, rejected(["a", "b", "b2"]));
    const none = stage("c");
    const nothing = await run(none.wrangler, passing(none.state));
    expect(nothing).toMatchObject({ ok: false, changed: "no" });
    expect(nothing.lines.at(-2)).toMatch(/no earlier version .* redeploy a known-good commit/);
    const gone = stage("c");
    const expired = await run(gone.wrangler, passing(gone.state), { target: "z" });
    expect(expired.lines.at(-2)).toMatch(/version z is gone/);
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
    expect(outcome.lines.at(-2)).toBe("rollback: c serves all traffic, not b2");
    const moved = stage("c");
    const checks: Checks = {
      ...passing(moved.state),
      smoke: async () => {
        moved.state.active = "a";
        return { ok: true, lines: [] };
      },
    };
    expect((await run(moved.wrangler, checks)).lines.at(-2)).toBe(
      "rollback: after the checks, a serves all traffic, not b2",
    );
  });

  it("reports a stalled deployment call within its deadline, with the deployment state it can read", async () => {
    // Stand-ins that honour the deadline they are given, as the real ones do through runCommand and fetch signals.
    const stall = (deadline: number) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("did not finish before the deadline")), deadline - Date.now()),
      );
    const { state, wrangler } = stage("c", { rollback: (_v, _m, deadline) => stall(deadline) });
    const started = Date.now();
    const outcome = await run(wrangler, passing(state), { waitMs: 800 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines).toContain("active after the failure: c");
  });

  it("ends inside its whole budget even when the read after a failure stalls too", async () => {
    let reads = 0;
    const stall = (deadline: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stalled")), deadline - Date.now()));
    const { state, wrangler } = stage("c", {
      deployment: async (deadline) => (++reads <= 2 ? all("c") : stall(deadline)),
      rollback: (_v, _m, deadline) => stall(deadline),
    });
    const started = Date.now();
    const outcome = await run(wrangler, passing(state), { waitMs: 800 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome).toMatchObject({ ok: false, changed: "uncertain" });
  });

  it("refuses before changing anything when preflight or its record fails", async () => {
    const down = stage("c", {
      deployment: async () => {
        throw new Error("wrangler: not logged in");
      },
    });
    expect(await run(down.wrangler, passing(down.state))).toMatchObject({ ok: false, changed: "no" });
    writeFileSync(REJECTED, "{ not json");
    const damaged = stage("c");
    expect(await run(damaged.wrangler, passing(damaged.state))).toMatchObject({ ok: false, changed: "no" });
    rmSync(REJECTED);
    // The record's folder is a file, so the record cannot be written: nothing may change.
    writeFileSync(join(DIR, "blocked"), "");
    const unwritable = stage("c");
    const outcome = await run(unwritable.wrangler, passing(unwritable.state), {
      rejectedFile: join(DIR, "blocked/r.json"),
    });
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect([...down.state.rollbacks, ...damaged.state.rollbacks, ...unwritable.state.rollbacks]).toEqual([]);
  });

  it("refuses a rollback across changed secrets and says nothing changed", async () => {
    const { state, wrangler } = stage("c", {
      rollback: async () => {
        throw new SecretsChanged(["SMOKE_TOKEN"]);
      },
    });
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: false, changed: "no" });
    expect(outcome.lines.at(-2)).toMatch(
      /Cloudflare refused: secrets changed .*SMOKE_TOKEN.* redeploy a known-good commit/,
    );
  });

  it("reports each waiting stage, what /health answers meanwhile, and the total time", async () => {
    const { state, wrangler } = stage("c");
    let asks = 0;
    const logged: string[] = [];
    const checks: Checks = {
      ...passing(state),
      health: async () => ({ commit: ++asks < 2 ? (COMMITS.c as string) : (COMMITS[state.active] as string) }),
    };
    const outcome = await run(wrangler, checks, { log: (line) => logged.push(line) });
    expect(logged).toEqual(
      expect.arrayContaining([
        "Reading the versions serving traffic...",
        "Choosing a version from the deployment history...",
        `Rolling back to b2 (commit ${COMMITS.b})...`,
        "Waiting for /health to report the chosen commit...",
        `  /health: commit ${COMMITS.c}`,
      ]),
    );
    expect(outcome.lines.at(-1)).toMatch(/^rollback finished in \d+ s$/);
  });

  it("checks the whole command line before anything runs", () => {
    const id = "64244598-f549-4992-907a-54cc46d1c396";
    expect(parseRollbackArgs(["--reason", "broke", "--to", id])).toEqual({ reason: "broke", target: id });
    expect(parseRollbackArgs(["--reason", "broke"])).toEqual({ reason: "broke" });
    expect(() => parseRollbackArgs(["--reason", "broke", "--to"])).toThrow();
    expect(() => parseRollbackArgs(["--reason", "broke", "--to", "latest"])).toThrow(/needs a version id/);
    expect(() => parseRollbackArgs(["--reason", "broke", "--force"])).toThrow();
    expect(() => parseRollbackArgs(["--reason", "broke", id])).toThrow();
    expect(() => parseRollbackArgs(["--to", id])).toThrow(/give the reason/);
  });

  it("refuses a mistyped command line from the real entry point without touching the deployment", async () => {
    // With an empty PATH no wrangler could run: exit 2 and the message prove the refusal came first.
    const child = spawn(process.execPath, ["scripts/rollback.ts", "--reason", "x", "--to"], {
      cwd: ROOT,
      env: { PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(2);
    expect(stderr).toContain("deployment changed: no");
  }, 15_000);

  it("deploys through Cloudflare's API without force, and turns error 10220 into SecretsChanged", async () => {
    const bodies: { url: string; body: unknown }[] = [];
    let answer = { status: 200, body: { success: true, errors: [] } as object };
    const api = await serve((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push({ url: req.url as string, body: JSON.parse(raw) });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await deployVersion(api, "t", "v1", "why", Date.now() + 2_000);
    expect(bodies[0]?.url).toMatch(/\/workers\/scripts\/isitlegit\/deployments$/);
    expect(bodies[0]?.body).toMatchObject({
      strategy: "percentage",
      versions: [{ version_id: "v1", percentage: 100 }],
    });
    answer = {
      status: 400,
      body: {
        success: false,
        errors: [
          { code: 10220, message: "Cannot roll back. The following secrets have changed: SMOKE_TOKEN, META_KEY" },
        ],
      },
    };
    const refused = await deployVersion(api, "t", "v1", "why", Date.now() + 2_000).catch((e) => e);
    expect(refused).toBeInstanceOf(SecretsChanged);
    expect(refused.secrets).toEqual(["SMOKE_TOKEN", "META_KEY"]);
    expect(bodies[1]?.url).not.toContain("force");
    answer = { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } };
    await expect(deployVersion(api, "t", "v1", "why", Date.now() + 2_000)).rejects.toThrow(/HTTP 403 10000/);
  });

  it("bounds /health by its deadline whether the headers or the body stall", async () => {
    const headers = await serve(() => {});
    const body = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"commit":');
    });
    for (const base of [headers, body]) {
      const started = Date.now();
      const answer = await checksFor(base).health(Date.now() + 300);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(answer).toHaveProperty("error");
    }
  });

  it("calls a deployment it cannot read back uncertain", async () => {
    let reads = 0;
    const { state, wrangler } = stage("c", {
      deployment: async () => {
        if (++reads > 2) throw new Error("status unavailable");
        return all("c");
      },
    });
    const outcome = await run(wrangler, passing(state));
    expect(outcome).toMatchObject({ ok: false, changed: "uncertain" });
  });

  it("says the deployment state is uncertain when interrupted during the deployment call, and stops that command", async () => {
    // The real entry point against a stand-in pnpm: status, history and versions answer, and the deployment call
    // (`wrangler auth token`, its first step) hangs until the interrupt.
    const bin = join(DIR, "bin");
    mkdirSync(bin, { recursive: true });
    const pidFile = join(DIR, "stalled.pid");
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh
case "$*" in
  *"deployments status"*) echo '{"versions":[{"version_id":"c","percentage":100}]}' ;;
  *"deployments list"*) echo '[{"created_on":"1","versions":[{"version_id":"b","percentage":100}]},{"created_on":"2","versions":[{"version_id":"c","percentage":100}]}]' ;;
  *"versions view c"*) echo '{"number":2,"resources":{"bindings":[{"name":"COMMIT_SHA","text":"${"C".repeat(40)}"}]}}' ;;
  *"versions view b"*) echo '{"number":1,"resources":{"bindings":[{"name":"COMMIT_SHA","text":"${"B".repeat(40)}"}]}}' ;;
  *"auth token"*) echo $$ > "${pidFile}"; exec sleep 30 ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ["scripts/rollback.ts", "--reason", "interrupt test"], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROLLBACK_RECORD: REJECTED },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let waited = 0; !stdout.includes("Rolling back to b") || !existsSync(pidFile); waited += 100) {
      if (waited > 10_000) throw new Error(`the rollback never reached the deployment call: ${stdout}${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const stalled = Number(readFileSync(pidFile, "utf-8"));
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(stderr).toContain("rollback: interrupted; whether the deployment changed is uncertain");
    expect(() => process.kill(stalled, 0)).toThrow();
  }, 20_000);
});
