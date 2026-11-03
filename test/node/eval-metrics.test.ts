// The evaluation's metrics (D08 T02 §2): every figure on a seeded run to exact numbers, the boundaries of each target,
// the denominators of what did not finish, the challenge set apart, and the command that prints them.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAIRS } from "../../eval/generate/challenge.ts";
import { MAX_LABELS_BYTES } from "../../eval/load.ts";
import { computeMetrics, coverageMetrics, MAX_EXPORT_BYTES, renderTable, runMetrics } from "../../eval/metrics.ts";
import { publishProblems } from "../../eval/publish.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";
import {
  type BaselineManifest,
  hashFile,
  MAX_SAMPLE_BYTES,
  type ManifestEntry,
  type Outcome,
  type RunSample,
  selectSamples,
} from "../../eval/run-core.ts";

const ROOT = join(import.meta.dirname, "../..");
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "eval-metrics-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sample = (
  set: string,
  name: string,
  label: "attack" | "genuine",
  basis?: "checks" | "model",
  category = label === "attack" ? "credential-phishing" : "genuine-business",
): RunSample => ({
  id: `${set}/${name}`,
  set,
  path: name,
  file: `/nowhere/${name}`,
  label,
  category,
  basis: label === "attack" ? (basis ?? "checks") : undefined,
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
  caseId: outcome === "lost" ? null : `case-${id}`,
  outcome,
  label: "attack",
  category: "x",
  verdict,
  ms: outcome === "done" || outcome === "partial" ? 1000 : null,
  costUsd: 0.02,
  criticalFound: false,
  httpStatus: null,
  detail: null,
  ...over,
});
const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "run-00000001",
  commitSha: "abc1234",
  setVersion: "a".repeat(64),
  mode: "full",
  sets: ["synthetic-sa"],
  sampleLimit: null,
  status: "complete",
  selected: 0,
  capUsd: 5,
  startedAt: "2026-11-01T10:00:00.000Z",
  finishedAt: "2026-11-01T10:10:00.000Z",
  costUsd: 0,
  ...over,
});
const go = (samples: RunSample[], results: ResultRow[], over: Partial<RunRow> = {}) =>
  computeMetrics({ run: run({ selected: samples.length, ...over }), samples, results });

