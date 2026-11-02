import { describe, expect, it } from "vitest";
import { runBaseline } from "../../eval/baseline.ts";
import type { Api, CaseState, Db, Env, ResultRow, RunRow } from "../../eval/run.ts";
import type { RunSample } from "../../eval/run-core.ts";

type Script = {
  commits: string[];
  cases: Record<string, { verdict: "safe" | "suspicious" | "malicious" | null }>;
};

function setup(script: Script) {
  const samples: RunSample[] = ["synthetic-sa", "nazario-2025", "synthetic-challenge"].flatMap((set, si) =>
    [0, 1].map((i) => ({
      id: `${set}/s${i}.eml`,
      set,
      path: `s${i}.eml`,
      file: `/nowhere/${set}-s${i}.eml`,
      label: (i % 2 ? "genuine" : "attack") as "genuine" | "attack",
      category: "test-category",
      sha256: `${si}${i}`.padEnd(64, "0"),
    })),
  );
  const runs = new Map<string, RunRow>();
  const stored = new Map<string, ResultRow>();
  const uploads: string[] = [];
  let clock = Date.parse("2026-11-02T10:00:00Z");
  const commits = [...script.commits];
  const api: Api = {
    commit: async () => (commits.length > 1 ? (commits.shift() as string) : (commits[0] as string)),
    whoami: async () => "user-1",
    upload: async (sample, _bytes, _mode) => {
      uploads.push(sample.id);
      return { status: 201, caseId: `case-${sample.id}` };
    },
  };
  const db: Db = {
    orgId: async () => "org-eval",
    memberships: async () => ["org-eval"],
    allowance: async () => ({ used: 0, limit: 500 }),
    spent: async () => ({ daySpentUsd: 0, totalSpentUsd: 0 }),
    lastCostPerCase: async () => 0.01,
    caseState: async (id): Promise<CaseState | null> => {
      const c = script.cases[id];
      if (!c) return null;
      return {
        status: c.verdict === null ? "partial" : "done",
        verdict: c.verdict,
        costUsd: 0.01,
        critical: false,
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock + 1500).toISOString(),
      };
    },
    insertRun: async (r) => void runs.set(r.id, r),
    putResult: async (r) => void stored.set(`${r.runId}|${r.sample}`, r),
    finishRun: async (id, status, costUsd, finishedAt) => {
      const r = runs.get(id) as RunRow;
      runs.set(id, { ...r, status, costUsd, finishedAt });
    },
    readRun: async (id) => {
      const r = runs.get(id);
      return r ? { run: r, results: [...stored.values()].filter((x) => x.runId === id) } : null;
    },
  };
  const dir = `/tmp/eval-baseline-${Date.now()}`;
  const env: Env = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    id: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
    journalDir: dir,
    bytes: () => new TextEncoder().encode("x"),
    log: () => {},
    timeout: (_ms, work) => work(),
    ticker: (_ms, _fn) => () => {},
  };
  const samplesOf = (set: string) => samples.filter((s) => s.set === set);
  const selectFor =
    (emptySets: string[] = []) =>
    (set: string) => ({
      samples: emptySets.includes(set) ? [] : samplesOf(set),
      setVersion: `v-${set}`,
    });
  return { samples, api, db, env, runs, stored, dir, uploads, selectFor };
}

describe("the baseline orchestration", () => {
  const allSafe = (ids: string[]) => Object.fromEntries(ids.map((id) => [`case-${id}`, { verdict: "safe" as const }]));
  it("runs per-set batches within their caps and writes a manifest", async () => {
    const t = setup({ commits: ["abc123"], cases: allSafe(["synthetic-sa/s0.eml", "synthetic-sa/s1.eml"]) });
    const out = await runBaseline({
      sets: ["synthetic-sa"],
      caps: { "synthetic-sa": 13 },
      api: t.api,
      db: t.db,
      env: t.env,
      manifestDir: t.dir,
      select: t.selectFor(),
    });
    expect(out.status).toBe("complete");
    expect(out.batches).toHaveLength(1);
    expect(out.manifest).not.toBeNull();
  });
  it("refuses a changed deployment mid-baseline, naming both", async () => {
    const t = setup({ commits: ["abc123", "abc123", "def456", "def456"], cases: allSafe(["synthetic-sa/s0.eml"]) });
    const out = await runBaseline({
      sets: ["synthetic-sa", "nazario-2025"],
      caps: { "synthetic-sa": 13, "nazario-2025": 5 },
      api: t.api,
      db: t.db,
      env: t.env,
      manifestDir: t.dir,
      select: t.selectFor(),
    });
    expect(out.status).toBe("incomplete");
    expect(out.problems.join(" ")).toMatch(/def456/);
    expect(out.problems.join(" ")).toMatch(/abc123/);
    expect(out.batches).toHaveLength(1);
  });
  it("resumes after the first batch without resubmitting it", async () => {
    const t = setup({
      commits: ["abc123"],
      cases: allSafe(["synthetic-sa/s0.eml", "synthetic-sa/s1.eml", "nazario-2025/s0.eml", "nazario-2025/s1.eml"]),
    });
    const clients = {
      sets: ["synthetic-sa", "nazario-2025"],
      caps: { "synthetic-sa": 13, "nazario-2025": 5 },
      api: t.api,
      db: t.db,
      env: t.env,
      manifestDir: t.dir,
    };
    const first = await runBaseline({ ...clients, select: t.selectFor(["nazario-2025"]) });
    expect(first.status).toBe("incomplete");
    const uploadedFirst = t.uploads.length;
    expect(uploadedFirst).toBe(2);
    const resumed = await runBaseline({ ...clients, select: t.selectFor(), resume: first.id });
    expect(resumed.status).toBe("complete");
    expect(t.uploads.filter((u) => u.startsWith("synthetic-sa/"))).toHaveLength(2);
    expect(t.uploads.filter((u) => u.startsWith("nazario-2025/"))).toHaveLength(2);
    expect(resumed.batches.map((b) => b.set)).toEqual(["synthetic-sa", "nazario-2025"]);
  });
});
