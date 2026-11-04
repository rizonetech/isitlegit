// The evaluation runner (D08 T02 §1): the migration, the pure rules, and the run on distinct injected answers, so a
// stored row that differs from its injected response, or a partial run reported complete, fails here.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Api,
  boundedBy,
  CASE_TIMEOUT_MS,
  type CaseState,
  type Db,
  type Env,
  liveDb,
  type ResultRow,
  type RunRow,
  resolveSelection,
  runEval,
  verifyLine,
  verifyRun,
  WriteFailed,
} from "../../eval/run.ts";
import {
  EXIT,
  exitCode,
  type Outcome,
  parseArgs,
  perSampleEstimate,
  preflightProblems,
  type RunSample,
  recoveryHint,
  runStatus,
  selectSamples,
} from "../../eval/run-core.ts";
import { inline } from "../../src/meta/budget-sql.ts";

const ROOT = join(import.meta.dirname, "../..");
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "eval-run-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the migration 0067", () => {
  const sql = readFileSync(join(ROOT, "src/db/migrations/0067_eval.sql"), "utf-8");
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(sql);
    return db;
  };
  const run = (db: DatabaseSync, over: Record<string, string | number | null> = {}) => {
    const r = {
      id: "r1",
      commit_sha: "abcdef1",
      set_version: "a".repeat(64),
      mode: "full",
      sets: "synthetic-sa",
      status: "running",
      selected: 2,
      cap_usd: 1,
      started_at: "2026-11-01T00:00:00Z",
      finished_at: null,
      ...over,
    };
    db.prepare(
      "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      r.id,
      r.commit_sha,
      r.set_version,
      r.mode,
      r.sets,
      r.status,
      r.selected,
      r.cap_usd,
      r.started_at,
      r.finished_at,
    );
  };
  const result = (db: DatabaseSync, over: Record<string, string | number | null> = {}) => {
    const r = { run_id: "r1", sample: "synthetic-sa/a.eml", outcome: "done", label: "attack", ...over };
    db.prepare(
      "INSERT INTO eval_results (run_id, sample, outcome, label, category) VALUES (?, ?, ?, ?, 'phishing')",
    ).run(r.run_id, r.sample, r.outcome, r.label);
  };

  it("applies, and refuses a duplicate result, an unknown outcome and a complete run with no finish time", () => {
    const db = fresh();
    run(db);
    result(db);
    expect(() => result(db)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => result(db, { sample: "synthetic-sa/b.eml", outcome: "fine" })).toThrow(/CHECK/);
    expect(() => result(db, { sample: "bare.eml" })).toThrow(/CHECK/);
    expect(() => run(db, { id: "r2", status: "complete" })).toThrow(/CHECK/);
    expect(() => run(db, { id: "r3", status: "running", finished_at: "2026-11-01T01:00:00Z" })).toThrow(/CHECK/);
    run(db, { id: "r4", status: "complete", finished_at: "2026-11-01T01:00:00Z" });
    expect(() => run(db, { id: "r5", sets: "" })).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO eval_results (run_id, sample, outcome, label, category, http_status) VALUES ('r1', 'a/b', 'refused', 'attack', 'x', 99)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("the rules", () => {
  const base = {
    selected: 10,
    capUsd: 1,
    perSampleUsd: 0.08,
    day: "2026-11-01",
    daySpentUsd: 1,
    totalSpentUsd: 20,
    allowance: { used: 0, limit: 50 },
  };

  it("refuse a run before any upload: no samples, no cap, over the stated cap, any shared cap, or the allowance", () => {
    expect(preflightProblems(base)).toEqual([]);
    expect(preflightProblems({ ...base, selected: 0 }).join()).toMatch(/no samples/);
    expect(preflightProblems({ ...base, capUsd: Number.NaN }).join()).toMatch(/--cap-usd/);
    expect(preflightProblems({ ...base, capUsd: 0.5 }).join()).toMatch(/passes the stated cap/);
    expect(preflightProblems({ ...base, daySpentUsd: 14.5 }).join()).toMatch(/shared day cap/);
    expect(preflightProblems({ ...base, totalSpentUsd: 119.9 }).join()).toMatch(/shared total cap/);
    expect(preflightProblems({ ...base, totalSpentUsd: 89.5 }).join()).toMatch(/shared reserve cap/);
    expect(preflightProblems({ ...base, selected: 10, allowance: { used: 45, limit: 50 } }).join()).toMatch(
      /10 samples pass the organisation's 5 cases left today/,
    );
    expect(preflightProblems({ ...base, selected: 10, uploads: 5, allowance: { used: 45, limit: 50 } })).toEqual([]);
  });

  it("estimate from the last run's cost, US$0.08 when none", () => {
    expect(perSampleEstimate(null)).toBe(0.08);
    expect(perSampleEstimate(0.031)).toBe(0.031);
    expect(perSampleEstimate(0)).toBe(0.08);
  });

  it("call a run complete only when every sample ended done or partial, and name its exit code", () => {
    const o = (...xs: Outcome[]) => xs;
    expect(runStatus(3, o("done", "partial", "done"))).toBe("complete");
    expect(runStatus(3, o("done", "partial"))).toBe("incomplete");
    expect(runStatus(3, o("done", "partial", "timeout"))).toBe("incomplete");
    for (const bad of ["refused", "capped", "timeout", "stale-repeat", "lost"] as const)
      expect(runStatus(2, o("done", bad))).toBe("incomplete");
    expect([exitCode("complete"), exitCode("incomplete"), exitCode("aborted"), exitCode("refused")]).toEqual([
      0, 2, 1, 3,
    ]);
  });

  it("validate every option", () => {
    expect(parseArgs(["--cap-usd", "0.5", "--limit", "10"])).toMatchObject({ capUsd: 0.5, limit: 10 });
    for (const bad of [
      ["--limit", "0", "--cap-usd", "1"],
      ["--limit", "x", "--cap-usd", "1"],
      ["--cap-usd", "-1"],
      ["--cap-usd", "0"],
      ["--set", "other", "--cap-usd", "1"],
      ["--bogus"],
      [],
      ["--resume", "x", "--cap-usd", "1"],
    ])
      expect(parseArgs(bad), bad.join(" ")).toHaveProperty("error");
    expect(parseArgs(["--verify", "abcdefgh-1"])).toMatchObject({ verify: "abcdefgh-1" });
    expect(parseArgs(["--cap-usd", "1", "--mode", "ablate:no-sam"])).toMatchObject({ mode: "ablate:no-sam" });
    expect(parseArgs(["--cap-usd", "1", "--replay", "run-00000001"])).toMatchObject({ replay: "run-00000001" });
    expect(parseArgs(["--mode"])).toHaveProperty("error");
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
  });

  it("select set-qualified samples and a set version that follows the content", () => {
    const root = temp();
    const make = (body: string) => {
      mkdirSync(join(root, "synthetic-sa"), { recursive: true });
      writeFileSync(join(root, "synthetic-sa", "a.eml"), body);
      writeFileSync(
        join(root, "synthetic-sa", "labels.json"),
        JSON.stringify([
          {
            path: "a.eml",
            label: "attack",
            category: "credential-phishing",
            expected: [],
            source: "x",
            basis: "model",
          },
        ]),
      );
    };
    make("one");
    const first = selectSamples(root, ["synthetic-sa"]);
    expect(first.samples.map((s) => s.id)).toEqual(["synthetic-sa/a.eml"]);
    expect(first.setVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(selectSamples(root, ["synthetic-sa"]).setVersion).toBe(first.setVersion);
    make("two");
    expect(selectSamples(root, ["synthetic-sa"]).setVersion).not.toBe(first.setVersion);
    expect(() => selectSamples(root, ["missing"])).toThrow();
  });
});

// ---- the run on injected answers ----------------------------------------------------------------------------------------

type CaseSpec = {
  status?: CaseState["status"] | undefined;
  verdict?: CaseState["verdict"] | undefined;
  costUsd?: number | undefined;
  critical?: boolean | undefined;
  createdAt?: string | undefined;
  polls?: number | undefined;
  ms?: number | undefined;
};
type Script = {
  // What the upload answers for a sample (by index), the case it opened, or a throw.
  upload?: (
    i: number,
    sample: RunSample,
    call: number,
  ) => { status: number; caseId?: string; repeat?: boolean } | "throw";
  cases: Record<string, CaseSpec>;
};

function setup(
  count: number,
  script: Script,
  over: { allowance?: { used: number; limit: number }; cost?: number } = {},
) {
  const samples: RunSample[] = Array.from({ length: count }, (_, i) => ({
    id: `synthetic-sa/s${String(i).padStart(2, "0")}.eml`,
    set: "synthetic-sa",
    path: `s${String(i).padStart(2, "0")}.eml`,
    file: `/nowhere/s${i}.eml`,
    label: i % 2 ? "genuine" : "attack",
    category: i % 2 ? "genuine-business" : "credential-phishing",
    sha256: "0".repeat(64),
  }));
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const uploads: string[] = [];
  const calls = new Map<string, number>();
  const polls = new Map<string, number>();
  const runs = new Map<string, RunRow>();
  const stored = new Map<string, ResultRow>();
  const failWrites = { count: 0 };
  const logs: string[] = [];
  const tickers = new Set<() => void>();
  const identity = {
    user: "user-1" as string | null,
    memberships: ["org-eval"],
    org: "org-eval",
    commit: "deadbeef1234",
  };
  const api: Api = {
    commit: async () => identity.commit,
    whoami: async () => identity.user,
    upload: async (sample) => {
      uploads.push(sample.id);
      const i = samples.findIndex((s) => s.id === sample.id);
      const n = (calls.get(sample.id) ?? 0) + 1;
      calls.set(sample.id, n);
      const answer = script.upload ? script.upload(i, sample, n) : { status: 201, caseId: `case-${i}` };
      if (answer === "throw") throw new Error("network");
      return answer;
    },
  };
  const db: Db = {
    orgId: async () => identity.org,
    memberships: async () => identity.memberships,
    allowance: async () => over.allowance ?? { used: 0, limit: 50 },
    spent: async () => ({ daySpentUsd: 0, totalSpentUsd: 10 }),
    lastCostPerCase: async () => over.cost ?? null,
    caseState: async (id) => {
      const c = script.cases[id];
      if (!c) return null;
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      const done = n > (c.polls ?? 0);
      return {
        status: done ? (c.status ?? "done") : "running",
        verdict: c.verdict ?? null,
        costUsd: c.costUsd ?? 0.02,
        critical: c.critical ?? false,
        createdAt: c.createdAt ?? new Date(clock).toISOString(),
        updatedAt: new Date(Date.parse(c.createdAt ?? new Date(clock).toISOString()) + (c.ms ?? 1500)).toISOString(),
      };
    },
    insertRun: async (r) => void runs.set(r.id, r),
    putResult: async (r) => {
      if (failWrites.count > 0) {
        failWrites.count--;
        throw new Error("d1 down");
      }
      stored.set(`${r.runId}|${r.sample}`, r);
    },
    finishRun: async (id, status, costUsd, finishedAt) => {
      const r = runs.get(id) as RunRow;
      runs.set(id, { ...r, status, costUsd, finishedAt });
    },
    readRun: async (id) => {
      const r = runs.get(id);
      return r ? { run: r, results: [...stored.values()].filter((x) => x.runId === id) } : null;
    },
  };
  const journalDir = temp();
  const env: Env = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    id: () => "run-00000001",
    journalDir,
    bytes: () => new TextEncoder().encode("x"),
    log: (line) => void logs.push(line),
    timeout: (_ms, work) => work(),
    ticker: (_ms, fn) => {
      tickers.add(fn);
      return () => void tickers.delete(fn);
    },
  };
  return {
    samples,
    api,
    db,
    env,
    logs,
    tick: () => {
      for (const fn of tickers) fn();
    },
    identity,
    uploads,
    runs,
    stored,
    failWrites,
    advance: (ms: number) => {
      clock += ms;
    },
    journalDir,
  };
}

const opts = (capUsd = 5) => ({ capUsd, dry: false });
type T = ReturnType<typeof setup>;
const go = (t: T, options: { capUsd: number; dry: boolean }, extra: { api?: Api; resume?: string } = {}) =>
  runEval({
    samples: t.samples,
    setVersion: "v".repeat(64),
    sets: ["synthetic-sa"],
    sampleLimit: null,
    options,
    api: extra.api ?? t.api,
    db: t.db,
    env: t.env,
    resume: extra.resume ?? null,
  });
const caseFor = (i: number, over: CaseSpec = {}): Record<string, CaseSpec> => ({
  [`case-${i}`]: {
    status: "done" as const,
    verdict: (["safe", "suspicious", "malicious"] as const)[i % 3],
    costUsd: 0.01 * (i + 1),
    critical: i % 4 === 0,
    ...over,
  },
});

describe("a run", () => {
  it("stores exactly what each injected case says: verdict, a null verdict on a partial case, time, cost, critical, case id", async () => {
    const cases = Object.assign(
      {},
      ...Array.from({ length: 10 }, (_, i) => caseFor(i)),
      caseFor(3, { status: "partial", verdict: null }),
    );
    const t = setup(10, { cases });
    const r = await go(t, opts(), {});
    expect(r.status).toBe("complete");
    expect(r.exit).toBe(0);
    expect(r.results).toHaveLength(10);
    expect(new Set(r.results.map((x) => x.caseId)).size).toBe(10);
    for (const [i, row] of r.results.entries()) {
      expect(row.sample).toBe(t.samples[i]?.id);
      expect(row.caseId).toBe(`case-${i}`);
      expect(row.label).toBe(t.samples[i]?.label);
      if (i === 3) {
        expect(row).toMatchObject({ outcome: "partial", verdict: null });
      } else {
        expect(row).toMatchObject({
          outcome: "done",
          verdict: (["safe", "suspicious", "malicious"] as const)[i % 3],
          costUsd: 0.01 * (i + 1),
          criticalFound: i % 4 === 0,
        });
      }
      expect(t.stored.get(`run-00000001|${row.sample}`)).toEqual(row);
    }
    const run = t.runs.get("run-00000001") as RunRow;
    expect(run).toMatchObject({ status: "complete", commitSha: "deadbeef1234", selected: 10, capUsd: 5 });
    expect(run.costUsd).toBeCloseTo(r.costUsd);
    expect((await verifyRun(t.db, "run-00000001")).problems).toEqual([]);
  });

  it("is refused before any upload by a cap, an estimate or the allowance", async () => {
    for (const [capUsd, allowance] of [
      [0.1, { used: 0, limit: 50 }],
      [5, { used: 48, limit: 50 }],
    ] as const) {
      const t = setup(5, { cases: {} }, { allowance });
      const r = await go(t, opts(capUsd), {});
      expect(r).toMatchObject({ status: "refused", exit: 3 });
      expect(t.uploads).toEqual([]);
      expect(t.runs.size).toBe(0);
    }
  });

  it("calls a partial population incomplete (exit 2), never complete: a timeout, a refusal, a 429", async () => {
    const t = setup(6, {
      upload: (i) =>
        i === 1
          ? { status: 400 }
          : i === 2
            ? { status: 201, caseId: "case-2" }
            : i === 5
              ? { status: 429 }
              : { status: 201, caseId: `case-${i}` },
      cases: { ...caseFor(0), ...caseFor(2, { polls: 10 ** 6 }), ...caseFor(3), ...caseFor(4) },
    });
    const r = await go(t, opts(), {});
    expect(r.status).toBe("incomplete");
    expect(r.exit).toBe(2);
    const by = Object.fromEntries(r.results.map((x) => [x.sample.slice(-7, -4), x.outcome]));
    expect(by).toMatchObject({ s00: "done", s01: "refused", s02: "timeout", s03: "done", s04: "done", s05: "capped" });
    expect(r.results).toHaveLength(6);
    expect((t.runs.get("run-00000001") as RunRow).status).toBe("incomplete");
    expect((await verifyRun(t.db, "run-00000001")).ok).toBe(true);
    expect(CASE_TIMEOUT_MS).toBe(300_000);
  });

  it("keeps a sample it never sent in the denominator, as lost, when the shared allowance or session stops it", async () => {
    const t = setup(8, {
      upload: (i) => (i >= 3 ? { status: 429 } : { status: 201, caseId: `case-${i}` }),
      cases: { ...caseFor(0), ...caseFor(1), ...caseFor(2) },
    });
    const r = await go(t, opts(), {});
    expect(r.results).toHaveLength(8);
    expect(r.results.filter((x) => x.outcome === "capped" || x.outcome === "lost").length).toBe(5);
    expect(r.status).toBe("incomplete");
  });

  it("records a repeat of an earlier run's case as stale-repeat and measures nothing", async () => {
    const t = setup(3, {
      upload: (i) => (i === 1 ? { status: 200, caseId: "old", repeat: true } : { status: 201, caseId: `case-${i}` }),
      cases: {
        ...caseFor(0),
        ...caseFor(2),
        old: { status: "done", verdict: "safe", createdAt: "2026-11-01T08:00:00.000Z" },
      },
    });
    const r = await go(t, opts(), {});
    expect(r.results[1]).toMatchObject({ outcome: "stale-repeat", caseId: "old", verdict: null, ms: null, costUsd: 0 });
    expect(r.status).toBe("incomplete");
  });

  it("recovers a lost upload response from the repeat of the case this run opened", async () => {
    const t = setup(2, {
      upload: (i, _s, call) =>
        i === 0 && call === 1
          ? "throw"
          : i === 0
            ? { status: 200, caseId: "case-0", repeat: true }
            : { status: 201, caseId: `case-${i}` },
      cases: { ...caseFor(0), ...caseFor(1) },
    });
    const r = await go(t, opts(), {});
    expect(r.results[0]).toMatchObject({ outcome: "done", caseId: "case-0" });
    expect(r.status).toBe("complete");
  });

  it("retries a 503 and gives up after the bound, leaving the sample refused", async () => {
    const t = setup(2, {
      upload: (i, _s, call) => (i === 0 ? { status: 503 } : call ? { status: 201, caseId: "case-1" } : { status: 201 }),
      cases: { ...caseFor(1) },
    });
    const r = await go(t, opts(), {});
    expect(t.uploads.filter((u) => u === t.samples[0]?.id)).toHaveLength(4);
    expect(r.results[0]?.outcome).toBe("refused");
  });

  it("aborts on a refused session, keeps every case id, and resumes by polling without uploading again", async () => {
    const t = setup(4, {
      upload: (i) => (i === 3 ? { status: 401 } : { status: 201, caseId: `case-${i}` }),
      cases: { ...caseFor(0), ...caseFor(1), ...caseFor(2, { polls: 10 ** 6 }), ...caseFor(3) },
    });
    // Concurrency 4 sends all four at once; the session refusal aborts the run.
    const first = await go(t, opts(), {});
    expect(first.status).toBe("aborted");
    expect(first.exit).toBe(1);
    expect((t.runs.get("run-00000001") as RunRow).status).toBe("aborted");
    // The session is back: the same run resumes, uploads only the sample that never opened a case.
    const before = t.uploads.length;
    const t2api: Api = {
      ...t.api,
      upload: async (s) => {
        t.uploads.push(s.id);
        return { status: 201, caseId: "case-3" };
      },
    };
    t.db.caseState = (async (id: string) => ({
      status: "done",
      verdict: "safe",
      costUsd: 0.01,
      critical: false,
      createdAt: "2026-11-01T10:00:00.000Z",
      id,
    })) as never;
    const second = await go(t, opts(), { api: t2api, resume: "run-00000001" });
    expect(second.status).toBe("complete");
    expect(t.uploads.slice(before)).toEqual([t.samples[3]?.id]);
    expect(second.results.map((x) => x.caseId)).toEqual(["case-0", "case-1", "case-2", "case-3"]);
  });

  it("aborts when a result cannot be stored after its retries, and never reports complete", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    t.failWrites.count = 100;
    const r = await go(t, opts(), {});
    expect(r.status).toBe("aborted");
    expect(r.problems.join()).toMatch(/could not be stored/);
    expect(WriteFailed.name).toBe("WriteFailed");
  });

  it("stops starting samples once the measured spend reaches the stated cap, ending incomplete", async () => {
    const cases = Object.assign({}, ...Array.from({ length: 10 }, (_, i) => caseFor(i, { costUsd: 0.4 })));
    const t = setup(10, { cases }, { cost: 0.05 });
    const r = await go(t, opts(0.6), {});
    expect(r.status).toBe("incomplete");
    expect(r.problems.join()).toMatch(/stopped early: budget/);
    // The cap is checked before each sample starts: the four in flight finish, and no fifth is sent.
    expect(t.uploads).toHaveLength(4);
    expect(r.results.filter((x) => x.outcome === "lost")).toHaveLength(6);
    expect(r.results.some((x) => x.outcome === "lost")).toBe(true);
  });

  it("verifies a stored run against its cases, and names a result that differs from its case", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    await go(t, opts(), {});
    expect((await verifyRun(t.db, "run-00000001")).ok).toBe(true);
    const key = `run-00000001|${t.samples[0]?.id}`;
    t.stored.set(key, { ...(t.stored.get(key) as ResultRow), verdict: "malicious" });
    expect((await verifyRun(t.db, "run-00000001")).problems.join()).toMatch(
      /stored done\/malicious, the case says done\/safe/,
    );
    t.stored.delete(key);
    expect((await verifyRun(t.db, "run-00000001")).problems.join()).toMatch(/1 results for 2 selected samples/);
    expect((await verifyRun(t.db, "nope-nope-nope")).ok).toBe(false);
  });
});