describe("the figures", () => {
  const samples = [
    sample("synthetic-sa", "a1.eml", "attack", "checks"),
    sample("synthetic-sa", "a2.eml", "attack", "model"),
    sample("synthetic-sa", "a3.eml", "attack", "model"),
    sample("synthetic-sa", "a4.eml", "attack", "checks"),
    sample("synthetic-sa", "g1.eml", "genuine"),
    sample("synthetic-sa", "g2.eml", "genuine"),
    sample("synthetic-sa", "g3.eml", "genuine"),
  ];
  const results = [
    row("synthetic-sa/a1.eml", "done", "suspicious", { ms: 1000, costUsd: 0.01 }),
    row("synthetic-sa/a2.eml", "done", "malicious", { ms: 3000, costUsd: 0.03 }),
    row("synthetic-sa/a3.eml", "done", "safe", { ms: 2000, costUsd: 0.02 }),
    row("synthetic-sa/a4.eml", "timeout", null, { costUsd: 0.04 }),
    row("synthetic-sa/g1.eml", "done", "safe", { label: "genuine", ms: 4000, costUsd: 0.05 }),
    row("synthetic-sa/g2.eml", "done", "suspicious", { label: "genuine", ms: 5000, costUsd: 0.06 }),
    row("synthetic-sa/g3.eml", "partial", null, { label: "genuine", ms: 6000, costUsd: 0.07 }),
  ];

  it("counts a detection by the verdict it has, a timeout attack as missed, and keeps every figure to its population", () => {
    const m = go(samples, results, { status: "incomplete" });
    expect(m.main.detection).toEqual({ n: 4, hits: 2, rate: 0.5 });
    // Three genuine samples were measured: one false positive; the partial case with no verdict is neither.
    expect(m.main.falsePositives).toEqual({ n: 3, hits: 1, rate: 1 / 3 });
    expect(m.main.modelBasis).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.main.checksBasis).toEqual({ n: 2, hits: 1, rate: 0.5 });
    // Time and cost medians come from the five measured cases only (the timeout has neither; the partial case with
    // no verdict keeps its costs in the total but not in a median).
    expect(m.main.analysisMs).toEqual({ n: 5, median: 3000, p95: 5000 });
    expect(m.main.costUsd.n).toBe(5);
    expect(m.main.costUsd.median).toBeCloseTo(0.03);
    expect(m.main.costUsd.total).toBeCloseTo(0.28);
    expect(m.main.byCategory["credential-phishing"]).toMatchObject({ attacks: 4, detected: 2 });
    expect(m.main.byCategory["genuine-business"]).toMatchObject({ genuine: 3, measuredGenuine: 2, falsePositives: 1 });
    expect(m.unmeasured).toEqual([
      { sample: "synthetic-sa/a4.eml", outcome: "timeout" },
      { sample: "synthetic-sa/g3.eml", outcome: "partial" },
    ]);
    expect(m.complete).toBe(false);
    expect(m.targets.filter((t) => t.state === "incomplete").map((t) => t.name)).toEqual([
      "detection",
      "false positives",
      "median cost per case",
    ]);
  });

  it("counts a partial genuine case by the verdict it has (G10)", () => {
    const g = [sample("synthetic-sa", "g1.eml", "genuine"), sample("synthetic-sa", "g2.eml", "genuine")];
    const m = go(g, [
      row("synthetic-sa/g1.eml", "partial", "suspicious", { label: "genuine" }),
      row("synthetic-sa/g2.eml", "partial", null, { label: "genuine" }),
    ]);
    expect(m.main.falsePositives).toEqual({ n: 2, hits: 1, rate: 0.5 });
  });

  it("keeps a terminal case with no verdict unmeasured, never complete or publishable (C2)", () => {
    const g = [sample("synthetic-sa", "g1.eml", "genuine"), sample("synthetic-sa", "g2.eml", "genuine")];
    const m = go(g, [
      row("synthetic-sa/g1.eml", "partial", "safe", { label: "genuine" }),
      row("synthetic-sa/g2.eml", "partial", null, { label: "genuine" }),
    ]);
    expect(m.unmeasured).toEqual([{ sample: "synthetic-sa/g2.eml", outcome: "partial" }]);
    expect(m.complete).toBe(false);
    expect(publishProblems(m)).not.toEqual([]);
  });

  it("keeps a sample with no stored row in its denominator, listed, and never calls the report complete", () => {
    const m = go(samples.slice(0, 2), [row("synthetic-sa/a1.eml", "done", "suspicious")]);
    expect(m.missing).toEqual(["synthetic-sa/a2.eml"]);
    expect(m.main.detection).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.complete).toBe(false);
    expect(m.targets.find((t) => t.name === "detection")?.state).toBe("incomplete");
    expect(renderTable(m)).toMatch(/INCOMPLETE \(1 missing/);
  });

  it("says not measured for a zero denominator, never 0% and never met", () => {
    const m = go([sample("synthetic-sa", "a1.eml", "attack")], [row("synthetic-sa/a1.eml", "done", "suspicious")]);
    expect(m.main.falsePositives).toEqual({ n: 0, hits: 0, rate: null });
    expect(m.targets.find((t) => t.name === "false positives")?.state).toBe("not measured");
    expect(m.main.modelBasis).toEqual({ n: 0, hits: 0, rate: null });
    const empty = go([], []);
    expect(empty.targets.filter((t) => t.state === "not measured")).toHaveLength(7);
    expect(empty.main.analysisMs).toEqual({ n: 0, median: null, p95: null });
  });

  it("meets a target exactly at its boundary and misses US$0.05 (exact numbers)", () => {
    // 20 attacks with 19 detected (95.0%), 50 genuine with 1 false positive (2.0%), every case costing exactly US$0.05.
    const a = Array.from({ length: 20 }, (_, i) => sample("synthetic-sa", `a${i}.eml`, "attack"));
    const g = Array.from({ length: 50 }, (_, i) => sample("synthetic-sa", `g${i}.eml`, "genuine"));
    const rows = [
      ...a.map((s, i) => row(s.id, "done", i === 0 ? "safe" : "suspicious", { costUsd: 0.05 })),
      ...g.map((s, i) => row(s.id, "done", i === 0 ? "suspicious" : "safe", { label: "genuine", costUsd: 0.05 })),
    ];
    const m = go([...a, ...g], rows);
    const state = (name: string) => m.targets.find((t) => t.name === name)?.state;
    expect(state("detection")).toBe("met");
    expect(state("false positives")).toBe("met");
    expect(state("median cost per case")).toBe("missed");
    // One more miss, one more false positive, and a cheaper median flip each.
    const worse = go(
      [...a, ...g],
      [
        ...a.map((s, i) => row(s.id, "done", i < 2 ? "safe" : "suspicious", { costUsd: 0.049 })),
        ...g.map((s, i) => row(s.id, "done", i < 2 ? "suspicious" : "safe", { label: "genuine", costUsd: 0.049 })),
      ],
    );
    expect(worse.targets.find((t) => t.name === "detection")?.state).toBe("missed");
    expect(worse.targets.find((t) => t.name === "false positives")?.state).toBe("missed");
    expect(worse.targets.find((t) => t.name === "median cost per case")?.state).toBe("met");
  });

  it("marks every target a run cannot measure not measured, naming its owner, never met", () => {
    const m = go([], []);
    expect(m.targets.map((t) => t.state)).toEqual(Array(7).fill("not measured"));
    const note = (name: string) => m.targets.find((t) => t.name.startsWith(name))?.note;
    expect(note("forward-to-reply")).toMatch(/D09 T01 §1/);
    expect(note("median cost with a walkthrough")).toMatch(/D08 T02 §8/);
    expect(note("reputation providers")).toMatch(/D08 T02 §8/);
    expect(note("checks-only")).toMatch(/D08 T02 §3/);
    expect(renderTable(m)).toMatch(/reputation providers' false-positive rates: not measured/);
  });

  it("keeps a genuine sample that did not finish, or has no row, in the false-positive denominator (G4)", () => {
    const g = ["g1", "g2", "g3"].map((n) => sample("synthetic-sa", `${n}.eml`, "genuine"));
    const m = go(g, [
      row("synthetic-sa/g1.eml", "done", "suspicious", { label: "genuine" }),
      row("synthetic-sa/g2.eml", "timeout", null, { label: "genuine" }),
    ]);
    expect(m.main.falsePositives).toEqual({ n: 3, hits: 1, rate: 1 / 3 });
    expect(m.main.measuredGenuine).toBe(1);
    expect(m.complete).toBe(false);
    // The same for the challenge set.
    const c = [
      sample("synthetic-challenge", `${PAIRS[0]?.control}.eml`, "genuine"),
      sample("synthetic-challenge", `${PAIRS[1]?.control}.eml`, "genuine"),
    ];
    const mc = go(c, [row(c[0]?.id as string, "done", "suspicious", { label: "genuine" })]);
    expect(mc.challenge?.falsePositives).toEqual({ n: 2, hits: 1, rate: 0.5 });
  });

  it("writes each figure in the unit of its threshold, and keeps the numbers numeric in the JSON (E2)", () => {
    const a = Array.from({ length: 20 }, (_, i) => sample("synthetic-sa", `a${i}.eml`, "attack"));
    const g = Array.from({ length: 50 }, (_, i) => sample("synthetic-sa", `g${i}.eml`, "genuine"));
    const m = go(
      [...a, ...g],
      [
        ...a.map((s, i) => row(s.id, "done", i === 0 ? "safe" : "suspicious", { costUsd: 0.05 })),
        ...g.map((s, i) => row(s.id, "done", i === 0 ? "suspicious" : "safe", { label: "genuine", costUsd: 0.05 })),
      ],
    );
    const t = (name: string) => m.targets.find((x) => x.name === name);
    expect([t("detection")?.figureText, t("detection")?.threshold]).toEqual(["95.0%", "at least 95.0%"]);
    expect([t("false positives")?.figureText, t("false positives")?.threshold]).toEqual(["2.0%", "at most 2.0%"]);
    expect([t("median cost per case")?.figureText, t("median cost per case")?.threshold]).toEqual([
      "US$0.0500",
      "under US$0.0500",
    ]);
    expect(t("detection")?.figure).toBe(0.95);
    expect(renderTable(m)).toMatch(/detection: met \(figure 95\.0%, target at least 95\.0%, over 20\)/);
  });

  it("takes the median of an even count as the mean of the middle two and the p95 by nearest rank", () => {
    const s = Array.from({ length: 4 }, (_, i) => sample("synthetic-sa", `a${i}.eml`, "attack"));
    const m = go(
      s,
      s.map((x, i) => row(x.id, "done", "suspicious", { ms: [100, 200, 300, 400][i] as number })),
    );
    expect(m.main.analysisMs).toEqual({ n: 4, median: 250, p95: 400 });
    // Twenty cases of 1..20 ms: the 19th by rank is the p95, the median is the mean of the 10th and 11th.
    const twenty = Array.from({ length: 20 }, (_, i) => sample("synthetic-sa", `t${i}.eml`, "attack"));
    const spreadOf = go(
      twenty,
      twenty.map((x, i) => row(x.id, "done", "suspicious", { ms: i + 1 })),
    );
    expect(spreadOf.main.analysisMs).toEqual({ n: 20, median: 10.5, p95: 19 });
  });
});

