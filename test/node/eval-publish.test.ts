// Publishing an eval run (D08 T02 §4): who may be published, the summary the site reads, the order of the database row
// and the file, and the repair when the file write fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { computeMetrics, runMetrics } from "../../eval/metrics.ts";
import {
  livePublishDb,
  type PublishDb,
  publishProblems,
  publishRun,
  republishSummary,
  SUMMARY_PATH,
  summaryOf,
  withSummaryLock,
  writeResultsSummary,
} from "../../eval/publish.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";
import type { Outcome, RunSample } from "../../eval/run-core.ts";
import { parseResults } from "../../site/src/lib/results.ts";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "eval-publish-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sample = (name: string, label: "attack" | "genuine", set = "synthetic-sa"): RunSample => ({
  id: `${set}/${name}`,
  set,
  path: name,
  file: `/nowhere/${name}`,
  label,
  category: label === "attack" ? "credential-phishing" : "genuine-business",
  basis: label === "attack" ? "checks" : undefined,
  sha256: "0".repeat(64),
});
const row = (
  id: string,
  outcome: Outcome,
  verdict: ResultRow["verdict"],
  over: Partial<ResultRow> = {},
): ResultRow => ({
  runId: "run-00000001",
  sample: id,
  caseId: `case-${id}`,
  outcome,
  label: "attack",
  category: "x",
  verdict,
  ms: 4000,
  costUsd: 0.02,
  criticalFound: false,
  httpStatus: null,
  detail: null,
  ...over,
});
const runRow = (over: Partial<RunRow> = {}): RunRow => ({
  id: "run-00000001",
  commitSha: "abc1234",
  setVersion: "a".repeat(64),
  mode: "full",
  sets: ["synthetic-sa"],
  sampleLimit: null,
  status: "complete",
  selected: 4,
  capUsd: 5,
  startedAt: "2026-11-01T10:00:00.000Z",
  finishedAt: "2026-11-01T23:30:00.000Z",
  costUsd: 0.08,
  ...over,
});
const samples = [
  sample("a1.eml", "attack"),
  sample("a2.eml", "attack"),
  sample("g1.eml", "genuine"),
  sample("g2.eml", "genuine"),
];
const results = [
  row("synthetic-sa/a1.eml", "done", "suspicious"),
  row("synthetic-sa/a2.eml", "done", "malicious", { ms: 6000 }),
  row("synthetic-sa/g1.eml", "done", "safe", { label: "genuine" }),
  row("synthetic-sa/g2.eml", "done", "safe", { label: "genuine", ms: 2000 }),
];
const report = (over: Partial<RunRow> = {}, rows = results, sel = samples) =>
  computeMetrics({ run: runRow({ selected: sel.length, ...over }), samples: sel, results: rows });

