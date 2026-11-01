// The evaluation runner (D08 T02 §1): the migration, the pure rules, and the run on distinct injected answers, so a
// stored row that differs from its injected response, or a partial run reported complete, fails here.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Api,
  CASE_TIMEOUT_MS,
  type CaseState,
  type Db,
  type Env,
  type ResultRow,
  type RunRow,
  runEval,
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
  runStatus,
  selectSamples,
} from "../../eval/run-core.ts";

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
      status: "running",
      selected: 2,
      cap_usd: 1,
      started_at: "2026-11-01T00:00:00Z",
      finished_at: null,
      ...over,
    };
    db.prepare(
      "INSERT INTO eval_runs (id, commit_sha, set_version, mode, status, selected, cap_usd, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(r.id, r.commit_sha, r.set_version, r.mode, r.status, r.selected, r.cap_usd, r.started_at, r.finished_at);
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
  const api: Api = {
    commit: async () => "deadbeef1234",
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
  };
  return {
    samples,
    api,
    db,
    env,
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
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
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
      const r = await runEval({
        samples: t.samples,
        setVersion: "v".repeat(64),
        options: opts(capUsd),
        api: t.api,
        db: t.db,
        env: t.env,
      });
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
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
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
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
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
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
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
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
    expect(r.results[0]).toMatchObject({ outcome: "done", caseId: "case-0" });
    expect(r.status).toBe("complete");
  });

  it("retries a 503 and gives up after the bound, leaving the sample refused", async () => {
    const t = setup(2, {
      upload: (i, _s, call) => (i === 0 ? { status: 503 } : call ? { status: 201, caseId: "case-1" } : { status: 201 }),
      cases: { ...caseFor(1) },
    });
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
    expect(t.uploads.filter((u) => u === t.samples[0]?.id)).toHaveLength(4);
    expect(r.results[0]?.outcome).toBe("refused");
  });

  it("aborts on a refused session, keeps every case id, and resumes by polling without uploading again", async () => {
    const t = setup(4, {
      upload: (i) => (i === 3 ? { status: 401 } : { status: 201, caseId: `case-${i}` }),
      cases: { ...caseFor(0), ...caseFor(1), ...caseFor(2, { polls: 10 ** 6 }), ...caseFor(3) },
    });
    // Concurrency 4 sends all four at once; the session refusal aborts the run.
    const first = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
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
    const second = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t2api,
      db: t.db,
      env: t.env,
      resume: "run-00000001",
    });
    expect(second.status).toBe("complete");
    expect(t.uploads.slice(before)).toEqual([t.samples[3]?.id]);
    expect(second.results.map((x) => x.caseId)).toEqual(["case-0", "case-1", "case-2", "case-3"]);
  });

  it("aborts when a result cannot be stored after its retries, and never reports complete", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    t.failWrites.count = 100;
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
    expect(r.status).toBe("aborted");
    expect(r.problems.join()).toMatch(/could not be stored/);
    expect(WriteFailed.name).toBe("WriteFailed");
  });

  it("stops starting samples once the measured spend reaches the stated cap, ending incomplete", async () => {
    const cases = Object.assign({}, ...Array.from({ length: 10 }, (_, i) => caseFor(i, { costUsd: 0.4 })));
    const t = setup(10, { cases }, { cost: 0.05 });
    const r = await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(0.6),
      api: t.api,
      db: t.db,
      env: t.env,
    });
    expect(r.status).toBe("incomplete");
    expect(r.problems.join()).toMatch(/stopped early: budget/);
    // The cap is checked before each sample starts: the four in flight finish, and no fifth is sent.
    expect(t.uploads).toHaveLength(4);
    expect(r.results.filter((x) => x.outcome === "lost")).toHaveLength(6);
    expect(r.results.some((x) => x.outcome === "lost")).toBe(true);
  });

  it("verifies a stored run against its cases, and names a result that differs from its case", async () => {
    const t = setup(2, { cases: { ...caseFor(0), ...caseFor(1) } });
    await runEval({
      samples: t.samples,
      setVersion: "v".repeat(64),
      options: opts(),
      api: t.api,
      db: t.db,
      env: t.env,
    });
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