describe("the component capture", () => {
  it("reports provider false positives and the walkthrough median from captured results", () => {
    const samples = [sample("synthetic-sa", "g1.eml", "genuine"), sample("synthetic-sa", "a1.eml", "attack")];
    const results = [
      row("synthetic-sa/g1.eml", "done", "suspicious", {
        label: "genuine",
        providers: [{ provider: "google-web-risk", checked: true, listed: true }],
        walkthrough: true,
        costUsd: 0.2,
      }),
      row("synthetic-sa/a1.eml", "done", "safe", { providers: [], walkthrough: false, costUsd: 0.01 }),
    ];
    const report = computeMetrics({ run: run({ selected: 2 }), samples, results });
    expect(report.components.providers).toEqual([
      { provider: "google-web-risk", checked: 1, unchecked: 0, genuineChecked: 1, falsePositiveRate: 1 },
    ]);
    expect(report.components.walkthroughCompleted).toBe(1);
    expect(report.components.walkthroughMedianCostUsd).toBe(0.2);
    const bare = computeMetrics({
      run: run({ selected: 2 }),
      samples,
      results: results.map((r) => ({ ...r, providers: undefined, walkthrough: undefined })),
    });
    expect(bare.components.providers).toEqual([]);
    expect(bare.components.walkthroughMedianCostUsd).toBeNull();
  });
});