describe("the command", () => {
  const run = (args: string[]) => {
    try {
      const out = execFileSync("pnpm", ["eval:run", ...args], {
        cwd: ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  it("runs through the package command: usage with --help, a refusal (exit 3) for a bad option or no cap", () => {
    expect(run(["--help"])).toMatchObject({ code: 0 });
    expect(run(["--help"]).out).toMatch(/usage: pnpm eval:run/);
    expect(run(["--limit", "0", "--cap-usd", "1"])).toMatchObject({ code: EXIT.refused });
    expect(run(["--limit", "10"]).out).toMatch(/--cap-usd is required/);
  });
});

// ---- the live adapter on the real schema ------------------------------------------------------------------------------------

describe("the live database adapter (every migration applied to an in-memory database)", () => {
  const migrations = join(ROOT, "src/db/migrations");
  function seeded() {
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync(migrations)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(migrations, f), "utf-8"));
    const at = "2026-11-01T08:00:00.000Z";
    db.exec(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES ('org-eval', 'IsItLegit Eval', 'eval', '${at}'), ('org-other', 'Other Org', 'other', '${at}')`,
    );
    db.exec(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Eval', 'eval@isitlegit.co.za', 1, '${at}', '${at}'), ('u2', 'Two', 'two@x.example', 1, '${at}', '${at}')`,
    );
    db.exec(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m1', 'org-eval', 'u1', 'owner', '${at}'), ('m2', 'org-eval', 'u2', 'owner', '${at}'), ('m3', 'org-other', 'u2', 'owner', '${at}')`,
    );
    db.exec(`INSERT INTO cases (id, org_id, channel, status, verdict, created_at, updated_at) VALUES
      ('c1', 'org-eval', 'upload', 'done', 'suspicious', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:04.321Z'),
      ('c2', 'org-eval', 'upload', 'running', NULL, '2026-11-01T10:01:00.000Z', '2026-11-01T10:01:00.000Z'),
      ('c3', 'org-other', 'upload', 'done', 'safe', '2026-11-01T10:02:00.000Z', '2026-11-01T10:02:01.000Z')`);
    db.exec(`INSERT INTO model_spend (id, at, day, source, caller, model, case_id, estimate_usd, actual_usd, state) VALUES
      ('s1', '${at}', '2026-11-01', 'worker', 'case', 'm', 'c1', 0.04, 0.03, 'settled'),
      ('s2', '${at}', '2026-11-01', 'worker', 'case', 'm', 'c1', 0.02, NULL, 'reserved'),
      ('s3', '${at}', '2026-11-01', 'worker', 'case', 'm', 'c2', 0.07, NULL, 'reserved'),
      ('s4', '${at}', '2026-11-01', 'worker', 'case', 'm', 'c3', 9, 9, 'settled')`);
    db.exec(
      `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, created_at) VALUES ('c1', 'r1', 'E1', 1, 'x', 'critical', 's', '${at}'), ('c2', 'r1', 'E1', 1, 'x', 'low', 's', '${at}')`,
    );
    return db;
  }
  const exec = (db: DatabaseSync) => async (s: { sql: string; params: (string | number | null)[] }) => {
    const stmt = db.prepare(inline(s));
    return /^\s*(SELECT|WITH)/i.test(s.sql)
      ? { results: stmt.all() as Record<string, unknown>[] }
      : { meta: { changes: Number(stmt.run().changes) } };
  };
  const fixed = () => new Date("2026-11-01T11:00:00.000Z");

  it("finds the organisation by name, its members, today's usage and its cap", async () => {
    const adapter = liveDb("IsItLegit Eval", exec(seeded()), fixed);
    expect(await adapter.orgId()).toBe("org-eval");
    expect(await adapter.memberships("u1")).toEqual(["org-eval"]);
    expect((await adapter.memberships("u2")).sort()).toEqual(["org-eval", "org-other"]);
    expect(await adapter.allowance()).toEqual({ used: 2, limit: 50 });
    // As admission counts: a counterparty case and a case whose admission failed before its file was stored use none.
    const db = seeded();
    db.exec(`INSERT INTO cases (id, org_id, channel, status, created_at, updated_at, origin, forwarded_by) VALUES
      ('c4', 'org-eval', 'email', 'done', '2026-11-01T10:03:00.000Z', '2026-11-01T10:03:01.000Z', 'counterparty', 'x@y.example'),
      ('c5', 'org-eval', 'upload', 'partial', '2026-11-01T10:04:00.000Z', '2026-11-01T10:04:01.000Z', NULL, NULL),
      ('c6', 'org-eval', 'upload', 'done', '2026-10-31T10:04:00.000Z', '2026-10-31T10:04:01.000Z', NULL, NULL)`);
    db.exec(
      `INSERT INTO case_events (case_id, step, status, started_at, error) VALUES ('c5', 'admit', 'failed', '2026-11-01T10:04:00.000Z', 'RawMissing')`,
    );
    expect(await liveDb("IsItLegit Eval", exec(db), fixed).allowance()).toEqual({ used: 2, limit: 50 });
    await expect(liveDb("Nobody", exec(seeded()), fixed).orgId()).rejects.toThrow(/found 0/);
  });

  it("reads a case's verdict, critical evidence, server time and the ledger's cost: settled at actual, else the estimate, its own case only", async () => {
    const adapter = liveDb("IsItLegit Eval", exec(seeded()), fixed);
    expect(await adapter.caseState("c1")).toEqual({
      status: "done",
      verdict: "suspicious",
      costUsd: 0.05,
      critical: true,
      providers: [],
      walkthrough: null, // No walkthrough record is unknown coverage, not a measured negative.
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:04.321Z",
    });
    expect(await adapter.caseState("c2")).toMatchObject({
      status: "running",
      verdict: null,
      costUsd: 0.07,
      critical: false,
    });
    // Another organisation's case is not readable through this one.
    expect(await adapter.caseState("c3")).toBeNull();
  });

  it("stores a run and its results and reads them back whole, the selection and the reasons included", async () => {
    const db = seeded();
    const adapter = liveDb("IsItLegit Eval", exec(db), fixed);
    const run: RunRow = {
      id: "run-1",
      commitSha: "abc1234",
      setVersion: "f".repeat(64),
      mode: "full",
      sets: ["synthetic-sa", "synthetic-challenge"],
      sampleLimit: 12,
      status: "running",
      selected: 2,
      capUsd: 0.8,
      startedAt: "2026-11-01T10:00:00.000Z",
      finishedAt: null,
      costUsd: 0,
    };
    await adapter.insertRun(run);
    const done: ResultRow = {
      runId: "run-1",
      sample: "synthetic-sa/a.eml",
      caseId: "c1",
      outcome: "done",
      label: "attack",
      category: "phishing",
      verdict: "suspicious",
      ms: 4321,
      costUsd: 0.05,
      criticalFound: true,
      httpStatus: null,
      detail: null,
    };
    const refused: ResultRow = {
      ...done,
      sample: "synthetic-sa/b.eml",
      caseId: null,
      outcome: "refused",
      verdict: null,
      ms: null,
      costUsd: 0,
      criticalFound: false,
      httpStatus: 415,
      detail: "the upload was refused (415)",
    };
    await adapter.putResult(done);
    await adapter.putResult(refused);
    await adapter.putResult({ ...refused, httpStatus: 400 });
    await adapter.finishRun("run-1", "incomplete", 0.05, "2026-11-01T10:05:00.000Z");
    const read = await adapter.readRun("run-1");
    expect(read?.run).toEqual({ ...run, status: "incomplete", costUsd: 0.05, finishedAt: "2026-11-01T10:05:00.000Z" });
    expect(read?.results).toEqual([
      { ...done, providers: undefined, walkthrough: null },
      { ...refused, httpStatus: 400, providers: undefined, walkthrough: null },
    ]);
    expect(await adapter.readRun("nope")).toBeNull();
  });

  it("verifies a stored run against the ledger, and names a changed cost, critical flag, time or run total", async () => {
    const db = seeded();
    const adapter = liveDb("IsItLegit Eval", exec(db), fixed);
    const base: RunRow = {
      id: "run-2",
      commitSha: "abc1234",
      setVersion: "f".repeat(64),
      mode: "full",
      sets: ["synthetic-sa"],
      sampleLimit: null,
      status: "running",
      selected: 1,
      capUsd: 1,
      startedAt: "2026-11-01T10:00:00.000Z",
      finishedAt: null,
      costUsd: 0,
    };
    await adapter.insertRun(base);
    const row: ResultRow = {
      runId: "run-2",
      sample: "synthetic-sa/a.eml",
      caseId: "c1",
      outcome: "done",
      label: "attack",
      category: "phishing",
      verdict: "suspicious",
      ms: 4321,
      costUsd: 0.05,
      criticalFound: true,
      httpStatus: null,
      detail: null,
    };
    await adapter.putResult(row);
    await adapter.finishRun("run-2", "complete", 0.05, "2026-11-01T10:05:00.000Z");
    expect(await verifyRun(adapter, "run-2")).toEqual({ ok: true, problems: [] });
    for (const [change, pattern] of [
      [{ costUsd: 999 }, /stored cost 999, the ledger says 0.05/],
      [{ criticalFound: false }, /stored critical false, the case says true/],
      [{ ms: 1 }, /stored 1 ms, the case says 4321/],
      [{ verdict: "safe" }, /stored done\/safe, the case says done\/suspicious/],
    ] as const) {
      await adapter.putResult({ ...row, ...change });
      expect((await verifyRun(adapter, "run-2")).problems.join(), JSON.stringify(change)).toMatch(pattern);
      await adapter.putResult(row);
    }
    await adapter.finishRun("run-2", "complete", 7, "2026-11-01T10:05:00.000Z");
    expect((await verifyRun(adapter, "run-2")).problems.join()).toMatch(/the run's cost 7 is not its results' 0.05/);
  });
});

// ---- the review's gaps ----------------------------------------------------------------------------------------------------------

describe("what the completion review found", () => {
  it("takes a repeated --set once (G1)", () => {
    const o = parseArgs(["--set", "synthetic-sa", "--set", "synthetic-sa", "--set", "nazario-2025", "--cap-usd", "1"]);
    expect(o).toMatchObject({ sets: ["synthetic-sa", "nazario-2025"] });
  });

  it("measures cost from the ledger for a case that did not end, and refuses a stated cap the shared caps would refuse (G2, G3)", async () => {
    const base = {
      selected: 5,
      perSampleUsd: 0.08,
      day: "2026-11-01",
      daySpentUsd: 14,
      totalSpentUsd: 10,
      allowance: { used: 0, limit: 50 },
    };
    expect(preflightProblems({ ...base, capUsd: 1 })).toEqual([]);
    expect(preflightProblems({ ...base, capUsd: 100 }).join()).toMatch(
      /the stated cap US\$100\.0000 passes the shared \w+ cap/,
    );
    const t = setup(1, {
      upload: () => ({ status: 201, caseId: "case-0" }),
      cases: { "case-0": { polls: 10 ** 6, costUsd: 0.03 } },
    });
    const r = await go(t, opts());
    expect(r.results[0]).toMatchObject({ outcome: "timeout", costUsd: 0.03 });
  });

  it("stops starting samples when another lane uses the shared headroom between admissions (G3)", async () => {
    const cases = Object.assign({}, ...Array.from({ length: 12 }, (_, i) => caseFor(i, { polls: 4, costUsd: 0.01 })));
    const t = setup(12, { cases });
    let reads = 0;
    t.db.spent = async () => ({ daySpentUsd: reads++ === 0 ? 1 : 14.99, totalSpentUsd: 10 });
    const r = await go(t, opts());
    expect(r.problems.join()).toMatch(/stopped early: shared/);
    expect(r.status).toBe("incomplete");
    expect(t.uploads.length).toBeLessThan(12);
  });

  it("keeps a stale repeat excluded when the run is resumed (G4)", async () => {
    const t = setup(3, {
      upload: (i) => (i === 1 ? { status: 200, caseId: "old", repeat: true } : { status: 201, caseId: `case-${i}` }),
      cases: {
        ...caseFor(0),
        ...caseFor(2),
        old: { status: "done", verdict: "safe", createdAt: "2026-11-01T08:00:00.000Z" },
      },
    });
    const first = await go(t, opts());
    expect(first.results[1]?.outcome).toBe("stale-repeat");
    const before = t.uploads.length;
    const second = await go(t, opts(), { resume: "run-00000001" });
    expect(second.problems).toEqual([]);
    expect(t.uploads.length).toBe(before);
    expect(second.results[1]).toMatchObject({ outcome: "stale-repeat", verdict: null, ms: null });
    expect(second.status).toBe("incomplete");
  });

  it("takes the time from the case's own server timestamps, whatever the polling delay (G5)", async () => {
    const t = setup(2, { cases: { ...caseFor(0, { polls: 6, ms: 4321 }), ...caseFor(1, { ms: 250 }) } });
    const r = await go(t, opts());
    expect(r.results.map((x) => x.ms)).toEqual([4321, 250]);
  });

  it("is never success when the run row, the unsent rows or the finish cannot be stored, or the journal cannot be written (G6)", async () => {
    const insert = setup(1, { cases: { ...caseFor(0) } });
    insert.db.insertRun = async () => {
      throw new Error("d1 down");
    };
    expect(await go(insert, opts())).toMatchObject({ status: "aborted", exit: 1, runId: null });
    expect(insert.uploads).toEqual([]);

    const finish = setup(1, { cases: { ...caseFor(0) } });
    finish.db.finishRun = async () => {
      throw new Error("d1 down");
    };
    const r = await go(finish, opts());
    expect(r).toMatchObject({ status: "aborted", exit: 1 });
    expect(r.problems.join()).toMatch(/could not be finished/);

    const journal = setup(1, { cases: { ...caseFor(0) } });
    const file = join(temp(), "not-a-directory");
    writeFileSync(file, "x");
    journal.env.journalDir = join(file, "inside");
    expect(await go(journal, opts())).toMatchObject({ status: "aborted", exit: 1 });
  });

  it("refuses a resume on another deployment, and restores the run's own selection (G7)", async () => {
    const t = setup(2, {
      upload: (i) => (i === 1 ? { status: 429 } : { status: 201, caseId: "case-0" }),
      cases: { ...caseFor(0) },
    });
    await go(t, opts());
    expect(t.runs.get("run-00000001")).toMatchObject({ sets: ["synthetic-sa"], sampleLimit: null });
    t.identity.commit = "feedface9999";
    const before = t.uploads.length;
    const r = await go(t, opts(), { resume: "run-00000001" });
    expect(r).toMatchObject({ status: "refused", exit: 3 });
    expect(r.problems.join()).toMatch(/a run is measured on one deployment/);
    expect(t.uploads.length).toBe(before);
  });

  it("sends nothing from a session that is not the eval organisation's alone (G8)", async () => {
    for (const change of [
      (t: T) => (t.identity.user = null),
      (t: T) => (t.identity.memberships = ["org-eval", "org-other"]),
      (t: T) => (t.identity.memberships = ["org-other"]),
      (t: T) => (t.identity.memberships = []),
    ]) {
      const t = setup(3, { cases: {} });
      change(t);
      const r = await go(t, opts());
      expect(r).toMatchObject({ status: "refused", exit: 3 });
      expect(t.uploads).toEqual([]);
      expect(t.runs.size).toBe(0);
    }
  });

  it("bounds a stalled request, and a stalled upload ends refused rather than hanging (G9)", async () => {
    await expect(boundedBy(10, () => new Promise<never>(() => {}))).rejects.toThrow(/no answer in 10 ms/);
    await expect(boundedBy(1_000, async () => 7)).resolves.toBe(7);
    const t = setup(2, { cases: { ...caseFor(1) } });
    t.env.timeout = (ms, work) => (ms === 120_000 ? Promise.reject(new Error("stalled")) : work());
    const r = await go(t, opts());
    expect(r.results.every((x) => x.outcome === "refused" && x.httpStatus === 503)).toBe(true);
    expect(r.status).toBe("incomplete");
  });

  it("keeps the upload status and a safe reason, and tells a local read failure from a refusal (G10)", async () => {
    const t = setup(4, {
      upload: (i) =>
        i === 0
          ? { status: 400 }
          : i === 1
            ? { status: 413 }
            : i === 2
              ? { status: 415 }
              : { status: 201, caseId: "case-3" },
      cases: { ...caseFor(3) },
    });
    const bytes = t.env.bytes;
    t.env.bytes = (file) => {
      if (file.endsWith("s3.eml")) throw new Error("EACCES");
      return bytes(file);
    };
    const r = await go(t, opts());
    expect(r.results.map((x) => [x.outcome, x.httpStatus, x.detail])).toEqual([
      ["refused", 400, "the upload was refused (400)"],
      ["refused", 413, "the upload was refused (413)"],
      ["refused", 415, "the upload was refused (415)"],
      ["lost", null, "its file could not be read here"],
    ]);
    expect(t.uploads).toHaveLength(3);
  });

  it("states the estimate, cap and allowance before the first upload, then progress, and a dry run needs no cap (G12, E1)", async () => {
    const cases = Object.assign({}, ...Array.from({ length: 8 }, (_, i) => caseFor(i, { polls: 3 })));
    const t = setup(8, { cases }, { cost: 0.05 });
    await go(t, opts(2));
    expect(t.logs[0]).toMatch(
      /8 of 8 samples to measure \(8 to upload\), estimate US\$0\.4000 at US\$0\.0500 each, cap US\$2\.0000, organisation allowance 0 of 50 used today/,
    );
    expect(t.logs[1]).toMatch(
      /run run-00000001 started on deadbeef1234; resume it with: pnpm eval:run --resume run-00000001/,
    );
    expect(t.logs.some((l) => /\d of 8 ended, \d in flight, \d+ s, spend US\$/.test(l))).toBe(true);

    const dry = setup(5, { cases: {} });
    const r = await go(dry, { capUsd: Number.NaN, dry: true });
    expect(r).toMatchObject({ status: "complete", exit: 0 });
    expect(dry.uploads).toEqual([]);
    expect(dry.runs.size).toBe(0);
    expect(dry.logs[0]).toMatch(/5 of 5 samples to measure.*estimate US\$0\.4000.*cap none stated/);
    expect(parseArgs(["--dry"])).toMatchObject({ dry: true });
  });
});

describe("what the second completion review found", () => {
  it("admits only what the headroom holds when four workers start at once (G1)", async () => {
    // Three cases of US$0.18 leave US$0.10 of a US$0.64 cap: one more estimated case (US$0.08) fits, not four.
    let phase: "first" | "resume" = "first";
    const cases = Object.assign({}, ...Array.from({ length: 8 }, (_, i) => caseFor(i, { costUsd: 0.18 })));
    const t = setup(8, {
      upload: (i) => (phase === "first" && i >= 3 ? { status: 429 } : { status: 201, caseId: `case-${i}` }),
      cases,
    });
    const first = await go(t, opts(0.64));
    expect(first.results.filter((x) => x.outcome === "done")).toHaveLength(3);
    phase = "resume";
    const before = t.uploads.length;
    const second = await go(t, opts(0.64), { resume: "run-00000001" });
    expect(t.uploads.length - before).toBe(1);
    expect(second.problems.join()).toMatch(/stopped early: budget/);
    expect(second.status).toBe("incomplete");
  });

  it("refuses admissions when the shared headroom cannot be read, and reads it once for concurrent admissions (G2)", async () => {
    const cases = Object.assign({}, ...Array.from({ length: 12 }, (_, i) => caseFor(i, { polls: 4, costUsd: 0.01 })));
    const outage = setup(12, { cases });
    let reads = 0;
    outage.db.spent = async () => {
      if (reads++ > 0) throw new Error("d1 down");
      return { daySpentUsd: 1, totalSpentUsd: 10 };
    };
    const r = await go(outage, opts());
    expect(r.problems.join()).toMatch(/stopped early: shared/);
    expect(outage.uploads.length).toBeLessThan(12);

    // Past the recheck interval, four admissions at once share one read in flight.
    const once = setup(8, {
      cases: Object.assign({}, ...Array.from({ length: 8 }, (_, i) => caseFor(i, { polls: 8, costUsd: 0.01 }))),
    });
    const reading: number[] = [];
    let open = 0;
    let peak = 0;
    once.db.spent = async () => {
      open++;
      peak = Math.max(peak, open);
      reading.push(open);
      await Promise.resolve();
      await Promise.resolve();
      open--;
      return { daySpentUsd: 1, totalSpentUsd: 10 };
    };
    await go(once, opts());
    expect(peak).toBe(1);
  });

  it("keeps the cap a run began with, and refuses a different one on resume (G3)", async () => {
    const t = setup(2, {
      upload: (i) => (i === 1 ? { status: 429 } : { status: 201, caseId: "case-0" }),
      cases: { ...caseFor(0) },
    });
    await go(t, opts(2));
    expect((t.runs.get("run-00000001") as RunRow).capUsd).toBe(2);
    const bigger = await go(t, opts(50), { resume: "run-00000001" });
    expect(bigger).toMatchObject({ status: "refused", exit: 3 });
    expect(bigger.problems.join()).toMatch(/was started with cap US\$2\.0000; a resume keeps it/);
    const same = await go(t, { capUsd: Number.NaN, dry: false }, { resume: "run-00000001" });
    expect(same.status).not.toBe("refused");
    expect(t.runs.get("run-00000001")).toMatchObject({ capUsd: 2 });
    expect(parseArgs(["--resume", "abcdefgh-1"])).toMatchObject({ resume: "abcdefgh-1" });
  });

  it("finds a stale repeat again after an interruption, never measuring it (G4)", async () => {
    const t = setup(1, {
      upload: () => ({ status: 200, caseId: "old", repeat: true }),
      cases: { old: { status: "done", verdict: "safe", createdAt: "2026-11-01T08:00:00.000Z" } },
    });
    // The store of the stale classification fails: the run aborts, and the case is not journaled.
    t.failWrites.count = 100;
    const first = await go(t, opts());
    expect(first.status).toBe("aborted");
    t.failWrites.count = 0;
    const second = await go(t, opts(), { resume: "run-00000001" });
    expect(second.results[0]).toMatchObject({ outcome: "stale-repeat", verdict: null, ms: null });
    expect(second.status).toBe("incomplete");
    expect(t.uploads).toHaveLength(2);
    expect((await verifyRun(t.db, "run-00000001")).problems.join()).not.toMatch(/done/);
  });

  it("logs progress during waits, with no case finished (G5)", async () => {
    const t = setup(4, { cases: Object.assign({}, ...Array.from({ length: 4 }, (_, i) => caseFor(i, { polls: 9 }))) });
    await go(t, opts());
    const waiting = t.logs.filter((l) => /^eval:run: 0 of 4 ended, 4 in flight, \d+ s, spend/.test(l));
    expect(waiting.length).toBeGreaterThanOrEqual(2);
  });
});

describe("what round 1 found", () => {
  it("retries, never excludes, a repeated case whose age could not be read (R1)", async () => {
    const t = setup(1, { upload: () => ({ status: 200, caseId: "case-0", repeat: true }), cases: { ...caseFor(0) } });
    const read = t.db.caseState;
    let failing = true;
    t.db.caseState = async (id) => {
      if (failing) throw new Error("d1 blip");
      return read(id);
    };
    const first = await go(t, opts());
    expect(first.results[0]).toMatchObject({ outcome: "lost", caseId: null });
    failing = false;
    // The case belongs to this run (created now): after the blip the resume measures it.
    const second = await go(t, opts(), { resume: "run-00000001" });
    expect(second.results[0]).toMatchObject({ outcome: "done", caseId: "case-0" });
    expect(second.status).toBe("complete");
  });

  it("reconciles cases already opened whatever the budget says, and keeps their recorded cost (R2)", async () => {
    // US$0.20 cap: a done case of US$0.15, then a timed-out case of US$0.03 that later finishes.
    let phase: "first" | "resume" = "first";
    const t = setup(2, {
      upload: (i) => ({ status: 201, caseId: `case-${i}` }),
      cases: { ...caseFor(0, { costUsd: 0.15 }), ...caseFor(1, { costUsd: 0.03, polls: 10 ** 6 }) },
    });
    const first = await go(t, opts(0.2));
    expect(first.results.map((x) => [x.outcome, x.costUsd])).toEqual([
      ["done", 0.15],
      ["timeout", 0.03],
    ]);
    phase = "resume";
    const read = t.db.caseState;
    t.db.caseState = async (id) => {
      const s = await read(id);
      return s && id === "case-1" && phase === "resume" ? { ...s, status: "done" } : s;
    };
    const second = await go(t, opts(0.2), { resume: "run-00000001" });
    expect(t.uploads).toHaveLength(2);
    expect(second.results.map((x) => [x.outcome, x.costUsd])).toEqual([
      ["done", 0.15],
      ["done", 0.03],
    ]);
    expect(second.costUsd).toBeCloseTo(0.18);

    // A budget stop also leaves an earlier row (its case and cost) as it was.
    const t2 = setup(2, {
      upload: (i) => ({ status: 201, caseId: `case-${i}` }),
      cases: { ...caseFor(0, { costUsd: 0.15 }), ...caseFor(1, { costUsd: 0.03, polls: 10 ** 6 }) },
    });
    await go(t2, opts(0.2));
    const stopped = await go(t2, opts(0.2), { resume: "run-00000001" });
    expect(stopped.results[1]).toMatchObject({ caseId: "case-1", costUsd: 0.03 });
  });

  it("logs progress while an upload or a read is still pending, driven by a timer, not a result (R3)", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    const upload = t.api.upload;
    t.api.upload = async (sample, bytes, opts) => {
      // A 30 second upload: the timer fires while nothing has finished.
      for (let i = 0; i < 6; i++) {
        await t.env.sleep(5_000);
        t.tick();
      }
      return upload(sample, bytes, opts);
    };
    await go(t, opts());
    const during = t.logs.filter((l) => /^eval:run: 0 of 2 ended, 2 in flight, \d+ s, spend/.test(l));
    expect(during.length).toBeGreaterThanOrEqual(4);
  });

  it("polls reopened cases after a stop, and leaves an unreached sample the row an earlier pass stored (R2)", async () => {
    let phase: "first" | "resume" = "first";
    const cases = Object.assign({}, ...[5, 6, 7].map((i) => caseFor(i, { costUsd: 0.02, polls: 10 ** 6 })));
    const t = setup(8, {
      upload: (i) =>
        i >= 5 ? { status: 201, caseId: `case-${i}` } : phase === "first" ? { status: 400 } : { status: 429 },
      cases,
    });
    const first = await go(t, opts(5));
    expect(first.results.slice(0, 5).every((x) => x.outcome === "refused" && x.httpStatus === 400)).toBe(true);
    expect(first.results.slice(5).every((x) => x.outcome === "timeout" && x.costUsd === 0.02)).toBe(true);
    phase = "resume";
    const read = t.db.caseState;
    t.db.caseState = async (id) => {
      const s = await read(id);
      return s ? { ...s, status: "done" } : s;
    };
    const second = await go(t, opts(5), { resume: "run-00000001" });
    // Four uploads were answered 429 and set the stop; the three reopened cases are still reconciled.
    expect(second.results.slice(0, 4).map((x) => x.outcome)).toEqual(["capped", "capped", "capped", "capped"]);
    expect(second.results.slice(5).map((x) => x.outcome)).toEqual(["done", "done", "done"]);
    // The fifth sample was never reached this time: it keeps the refusal an earlier pass stored.
    expect(second.results[4]).toMatchObject({
      outcome: "refused",
      httpStatus: 400,
      detail: "the upload was refused (400)",
    });
  });

  it("reconciles reopened cases with no headroom left, and a read outage keeps the recorded cost (round 2)", async () => {
    let phase: "first" | "resume" = "first";
    const t = setup(1, {
      upload: () => ({ status: 201, caseId: "case-0" }),
      cases: { ...caseFor(0, { costUsd: 0.03, polls: 10 ** 6 }) },
    });
    const first = await go(t, opts());
    expect(first.results[0]).toMatchObject({ outcome: "timeout", costUsd: 0.03 });
    phase = "resume";
    // The shared day is used up: a new upload would be refused, but the opened case is still read.
    t.db.spent = async () => ({ daySpentUsd: 15, totalSpentUsd: 20 });
    const read = t.db.caseState;
    t.db.caseState = async (id) => {
      const s = await read(id);
      return s && phase === "resume" ? { ...s, status: "done" } : s;
    };
    const second = await go(t, opts(), { resume: "run-00000001" });
    expect(second.problems).toEqual([]);
    expect(second.status).toBe("complete");
    expect(second.results[0]).toMatchObject({ outcome: "done", costUsd: 0.03 });
    expect(t.uploads).toHaveLength(1);

    // A read outage on resume leaves the stored cost, never zero.
    const t2 = setup(1, {
      upload: () => ({ status: 201, caseId: "case-0" }),
      cases: { ...caseFor(0, { costUsd: 0.03, polls: 10 ** 6 }) },
    });
    await go(t2, opts());
    t2.db.caseState = async () => {
      throw new Error("d1 outage");
    };
    const outage = await go(t2, opts(), { resume: "run-00000001" });
    expect(outage.results[0]).toMatchObject({ outcome: "lost", costUsd: 0.03, caseId: "case-0" });
    expect(outage.costUsd).toBeCloseTo(0.03);
  });

  it("reconciles opened cases in a mixed resume while new uploads stay refused (round 3)", async () => {
    // Sample 0 timed out with a case; sample 1 was never sent. Then the shared day is used up.
    let phase: "first" | "resume" = "first";
    const t = setup(2, {
      upload: (i) => (phase === "first" && i === 1 ? { status: 429 } : { status: 201, caseId: `case-${i}` }),
      cases: { ...caseFor(0, { costUsd: 0.03, polls: 10 ** 6 }), ...caseFor(1) },
    });
    const first = await go(t, opts());
    expect(first.results.map((x) => x.outcome)).toEqual(["timeout", "capped"]);
    phase = "resume";
    t.db.spent = async () => ({ daySpentUsd: 15, totalSpentUsd: 20 });
    const read = t.db.caseState;
    t.db.caseState = async (id) => {
      const s = await read(id);
      return s ? { ...s, status: "done" } : s;
    };
    const before = t.uploads.length;
    const second = await go(t, opts(), { resume: "run-00000001" });
    expect(second.results[0]).toMatchObject({ outcome: "done", caseId: "case-0", costUsd: 0.03 });
    expect(second.results[1]?.outcome).toBe("capped");
    expect(t.uploads.length).toBe(before);
    expect(second.status).toBe("incomplete");
    expect(second.problems.join()).toMatch(/new uploads refused: .*shared day cap/);
    // Without a case to reconcile the same refusal stands.
    const fresh = setup(2, { cases: {} });
    fresh.db.spent = async () => ({ daySpentUsd: 15, totalSpentUsd: 20 });
    expect(await go(fresh, opts())).toMatchObject({ status: "refused", exit: 3 });
  });

  it("restores a resumed run's own selection whatever --set and --limit say (round 5)", async () => {
    const t = setup(2, {
      upload: (i) => (i === 1 ? { status: 429 } : { status: 201, caseId: "case-0" }),
      cases: { ...caseFor(0) },
    });
    await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      sets: ["synthetic-sa", "synthetic-challenge"],
      sampleLimit: 7,
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
      resume: null,
    });
    const conflicting = parseArgs(["--resume", "run-00000001", "--set", "nazario-2025", "--limit", "99"]);
    if ("error" in conflicting) throw new Error(conflicting.error);
    expect(await resolveSelection(t.db, conflicting)).toEqual({
      sets: ["synthetic-sa", "synthetic-challenge"],
      limit: 7,
    });
    expect(await resolveSelection(t.db, { ...conflicting, resume: "missing-run-1" })).toEqual({
      error: "no run missing-run-1",
    });
    const fresh = parseArgs(["--set", "nazario-2025", "--limit", "5", "--cap-usd", "1"]);
    if ("error" in fresh) throw new Error(fresh.error);
    expect(await resolveSelection(t.db, fresh)).toEqual({ sets: ["nazario-2025"], limit: 5 });
  });
});

