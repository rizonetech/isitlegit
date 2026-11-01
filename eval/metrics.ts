// The evaluation's metrics (D08 T02 §2): a pure function of what a run stored (`eval_results`, D08 T02 §1) joined to the
// sets' own labels, and the command that prints them (`pnpm eval:metrics --run <id> [--json]`).
//
// Rules the figures keep:
// - A selected sample with no stored result is `missing`, listed, and kept in its denominator: a missing attack is a
//   miss. A report is `complete` only when the run is complete and every selected sample has a result; a target is
//   `met` or `missed` only on a complete report, else `incomplete`.
// - Each figure names its eligible population: detection over every selected attack, false positives over every
//   selected genuine sample (one that did not finish stays in the denominator and the report is incomplete; the measured
//   coverage is reported apart), time and cost medians over `done` and `partial` rows only. A zero denominator is `not measured`, never 0% and never met.
// - A case counts by the verdict it has: suspicious or malicious on an attack is a detection, on genuine mail a false
//   positive; a `partial` case with no verdict is neither.
// - The challenge set (`synthetic-challenge`) is scored on its own and never enters a main figure.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PAIRS } from "./generate/challenge.ts";
import { SetRefused } from "./load.ts";
import type { Db, ResultRow, RunRow } from "./run.ts";
import { liveDb } from "./run.ts";
import { isTerminal, type RunSample, selectSamples } from "./run-core.ts";

export const CHALLENGE = "synthetic-challenge";

// The spec's targets (design spec 4.9) as constants.
export const TARGETS = {
  detectionAtLeast: 0.95,
  falsePositivesAtMost: 0.02,
  medianCostUnderUsd: 0.05,
} as const;

export type TargetState = "met" | "missed" | "not measured" | "incomplete";
export type Rate = { n: number; hits: number; rate: number | null };
export type Spread = { n: number; median: number | null; p95: number | null };
export type Population = {
  attacks: number;
  genuine: number;
  measuredGenuine: number;
  detection: Rate;
  falsePositives: Rate;
  byCategory: Record<
    string,
    { attacks: number; detected: number; genuine: number; measuredGenuine: number; falsePositives: number }
  >;
  modelBasis: Rate;
  checksBasis: Rate;
  analysisMs: Spread;
  costUsd: { n: number; median: number | null; total: number };
};
export type Target = {
  name: string;
  figure: number | null;
  // The figure in the unit of its threshold (95.0%, US$0.0500), for the table.
  figureText: string;
  threshold: string;
  denominator: number;
  state: TargetState;
  note?: string;
};
export type Pairs = { total: number; evaluated: number; notEvaluated: number; bothRight: number };
export type Report = {
  run: { id: string; commit: string; setVersion: string; status: string; selected: number; stored: number };
  complete: boolean;
  missing: string[];
  unmeasured: { sample: string; outcome: string }[];
  main: Population;
  challenge: (Population & { pairs: Pairs }) | null;
  targets: Target[];
};

const rate = (hits: number, n: number): Rate => ({ n, hits, rate: n === 0 ? null : hits / n });
const flagged = (v: string | null) => v === "suspicious" || v === "malicious";

// The median (the mean of the two middle values for an even count) and the nearest-rank p95.
function spread(values: number[]): Spread {
  if (values.length === 0) return { n: 0, median: null, p95: null };
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  const median = v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
  return { n: v.length, median, p95: v[Math.ceil(0.95 * v.length) - 1] as number };
}

