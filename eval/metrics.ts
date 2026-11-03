// The evaluation's metrics (D08 T02 §2): a pure function of what a run stored (`eval_results`, D08 T02 §1) joined to the
// sets' own labels, and the command that prints them (`pnpm eval:metrics --run <id> [--json]`).
//
// Rules the figures keep:
// - A selected sample with no stored result is `missing`, listed, and kept in its denominator: a missing attack is a
//   miss. A report is `complete` only when the run is complete and every selected sample has a result; a target is
//   `met` or `missed` only on a complete report, else `incomplete`.
// - Each figure names its eligible population: detection over every selected attack, false positives over every
//   selected genuine sample (one that did not finish stays in the denominator and the report is incomplete; the measured
//   coverage is reported apart), time and cost medians over measured rows only (a terminal row with no verdict keeps
//   its costs in the total but not in a median). A zero denominator is `not measured`, never 0% and never met.
// - A case counts by the verdict it has: suspicious or malicious on an attack is a detection, on genuine mail a false
//   positive; a `partial` case with no verdict is neither. A terminal result with no verdict is unmeasured (its costs
//   are still preserved), so it can never satisfy report completeness or publication.
// - The challenge set (`synthetic-challenge`) is scored on its own and never enters a main figure.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type ComponentRecords, checkComponentRows, providerFigures } from "./components.ts";
import { PAIRS } from "./generate/challenge.ts";
import { SetRefused } from "./load.ts";
import { livePublishDb, type PublishDb, publishRun, republishSummary } from "./publish.ts";
import type { Db, ResultRow, RunRow } from "./run.ts";
import { liveDb, verifyRun } from "./run.ts";
import { type BaselineManifest, isTerminal, type ManifestEntry, type RunSample, selectSamples } from "./run-core.ts";

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
  run: {
    id: string;
    mode: string;
    commit: string;
    setVersion: string;
    sets: string[];
    sampleLimit: number | null;
    status: string;
    selected: number;
    stored: number;
    startedAt: string;
    finishedAt: string | null;
  };
  complete: boolean;
  missing: string[];
  unmeasured: { sample: string; outcome: string }[];
  main: Population;
  challenge: (Population & { pairs: Pairs }) | null;
  targets: Target[];
  // Component capture (D08 T02 section 8): per-provider false positives and the walkthrough median cost,
  // computed only over results that carry the capture; a run without it reports null, never zero.
  components: {
    providers: {
      provider: string;
      checked: number;
      unchecked: number;
      genuineChecked: number;
      falsePositiveRate: number | null;
    }[];
    walkthroughMedianCostUsd: number | null;
    walkthroughCompleted: number;
  };
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
    // Measured means the case ended with a verdict: a terminal row with no verdict keeps its costs in the totals
    // but counts for no coverage, median or rate.
    const measured = row !== undefined && isTerminal(row.outcome) && row.verdict !== null;
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
  // A terminal result with no verdict measured that the case ended, not what it decided: it stays unmeasured, so a
  // run of null verdicts can never read complete or publishable.
  const unmeasured = results
    .filter((r) => (!isTerminal(r.outcome) || r.verdict === null) && selected.has(r.sample))
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
  const providerRecords = results.flatMap((r) => {
    const s = selected.get(r.sample);
    if (!s || s.set === CHALLENGE) return [];
    return (r.providers ?? []).map((pr) => ({
      provider: pr.provider,
      checked: pr.checked,
      listed: pr.listed,
      genuine: s.label === "genuine",
    }));
  });
  const walked = results.filter(
    (r) => selected.has(r.sample) && selected.get(r.sample)?.set !== CHALLENGE && r.walkthrough,
  );
  const walkedCosts = walked.map((r) => r.costUsd).sort((a, b) => a - b);
  const components = {
    providers: providerFigures(providerRecords),
    walkthroughMedianCostUsd: walkedCosts.length ? (walkedCosts[Math.floor(walkedCosts.length / 2)] as number) : null,
    walkthroughCompleted: walked.length,
  };
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
    components.walkthroughCompleted > 0
      ? {
          name: "median cost with a walkthrough",
          figure: components.walkthroughMedianCostUsd,
          figureText: usdText(components.walkthroughMedianCostUsd),
          threshold: `under ${usdText(0.25)}`,
          denominator: components.walkthroughCompleted,
          state: state(
            components.walkthroughCompleted,
            (components.walkthroughMedianCostUsd ?? Number.POSITIVE_INFINITY) < 0.25,
          ),
        }
      : notMeasured(
          "median cost with a walkthrough",
          `under ${usdText(0.25)}`,
          "needs each case's walkthrough use (D08 T02 §8)",
        ),
    components.providers.length > 0
      ? {
          name: "reputation providers' false-positive rates",
          figure: null,
          figureText: components.providers
            .map(
              (pr) =>
                `${pr.provider} ${pr.falsePositiveRate === null ? "not measured" : `${(100 * pr.falsePositiveRate).toFixed(1)}%`}`,
            )
            .join(", "),
          threshold: "reported per provider",
          denominator: components.providers.reduce((a, pr) => a + pr.genuineChecked, 0),
          state: "not measured" as TargetState,
          note: "per-provider figures in components; checked-and-unlisted cases are not persisted yet",
        }
      : notMeasured(
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
    components,
    run: {
      id: run.id,
      mode: run.mode,
      commit: run.commitSha,
      setVersion: run.setVersion,
      sets: run.sets,
      sampleLimit: run.sampleLimit,
      status: run.status,
      selected: run.selected,
      stored: results.length,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    complete,
    missing,
    unmeasured,
    main,
    challenge,
    targets,
  };
}