describe("what the completion review found (E3)", () => {
  it("names a safe next step for every refusal class", () => {
    expect(recoveryHint("no samples selected")).toMatch(/--set/);
    expect(recoveryHint("--cap-usd must be a positive number")).toMatch(/--cap-usd/);
    expect(recoveryHint("the estimate US$1.0000 passes the stated cap US$0.5000")).toMatch(/headroom/);
    expect(recoveryHint("the estimate US$1.0000 passes the shared day cap")).toMatch(/fresh SAST day/);
    expect(recoveryHint("3 samples pass the organisation's 0 cases left today")).toMatch(/coordinator/);
    expect(recoveryHint("the session is not signed in")).toMatch(/EVAL_SESSION_COOKIE/);
    expect(recoveryHint("run abc is already complete")).toMatch(/new run/);
    expect(recoveryHint("the deployment is X, not Y of run abc")).toMatch(/new run/);
    expect(recoveryHint("run abc was started with cap US$1")).toMatch(/keeps the run's cap/);
    expect(recoveryHint("something entirely new")).toBeNull();
  });

  it("prints the stored status with measured and unmeasured counts on --verify", () => {
    const stored = {
      run: {
        id: "run-00000001",
        status: "incomplete",
        selected: 3,
      } as RunRow,
      results: [
        { sample: "a", outcome: "done", verdict: "safe" },
        { sample: "b", outcome: "partial", verdict: "suspicious" },
        { sample: "c", outcome: "stale-repeat", verdict: null },
      ] as ResultRow[],
    };
    expect(verifyLine(stored)).toBe(
      "run run-00000001 is incomplete: 3 of 3 results, 2 measured (1 done, 1 partial, 1 stale-repeat)",
    );
  });
});

describe("the ablation arm mode", () => {
  it("refuses unbound and unknown ablation modes before a run is created", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    const out = await runEval({
      samples: t.samples.slice(0, 2),
      setVersion: "v".repeat(64),
      sets: ["synthetic-sa"],
      sampleLimit: null,
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
      mode: "ablate:no-sam",
    });
    expect(out.exit).toBe(3);
    expect(out.problems.join()).toContain("immutable experiment metadata");
    expect(t.runs.size).toBe(0);
    expect(t.uploads).toHaveLength(0);
    const refused = await runEval({
      samples: t.samples.slice(0, 2),
      setVersion: "v".repeat(64),
      sets: ["synthetic-sa"],
      sampleLimit: null,
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
      mode: "ablate:no-such-model",
    });
    expect(refused.exit).toBe(3);
    expect(refused.problems).toMatchObject([expect.stringMatching(/unknown run mode/)]);
  });
});

