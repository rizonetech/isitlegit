import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BaselineDb, runBaseline } from "../../eval/baseline.ts";
import type { Api, CaseState, Env, ResultRow, RunRow } from "../../eval/run.ts";
import type { BaselineManifest, RunSample } from "../../eval/run-core.ts";

type CaseSpec = {
  verdict: "safe" | "suspicious" | "malicious" | null;
  createdAt?: string;
  updatedAt?: string;
};

type Script = {
  commits: string[];
  cases: Record<string, CaseSpec>;
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
  const db: BaselineDb = {
    orgId: async () => "org-eval",
    memberships: async () => ["org-eval"],
    allowance: async () => ({ used: 0, limit: 500 }),
    spent: async () => ({ daySpentUsd: 0, totalSpentUsd: 0 }),
    lastCostPerCase: async () => 0.01,
    findSampleRuns: async (sample) =>
      [...stored.values()]
        .filter((r) => r.sample === sample)
        .map((r) => {
          const run = runs.get(r.runId) as RunRow;
          return {
            runId: run.id,
            deployment: run.commitSha,
            setVersion: run.setVersion,
            mode: run.mode,
            status: run.status,
            finishedAt: run.finishedAt,
            outcome: r.outcome,
            verdict: r.verdict,
            caseId: r.caseId,
            ms: r.ms,
            costUsd: r.costUsd,
          };
        }),
    caseState: async (id): Promise<CaseState | null> => {
      const c = script.cases[id];
      if (!c) return null;
      const createdAt = c.createdAt ?? new Date(clock).toISOString();
      return {
        status: c.verdict === null ? "partial" : "done",
        verdict: c.verdict,
        costUsd: 0.01,
        critical: false,
        createdAt,
        updatedAt: c.updatedAt ?? new Date(Date.parse(createdAt) + 1500).toISOString(),
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
  return {
    samples,
    api,
    db,
    env,
    runs,
    stored,
    dir,
    uploads,
    selectFor,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const oldCases = { createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:01.500Z" };
const allSafe = (ids: string[]) =>
  Object.fromEntries(ids.map((id) => [`case-${id}`, { verdict: "safe" as const, ...oldCases }]));

describe("the baseline orchestration", () => {
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
  it("pools a stale repeat from the earlier verified run, each sample once", async () => {
    const t = setup({ commits: ["abc123"], cases: allSafe(["synthetic-sa/s0.eml", "synthetic-sa/s1.eml"]) });
    const clients = {
      sets: ["synthetic-sa"],
      caps: { "synthetic-sa": 13 },
      api: t.api,
      db: t.db,
      env: t.env,
      manifestDir: t.dir,
      select: t.selectFor(),
    };
    const first = await runBaseline(clients);
    expect(first.status).toBe("complete");
    const sourceCase = (sample: string) =>
      [...t.stored.values()].find((r) => r.runId === "run-1" && r.sample === sample)?.caseId as string;
    t.advance(86_400_000);
    t.api.upload = async (sample) => ({ status: 200, caseId: sourceCase(sample.id), repeat: true });
    const second = await runBaseline(clients);
    expect(second.status).toBe("incomplete");
    expect(second.batches).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(second.manifest as string, "utf8")) as BaselineManifest;
    expect(manifest.entries).toHaveLength(2);
    for (const e of manifest.entries) {
      expect(e.pooledFrom).toBe("run-1");
      expect(e.verdict).toBe("safe");
      expect(e.outcome).toBe("done");
    }
    expect(manifest.unmeasured).toEqual([]);
  });
  it("leaves a stale repeat with no source unmeasured, never counted", async () => {
    const t = setup({
      commits: ["abc123"],
      cases: {
        "case-orphan-s0": { verdict: "safe", ...oldCases },
        "case-orphan-s1": { verdict: "safe", ...oldCases },
      },
    });
    t.api.upload = async (sample) => ({
      status: 200,
      caseId: `case-orphan-${sample.path.slice(1, 2)}`,
      repeat: true,
    });
    t.advance(86_400_000);
    const out = await runBaseline({
      sets: ["synthetic-sa"],
      caps: { "synthetic-sa": 13 },
      api: t.api,
      db: t.db,
      env: t.env,
      manifestDir: t.dir,
      select: t.selectFor(),
    });
    expect(out.status).toBe("incomplete");
    const manifest = JSON.parse(readFileSync(out.manifest as string, "utf8")) as BaselineManifest;
    expect(manifest.unmeasured).toHaveLength(2);
    for (const e of manifest.entries) {
      expect(e.pooledFrom).toBeUndefined();
      expect(e.verdict).toBeNull();
    }
  });
});

describe("the baseline comparability guard", () => {
  it("refuses a resume whose set changed, naming the set and both versions", async () => {
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
    const sa = t.samples.filter((s) => s.set === "synthetic-sa");
    const first = await runBaseline({
      ...clients,
      select: (set) =>
        set === "synthetic-sa" ? { samples: sa, setVersion: "v1-sa" } : { samples: [], setVersion: "v1-naz" },
    });
    expect(first.status).toBe("incomplete");
    const uploaded = t.uploads.length;
    expect(uploaded).toBeGreaterThan(0);
    const resumed = await runBaseline({
      ...clients,
      select: (set) =>
        set === "synthetic-sa" ? { samples: sa, setVersion: "v2-sa" } : { samples: [], setVersion: "v1-naz" },
      resume: first.id,
    });
    expect(resumed.status).toBe("refused");
    expect(resumed.problems.join(" ")).toMatch(/synthetic-sa/);
    expect(resumed.problems.join(" ")).toMatch(/v1-sa/);
    expect(resumed.problems.join(" ")).toMatch(/v2-sa/);
    expect(t.uploads).toHaveLength(uploaded);
  });
});