describe("who may be published and what the site reads", () => {
  it("publishes a complete report, and the summary meets the site's own contract", () => {
    const r = report();
    expect(publishProblems(r)).toEqual([]);
    const summary = summaryOf(r);
    expect(summary).toEqual({
      detectionRate: 1,
      falseAlarmRate: 0,
      medianSeconds: 4,
      samples: 4,
      runDate: "2026-11-02",
      runId: "run-00000001",
    });
    expect(parseResults(JSON.stringify(summary), "summary")).toMatchObject({ detectionRate: 1, medianSeconds: 4 });
  });

  it("refuses an incomplete report and one whose main figures are not numbers, naming what is missing", () => {
    expect(publishProblems(report({ status: "incomplete" })).join()).toMatch(/not complete/);
    expect(publishProblems(report({}, results.slice(0, 3))).join()).toMatch(/not complete \(run complete, 1 missing/);
    // A challenge-only selection has no main figures: no invented zero.
    const challenge = [
      sample("c1.eml", "attack", "synthetic-challenge"),
      sample("c2.eml", "genuine", "synthetic-challenge"),
    ];
    const only = report(
      {},
      [
        row("synthetic-challenge/c1.eml", "done", "suspicious"),
        row("synthetic-challenge/c2.eml", "done", "safe", { label: "genuine" }),
      ],
      challenge,
    );
    expect(publishProblems(only).join()).toMatch(/detection is not measured/);
    expect(publishProblems(only).join()).toMatch(/false positives are not measured/);
    expect(publishProblems(only).join()).toMatch(/analysis time above zero/);
    // A median time of zero would fail the site's contract.
    const zero = report(
      {},
      results.map((x) => ({ ...x, ms: 0 })),
    );
    expect(publishProblems(zero).join()).toMatch(/analysis time above zero/);
  });

  it("writes the file whole or not at all, keeping the previous one on a failure", () => {
    const root = temp();
    const file = join(root, SUMMARY_PATH);
    writeResultsSummary(file, summaryOf(report()));
    const first = readFileSync(file, "utf-8");
    expect(parseResults(first, file).runId).toBe("run-00000001");
    mkdirSync(join(root, "eval/blocked"), { recursive: true });
    expect(() => writeResultsSummary(join(root, "eval/blocked"), summaryOf(report()))).toThrow();
    expect(readFileSync(file, "utf-8")).toBe(first);
  });
});

describe("publication against the real schema", () => {
  const migrations = join(import.meta.dirname, "../../src/db/migrations");
  function database() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(join(migrations, "0067_eval.sql"), "utf-8"));
    db.exec(readFileSync(join(migrations, "0073_eval_published.sql"), "utf-8"));
    return db;
  }
  const seed = (db: DatabaseSync, id: string, mode = "full") =>
    db
      .prepare(
        "INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, status, selected, cap_usd, started_at, finished_at) VALUES (?, 'abc1234', ?, ?, 'synthetic-sa', 'complete', 4, 5, '2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z')",
      )
      .run(id, "a".repeat(64), mode);
  const exec = (db: DatabaseSync) => async (s: { sql: string; params: (string | number | null)[] }) => {
    const stmt = db.prepare(s.sql.replace(/\?(\d+)/g, "?$1"));
    return /^\s*SELECT/i.test(s.sql)
      ? { results: stmt.all(...s.params) as Record<string, unknown>[] }
      : (() => {
          stmt.run(...s.params);
          return {};
        })();
  };
  const now = () => new Date("2026-11-02T06:00:00.000Z");

  it("stores a run once, writes the summary, and refuses a second publication pointing at the repair", async () => {
    const db = database();
    seed(db, "run-00000001");
    const pub = livePublishDb(exec(db));
    const root = temp();
    const first = await publishRun({ report: report(), db: pub, root, now });
    expect(first).toMatchObject({ code: 0 });
    const stored = db.prepare("SELECT run_id, mode, published_at, report_json FROM eval_published").all() as {
      run_id: string;
      mode: string;
      published_at: string;
      report_json: string;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ run_id: "run-00000001", mode: "full", published_at: "2026-11-02T06:00:00.000Z" });
    expect(JSON.parse(stored[0]?.report_json ?? "{}").main.detection).toEqual({ n: 2, hits: 2, rate: 1 });
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-00000001");
    const again = await publishRun({ report: report(), db: pub, root, now });
    expect(again.code).toBe(3);
    expect(again.message).toMatch(/already published; its summary file is repaired with --republish-summary/);
    expect((db.prepare("SELECT count(*) AS n FROM eval_published").get() as { n: number }).n).toBe(1);
  });

  it("publishes nothing when the database fails, and repairs the file after a failed write without a second row", async () => {
    const db = database();
    seed(db, "run-00000001");
    const real = livePublishDb(exec(db));
    const root = temp();
    const broken = {
      ...real,
      insertPublished: async () => {
        throw new Error("d1 down");
      },
    };
    const down = await publishRun({ report: report(), db: broken, root, now });
    expect(down).toMatchObject({ code: 1 });
    expect(down.message).toMatch(/nothing was published/);
    expect((db.prepare("SELECT count(*) AS n FROM eval_published").get() as { n: number }).n).toBe(0);
    expect(() => readFileSync(join(root, SUMMARY_PATH))).toThrow();

    // The row lands, then the file write fails (an interruption between the two): reported exactly, repairable.
    const failed = await publishRun({
      report: report(),
      db: real,
      root,
      now,
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(failed.code).toBe(1);
    expect(failed.message).toMatch(
      /published in the database, but eval\/results-summary\.json could not be written \(disk full\).*repair it with --republish-summary/,
    );
    expect((db.prepare("SELECT count(*) AS n FROM eval_published").get() as { n: number }).n).toBe(1);
    const repaired = await republishSummary({ db: real, root });
    expect(repaired).toMatchObject({ code: 0 });
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-00000001");
    expect((db.prepare("SELECT count(*) AS n FROM eval_published").get() as { n: number }).n).toBe(1);
  });

  it("keeps the headline on the latest full run: an ablation never replaces it, an older full run never rewinds it", async () => {
    const db = database();
    seed(db, "run-00000001");
    seed(db, "run-00000002");
    seed(db, "run-00000003", "no-spark");
    const pub = livePublishDb(exec(db));
    const root = temp();
    const at = (iso: string) => () => new Date(iso);
    await publishRun({ report: report({ id: "run-00000001" }), db: pub, root, now: at("2026-11-02T06:00:00.000Z") });
    await publishRun({ report: report({ id: "run-00000002" }), db: pub, root, now: at("2026-11-03T06:00:00.000Z") });
    const abl = await publishRun({
      report: report({ id: "run-00000003", mode: "no-spark" }),
      db: pub,
      root,
      now: at("2026-11-04T06:00:00.000Z"),
    });
    expect(abl.message).toMatch(/no summary file for an ablation/);
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-00000002");
    expect((await pub.latestFull())?.runId).toBe("run-00000002");
    // Repair rebuilds from the latest full report, not from the newest publication.
    writeFileSync(join(root, SUMMARY_PATH), "{}");
    expect(await republishSummary({ db: pub, root })).toMatchObject({ code: 0 });
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-00000002");
    expect(await republishSummary({ db: livePublishDb(exec(database())), root })).toMatchObject({
      code: 3,
      message: "no full run is published",
    });
  });

  it("publishes a complete replay as the latest full measurement, provenance kept (section 12)", async () => {
    const db = database();
    seed(db, "run-00000001");
    seed(db, "run-00000009");
    const pub = livePublishDb(exec(db));
    const root = temp();
    const at = (iso: string) => () => new Date(iso);
    await publishRun({ report: report({ id: "run-00000001" }), db: pub, root, now: at("2026-11-02T06:00:00.000Z") });
    const replayed = await publishRun({
      report: report({ id: "run-00000009", mode: "replay:run-00000001" }),
      db: pub,
      root,
      now: at("2026-11-03T06:00:00.000Z"),
    });
    expect(replayed.code).toBe(0);
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-00000009");
    expect((await pub.latestFull())?.runId).toBe("run-00000009");
    const stored = await pub.readPublished("run-00000009");
    expect(stored?.mode).toBe("full");
    expect(JSON.parse(stored?.reportJson ?? "{}").run.mode).toBe("replay:run-00000001");
  });

  it("publishes through the command: --publish and --republish-summary, with their refusals", async () => {
    const db = database();
    seed(db, "run-00000001");
    const pub = livePublishDb(exec(db));
    const root = temp();
    const sets = join(root, "eval/sets/synthetic-sa");
    mkdirSync(sets, { recursive: true });
    writeFileSync(join(sets, "a1.eml"), "attack one");
    writeFileSync(join(sets, "g1.eml"), "genuine one");
    writeFileSync(
      join(sets, "labels.json"),
      JSON.stringify([
        { path: "a1.eml", label: "attack", category: "credential-phishing", expected: [], source: "x", basis: "model" },
        { path: "g1.eml", label: "genuine", category: "genuine-business", expected: [], source: "x" },
      ]),
    );
    const { selectSamples } = await import("../../eval/run-core.ts");
    const { setVersion } = selectSamples(join(root, "eval/sets"), ["synthetic-sa"], null);
    const run = runRow({ setVersion, selected: 2, sets: ["synthetic-sa"] });
    const stored = {
      run,
      results: [
        row("synthetic-sa/a1.eml", "done", "malicious"),
        row("synthetic-sa/g1.eml", "done", "safe", { label: "genuine" }),
      ],
    };
    const readRun = async () => stored;
    expect(
      (
        await runMetrics({
          argv: ["--run", "run-00000001", "--publish", "--from", "x.json"],
          db: { readRun },
          pub,
          root,
          now,
        })
      ).code,
    ).toBe(3);
    const verified = async () => ({ ok: true, problems: [] as string[] });
    const out = await runMetrics({
      argv: ["--run", "run-00000001", "--publish"],
      db: { readRun },
      pub,
      root,
      now,
      verify: verified,
    });
    expect(out).toMatchObject({ code: 0 });
    expect(out.stdout).toMatch(/published; eval\/results-summary\.json written/);
    expect((await runMetrics({ argv: ["--republish-summary"], pub, root })).code).toBe(0);
    expect((await runMetrics({ argv: ["--republish-summary", "--run", "run-00000001"], pub, root })).code).toBe(3);
    expect((await runMetrics({ argv: ["--run", "run-00000001", "--publish"], db: { readRun }, root, now })).code).toBe(
      1,
    );
  });

  it("refuses publication when the cases do not reconcile or no verifier is passed (C4)", async () => {
    const db = database();
    seed(db, "run-00000001");
    const pub = livePublishDb(exec(db));
    const root = temp();
    const sets = join(root, "eval/sets/synthetic-sa");
    mkdirSync(sets, { recursive: true });
    writeFileSync(join(sets, "a1.eml"), "attack one");
    writeFileSync(join(sets, "g1.eml"), "genuine one");
    writeFileSync(
      join(sets, "labels.json"),
      JSON.stringify([
        { path: "a1.eml", label: "attack", category: "credential-phishing", expected: [], source: "x", basis: "model" },
        { path: "g1.eml", label: "genuine", category: "genuine-business", expected: [], source: "x" },
      ]),
    );
    const { selectSamples } = await import("../../eval/run-core.ts");
    const { setVersion } = selectSamples(join(root, "eval/sets"), ["synthetic-sa"], null);
    const run = runRow({ setVersion, selected: 2, sets: ["synthetic-sa"] });
    const stored = {
      run,
      results: [
        row("synthetic-sa/a1.eml", "done", "malicious"),
        row("synthetic-sa/g1.eml", "done", "safe", { label: "genuine" }),
      ],
    };
    const readRun = async () => stored;
    const base = { argv: ["--run", "run-00000001", "--publish"], db: { readRun }, pub, root, now };
    // No verifier: the command refuses rather than publish unverified figures.
    const noVerifier = await runMetrics(base);
    expect(noVerifier.code).toBe(3);
    expect(noVerifier.stderr).toMatch(/needs its cases reconciled/);
    // A verifier that reports a mismatch: refused, naming the case problem.
    const mismatched = await runMetrics({
      ...base,
      verify: async () => ({
        ok: false,
        problems: ["synthetic-sa/a1.eml: stored done/malicious, the case says done/safe"],
      }),
    });
    expect(mismatched.code).toBe(3);
    expect(mismatched.stderr).toMatch(/do not reconcile/);
    expect((db.prepare("SELECT count(*) AS n FROM eval_published").get() as { n: number }).n).toBe(0);
    // A verifier that reconciles: published.
    const reconciled = await runMetrics({
      ...base,
      verify: async () => ({ ok: true, problems: [] as string[] }),
    });
    expect(reconciled.code).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM eval_published").get() as { n: number }).n).toBe(1);
  });

  it("ends on the latest published full run when two publications race, whoever writes last (round 1)", async () => {
    // A inserts and reads the latest while it is still its own (a stale view), is held, B publishes whole, then A resumes
    // and writes from its stale read: the file must still end on B, the latest.
    const rows: { runId: string; mode: string; reportJson: string; publishedAt: string }[] = [];
    const newest = () => {
      const full = rows.filter((x) => x.mode === "full").sort((x, y) => (x.publishedAt < y.publishedAt ? 1 : -1))[0];
      return full ? { runId: full.runId, reportJson: full.reportJson, publishedAt: full.publishedAt } : null;
    };
    let releaseA: () => void = () => {};
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let snapshotTaken: () => void = () => {};
    const aSnapshot = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    let aReads = 0;
    const store = (isA: boolean): PublishDb => ({
      async insertPublished(runId, mode, reportJson, at) {
        rows.push({ runId, mode, reportJson, publishedAt: at });
      },
      async readPublished(runId) {
        const r = rows.find((x) => x.runId === runId);
        return r ? { mode: r.mode, reportJson: r.reportJson, publishedAt: r.publishedAt } : null;
      },
      async latestFull() {
        if (!isA || aReads++ > 0) return newest();
        const stale = newest();
        snapshotTaken();
        await heldA;
        return stale;
      },
    });
    const root = temp();
    const a = publishRun({
      report: report({ id: "run-0000000a" }),
      db: store(true),
      root,
      now: () => new Date("2026-11-02T06:00:00.000Z"),
    });
    await aSnapshot;
    // B publishes while A holds the summary lock: its row lands at once, its write waits for the lock.
    const bPromise = publishRun({
      report: report({ id: "run-0000000b" }),
      db: store(false),
      root,
      now: () => new Date("2026-11-02T06:00:01.000Z"),
    });
    await new Promise((r) => setTimeout(r, 50));
    releaseA();
    const b = await bPromise;
    expect(b.code).toBe(0);
    expect((await a).code).toBe(0);
    // A wrote its stale read last, then checked the database again and wrote the latest: B's.
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-0000000b");
  });

  it("says accurately that the file may be stale when the recheck fails after a stale write, and repairs it (round 2)", async () => {
    const rows: { runId: string; mode: string; reportJson: string; publishedAt: string }[] = [];
    const newest = () => {
      const full = rows.filter((x) => x.mode === "full").sort((x, y) => (x.publishedAt < y.publishedAt ? 1 : -1))[0];
      return full ? { runId: full.runId, reportJson: full.reportJson, publishedAt: full.publishedAt } : null;
    };
    let releaseA: () => void = () => {};
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let snapshotTaken: () => void = () => {};
    const aSnapshot = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    let aReads = 0;
    const base = (): Omit<PublishDb, "latestFull"> => ({
      async insertPublished(runId, mode, reportJson, at) {
        rows.push({ runId, mode, reportJson, publishedAt: at });
      },
      async readPublished(runId) {
        const r = rows.find((x) => x.runId === runId);
        return r ? { mode: r.mode, reportJson: r.reportJson, publishedAt: r.publishedAt } : null;
      },
    });
    const dbA: PublishDb = {
      ...base(),
      async latestFull() {
        aReads++;
        if (aReads === 1) {
          const stale = newest();
          snapshotTaken();
          await heldA;
          return stale;
        }
        throw new Error("network outage");
      },
    };
    const dbB: PublishDb = { ...base(), latestFull: async () => newest() };
    const root = temp();
    const a = publishRun({
      report: report({ id: "run-0000000a" }),
      db: dbA,
      root,
      now: () => new Date("2026-11-02T06:00:00.000Z"),
    });
    await aSnapshot;
    // B inserts its row at once and waits for the summary lock A holds.
    const bPromise = publishRun({
      report: report({ id: "run-0000000b" }),
      db: dbB,
      root,
      now: () => new Date("2026-11-02T06:00:01.000Z"),
    });
    await new Promise((r) => setTimeout(r, 50));
    releaseA();
    const failed = await a;
    expect(failed.code).toBe(1);
    expect(failed.message).toMatch(/the file may hold an older run, so repair it with --republish-summary/);
    expect(failed.message).not.toMatch(/previous file stands/);
    // A's stale write is on disk when it fails; the writer that was waiting converges on the latest, B.
    expect((await bPromise).code).toBe(0);
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-0000000b");
    // And with no other writer, the repair command alone converges too.
    writeFileSync(join(root, SUMMARY_PATH), JSON.stringify(summaryOf(report({ id: "run-0000000a" }))));
    expect(await republishSummary({ db: dbB, root })).toMatchObject({ code: 0 });
    expect(parseResults(readFileSync(join(root, SUMMARY_PATH), "utf-8"), "f").runId).toBe("run-0000000b");
  });

  it("serialises the summary writers across processes by an owned lock file (round 2, round 3)", async () => {
    const root = temp();
    const file = join(root, SUMMARY_PATH);
    // Two writers never overlap.
    let inside = 0;
    let overlapped = false;
    const work = async () => {
      inside++;
      if (inside > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 20));
      inside--;
    };
    await Promise.all([withSummaryLock(file, work), withSummaryLock(file, work), withSummaryLock(file, work)]);
    expect(overlapped).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
    // The lock names its owner, and the release removes only the writer's own lock.
    await withSummaryLock(file, async () => {
      expect(readFileSync(`${file}.lock`, "utf-8")).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]{36}$`));
    });
    await withSummaryLock(file, async () => {
      // Another writer's lock replaces ours (as after a takeover): our release must leave it alone.
      writeFileSync(`${file}.lock`, `${process.pid}:someone-elses-token`);
    });
    expect(readFileSync(`${file}.lock`, "utf-8")).toBe(`${process.pid}:someone-elses-token`);
    // A lock held by a live process is never taken over, however old: the writer gives up, naming why.
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(`${file}.lock`, old, old);
    await expect(
      withSummaryLock(
        file,
        async () => 1,
        50,
        async () => {},
      ),
    ).rejects.toThrow(/another publication holds the summary lock/);
    expect(readFileSync(`${file}.lock`, "utf-8")).toBe(`${process.pid}:someone-elses-token`);
    // A lock whose process is gone is a dead writer's: taken over and released after the work.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(`${file}.lock`, `${dead.pid}:ghost`);
    expect(await withSummaryLock(file, async () => "done", 50)).toBe("done");
    expect(existsSync(`${file}.lock`)).toBe(false);
    // An empty lock (a writer that died between creating and naming it) is dead once a minute old, and not before.
    writeFileSync(`${file}.lock`, "");
    await expect(
      withSummaryLock(
        file,
        async () => 1,
        50,
        async () => {},
      ),
    ).rejects.toThrow(/another publication holds/);
    utimesSync(`${file}.lock`, old, old);
    expect(await withSummaryLock(file, async () => "again", 50)).toBe("again");
    // The lock is released when the work throws.
    await expect(
      withSummaryLock(file, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
