import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { recordAblationArm, resumeAblationArm, startAblationRun } from "../../eval/ablate.ts";
import { parseAblateArgs } from "../../eval/ablate-run.ts";
import { liveApi, runEval } from "../../eval/run.ts";

const context = {
  experimentId: "experiment-1",
  arm: "full" as const,
  manifestDigest: "a".repeat(64),
  deployment: "b".repeat(40),
  replayRunId: "arm-1",
};

describe("durable ablation transport", () => {
  it("exposes resume and upload-supported defaults", () => {
    expect(parseAblateArgs(["--resume", "experiment-1"])).toMatchObject({ resume: "experiment-1" });
    const defaults = parseAblateArgs(["--cap-usd", "1"]);
    expect(defaults).toMatchObject({ flags: ["no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe"] });
    expect(parseAblateArgs(["--resume", "experiment-1", "--cap-usd", "2"])).toHaveProperty("error");
  });

  it("keeps a known run identity when resuming an arm", () => {
    const manifest = startAblationRun(
      { seed: "s", sets: ["s"], setVersions: { s: "v" }, deployment: "d", ids: ["a"] },
      ["no-sam"],
    );
    const resumed = resumeAblationArm(recordAblationArm(manifest, "full", "stable-arm-id", "failed"), "full");
    expect(resumed.arms[0]?.runId).toBe("stable-arm-id");
  });

  it("sends strict ablate JSON and returns persisted attribution", async () => {
    let form: FormData | undefined;
    const api = liveApi("https://app.example", "session=test", async (_url, init) => {
      form = init?.body as FormData;
      return Response.json({ caseId: "case-1", experiment: context }, { status: 201 });
    });
    const sample = {
      id: "s/a.eml",
      set: "s",
      path: "a.eml",
      file: "/unused",
      label: "attack" as const,
      category: "phishing",
      sha256: "0".repeat(64),
    };
    const { replayRunId, ...experiment } = context;
    const answer = await api.upload(sample, new Uint8Array([1]), { mode: "full", replayRunId, experiment });
    expect(form?.get("ablate")).toBe(JSON.stringify(experiment));
    expect(form?.get("replayRunId")).toBe(replayRunId);
    expect(answer).toMatchObject({ experiment: context });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  type CaseExperiment as Context,
  experimentDigest,
  loadExperiment,
  parseExperiment,
  saveExperiment,
} from "../../eval/ablate.ts";
import { main } from "../../eval/ablate-run.ts";
import type { ExperimentDeps } from "../../eval/ablation-experiment.ts";
import {
  type Api,
  type Attribution,
  type CaseState,
  type Db,
  type ResultRow,
  type RunRow,
  sampleUploadKey,
  sha256,
} from "../../eval/run.ts";
import type { RunSample } from "../../eval/run-core.ts";

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function harness() {
  const root = mkdtempSync(join(tmpdir(), "ablation-transport-"));
  folders.push(root);
  let clock = Date.parse("2026-11-04T08:00:00Z"),
    serial = 0;
  const bytes = new Map<string, Uint8Array>();
  const samples: RunSample[] = ["attack", "genuine"].map((label, i) => {
    const file = `/virtual/${i}.eml`,
      body = new TextEncoder().encode(`synthetic ${label}`);
    bytes.set(file, body);
    return {
      id: `synthetic-sa/${i}.eml`,
      set: "synthetic-sa",
      path: `${i}.eml`,
      file,
      label: label as "attack" | "genuine",
      category: label,
      sha256: sha256(body),
    };
  });
  const runs = new Map<string, RunRow>(),
    rows = new Map<string, ResultRow>();
  const bindings = new Map<string, Attribution>(),
    states = new Map<string, CaseState>(),
    active = new Map<string, string>();
  const uploads: { sample: string; context: Context }[] = [];
  const logs: string[] = [];
  const control = {
    capability: true,
    echoMismatch: false,
    bindingMismatch: false,
    ambiguousInsert: false,
    unknown: false,
    rawMissing: false,
    rawMissingPoll: false,
    failArm: "",
    restoreBinding: false,
  };
  let admissions = 0;
  const db: Db = {
    orgId: async () => "org-eval",
    memberships: async () => ["org-eval"],
    allowance: async () => ({ used: 0, limit: 1000 }),
    spent: async () => ({ daySpentUsd: 0, totalSpentUsd: 0 }),
    lastCostPerCase: async () => 0.01,
    caseState: async (id) => {
      const state = states.get(id);
      if (control.rawMissingPoll && state) {
        control.rawMissingPoll = false;
        state.status = "partial";
        state.verdict = null;
        state.costUsd = 0;
        const bound = bindings.get(id);
        if (bound) {
          bound.active = false;
          bound.rawMissing = true;
        }
        for (const [key, value] of active) if (value === id) active.delete(key);
      }
      return state ?? null;
    },
    caseExperiment: async (id) => {
      const row = bindings.get(id);
      return row
        ? {
            ...row,
            context: { ...row.context, ...(control.bindingMismatch ? { manifestDigest: "c".repeat(64) } : {}) },
          }
        : null;
    },
    modelUse: async (id) => {
      const arm = bindings.get(id)?.context.arm;
      return [
        { flag: "no-agent-reasoning", model: "muse-spark-1.3", step: "verdict" },
        { flag: "no-walkthrough", model: "muse-wonder-1.0", step: "walkthrough" },
        { flag: "no-sam", model: "sam-3.1", step: "vision" },
        { flag: "no-transcribe", model: "muse-voice-transcribe-1.0", step: "voice" },
      ]
        .filter((m) => m.flag !== arm)
        .map((m) => ({ model: m.model, step: m.step, outcome: "ok", state: "settled", cache: null }));
    },
    insertRun: async (run) => {
      if (runs.has(run.id)) throw new Error("duplicate");
      runs.set(run.id, { ...run });
      if (control.ambiguousInsert) {
        control.ambiguousInsert = false;
        throw new Error("insert response lost");
      }
    },
    putResult: async (row) => {
      rows.set(`${row.runId}:${row.sample}`, { ...row });
    },
    finishRun: async (id, status, costUsd, finishedAt) => {
      const row = runs.get(id);
      if (!row) throw new Error("missing run");
      Object.assign(row, { status, costUsd, finishedAt });
    },
    readRun: async (id) => {
      const run = runs.get(id);
      return run
        ? { run: { ...run }, results: [...rows.values()].filter((row) => row.runId === id).map((row) => ({ ...row })) }
        : null;
    },
  };
  const api: Api = {
    commit: async () => context.deployment,
    whoami: async () => "member",
    capabilities: async () => ({
      version: 1,
      commit: context.deployment,
      durableContext: true,
      uploadArms: control.capability
        ? ["full", "no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe"]
        : ["full"],
      screening: false,
    }),
    upload: async (sample, _bytes, opts) => {
      if (!opts.experiment || !opts.replayRunId) throw new Error("ordinary upload forbidden in experiment test");
      const bound: Context = { ...opts.experiment, replayRunId: opts.replayRunId };
      uploads.push({ sample: sample.id, context: bound });
      if (control.failArm === bound.arm) return { status: 503 };
      const key = `${bound.replayRunId}:${sample.id}`;
      let caseId = active.get(key);
      const repeat = Boolean(caseId);
      if (!caseId) {
        caseId = `case-${++admissions}`;
        active.set(key, caseId);
        bindings.set(caseId, { context: bound, uploadKey: sampleUploadKey(sample), active: true, rawMissing: false });
        states.set(caseId, {
          status: "done",
          verdict: sample.label === "attack" ? (bound.arm === "no-sam" ? "safe" : "malicious") : "safe",
          costUsd: 0.01,
          critical: false,
          createdAt: new Date(clock).toISOString(),
          updatedAt: new Date(clock + 100).toISOString(),
        });
      }
      if (control.rawMissing) {
        control.rawMissing = false;
        const b = bindings.get(caseId);
        if (b) {
          b.active = false;
          b.rawMissing = true;
        }
        active.delete(key);
        return { status: 503 };
      }
      if (control.unknown) return { status: 503 };
      return {
        status: repeat ? 200 : 201,
        caseId,
        repeat,
        experiment: control.echoMismatch ? { ...bound, arm: "no-sam" } : bound,
      };
    },
  };
  const deps: ExperimentDeps = {
    api,
    db,
    stateDir: join(root, "state"),
    resultsDir: root,
    select: () => ({ samples, setVersions: { "synthetic-sa": "d".repeat(64) } }),
    env: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      id: () => `id-${++serial}`,
      journalDir: join(root, "journals"),
      bytes: (file) => {
        const b = bytes.get(file);
        if (!b) throw new Error("missing bytes");
        return b;
      },
      log: (line) => logs.push(line),
      ticker: () => () => {},
      timeout: async (_ms, work) => work(),
    },
  };
  const manifest = () => loadExperiment(join(deps.stateDir, "id-1", "manifest.json"));
  const run = (extra: string[] = []) => main(["--cap-usd", "1", "--set", "synthetic-sa", ...extra], {}, deps);
  const resume = () => main(["--resume", "id-1"], {}, deps);
  return {
    root,
    deps,
    control,
    runs,
    rows,
    bindings,
    states,
    uploads,
    logs,
    manifest,
    run,
    resume,
    admissions: () => admissions,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("real ablation command recovery", () => {
  it("runs supported defaults and recomputes every arm after restart without another upload", async () => {
    const t = harness();
    writeFileSync(join(t.root, "RESULTS.md"), "# Results\n\n## Unrelated\n\nkeep this\n");
    expect(await t.run()).toBe(0);
    expect(t.admissions()).toBe(10);
    const first = t.manifest();
    expect(first.arms).toHaveLength(5);
    expect(new Set(first.arms.map((a) => a.replayRunId)).size).toBe(5);
    const report = readFileSync(join(t.root, "RESULTS.md"), "utf8");
    expect(report).toContain("keep this");
    expect(report).toContain("sam-3.1 | synthetic-sa | -100.0%");
    expect(report).toContain("Cost per check change");
    expect(report).toContain("100 ms | US$0.0100 |");
    expect(await t.resume()).toBe(0);
    expect(t.admissions()).toBe(10);
    expect(t.manifest()).toEqual(first);
    expect(readFileSync(join(t.root, "RESULTS.md"), "utf8")).toBe(report);
  });
  it("reports mean cost per check and its paired difference rather than population totals", async () => {
    const t = harness();
    const read = t.deps.db.caseState;
    t.deps.db.caseState = async (id) => {
      const state = await read(id);
      return state ? { ...state, costUsd: t.bindings.get(id)?.context.arm === "full" ? 0.05 : 0.04 } : null;
    };
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const report = readFileSync(join(t.root, "RESULTS.md"), "utf8");
    expect(report).toContain("100 ms | US$0.0500 |");
    expect(report).toContain("0 ms | US$-0.0100 |");
    expect(report).not.toContain("US$0.1000");
  });
  it("refuses unsupported arms and missing capabilities before even the baseline", async () => {
    const t = harness();
    expect(await t.run(["--flags", "no-screening"])).toBe(3);
    expect(t.uploads).toHaveLength(0);
    t.control.capability = false;
    expect(await t.run()).toBe(3);
    expect(t.uploads).toHaveLength(0);
  });
  it("keeps completed baseline and resumes failed arm under its original replay ID and cap", async () => {
    const t = harness();
    t.control.failArm = "no-sam";
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    const first = t.manifest();
    expect(first.arms[0]?.status).toBe("complete");
    const baselineCalls = t.uploads.filter((x) => x.context.arm === "full").length;
    t.control.failArm = "";
    expect(await t.resume()).toBe(0);
    expect(t.manifest().arms.map((a) => a.replayRunId)).toEqual(first.arms.map((a) => a.replayRunId));
    expect(t.uploads.filter((x) => x.context.arm === "full")).toHaveLength(baselineCalls);
    expect(readFileSync(join(t.root, "RESULTS.md"), "utf8")).toContain("none (full baseline)");
  });
  it("reconciles ambiguous run insertion before creating or uploading another run", async () => {
    const t = harness();
    t.control.ambiguousInsert = true;
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    expect(t.admissions()).toBe(0);
    expect(t.runs.size).toBe(1);
    const first = t.manifest();
    expect(await t.resume()).toBe(0);
    expect(t.runs.size).toBe(2);
    expect(t.manifest().arms.map((a) => a.replayRunId)).toEqual(first.arms.map((a) => a.replayRunId));
  });
  it("recovers a lost admission response after 24 hours without a second paid case", async () => {
    const t = harness();
    t.control.unknown = true;
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    expect(t.admissions()).toBe(2);
    t.advance(25 * 60 * 60 * 1000);
    t.control.unknown = false;
    expect(await t.resume()).toBe(0);
    expect(t.admissions()).toBe(4);
    expect([...t.rows.values()].every((row) => row.outcome !== "stale-repeat")).toBe(true);
  });
  it("excludes definitively failed RawMissing history and admits a replacement under the same arm", async () => {
    const t = harness();
    t.control.rawMissing = true;
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const failed = [...t.bindings].filter(([, b]) => b.rawMissing);
    expect(failed).toHaveLength(1);
    expect([...t.rows.values()].some((row) => row.caseId === failed[0]?.[0])).toBe(false);
    expect(t.admissions()).toBe(5);
    expect(new Set(t.uploads.filter((x) => x.context.arm === "full").map((x) => x.context.replayRunId)).size).toBe(1);
  });
  it("clears only a definitive RawMissing journal binding on restart and preserves other cases", async () => {
    const t = harness();
    t.control.rawMissingPoll = true;
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    const first = t.manifest();
    const failed = [...t.bindings].find(([, binding]) => binding.rawMissing);
    expect(failed).toBeDefined();
    expect(t.admissions()).toBe(2);
    expect(await t.resume()).toBe(0);
    expect(t.admissions()).toBe(5);
    expect(t.manifest().arms.map((a) => a.replayRunId)).toEqual(first.arms.map((a) => a.replayRunId));
    expect([...t.rows.values()].some((row) => row.caseId === failed?.[0])).toBe(false);
  });

  it("refuses unknown inactive attribution without manufacturing a replacement", async () => {
    const t = harness();
    t.control.failArm = "no-sam";
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    const bound = [...t.bindings.values()][0];
    if (!bound) throw new Error("missing bound case");
    bound.active = false;
    bound.rawMissing = false;
    t.control.failArm = "";
    expect(await t.resume()).toBe(3);
    expect(t.admissions()).toBe(2);
  });

  it("refuses missing attribution clients, shared headroom, deployment and population drift before spending", async () => {
    const t = harness();
    const method = t.deps.db.caseExperiment;
    if (!method) throw new Error("missing attribution reader");
    delete t.deps.db.caseExperiment;
    expect(await t.run(["--flags", "no-sam"])).toBe(3);
    expect(t.uploads).toHaveLength(0);
    t.deps.db.caseExperiment = method;
    t.deps.db.spent = async () => ({ daySpentUsd: 1e9, totalSpentUsd: 1e9 });
    expect(await t.run(["--flags", "no-sam"])).toBe(3);
    expect(t.uploads).toHaveLength(0);
    const other = harness();
    expect(await other.run(["--flags", "no-sam"])).toBe(0);
    other.deps.api.commit = async () => "c".repeat(40);
    expect(await other.resume()).toBe(3);
    other.deps.api.commit = async () => context.deployment;
    const select = other.deps.select;
    other.deps.select = (sets) => ({ ...select(sets), setVersions: { "synthetic-sa": "e".repeat(64) } });
    expect(await other.resume()).toBe(3);
    expect(other.admissions()).toBe(4);
  });

  it.each(["echoMismatch", "bindingMismatch"] as const)("rejects %s without publishing or later arms", async (key) => {
    const t = harness();
    t.control[key] = true;
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    expect(t.uploads.every((x) => x.context.arm === "full")).toBe(true);
    expect(() => readFileSync(join(t.root, "RESULTS.md"))).toThrow();
  });
  it("refuses publication when the stored arm cost no longer matches its ledger", async () => {
    const t = harness();
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const state = [...t.states.values()][0];
    if (!state) throw new Error("missing measured case");
    state.costUsd = 0.5;
    expect(await t.resume()).toBe(3);
    expect(t.admissions()).toBe(4);
  });

  it("keeps unexercised models explicitly not measured and records report provenance", async () => {
    const t = harness();
    t.deps.db.modelUse = async () => [];
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const report = readFileSync(join(t.root, "RESULTS.md"), "utf8");
    expect(report).toContain("sam-3.1 | synthetic-sa | not measured");
    expect(report).toContain("Loupe screening: not measured");
    expect(t.admissions()).toBe(2); // No removed-model call was exercised, so no paid arm is useful.
    expect(report).toContain(t.manifest().manifestDigest);
    expect(report).toContain(context.deployment);
  });

  it.each(["stale-repeat", "null-verdict"])("does not publish a %s completed database arm", async (fault) => {
    const t = harness();
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const report = readFileSync(join(t.root, "RESULTS.md"), "utf8");
    const row = [...t.rows.values()][0];
    if (!row) throw new Error("missing measured row");
    if (fault === "stale-repeat") row.outcome = "stale-repeat";
    else row.verdict = null;
    expect(await t.resume()).toBe(3);
    expect(t.manifest().arms[0]?.status).toBe("incomplete");
    expect(readFileSync(join(t.root, "RESULTS.md"), "utf8")).toBe(report);
    expect(t.admissions()).toBe(4);
  });

  it("refuses a second command holding the same experiment and releases after completion", async () => {
    const t = harness();
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const capability = t.deps.api.capabilities;
    if (!capability) throw new Error("missing capability method");
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.deps.api.capabilities = async () => {
      entered();
      await held;
      return capability();
    };
    const first = t.resume();
    await ready;
    try {
      expect(await t.resume()).toBe(3);
    } finally {
      release();
    }
    expect(await first).toBe(0);
    expect(t.admissions()).toBe(4);
  });

  it("recovers a failed progress write after baseline completion without repeating paid work", async () => {
    const t = harness();
    t.deps.save = (dir, m) => {
      if (m.arms[0]?.status === "complete") throw new Error("disk full after baseline");
      return saveExperiment(dir, m);
    };
    expect(await t.run(["--flags", "no-sam"])).toBe(3);
    expect(t.admissions()).toBe(2);
    const before = t.manifest();
    expect(before.arms[0]?.status).toBe("pending");
    delete t.deps.save;
    expect(await t.resume()).toBe(0);
    expect(t.admissions()).toBe(4);
    expect(t.manifest().arms.map((a) => a.replayRunId)).toEqual(before.arms.map((a) => a.replayRunId));
  });

  it("validates immutable manifest fields, duplicate keys and canonical digest independently", async () => {
    const t = harness();
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const m = t.manifest();
    expect(experimentDigest({ ...m, setVersions: Object.fromEntries(Object.entries(m.setVersions).reverse()) })).toBe(
      m.manifestDigest,
    );
    expect(experimentDigest({ ...m, ids: [...m.ids].reverse() })).not.toBe(m.manifestDigest);
    expect(() => parseExperiment({ ...m, extra: true })).toThrow();
    expect(() => parseExperiment({ ...m, ids: [...m.ids, m.ids[0]] })).toThrow();
    expect(() => parseExperiment({ ...m, arms: [m.arms[0], m.arms[0]] })).toThrow();
    expect(() => parseExperiment({ ...m, experimentId: "../escape" })).toThrow();
    expect(() => parseExperiment({ ...m, deployment: "wrong" })).toThrow();
    const file = join(t.deps.stateDir, m.experimentId, "manifest.json");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace('"version": 1,', '"version": 0, "version": 1,'));
    expect(() => loadExperiment(file)).toThrow("canonical");
    expect(await t.resume()).toBe(3);
    expect(t.admissions()).toBe(4);
  });

  it("cannot resume an experimental baseline through the ordinary runner without context", async () => {
    const t = harness();
    t.control.unknown = true;
    expect(await t.run(["--flags", "no-sam"])).toBe(2);
    const m = t.manifest();
    const arm = m.arms[0];
    if (!arm) throw new Error("missing baseline");
    t.control.unknown = false;
    const out = await runEval({
      samples: t.deps.select(m.sets).samples,
      setVersion: m.manifestDigest,
      sets: m.sets,
      sampleLimit: null,
      options: { capUsd: 1, dry: false },
      api: t.deps.api,
      db: t.deps.db,
      env: t.deps.env,
      resume: arm.replayRunId,
    });
    expect(out.exit).toBe(3);
    expect(out.problems.join()).toContain("immutable experiment metadata");
    expect(t.admissions()).toBe(2);
  });

  it("does not dispatch when durable manifest publication fails", async () => {
    const t = harness();
    t.deps.save = () => {
      throw new Error("disk full");
    };
    expect(await t.run(["--flags", "no-sam"])).toBe(3);
    expect(t.uploads).toHaveLength(0);
  });
  it("refuses manifest identity mutation and changed selected bytes on resume", async () => {
    const t = harness();
    expect(await t.run(["--flags", "no-sam"])).toBe(0);
    const m = t.manifest();
    const changed = structuredClone(m);
    const arm = changed.arms[0];
    if (!arm) throw new Error("missing arm");
    arm.capUsd = 2;
    expect(() => saveExperiment(join(t.deps.stateDir, m.experimentId), changed)).toThrow("immutable");
    t.deps.env.bytes = () => new Uint8Array([0]);
    expect(await t.resume()).toBe(3);
    expect(t.admissions()).toBe(4);
  });
});

import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { liveDb } from "../../eval/run.ts";
import { inline } from "../../src/meta/budget-sql.ts";

describe("durable attribution SQL adapter", () => {
  it("reads the agreed three-table contract with org isolation, active state and real model calls", async () => {
    const sql = new DatabaseSync(":memory:");
    try {
      const migrations = join(import.meta.dirname, "../../src/db/migrations");
      for (const name of readdirSync(migrations)
        .filter((n) => n.endsWith(".sql"))
        .sort())
        sql.exec(readFileSync(join(migrations, name), "utf8"));
      // Contract fixture only until checks' independently reviewed 0095 migration is merged here.
      if (!sql.prepare("SELECT name FROM sqlite_master WHERE name='eval_experiments'").get())
        sql.exec(`
        CREATE TABLE eval_experiments(org_id TEXT,experiment_id TEXT,manifest_digest TEXT,deployment TEXT);
        CREATE TABLE eval_experiment_arms(org_id TEXT,experiment_id TEXT,arm TEXT,replay_run_id TEXT);
        CREATE TABLE case_experiments(case_id TEXT,org_id TEXT,experiment_id TEXT,arm TEXT,replay_run_id TEXT,upload_key TEXT,active_upload_key TEXT);`);
      const at = "2026-11-04T08:00:00Z";
      sql.exec(`INSERT INTO organization(id,name,slug,createdAt) VALUES('org-eval','IsItLegit Eval','eval','${at}'),('other','Other','other','${at}');
        INSERT INTO cases(id,org_id,channel,status,created_at,updated_at) VALUES('case-a','org-eval','upload','partial','${at}','${at}'),('case-other','other','upload','done','${at}','${at}');`);
      sql
        .prepare("INSERT INTO eval_experiments VALUES(?,?,?,?)")
        .run("org-eval", context.experimentId, context.manifestDigest, context.deployment);
      sql
        .prepare("INSERT INTO eval_experiment_arms VALUES(?,?,?,?)")
        .run("org-eval", context.experimentId, context.arm, context.replayRunId);
      sql
        .prepare("INSERT INTO case_experiments VALUES(?,?,?,?,?,?,?)")
        .run(
          "case-a",
          "org-eval",
          context.experimentId,
          context.arm,
          context.replayRunId,
          "sha256:input",
          "sha256:input",
        );
      sql.exec(`INSERT INTO model_spend(id,at,day,source,caller,model,case_id,estimate_usd,actual_usd,state,owner,step,outcome) VALUES
        ('call-a','${at}','2026-11-04','worker','verdict-agent','muse-spark-1.3','case-a',0.1,0.01,'settled','case','verdict','ok');`);
      const adapter = liveDb("IsItLegit Eval", async (statement) => ({
        results: sql.prepare(inline(statement)).all() as Record<string, unknown>[],
      }));
      expect(await adapter.caseExperiment?.("case-a")).toEqual({
        context,
        uploadKey: "sha256:input",
        active: true,
        rawMissing: false,
      });
      expect(await adapter.caseExperiment?.("case-other")).toBeNull();
      expect(await adapter.modelUse?.("case-a")).toEqual([
        { model: "muse-spark-1.3", step: "verdict", outcome: "ok", state: "settled", cache: null },
      ]);
      sql.exec(`INSERT INTO case_events(case_id,step,status,started_at,error) VALUES('case-a','admit','failed','${at}','RawMissing');
        UPDATE case_experiments SET active_upload_key=NULL WHERE case_id='case-a';`);
      expect(await adapter.caseExperiment?.("case-a")).toMatchObject({ active: false, rawMissing: true, context });
      sql.exec("DROP TABLE eval_experiments");
      await expect(adapter.caseExperiment?.("case-a")).rejects.toThrow();
    } finally {
      sql.close();
    }
  });
});

it("runs the real Node command for help and unsupported-arm refusal without credentials", () => {
  const env = { ...process.env };
  delete env.EVAL_SESSION_COOKIE;
  const command = join(import.meta.dirname, "../../eval/ablate-run.ts");
  const help = spawnSync(process.execPath, [command, "--help"], { env, encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--resume <experiment-id>");
  const refused = spawnSync(process.execPath, [command, "--cap-usd", "1", "--flags", "no-screening"], {
    env,
    encoding: "utf8",
  });
  expect(refused.status).toBe(3);
  expect(refused.stderr).toContain("not supported by uploads");
});