function population(samples: RunSample[], rows: Map<string, ResultRow>): Population {
  let detected = 0;
  let falsePositives = 0;
  let measuredGenuine = 0;
  const bases = { model: [0, 0], checks: [0, 0] } as Record<"model" | "checks", [number, number]>;
  const byCategory: Population["byCategory"] = {};
  const ms: number[] = [];
  const costs: number[] = [];
  let total = 0;
  for (const s of samples) {
    const row = rows.get(s.id);
    const measured = row !== undefined && isTerminal(row.outcome);
    byCategory[s.category] ??= {
      attacks: 0,
      detected: 0,
      genuine: 0,
      measuredGenuine: 0,
      falsePositives: 0,
    };
    const cat = byCategory[s.category] as Population["byCategory"][string];
    if (row) total += row.costUsd;
    if (measured && row) {
      if (row.ms !== null) ms.push(row.ms);
      costs.push(row.costUsd);
    }
    if (s.label === "attack") {
      const hit = measured && flagged(row?.verdict ?? null);
      cat.attacks++;
      if (hit) {
        detected++;
        cat.detected++;
      }
      const basis = s.basis === "model" ? "model" : "checks";
      bases[basis][0] += hit ? 1 : 0;
      bases[basis][1]++;
    } else {
      cat.genuine++;
      if (measured) {
        measuredGenuine++;
        cat.measuredGenuine++;
        if (flagged(row?.verdict ?? null)) {
          falsePositives++;
          cat.falsePositives++;
        }
      }
    }
  }
  const attacks = samples.filter((s) => s.label === "attack").length;
  return {
    attacks,
    genuine: samples.length - attacks,
    measuredGenuine,
    detection: rate(detected, attacks),
    // Over every selected genuine sample: one that did not finish stays in the denominator (the report says so as
    // incomplete), and `measuredGenuine` keeps the coverage apart.
    falsePositives: rate(falsePositives, samples.length - attacks),
    byCategory,
    modelBasis: rate(bases.model[0], bases.model[1]),
    checksBasis: rate(bases.checks[0], bases.checks[1]),
    analysisMs: spread(ms),
    costUsd: { n: costs.length, median: spread(costs).median, total },
  };
}

function pairs(selected: Map<string, RunSample>, rows: Map<string, ResultRow>): Pairs {
  let evaluated = 0;
  let notEvaluated = 0;
  let bothRight = 0;
  for (const p of PAIRS) {
    const a = `${CHALLENGE}/${p.attack}.eml`;
    const c = `${CHALLENGE}/${p.control}.eml`;
    if (!selected.has(a) || !selected.has(c)) {
      notEvaluated++;
      continue;
    }
    evaluated++;
    const ra = rows.get(a);
    const rc = rows.get(c);
    const attackRight = ra !== undefined && isTerminal(ra.outcome) && flagged(ra.verdict);
    const controlRight = rc !== undefined && isTerminal(rc.outcome) && rc.verdict === "safe";
    if (attackRight && controlRight) bothRight++;
  }
  return { total: PAIRS.length, evaluated, notEvaluated, bothRight };
}

