import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { armContext, createExperiment, saveExperiment } from "../../eval/ablate.ts";
import { runMetrics } from "../../eval/metrics.ts";
import type { PublishDb } from "../../eval/publish.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";
import { sampleUploadKey } from "../../eval/run.ts";
import { selectSamples } from "../../eval/run-core.ts";

const root = mkdtempSync(join(tmpdir(), "experiment-publication-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("required test fixture missing");
  return value;
}
function fixture() {
  const sets = ["synthetic-sa", "synthetic-challenge"];
  const pools = sets.map((set) => selectSamples(resolve("eval/sets"), [set]));
  const samples = pools.flatMap((p) => [
    present(p.samples.filter((s) => s.label === "attack").at(-1)),
    present(p.samples.filter((s) => s.label === "genuine").at(-1)),
  ]);
  let next = 0;
  const manifest = createExperiment(
    {
      seed: "existing-only",
      sets,
      setVersions: Object.fromEntries(sets.map((s, i) => [s, present(pools[i]).setVersion])),
      deployment: "a".repeat(40),
      ids: samples.map((s) => s.id),
    },
    ["no-agent-reasoning"],
    1,
    () => `identity-${++next}`,
  );
  const file = saveExperiment(join(root, `case-${Math.random()}`), manifest);
  const records = manifest.arms.map((arm) => {
    const run: RunRow = {
      id: arm.replayRunId,
      mode: `ablate:${arm.flag}`,
      commitSha: manifest.deployment,
      setVersion: manifest.manifestDigest,
      sets,
      sampleLimit: null,
      status: "complete",
      selected: samples.length,
      capUsd: 1,
      costUsd: 0.08,
      startedAt: "2026-11-04T10:00:00Z",
      finishedAt: "2026-11-04T10:00:01Z",
    };
    const results: ResultRow[] = samples.map((s, i) => ({
      runId: run.id,
      sample: s.id,
      caseId: `${run.id}-${i}`,
      outcome: "done",
      label: s.label,
      category: s.category,
      verdict: s.label === "attack" ? "suspicious" : "safe",
      ms: 1000,
      costUsd: 0.02,
      criticalFound: false,
      httpStatus: 201,
      detail: null,
    }));
    return { run, results };
  });
  const published = new Map<string, { mode: string; reportJson: string; publishedAt: string }>();
  const pub: PublishDb = {
    insertPublished: async (id, mode, reportJson, publishedAt) => {
      published.set(id, { mode, reportJson, publishedAt });
    },
    readPublished: async (id) => published.get(id) ?? null,
    latestFull: async () => null,
  };
  const db = {
    readRun: async (id: string) => records.find((r) => r.run.id === id) ?? null,
    caseExperiment: async (id: string) => {
      for (const [a, record] of records.entries()) {
        const i = record.results.findIndex((r) => r.caseId === id);
        if (i >= 0)
          return {
            context: armContext(manifest, present(manifest.arms[a])),
            active: true,
            rawMissing: false,
            uploadKey: sampleUploadKey(present(samples[i])),
          };
      }
      return null;
    },
    modelUse: async (id: string) =>
      id.startsWith(present(records[0]).run.id)
        ? [{ model: "muse-spark-1.3", step: "verdict", state: "settled", outcome: "ok", cache: null }]
        : [],
  };
  const execute = (index: number, publish = false) =>
    runMetrics({
      argv: ["--run", present(records[index]).run.id, "--experiment", file, publish ? "--publish" : "--json"],
      db,
      pub,
      verify: async () => ({ ok: true, problems: [] }),
      root: resolve("."),
    });
  return { execute, records, manifest, published, pub, db };
}
it("scores exact saved IDs and challenge separately, publishes matched arms without changing full identity", async () => {
  const t = fixture();
  const scored = await t.execute(0);
  expect(scored.code, scored.stderr).toBe(0);
  const report = JSON.parse(scored.stdout);
  expect(report.run.mode).toBe("ablate:full");
  expect(report.run.setVersion).toBe(t.manifest.manifestDigest);
  expect(report.main.attacks).toBe(1);
  expect(report.main.genuine).toBe(1);
  expect(report.challenge.attacks).toBe(1);
  expect(report.challenge.genuine).toBe(1);
  expect((await t.execute(0, true)).code).toBe(0);
  expect((await t.execute(1, true)).code).toBe(0);
  expect(t.published.get(present(t.records[0]).run.id)?.mode).toBe("ablate:full");
});
it("refuses unmatched baseline publication and retains an existing valid publication after a later failure", async () => {
  const t = fixture();
  expect((await t.execute(1, true)).code).toBe(3);
  expect(t.published.size).toBe(0);
  expect((await t.execute(0, true)).code).toBe(0);
  const before = JSON.stringify([...t.published]);
  present(present(t.records[1]).results[0]).verdict = null;
  expect((await t.execute(1, true)).code).toBe(3);
  expect(JSON.stringify([...t.published])).toBe(before);
});

it("compares a published arm only with its durable experiment baseline, even without a headline", async () => {
  const t = fixture();
  await t.execute(0, true);
  await t.execute(1, true);
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const { ablations } = await import(new URL("../../src/eval/results.ts", import.meta.url).href);
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(
      "CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE cases(id TEXT PRIMARY KEY, status TEXT); CREATE TABLE case_events(case_id TEXT, step TEXT, status TEXT, error TEXT); CREATE TABLE eval_published(run_id TEXT PRIMARY KEY, mode TEXT, report_json TEXT, published_at TEXT);",
    );
    sql.exec(readFileSync("src/db/migrations/0095_case_experiments.sql", "utf8"));
    sql.prepare("INSERT INTO organization VALUES (?)").run("eval-org");
    sql
      .prepare("INSERT INTO eval_experiments VALUES (?,?,?,?)")
      .run("eval-org", t.manifest.experimentId, t.manifest.manifestDigest, t.manifest.deployment);
    for (const arm of t.manifest.arms)
      sql
        .prepare("INSERT INTO eval_experiment_arms VALUES (?,?,?,?)")
        .run("eval-org", t.manifest.experimentId, arm.flag, arm.replayRunId);
    for (const [id, p] of t.published)
      sql.prepare("INSERT INTO eval_published VALUES (?,?,?,?)").run(id, p.mode, p.reportJson, p.publishedAt);
    const db = {
      prepare: (query: string) => {
        let params: (string | number | null)[] = [];
        const stmt = {
          bind: (...values: typeof params) => {
            params = values;
            return stmt;
          },
          all: async () => ({ results: sql.prepare(query).all(...params) }),
          first: async () => sql.prepare(query).get(...params) ?? null,
        };
        return stmt;
      },
    };
    const rows = await ablations(db, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ comparable: true, baselineRunId: present(t.records[0]).run.id, detectionDelta: 0 });
    sql.prepare("DELETE FROM eval_published WHERE run_id = ?").run(present(t.records[0]).run.id);
    expect(
      await ablations(db, JSON.parse(present(t.published.get(present(t.records[0]).run.id)).reportJson)),
    ).toMatchObject([{ comparable: false }]);
  } finally {
    sql.close();
  }
});

