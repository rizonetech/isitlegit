// The evaluation's metrics (D08 T02 §2): every figure on a seeded run to exact numbers, the boundaries of each target,
// the denominators of what did not finish, the challenge set apart, and the command that prints them.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAIRS } from "../../eval/generate/challenge.ts";
import { computeMetrics, renderTable, runMetrics } from "../../eval/metrics.ts";
import type { ResultRow, RunRow } from "../../eval/run.ts";
import { type Outcome, type RunSample, selectSamples } from "../../eval/run-core.ts";

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
    // Time and cost medians come from the six measured cases only (the timeout has neither).
    expect(m.main.analysisMs).toEqual({ n: 6, median: 3500, p95: 6000 });
    expect(m.main.costUsd.n).toBe(6);
    expect(m.main.costUsd.median).toBeCloseTo(0.04);
    expect(m.main.costUsd.total).toBeCloseTo(0.28);
    expect(m.main.byCategory["credential-phishing"]).toMatchObject({ attacks: 4, detected: 2 });
    expect(m.main.byCategory["genuine-business"]).toMatchObject({ genuine: 3, measuredGenuine: 3, falsePositives: 1 });
    expect(m.unmeasured).toEqual([{ sample: "synthetic-sa/a4.eml", outcome: "timeout" }]);
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
    expect(empty.targets.filter((t) => t.state === "not measured")).toHaveLength(5);
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

  it("marks the forward-to-reply and walkthrough targets not measured, never met", () => {
    const m = go([], []);
    expect(m.targets.map((t) => t.state)).toEqual([
      "not measured",
      "not measured",
      "not measured",
      "not measured",
      "not measured",
    ]);
    expect(m.targets.at(-2)?.note).toMatch(/D09 T01 §1/);
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
});