describe("the challenge set", () => {
  const id = (name: string) => `synthetic-challenge/${name}.eml`;
  const [p0, p1, p2] = PAIRS;
  const sel = [
    sample("synthetic-sa", "a1.eml", "attack"),
    sample("synthetic-sa", "g1.eml", "genuine"),
    sample("synthetic-challenge", `${p0?.attack}.eml`, "attack", "model"),
    sample("synthetic-challenge", `${p0?.control}.eml`, "genuine"),
    sample("synthetic-challenge", `${p1?.attack}.eml`, "attack", "model"),
    sample("synthetic-challenge", `${p1?.control}.eml`, "genuine"),
    sample("synthetic-challenge", `${p2?.attack}.eml`, "attack", "model"),
    sample("synthetic-challenge", `${p2?.control}.eml`, "genuine"),
  ];
  const rows = [
    row("synthetic-sa/a1.eml", "done", "suspicious"),
    row("synthetic-sa/g1.eml", "done", "safe", { label: "genuine" }),
    // Pair 0: both right. Pair 1: the control is a partial case with no verdict. Pair 2: the attack row is missing.
    row(id(p0?.attack as string).replace(".eml", ".eml"), "done", "malicious"),
    row(id(p0?.control as string), "done", "safe", { label: "genuine" }),
    row(id(p1?.attack as string), "done", "suspicious"),
    row(id(p1?.control as string), "partial", null, { label: "genuine" }),
    row(id(p2?.control as string), "done", "safe", { label: "genuine" }),
  ];

  it("scores the challenge set on its own, never pooled, with the pairs both right", () => {
    const m = go(sel, rows);
    // The main figures hold only the main sets' two samples.
    expect(m.main.attacks).toBe(1);
    expect(m.main.genuine).toBe(1);
    expect(m.main.detection).toEqual({ n: 1, hits: 1, rate: 1 });
    expect(m.main.falsePositives).toEqual({ n: 1, hits: 0, rate: 0 });
    // The challenge figures hold the six challenge samples, with their own denominators.
    expect(m.challenge?.attacks).toBe(3);
    expect(m.challenge?.detection).toEqual({ n: 3, hits: 2, rate: 2 / 3 });
    expect(m.challenge?.falsePositives).toEqual({ n: 3, hits: 0, rate: 0 });
    expect(m.challenge?.modelBasis).toEqual({ n: 3, hits: 2, rate: 2 / 3 });
    // A pair with a partial control with no verdict, or a missing member, is not both right; 27 are not selected.
    expect(m.challenge?.pairs).toEqual({ total: 30, evaluated: 3, notEvaluated: 27, bothRight: 1 });
    expect(m.missing).toEqual([id(p2?.attack as string)]);
  });

  it("fails a challenge sample counted in a main figure and a main sample in a challenge one", () => {
    const m = go(sel, rows);
    const mainOnly = go(sel.slice(0, 2), rows.slice(0, 2));
    expect(m.main).toEqual(mainOnly.main);
    const challengeOnly = go(sel.slice(2), rows.slice(2));
    expect(m.challenge?.detection).toEqual(challengeOnly.challenge?.detection);
    expect(challengeOnly.main.attacks + challengeOnly.main.genuine).toBe(0);
    expect(renderTable(m)).toMatch(/challenge set \(scored on its own\)/);
  });

  it("reports a model-basis attack verdicted safe as missed and one with no cited evidence as detected", () => {
    const s = [
      sample("synthetic-sa", "m1.eml", "attack", "model"),
      sample("synthetic-sa", "m2.eml", "attack", "model"),
    ];
    const m = go(s, [
      row(s[0]?.id as string, "done", "safe", { criticalFound: false }),
      row(s[1]?.id as string, "done", "suspicious", { criticalFound: false }),
    ]);
    expect(m.main.modelBasis).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.main.checksBasis).toEqual({ n: 0, hits: 0, rate: null });
  });
});