it("keeps missing samples in denominators and refuses altered identity, attribution and unexercised models", async () => {
  const t = fixture();
  const original = present(present(t.records[0]).results.pop());
  const incomplete = await t.execute(0);
  expect(incomplete.code).toBe(0);
  expect(JSON.parse(incomplete.stdout)).toMatchObject({ complete: false, missing: [original.sample] });
  expect((await t.execute(0, true)).code).toBe(3);
  present(t.records[0]).results.push(original);
  present(t.records[0]).run.setVersion = "b".repeat(64);
  expect((await t.execute(0)).code).toBe(3);
  present(t.records[0]).run.setVersion = t.manifest.manifestDigest;
  const binding = t.db.caseExperiment;
  t.db.caseExperiment = async () => null;
  expect((await t.execute(0, true)).code).toBe(3);
  t.db.caseExperiment = binding;
  expect((await t.execute(0, true)).code).toBe(0);
  t.db.modelUse = async () => [];
  const absent = await t.execute(1, true);
  expect(absent.code).toBe(3);
  expect(absent.stderr).toContain("not measured");
  expect(t.published.size).toBe(1);
});

it("retains the baseline after a publication database failure and retries the same arm identity", async () => {
  const t = fixture();
  expect((await t.execute(0, true)).code).toBe(0);
  const before = JSON.stringify([...t.published]);
  const insert = t.pub.insertPublished;
  t.pub.insertPublished = async () => {
    throw new Error("storage unavailable");
  };
  expect((await t.execute(1, true)).code).toBe(1);
  expect(JSON.stringify([...t.published])).toBe(before);
  t.pub.insertPublished = insert;
  expect((await t.execute(1, true)).code).toBe(0);
  expect(t.published.size).toBe(2);
  expect((await t.execute(1, true)).code).toBe(3);
  expect(t.published.size).toBe(2);
});

it("refuses changed deployment, selected counts, foreign sample IDs and a removed model still executing", async () => {
  const t = fixture();
  const run = present(t.records[1]).run;
  run.commitSha = "c".repeat(40);
  expect((await t.execute(1)).code).toBe(3);
  run.commitSha = t.manifest.deployment;
  run.selected++;
  expect((await t.execute(1)).code).toBe(3);
  run.selected--;
  const row = present(present(t.records[1]).results[0]);
  const id = row.sample;
  row.sample = "synthetic-sa/not-selected";
  expect((await t.execute(1)).code).toBe(3);
  row.sample = id;
  expect((await t.execute(0, true)).code).toBe(0);
  const uses = t.db.modelUse;
  t.db.modelUse = async () => uses(present(t.records[0]).run.id);
  const removed = await t.execute(1, true);
  expect(removed.code).toBe(3);
  expect(removed.stderr).toContain("still exercised");
  expect(t.published.size).toBe(1);
});