// The pooled metrics of a baseline manifest (D08 T02 §11): the same scoring contract as a stored run, over the
// manifest's deduplicated entries. A repeated sample counts once, a measured entry winning over an unmeasured one;
// challenge samples stay out of the headline rates. Hand pooling is replaced by this helper from here on.
export type CoverageMetrics = {
  expected: number;
  measured: number;
  pooled: number;
  unmeasured: string[];
  bySample: Record<string, ManifestEntry>;
  main: Population;
  challenge: (Population & { pairs: Pairs }) | null;
};

const withPooledFrom = (e: ManifestEntry, pooledFrom: string | undefined): ManifestEntry =>
  pooledFrom === undefined ? e : { ...e, pooledFrom };

export function coverageMetrics(manifest: BaselineManifest, samples: RunSample[]): CoverageMetrics {
  const measuredEntry = (e: ManifestEntry) => isTerminal(e.outcome) && e.verdict !== null;
  const bySample = new Map<string, ManifestEntry>();
  for (const e of manifest.entries) {
    const prior = bySample.get(e.sample);
    if (!prior) bySample.set(e.sample, e);
    // A repeated sample counts once: the measured entry wins, keeping the pooling provenance of either.
    else if (!measuredEntry(prior) && measuredEntry(e)) bySample.set(e.sample, withPooledFrom(e, prior.pooledFrom));
    else if (prior.pooledFrom === undefined && e.pooledFrom !== undefined)
      bySample.set(e.sample, withPooledFrom(prior, e.pooledFrom));
  }
  const selected = new Map(samples.map((s) => [s.id, s]));
  const rows = new Map<string, ResultRow>();
  for (const [id, e] of bySample) {
    const s = selected.get(id);
    rows.set(id, {
      runId: e.runId,
      sample: id,
      caseId: null,
      outcome: e.outcome,
      label: s?.label ?? "attack",
      category: s?.category ?? "",
      verdict: e.verdict as ResultRow["verdict"],
      ms: e.ms,
      costUsd: e.costUsd,
      criticalFound: false,
      httpStatus: null,
      detail: null,
    });
  }
  const mainSamples = samples.filter((s) => s.set !== CHALLENGE);
  const challengeSamples = samples.filter((s) => s.set === CHALLENGE);
  const unmeasured = manifest.expected.filter((id) => {
    const e = bySample.get(id);
    return !e || !measuredEntry(e);
  });
  const pooled = [...bySample.values()].filter((e) => e.pooledFrom !== undefined).length;
  return {
    expected: manifest.expected.length,
    measured: manifest.expected.length - unmeasured.length,
    pooled,
    unmeasured,
    bySample: Object.fromEntries(bySample),
    main: population(mainSamples, rows),
    challenge: challengeSamples.length ? { ...population(challengeSamples, rows), pairs: pairs(selected, rows) } : null,
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
  // The component fields the runner stores since section 8 (migration 0079): a run from before them has neither.
  providers: z
    .array(z.strictObject({ provider: z.string().min(1).max(80), checked: z.boolean(), listed: z.boolean() }))
    .max(50)
    .optional(),
  walkthrough: z.boolean().nullable().optional(),
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
  "usage: pnpm eval:metrics --check <RESULTS.md> [--records <dir>]   (exit 0 figures match their records, 3 refused)",
  "       pnpm eval:metrics --run <run id> [--json]   (exit 0 report, 1 database fault, 3 refused)",
  "       pnpm eval:metrics --run <run id> --from <run.json> [--sets <dir>]   (an exported run, read offline)",
  "       pnpm eval:metrics --run <run id> --publish   (store a complete report for the public page; a full run also writes eval/results-summary.json)",
  "       pnpm eval:metrics --compare <replay run id> [--json]   (compare a replay with its source run: same population, per-scope deltas, changed verdicts)",
  "       pnpm eval:metrics --republish-summary   (rebuild eval/results-summary.json from the latest published full report)",
].join("\n");

export type Outcome = { code: number; stdout: string; stderr: string };

export async function runMetrics(args: {
  argv: string[];
  db?: Pick<Db, "readRun">;
  pub?: PublishDb;
  root?: string;
  now?: () => Date;
  write?: Parameters<typeof publishRun>[0]["write"];
  // Reconciliation of the stored results against their cases before publication. The live command always passes it;
  // a caller without case access (an offline `--from` read) cannot publish.
  verify?: (id: string) => Promise<{ ok: boolean; problems: string[] }>;
  // Read progress for the operator, on stderr only: stdout stays machine-readable.
  onProgress?: (line: string) => void;
}): Promise<Outcome> {
  const refuse = (message: string): Outcome => ({
    code: 3,
    stdout: "",
    stderr: `eval:metrics: ${message}\n${USAGE}\n`,
  });
  let id: string | null = null;
  let json = false;
  let from: string | null = null;
  let setsDir: string | null = null;
  let publish = false;
  let republish = false;
  let checkFile: string | null = null;
  let recordsDir: string | null = null;
  let compare: string | null = null;
  for (let i = 0; i < args.argv.length; i++) {
    const a = args.argv[i];
    if (a === "--json") json = true;
    else if (a === "--compare") {
      compare = args.argv[++i] ?? null;
      if (!compare || !/^[a-z0-9-]{8,64}$/.test(compare)) return refuse("--compare needs a replay run id");
    } else if (a === "--publish") publish = true;
    else if (a === "--republish-summary") republish = true;
    else if (a === "--help" || a === "-h") return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
    else if (a === "--check") {
      checkFile = args.argv[++i] ?? null;
      if (!checkFile) return refuse("--check needs a file");
    } else if (a === "--records") {
      recordsDir = args.argv[++i] ?? null;
      if (!recordsDir) return refuse("--records needs a folder");
    } else if (a === "--from") {
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
  const root = args.root ?? ROOT;
  const done = (o: { code: number; message: string }): Outcome =>
    o.code === 0
      ? { code: 0, stdout: `${o.message}\n`, stderr: "" }
      : { code: o.code, stdout: "", stderr: `eval:metrics: ${o.message}\n` };
  if (compare) {
    if (id || publish || republish || checkFile || from) return refuse("--compare stands alone");
    if (!args.db) return { code: 1, stdout: "", stderr: "eval:metrics: no database to read the runs from\n" };
    let replayStored: Awaited<ReturnType<Db["readRun"]>>;
    let sourceStored: Awaited<ReturnType<Db["readRun"]>>;
    try {
      args.onProgress?.(`eval:metrics: reading replay run ${compare}`);
      replayStored = await args.db.readRun(compare);
      if (!replayStored) return refuse(`no run ${compare} to compare`);
      const checkedReplay = checkStored(replayStored, compare);
      if (typeof checkedReplay === "string") return refuse(`the stored replay is damaged: ${checkedReplay}`);
      replayStored = checkedReplay;
      const sourceId = replayStored.run.mode.startsWith("replay:")
        ? replayStored.run.mode.slice("replay:".length)
        : null;
      if (!sourceId) return refuse(`run ${compare} is not a replay (its mode is ${replayStored.run.mode})`);
      args.onProgress?.(`eval:metrics: reading source run ${sourceId}`);
      sourceStored = await args.db.readRun(sourceId);
      if (!sourceStored) return refuse(`no source run ${sourceId} for replay ${compare}`);
      const checkedSource = checkStored(sourceStored, sourceId);
      if (typeof checkedSource === "string") return refuse(`the stored source is damaged: ${checkedSource}`);
      sourceStored = checkedSource;
    } catch (error) {
      return { code: 1, stdout: "", stderr: `eval:metrics: the runs could not be read: ${(error as Error).message}\n` };
    }
    const problem = pairForCompare(sourceStored, replayStored);
    if (problem) return refuse(problem);
    const comparison = compareRuns(sourceStored, replayStored);
    return {
      code: 0,
      stdout: json ? `${JSON.stringify(comparison, null, 1)}\n` : `${comparisonText(comparison)}\n`,
      stderr: "",
    };
  }
  if (republish) {
    if (publish || from || id) return refuse("--republish-summary stands alone");
    if (!args.pub)
      return { code: 1, stdout: "", stderr: "eval:metrics: no database to read the published reports from\n" };
    return done(await republishSummary({ db: args.pub, root, ...(args.write ? { write: args.write } : {}) }));
  }
  if (checkFile) {
    if (id || publish || from) return refuse("--check stands alone");
    const { existsSync } = await import("node:fs");
    const dir = recordsDir ?? join(root, "eval/components");
    const records: ComponentRecords = {};
    for (const name of ["cache", "providers", "walkthrough", "floor", "invisible", "ai", "attachments"] as const) {
      const file = join(dir, `${name}.json`);
      if (existsSync(file)) {
        try {
          records[name] = JSON.parse(readFileSync(file, "utf-8"));
        } catch {
          return refuse(`${file}: malformed records`);
        }
      }
    }
    let text: string;
    try {
      text = readFileSync(checkFile, "utf-8");
    } catch {
      return refuse(`${checkFile}: unreadable`);
    }
    const problems = checkComponentRows(text, records);
    return problems.length
      ? refuse(problems.join("; "))
      : done({ code: 0, message: "eval:metrics: RESULTS figures match their records" });
  }
  if (publish && from) return refuse("--publish reads the run from the database, not from --from");
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
  if (publish) {
    if (!args.pub) return { code: 1, stdout: "", stderr: "eval:metrics: no database to publish to\n" };
    if (!args.verify)
      return refuse("publication needs its cases reconciled: pass a verifier, or publish from the live command");
    const reconciled = await args.verify(id);
    if (!reconciled.ok)
      return refuse(`run ${id} is not published: its cases do not reconcile (${reconciled.problems.join("; ")})`);
    return done(
      await publishRun({
        report,
        db: args.pub,
        root,
        now: args.now ?? (() => new Date()),
        ...(args.write ? { write: args.write } : {}),
      }),
    );
  }
  if (![report.main.costUsd.total, report.challenge?.costUsd.total ?? 0].every(Number.isFinite))
    return refuse("the stored costs do not add up to a finite total");
  return { code: 0, stdout: `${json ? JSON.stringify(report, null, 1) : renderTable(report)}\n`, stderr: "" };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  let db: Db | undefined;
  let pub: PublishDb | undefined;
  // The live database is only opened for a run read from it.
  if (!argv.includes("--from") && !argv.includes("--help") && !argv.includes("-h")) {
    const { execute } = await import("../scripts/lib/meta-budget.ts");
    const { inlineLong } = await import("../src/meta/budget-sql.ts");
    const run = (s: { sql: string; params: (string | number | null)[] }) => execute({ sql: inlineLong(s), params: [] });
    db = liveDb(process.env.EVAL_ORG_NAME ?? "IsItLegit Eval", run);
    pub = livePublishDb(run);
  }
  const out = await runMetrics({
    argv,
    onProgress: (line) => console.error(line),
    ...(db ? { db } : {}),
    ...(pub ? { pub } : {}),
    ...(db ? { verify: (runId: string) => verifyRun(db, runId) } : {}),
  });
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  process.exit(out.code);
}

// Replay merging (D08 T02 section 12): a terminal replay result replaces its original from either state; the
// replaced originals are counted apart as replay consent lines.
export function mergeReplayResults(
  original: ResultRow[],
  replays: ResultRow[][],
): { results: ResultRow[]; consentLines: number } {
  // A replay remeasures the whole population (D08 T02 section 12): a terminal replay line replaces its
  // original from either state, and a non-terminal one never does.
  const measured = new Map<string, ResultRow>();
  for (const run of replays)
    for (const r of run) if (r.outcome === "done" || r.outcome === "partial") measured.set(r.sample, r);
  let consentLines = 0;
  const results = original.map((r) => {
    const replay = measured.get(r.sample);
    if (replay) {
      consentLines++;
      return replay;
    }
    return r;
  });
  return { results, consentLines };
}

// ---- source-versus-replay comparison (D08 T02 section 13) ------------------------------------------------------

export type ScopeDelta = {
  detection: { source: Rate; replay: Rate; deltaPp: number | null };
  falsePositives: { source: Rate; replay: Rate; deltaPp: number | null };
  medianMs: { source: number | null; replay: number | null; delta: number | null };
  medianCostUsd: { source: number | null; replay: number | null; delta: number | null };
};

export type RunComparison = {
  sourceId: string;
  replayId: string;
  sourceCommit: string;
  replayCommit: string;
  main: ScopeDelta;
  challenge: ScopeDelta | null;
  changed: {
    sample: string;
    label: "attack" | "genuine";
    scope: "main" | "challenge";
    sourceVerdict: string | null;
    replayVerdict: string | null;
    // An improvement flags an attack the source missed, or clears a genuine false alarm; a regression is the
    // inverse. A change between two flagged or two clear verdicts is neither, and reads "changed".
    change: "improvement" | "regression" | "changed";
  }[];
};

// Two stored runs pair for comparison only as a full measured replay of its source: the replay's stored mode
// names the source, both runs are complete with complete measured coverage (every selected sample terminal
// with a verdict, so an outage cannot read as a detection change), and the populations are one population.
export function pairForCompare(
  source: { run: RunRow; results: ResultRow[] },
  replay: { run: RunRow; results: ResultRow[] },
): string | null {
  if (replay.run.mode !== `replay:${source.run.id}`)
    return `run ${replay.run.id} is not a replay of run ${source.run.id} (its mode is ${replay.run.mode})`;
  for (const [name, stored] of [
    ["source", source],
    ["replay", replay],
  ] as const) {
    if (stored.run.status !== "complete")
      return `the ${name} run ${stored.run.id} is ${stored.run.status}, not complete`;
    if (stored.results.length !== stored.run.selected)
      return `the ${name} run ${stored.run.id} holds ${stored.results.length} results for ${stored.run.selected} selected samples`;
    const uncovered = stored.results.filter((r) => !isTerminal(r.outcome) || r.verdict === null);
    if (uncovered.length > 0)
      return `the ${name} run ${stored.run.id} is not fully measured: ${uncovered.length} samples ended without a verdict (first: ${uncovered[0]?.sample})`;
  }
  if (source.run.setVersion !== replay.run.setVersion)
    return `the runs were measured on different set versions (${source.run.setVersion.slice(0, 12)} and ${replay.run.setVersion.slice(0, 12)})`;
  const bySample = new Map(replay.results.map((r) => [r.sample, r]));
  for (const r of source.results) {
    const other = bySample.get(r.sample);
    if (!other) return `sample ${r.sample} is in run ${source.run.id} but not in run ${replay.run.id}`;
    if (other.label !== r.label) return `sample ${r.sample} changed label between the runs`;
  }
  if (bySample.size !== source.results.length)
    return `run ${replay.run.id} holds samples run ${source.run.id} does not`;
  return null;
}

function scopeDelta(sourceRows: ResultRow[], replayRows: ResultRow[]): ScopeDelta {
  const figures = (rows: ResultRow[]) => {
    const attacks = rows.filter((r) => r.label === "attack");
    const genuine = rows.filter((r) => r.label === "genuine");
    return {
      detection: rate(attacks.filter((r) => flagged(r.verdict)).length, attacks.length),
      falsePositives: rate(genuine.filter((r) => flagged(r.verdict)).length, genuine.length),
      ms: spread(rows.map((r) => r.ms).filter((v): v is number => v !== null)),
      cost: spread(rows.map((r) => r.costUsd)),
    };
  };
  const a = figures(sourceRows);
  const b = figures(replayRows);
  const pp = (x: Rate, y: Rate) => (x.rate === null || y.rate === null ? null : (y.rate - x.rate) * 100);
  const delta = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
  return {
    detection: { source: a.detection, replay: b.detection, deltaPp: pp(a.detection, b.detection) },
    falsePositives: {
      source: a.falsePositives,
      replay: b.falsePositives,
      deltaPp: pp(a.falsePositives, b.falsePositives),
    },
    medianMs: { source: a.ms.median, replay: b.ms.median, delta: delta(a.ms.median, b.ms.median) },
    medianCostUsd: { source: a.cost.median, replay: b.cost.median, delta: delta(a.cost.median, b.cost.median) },
  };
}

export function compareRuns(
  source: { run: RunRow; results: ResultRow[] },
  replay: { run: RunRow; results: ResultRow[] },
): RunComparison {
  const inScope = (rows: ResultRow[], challenge: boolean) =>
    rows.filter((r) => (r.sample.split("/")[0] === CHALLENGE) === challenge);
  const replayBySample = new Map(replay.results.map((r) => [r.sample, r]));
  const changed = source.results
    .filter((r) => replayBySample.get(r.sample)?.verdict !== r.verdict)
    .map((r) => {
      const replayVerdict = replayBySample.get(r.sample)?.verdict ?? null;
      const was = flagged(r.verdict);
      const now = flagged(replayVerdict);
      const change = was === now ? "changed" : now === (r.label === "attack") ? "improvement" : ("regression" as const);
      return {
        sample: r.sample,
        label: r.label,
        scope: (r.sample.split("/")[0] === CHALLENGE ? "challenge" : "main") as "main" | "challenge",
        sourceVerdict: r.verdict,
        replayVerdict,
        change: change as "improvement" | "regression" | "changed",
      };
    })
    .sort((x, y) => (x.sample < y.sample ? -1 : 1));
  const hasChallenge = source.results.some((r) => r.sample.split("/")[0] === CHALLENGE);
  return {
    sourceId: source.run.id,
    replayId: replay.run.id,
    sourceCommit: source.run.commitSha,
    replayCommit: replay.run.commitSha,
    main: scopeDelta(inScope(source.results, false), inScope(replay.results, false)),
    challenge: hasChallenge ? scopeDelta(inScope(source.results, true), inScope(replay.results, true)) : null,
    changed,
  };
}

function signed(v: number | null, unit: string, digits = 1): string {
  return v === null ? "not measured" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}${unit}`;
}

export function comparisonText(c: RunComparison): string {
  const scope = (name: string, d: ScopeDelta) => [
    `${name}:`,
    `  detection ${pct(d.detection.source)} -> ${pct(d.detection.replay)} (${signed(d.detection.deltaPp, " pp")})`,
    `  false positives ${pct(d.falsePositives.source)} -> ${pct(d.falsePositives.replay)} (${signed(d.falsePositives.deltaPp, " pp")})`,
    `  median time ${d.medianMs.source === null ? "not measured" : `${Math.round(d.medianMs.source)} ms`} -> ${d.medianMs.replay === null ? "not measured" : `${Math.round(d.medianMs.replay)} ms`} (${signed(d.medianMs.delta === null ? null : Math.round(d.medianMs.delta), " ms", 0)})`,
    `  median cost ${d.medianCostUsd.source === null ? "not measured" : `US$${d.medianCostUsd.source.toFixed(4)}`} -> ${d.medianCostUsd.replay === null ? "not measured" : `US$${d.medianCostUsd.replay.toFixed(4)}`} (${signed(d.medianCostUsd.delta, "", 4)})`,
  ];
  const counts = (name: "main" | "challenge") => {
    const rows = c.changed.filter((x) => x.scope === name);
    return `${rows.filter((x) => x.change === "improvement").length} improvements, ${rows.filter((x) => x.change === "regression").length} regressions, ${rows.filter((x) => x.change === "changed").length} other changes`;
  };
  return [
    `comparison: run ${c.sourceId} (${c.sourceCommit}) -> replay ${c.replayId} (${c.replayCommit})`,
    ...scope("main sets", c.main),
    ...(c.challenge ? scope("challenge set", c.challenge) : []),
    `changed verdicts: ${c.changed.length} (main: ${counts("main")}${c.challenge ? `; challenge: ${counts("challenge")}` : ""})`,
    ...c.changed.map(
      (x) =>
        `  ${x.sample} [${x.scope}, ${x.label}, ${x.change}]: ${x.sourceVerdict ?? "none"} -> ${x.replayVerdict ?? "none"}`,
    ),
  ].join("\n");
}