// The metrics of a stored run: `samples` are those the run selected (its stored selection, reproduced), `results` what
// it stored.
export function computeMetrics(args: { run: RunRow; samples: RunSample[]; results: ResultRow[] }): Report {
  const { run, samples, results } = args;
  const rows = new Map(results.map((r) => [r.sample, r]));
  const selected = new Map(samples.map((s) => [s.id, s]));
  const missing = samples.filter((s) => !rows.has(s.id)).map((s) => s.id);
  const unmeasured = results
    .filter((r) => !isTerminal(r.outcome) && selected.has(r.sample))
    .map((r) => ({ sample: r.sample, outcome: r.outcome }));
  const complete = run.status === "complete" && missing.length === 0 && unmeasured.length === 0;
  const main = population(
    samples.filter((s) => s.set !== CHALLENGE),
    rows,
  );
  const challengeSamples = samples.filter((s) => s.set === CHALLENGE);
  const challenge = challengeSamples.length
    ? { ...population(challengeSamples, rows), pairs: pairs(selected, rows) }
    : null;

  const state = (n: number, ok: boolean): TargetState =>
    n === 0 ? "not measured" : !complete ? "incomplete" : ok ? "met" : "missed";
  const pctText = (v: number | null) => (v === null ? "not measured" : `${(v * 100).toFixed(1)}%`);
  const usdText = (v: number | null) => (v === null ? "not measured" : `US$${v.toFixed(4)}`);
  const notMeasured = (name: string, threshold: string, note: string): Target => ({
    name,
    figure: null,
    figureText: "not measured",
    threshold,
    denominator: 0,
    state: "not measured",
    note,
  });
  const targets: Target[] = [
    {
      name: "detection",
      figure: main.detection.rate,
      figureText: pctText(main.detection.rate),
      threshold: `at least ${(TARGETS.detectionAtLeast * 100).toFixed(1)}%`,
      denominator: main.detection.n,
      state: state(main.detection.n, (main.detection.rate ?? 0) >= TARGETS.detectionAtLeast),
    },
    {
      name: "false positives",
      figure: main.falsePositives.rate,
      figureText: pctText(main.falsePositives.rate),
      threshold: `at most ${(TARGETS.falsePositivesAtMost * 100).toFixed(1)}%`,
      denominator: main.falsePositives.n,
      state: state(main.falsePositives.n, (main.falsePositives.rate ?? 1) <= TARGETS.falsePositivesAtMost),
    },
    {
      name: "median cost per case",
      figure: main.costUsd.median,
      figureText: usdText(main.costUsd.median),
      threshold: `under ${usdText(TARGETS.medianCostUnderUsd)}`,
      denominator: main.costUsd.n,
      state: state(main.costUsd.n, (main.costUsd.median ?? Number.POSITIVE_INFINITY) < TARGETS.medianCostUnderUsd),
    },
    notMeasured(
      "forward-to-reply time",
      "median under 60 s, p95 under 180 s",
      "the analysis time is reported above; the forward-to-reply time is measured by the live mail run (D09 T01 §1)",
    ),
    notMeasured(
      "median cost with a walkthrough",
      `under ${usdText(0.25)}`,
      "needs each case's walkthrough use (D08 T02 §8)",
    ),
    notMeasured(
      "reputation providers' false-positive rates",
      "reported per provider",
      "needs each case's provider listings (D08 T02 §8)",
    ),
    notMeasured(
      "checks-only against model-enabled detection",
      "reported side by side",
      "needs the ablation runs (D08 T02 §3)",
    ),
  ];
  return {
    run: {
      id: run.id,
      commit: run.commitSha,
      setVersion: run.setVersion,
      status: run.status,
      selected: run.selected,
      stored: results.length,
    },
    complete,
    missing,
    unmeasured,
    main,
    challenge,
    targets,
  };
}

// ---- the table ------------------------------------------------------------------------------------------------------------

const pct = (r: Rate) => (r.rate === null ? "not measured" : `${(r.rate * 100).toFixed(1)}% (${r.hits} of ${r.n})`);
const num = (v: number | null, digits = 0) => (v === null ? "not measured" : v.toFixed(digits));

function populationLines(label: string, p: Population): string[] {
  const lines = [
    `${label}: ${p.attacks} attacks, ${p.genuine} genuine (${p.measuredGenuine} measured)`,
    `  detection ${pct(p.detection)}`,
    `  false positives ${pct(p.falsePositives)}`,
    `  detection by basis: model ${pct(p.modelBasis)}, checks ${pct(p.checksBasis)}`,
    `  analysis time: median ${num(p.analysisMs.median)} ms, p95 ${num(p.analysisMs.p95)} ms over ${p.analysisMs.n} cases`,
    `  cost: median US$${num(p.costUsd.median, 4)} over ${p.costUsd.n} cases, total US$${p.costUsd.total.toFixed(4)}`,
  ];
  for (const [category, c] of Object.entries(p.byCategory).sort()) {
    lines.push(
      c.attacks
        ? `  ${category}: ${c.detected} of ${c.attacks} detected`
        : `  ${category}: ${c.falsePositives} false positives in ${c.measuredGenuine} measured of ${c.genuine}`,
    );
  }
  return lines;
}