describe("the replay identity", () => {
  it("measures a replayed sample anew under replay identity while an ordinary repeat stays stale-repeat", async () => {
    const t = setup(2, {
      cases: {
        ...caseFor(0),
        ...caseFor(1),
        old: { status: "done", verdict: "safe", createdAt: "2026-11-01T08:00:00.000Z" },
      },
    });
    const replayIds: (string | null)[] = [];
    const api: Api = {
      ...t.api,
      upload: async (sample, _bytes, opts) => {
        replayIds.push(opts.replayRunId);
        return opts.replayRunId
          ? { status: 201, caseId: `case-${t.samples.findIndex((s) => s.id === sample.id)}` }
          : { status: 200, caseId: "old", repeat: true };
      },
    };
    const base = {
      samples: t.samples.slice(0, 2),
      setVersion: "v".repeat(64),
      sets: ["synthetic-sa"],
      sampleLimit: null,
      options: opts(),
      db: t.db,
      env: t.env,
    };
    const ordinary = await runEval({ ...base, api });
    expect(ordinary.results.every((r) => r.outcome === "stale-repeat")).toBe(true);
    // A replay named through --mode is refused: only --replay, after restoring the source, starts one.
    const bypass = await runEval({ ...base, api, mode: "replay:run-00000009" });
    expect(bypass.exit).toBe(3);
    expect(bypass.problems.join(" ")).toMatch(/--replay <run id>, not --mode/);
    // Distinct run ids per run, as the live entry's randomUUID gives: the harness id is constant.
    let seq = 100;
    const env = { ...t.env, id: () => `run-${String(++seq).padStart(8, "0")}` };
    const replayed = await runEval({ ...base, api, env, replayOf: "run-00000009" });
    expect(replayed.exit).toBe(0);
    expect(replayed.results.every((r) => r.outcome === "done")).toBe(true);
    expect(t.runs.get(replayed.runId ?? "")?.mode).toBe("replay:run-00000009");
    // The identity on the wire is the replay run's own id, never the source run's (section 12).
    const sent = replayIds.filter((x) => x !== null);
    expect(sent.length).toBe(2);
    expect(new Set(sent)).toEqual(new Set([replayed.runId]));
    expect(sent).not.toContain("run-00000009");
    // A second replay of the same source opens its own cases under a different identity.
    const again = await runEval({ ...base, api, env, replayOf: "run-00000009" });
    expect(again.exit).toBe(0);
    expect(again.runId).not.toBe(replayed.runId);
    const sentAgain = replayIds.filter((x) => x !== null).slice(2);
    expect(new Set(sentAgain)).toEqual(new Set([again.runId]));
  });
});

describe("unbound historical ablation transport", () => {
  it("never sends an unsupported unbound screening arm as an ordinary upload", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    const out = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      sets: ["synthetic-sa"],
      sampleLimit: null,
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
      mode: "ablate:no-screening",
    });
    expect(out.exit).toBe(3);
    expect(t.uploads).toHaveLength(0);
    expect(t.runs.size).toBe(0);
  });
  it("refuses a legacy arm resume that has no immutable experiment context", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    t.runs.set("run-00000001", {
      id: "run-00000001",
      commitSha: t.identity.commit,
      setVersion: "v".repeat(64),
      mode: "ablate:no-sam",
      sets: ["synthetic-sa"],
      sampleLimit: null,
      status: "incomplete",
      selected: 2,
      capUsd: 1,
      startedAt: "2026-11-01T10:00:00Z",
      finishedAt: null,
      costUsd: 0,
    });
    const out = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      sets: ["synthetic-sa"],
      sampleLimit: null,
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
      resume: "run-00000001",
    });
    expect(out.exit).toBe(3);
    expect(out.problems.join()).toContain("immutable experiment metadata");
    expect(t.uploads).toHaveLength(0);
    expect(t.runs.get("run-00000001")?.mode).toBe("ablate:no-sam");
  });
});