describe("the command", () => {
  function sets() {
    const root = temp();
    const set = join(root, "eval/sets/synthetic-sa");
    mkdirSync(set, { recursive: true });
    const labels = [
      { path: "a1.eml", label: "attack", category: "credential-phishing", expected: [], source: "x", basis: "model" },
      { path: "g1.eml", label: "genuine", category: "genuine-business", expected: [], source: "x" },
    ];
    writeFileSync(join(set, "a1.eml"), "attack one");
    writeFileSync(join(set, "g1.eml"), "genuine one");
    writeFileSync(join(set, "labels.json"), JSON.stringify(labels));
    return { root, set, labels };
  }
  function stored(root: string, over: Partial<RunRow> = {}) {
    const { samples, setVersion } = selectSamples(join(root, "eval/sets"), ["synthetic-sa"], null);
    const r = run({ setVersion, selected: samples.length, ...over });
    const results = [
      row("synthetic-sa/a1.eml", "done", "malicious", { ms: 1500 }),
      row("synthetic-sa/g1.eml", "done", "safe", { label: "genuine", ms: 500 }),
    ];
    return { r, results };
  }
  const db = (v: { run: RunRow; results: ResultRow[] } | null | Error) => ({
    readRun: async () => {
      if (v instanceof Error) throw v;
      return v;
    },
  });

  it("prints the table, and the same figures as parseable JSON with nothing else on stdout or stderr", async () => {
    const { root } = sets();
    const { r, results } = stored(root);
    const table = await runMetrics({ argv: ["--run", "run-00000001"], db: db({ run: r, results }), root });
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/report: complete/);
    expect(table.stdout).toMatch(/detection 100.0% \(1 of 1\)/);
    expect(table.stderr).toBe("");
    const json = await runMetrics({ argv: ["--run", "run-00000001", "--json"], db: db({ run: r, results }), root });
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout);
    expect(parsed.main.detection).toEqual({ n: 1, hits: 1, rate: 1 });
    expect(parsed.run).toMatchObject({ id: "run-00000001", commit: "abc1234", status: "complete", selected: 2 });
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.map((t: { state: string }) => t.state)).toContain("met");
  });

  it("refuses with exit 3, naming the cause: no run, a bad option, a changed label, changed bytes, malformed labels", async () => {
    const { root, set, labels } = sets();
    const { r, results } = stored(root);
    const refused = async (argv: string[], v: { run: RunRow; results: ResultRow[] } | null) =>
      runMetrics({ argv, db: db(v), root });
    expect((await refused(["--run", "run-00000001"], null)).stderr).toMatch(/no run run-00000001/);
    expect((await refused([], { run: r, results })).stderr).toMatch(/--run is required/);
    expect((await refused(["--run", "x"], { run: r, results })).code).toBe(3);
    expect((await refused(["--bogus"], { run: r, results })).stderr).toMatch(/unknown option/);
    // A label changed under an unchanged filename.
    writeFileSync(
      join(set, "labels.json"),
      JSON.stringify(
        labels.map((l) => (l.path === "a1.eml" ? { ...l, basis: undefined, expected: ["attachment.macro"] } : l)),
      ),
    );
    const changedLabel = await refused(["--run", "run-00000001"], { run: r, results });
    expect(changedLabel).toMatchObject({ code: 3, stdout: "" });
    expect(changedLabel.stderr).toMatch(/no longer match run run-00000001/);
    // Restored labels, changed bytes under an unchanged filename.
    writeFileSync(join(set, "labels.json"), JSON.stringify(labels));
    writeFileSync(join(set, "a1.eml"), "attack one, edited");
    expect((await refused(["--run", "run-00000001"], { run: r, results })).stderr).toMatch(/no longer match/);
    writeFileSync(join(set, "a1.eml"), "attack one");
    // Malformed labels.
    writeFileSync(join(set, "labels.json"), "{ not json");
    const malformed = await refused(["--run", "run-00000001"], { run: r, results });
    expect(malformed.code).toBe(3);
    expect(malformed.stderr).toMatch(/the sets cannot be read/);
  });

  it("exits 1 on a database fault", async () => {
    const { root } = sets();
    const out = await runMetrics({ argv: ["--run", "run-00000001"], db: db(new Error("d1 down")), root });
    expect(out).toMatchObject({ code: 1, stdout: "" });
    expect(out.stderr).toMatch(/the run could not be read: d1 down/);
  });

  it("runs through the package command: usage with --help, a refusal (exit 3) with no run", () => {
    const run2 = (args: string[]) => {
      try {
        return {
          code: 0,
          out: execFileSync("pnpm", ["eval:metrics", ...args], {
            cwd: ROOT,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        };
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
      }
    };
    expect(run2(["--help"])).toMatchObject({ code: 0 });
    expect(run2(["--help"]).out).toMatch(/usage: pnpm eval:metrics/);
    expect(run2([]).code).toBe(3);
    expect(run2([]).out).toMatch(/--run is required/);
  });

  it("prints a seeded report through the real package command, as a table and as parseable JSON, and refuses through it (exit 3)", () => {
    const { root, set, labels } = sets();
    const { r, results } = stored(root);
    const file = join(root, "run.json");
    writeFileSync(file, JSON.stringify({ run: r, results }));
    const sync = (args: string[]) => {
      const res = spawnSync("pnpm", ["eval:metrics", ...args], { cwd: ROOT, encoding: "utf-8" });
      return { code: res.status, out: res.stdout, err: res.stderr };
    };
    const base = ["--run", "run-00000001", "--from", file, "--sets", join(root, "eval/sets")];
    const table = sync(base);
    expect(table.code).toBe(0);
    expect(table.out).toMatch(/report: complete/);
    expect(table.out).toMatch(/detection: met|detection: not measured|detection: missed/);
    expect(table.out).toMatch(/detection 100\.0% \(1 of 1\)/);
    const json = sync([...base, "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out.slice(json.out.indexOf("{")));
    expect(parsed.main.detection).toEqual({ n: 1, hits: 1, rate: 1 });
    expect(parsed.targets[0]).toMatchObject({ name: "detection", figure: 1, figureText: "100.0%" });
    // Refusals through the command: a run the file does not hold, a missing file, a changed label.
    const other = sync(["--run", "run-99999999", "--from", file, "--sets", join(root, "eval/sets")]);
    expect(other.code).toBe(3);
    expect(other.err).toMatch(/holds run run-00000001, not run-99999999/);
    expect(sync(["--run", "run-00000001", "--from", join(root, "missing.json")]).err).toMatch(/cannot be read/);
    writeFileSync(
      join(set, "labels.json"),
      JSON.stringify(labels.map((l) => ({ ...l, category: l.label === "attack" ? "voice-lure" : l.category }))),
    );
    const changed = sync(base);
    expect(changed.code).toBe(3);
    expect(changed.err).toMatch(/no longer match/);
  });

  it("refuses a damaged or foreign export cleanly, exit 3, and never scores it (round 1)", async () => {
    const { root } = sets();
    const { r, results } = stored(root);
    const file = join(root, "export.json");
    const via = async (value: unknown) => {
      writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
      return runMetrics({ argv: ["--run", "run-00000001", "--from", file], root });
    };
    const refused = async (value: unknown, pattern: RegExp) => {
      const out = await via(value);
      expect(out, JSON.stringify(value).slice(0, 80)).toMatchObject({ code: 3, stdout: "" });
      expect(out.stderr).toMatch(pattern);
    };
    const ok = await via({ run: r, results });
    expect(ok.code).toBe(0);
    await refused({ run: r, results: [{ ...results[0], costUsd: -1, ms: -100 }, results[1]] }, /not a stored run/);
    await refused(
      { run: r, results: [{ ...results[0], runId: "run-77777777" }, results[1]] },
      /belongs to run run-77777777/,
    );
    await refused({ run: r, results: [results[0], results[0]] }, /stored twice/);
    // A stored selected count that the stored selection does not reconstruct to.
    await refused(
      { run: { ...r, selected: 100 }, results },
      /selected 100 samples, its stored selection reconstructs to 2/,
    );
    // Costs and times past any bound cannot overflow a total.
    await refused({ run: r, results: results.map((x) => ({ ...x, costUsd: 1e308 })) }, /not a stored run/);
    await refused({ run: r, results: results.map((x) => ({ ...x, ms: 1e12 })) }, /not a stored run/);
    await refused({ run: { ...r, sets: [] }, results }, /not a stored run/);
    await refused({ run: { ...r, status: "fine" }, results }, /not a stored run/);
    await refused({ run: r, results: [{ ...results[0], extra: 1 }, results[1]] }, /not a stored run/);
    await refused(
      { run: r, results: [{ ...results[0], sample: "synthetic-sa/elsewhere.eml" }, results[1]] },
      /not in the run's selection/,
    );
    await refused({ run: { ...r, id: "run-99999999" }, results }, /holds run run-99999999, not run-00000001/);
    await refused("not json {", /cannot be read/);
    await refused(["not", "a", "run"], /not a stored run/);
    // Bounded reads: a directory is not a regular file, and a file past the bound is refused unread.
    const dir = await runMetrics({ argv: ["--run", "run-00000001", "--from", root], root });
    expect(dir).toMatchObject({ code: 3 });
    expect(dir.stderr).toMatch(/not a regular file/);
    writeFileSync(file, "x".repeat(MAX_EXPORT_BYTES + 1));
    const big = await runMetrics({ argv: ["--run", "run-00000001", "--from", file], root });
    expect(big.code).toBe(3);
    expect(big.stderr).toMatch(/larger than/);
  });

  it("accepts the component fields a section 8 run stores (providers, walkthrough)", async () => {
    const { root } = sets();
    const { r, results } = stored(root);
    const file = join(root, "components.json");
    const withComponents = results.map((x, i) =>
      i === 0
        ? { ...x, providers: [{ provider: "spamhaus", checked: true, listed: false }], walkthrough: true }
        : { ...x, walkthrough: null },
    );
    writeFileSync(file, JSON.stringify({ run: r, results: withComponents }));
    const out = await runMetrics({ argv: ["--run", "run-00000001", "--from", file], root });
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/report: complete/);
  });

  it("bounds the reads of --sets: an oversized labels file or sample is refused before it is read whole (round 3)", async () => {
    const { root, set } = sets();
    const { r, results } = stored(root);
    const file = join(root, "run.json");
    writeFileSync(file, JSON.stringify({ run: r, results }));
    const go2 = () =>
      runMetrics({ argv: ["--run", "run-00000001", "--from", file, "--sets", join(root, "eval/sets")], root });
    expect((await go2()).code).toBe(0);
    // A sample past the bound (a sparse file: no memory or disk is spent on it).
    const big = join(set, "a1.eml");
    truncateSync(big, MAX_SAMPLE_BYTES + 1);
    const sample = await go2();
    expect(sample.code).toBe(3);
    expect(sample.stderr).toMatch(/larger than/);
    writeFileSync(big, "attack one");
    // A labels file past the bound.
    const labelsFile = join(set, "labels.json");
    const original = readFileSync(labelsFile);
    truncateSync(labelsFile, MAX_LABELS_BYTES + 1);
    const labels = await go2();
    expect(labels.code).toBe(3);
    expect(labels.stderr).toMatch(/labels\.json is larger than/);
    writeFileSync(labelsFile, original);
    expect((await go2()).code).toBe(0);
    expect(hashFile(big, 100)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => hashFile(big, 5)).toThrow(/larger than 5 bytes/);
  });
});

describe("the coverage metrics from a baseline manifest", () => {
  const entry = (
    sampleId: string,
    outcome: Outcome,
    verdict: ResultRow["verdict"],
    over: Partial<ManifestEntry> = {},
  ): ManifestEntry => ({
    sample: sampleId,
    set: sampleId.slice(0, sampleId.indexOf("/")),
    runId: "run-1",
    deployment: "abc123",
    outcome,
    verdict,
    ms: 1000,
    costUsd: 0.02,
    ...over,
  });
  it("scores pooled denominators with no double count, challenge apart", () => {
    const samples = [
      sample("synthetic-sa", "a1.eml", "attack"),
      sample("synthetic-sa", "g1.eml", "genuine"),
      sample("synthetic-sa", "a2.eml", "attack"),
      sample("synthetic-challenge", "c1.eml", "attack"),
    ];
    const manifest: BaselineManifest = {
      id: "base-1",
      sets: ["synthetic-sa", "synthetic-challenge"],
      setVersions: { "synthetic-sa": "v1", "synthetic-challenge": "v2" },
      deployment: "abc123",
      caps: { "synthetic-sa": 13, "synthetic-challenge": 5 },
      expected: samples.map((s) => s.id),
      entries: [
        entry("synthetic-sa/a1.eml", "done", "suspicious"),
        entry("synthetic-sa/g1.eml", "done", "safe"),
        entry("synthetic-sa/a2.eml", "partial", null),
        entry("synthetic-challenge/c1.eml", "done", "malicious"),
      ],
      unmeasured: ["synthetic-sa/a2.eml"],
    };
    const c = coverageMetrics(manifest, samples);
    expect(c.main.detection).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(c.main.falsePositives).toEqual({ n: 1, hits: 0, rate: 0 });
    expect(c.unmeasured).toEqual(["synthetic-sa/a2.eml"]);
    expect(c.challenge?.detection).toEqual({ n: 1, hits: 1, rate: 1 });
    expect(c.pooled).toBe(0);
  });
  it("counts a hand-pooled repeat once, and a null verdict never counts", () => {
    const samples = [sample("nazario-2025", "p1.eml", "attack", "model"), sample("nazario-2025", "p2.eml", "attack")];
    const manifest: BaselineManifest = {
      id: "base-2",
      sets: ["nazario-2025"],
      setVersions: { "nazario-2025": "v3" },
      deployment: "abc123",
      caps: { "nazario-2025": 5 },
      expected: ["nazario-2025/p1.eml", "nazario-2025/p2.eml"],
      entries: [
        entry("nazario-2025/p1.eml", "stale-repeat", null, { runId: "run-2", pooledFrom: "run-1" }),
        entry("nazario-2025/p1.eml", "done", "suspicious", { runId: "run-1" }),
        entry("nazario-2025/p2.eml", "partial", null),
      ],
      unmeasured: ["nazario-2025/p2.eml"],
    };
    const c = coverageMetrics(manifest, samples);
    expect(c.main.detection).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(c.pooled).toBe(1);
    expect(c.bySample["nazario-2025/p1.eml"]?.outcome).toBe("done");
    expect(c.bySample["nazario-2025/p2.eml"]?.outcome).toBe("partial");
  });
});