export function renderTable(r: Report): string {
  const out = [
    `run ${r.run.id}: ${r.run.status}, ${r.run.stored} of ${r.run.selected} results, commit ${r.run.commit}, set version ${r.run.setVersion.slice(0, 12)}`,
    r.complete
      ? "report: complete"
      : `report: INCOMPLETE (${r.missing.length} missing, ${r.unmeasured.length} not measured); no target is final`,
    ...populationLines("main sets", r.main),
  ];
  if (r.challenge) {
    out.push(...populationLines("challenge set (scored on its own)", r.challenge));
    const p = r.challenge.pairs;
    out.push(
      `  pairs both right: ${p.bothRight} of ${p.evaluated} evaluated (${p.notEvaluated} of ${p.total} not evaluated)`,
    );
  }
  out.push("targets:");
  for (const t of r.targets)
    out.push(
      `  ${t.name}: ${t.state} (figure ${t.figureText}, target ${t.threshold}, over ${t.denominator})${t.note ? ` - ${t.note}` : ""}`,
    );
  if (r.missing.length) out.push(`missing: ${r.missing.join(", ")}`);
  if (r.unmeasured.length)
    out.push(`not measured: ${r.unmeasured.map((u) => `${u.sample} (${u.outcome})`).join(", ")}`);
  return out.join("\n");
}

// ---- the command ------------------------------------------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// What an exported run must be before anything is scored: every field typed and bounded, every result this run's own.
export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const Outcomes = z.enum(["done", "partial", "refused", "capped", "timeout", "stale-repeat", "lost"]);
const Verdicts = z.enum(["safe", "suspicious", "malicious"]);
const RunSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{8,64}$/),
  commitSha: z.string().min(7).max(64),
  setVersion: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.string().min(1).max(64),
  sets: z.array(z.string().min(1).max(64)).min(1).max(10),
  sampleLimit: z.number().int().positive().nullable(),
  status: z.enum(["running", "complete", "incomplete", "aborted"]),
  selected: z.number().int().min(0),
  capUsd: z.number().positive().max(1_000_000),
  startedAt: z.string().min(1).max(40),
  finishedAt: z.string().min(1).max(40).nullable(),
  costUsd: z.number().min(0).max(1_000_000),
});
const ResultSchema = z.strictObject({
  runId: z.string(),
  sample: z.string().regex(/^[^/]+\/.+/),
  caseId: z.string().nullable(),
  outcome: Outcomes,
  label: z.enum(["attack", "genuine"]),
  category: z.string().min(1).max(80),
  verdict: Verdicts.nullable(),
  ms: z.number().int().min(0).max(86_400_000).nullable(),
  costUsd: z.number().min(0).max(1_000),
  criticalFound: z.boolean(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  detail: z.string().max(200).nullable(),
});

// A stored run (from the database or an export) checked whole: its own results only, one row per sample.
export function checkStored(value: unknown, id: string): { run: RunRow; results: ResultRow[] } | string {
  const parsed = z.strictObject({ run: RunSchema, results: z.array(ResultSchema).max(5000) }).safeParse(value);
  if (!parsed.success)
    return `it is not a stored run: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`;
  const { run, results } = parsed.data;
  if (run.id !== id) return `it holds run ${run.id}, not ${id}`;
  const foreign = results.find((r) => r.runId !== run.id);
  if (foreign) return `a result for ${foreign.sample} belongs to run ${foreign.runId}`;
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.sample)) return `${r.sample} is stored twice`;
    seen.add(r.sample);
  }
  return { run, results };
}

export const USAGE = [
  "usage: pnpm eval:metrics --run <run id> [--json]   (exit 0 report, 1 database fault, 3 refused)",
  "       pnpm eval:metrics --run <run id> --from <run.json> [--sets <dir>]   (an exported run, read offline)",
].join("\n");

export type Outcome = { code: number; stdout: string; stderr: string };

export async function runMetrics(args: { argv: string[]; db?: Pick<Db, "readRun">; root?: string }): Promise<Outcome> {
  const refuse = (message: string): Outcome => ({
    code: 3,
    stdout: "",
    stderr: `eval:metrics: ${message}\n${USAGE}\n`,
  });
  let id: string | null = null;
  let json = false;
  let from: string | null = null;
  let setsDir: string | null = null;
  for (let i = 0; i < args.argv.length; i++) {
    const a = args.argv[i];
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
    else if (a === "--from") {
      from = args.argv[++i] ?? null;
      if (!from) return refuse("--from needs a file");
    } else if (a === "--sets") {
      setsDir = args.argv[++i] ?? null;
      if (!setsDir) return refuse("--sets needs a folder");
    } else if (a === "--run") {
      id = args.argv[++i] ?? null;
      if (!id || !/^[a-z0-9-]{8,64}$/.test(id)) return refuse("--run needs a run id");
    } else return refuse(`unknown option ${a}`);
  }
  if (!id) return refuse("--run is required");
  let stored: Awaited<ReturnType<Db["readRun"]>>;
  if (from) {
    // An exported run (`{ run, results }`), scored offline: a regular file of bounded size, checked whole.
    try {
      const info = statSync(from);
      if (!info.isFile()) return refuse(`${from} is not a regular file`);
      if (info.size > MAX_EXPORT_BYTES) return refuse(`${from} is larger than ${MAX_EXPORT_BYTES} bytes`);
      const checked = checkStored(JSON.parse(readFileSync(from, "utf-8")), id);
      if (typeof checked === "string") return refuse(`${from}: ${checked}`);
      stored = checked;
    } catch (error) {
      return refuse(`${from} cannot be read: ${(error as Error).message}`);
    }
  } else {
    if (!args.db) return { code: 1, stdout: "", stderr: "eval:metrics: no database to read the run from\n" };
    try {
      stored = await args.db.readRun(id);
    } catch (error) {
      return { code: 1, stdout: "", stderr: `eval:metrics: the run could not be read: ${(error as Error).message}\n` };
    }
  }
  if (!stored) return refuse(`no run ${id}`);
  if (!from) {
    const checked = checkStored(stored, id);
    if (typeof checked === "string") return refuse(`the stored run is damaged: ${checked}`);
  }
  let selection: ReturnType<typeof selectSamples>;
  try {
    selection = selectSamples(setsDir ?? join(args.root ?? ROOT, "eval/sets"), stored.run.sets, stored.run.sampleLimit);
  } catch (error) {
    const reason = error instanceof SetRefused ? error.message : (error as Error).message;
    return refuse(`the sets cannot be read: ${reason}`);
  }
  if (selection.setVersion !== stored.run.setVersion)
    return refuse(
      `the sets no longer match run ${id} (set version ${selection.setVersion.slice(0, 12)}, the run's ${stored.run.setVersion.slice(0, 12)}): a label or a sample changed since the run, so its results cannot be scored against them`,
    );
  if (stored.run.selected !== selection.samples.length)
    return refuse(
      `the run says it selected ${stored.run.selected} samples, its stored selection reconstructs to ${selection.samples.length}`,
    );
  const inSelection = new Set(selection.samples.map((x) => x.id));
  const outside = stored.results.find((r) => !inSelection.has(r.sample));
  if (outside) return refuse(`a result for ${outside.sample} is not in the run's selection`);
  const report = computeMetrics({ run: stored.run, samples: selection.samples, results: stored.results });
  if (![report.main.costUsd.total, report.challenge?.costUsd.total ?? 0].every(Number.isFinite))
    return refuse("the stored costs do not add up to a finite total");
  return { code: 0, stdout: `${json ? JSON.stringify(report, null, 1) : renderTable(report)}\n`, stderr: "" };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  let db: Pick<Db, "readRun"> | undefined;
  // The live database is only opened for a run read from it.
  if (!argv.includes("--from") && !argv.includes("--help") && !argv.includes("-h")) {
    const { execute } = await import("../scripts/lib/meta-budget.ts");
    const { inline } = await import("../src/meta/budget-sql.ts");
    db = liveDb(process.env.EVAL_ORG_NAME ?? "IsItLegit Eval", (s) => execute({ sql: inline(s), params: [] }));
  }
  const out = await runMetrics({ argv, ...(db ? { db } : {}) });
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  process.exit(out.code);
}
