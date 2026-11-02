// Measured phone attribution (D07 T09 §4): the analysis of the scripted phone readers' observations. The
// readers run on the shipped report itself in test/node/phone-attribution-measure.test.tsx (a deterministic
// viewport scan at 360 px, a proxy for human reading, not human times); this script validates their raw
// observations, summarises them and persists the result:
//
//   PHONE_BENCH=1 pnpm exec vitest run --project browser test/node/phone-attribution-measure.test.tsx
//   node eval/phone-attribution.ts   (writes eval/phone-attribution-results.json)
//
// The benchmark shape there is the same shipped report with the phone attribution segment removed (the
// pre-D07 T03 §43 surface). The pure analysis (medians, confusion, observation validation) is exported for
// test/node/phone-attribution.test.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STIMULUS_VERSION = "phone-attribution-v1";

export type Observation = {
  case: string;
  shape: "shipped" | "benchmark";
  run: number;
  scrolls: number;
  openedDetails: boolean;
  firstIdentity: "sender" | "submitter" | null;
  identified: boolean;
  confused: boolean;
  ms: number;
};

const valid = (o: unknown): o is Observation => {
  if (typeof o !== "object" || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.case === "string" &&
    (r.shape === "shipped" || r.shape === "benchmark") &&
    typeof r.run === "number" &&
    typeof r.scrolls === "number" &&
    typeof r.openedDetails === "boolean" &&
    (r.firstIdentity === "sender" || r.firstIdentity === "submitter" || r.firstIdentity === null) &&
    typeof r.identified === "boolean" &&
    typeof r.confused === "boolean" &&
    typeof r.ms === "number" &&
    r.ms >= 0
  );
};

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarise(observations: Observation[]) {
  for (const o of observations) {
    if (!valid(o)) throw new Error(`invalid observation: ${JSON.stringify(o)}`);
    if (!Number.isFinite(o.scrolls) || !Number.isFinite(o.ms) || o.scrolls < 0)
      throw new Error(`invalid observation: ${JSON.stringify(o)}`);
  }
  // Complete paired trials: every case has the same runs under both shapes.
  const keys = new Map<string, Set<number>>();
  for (const o of observations) {
    const key = `${o.case}|${o.shape}`;
    const runs = keys.get(key) ?? new Set<number>();
    if (runs.has(o.run)) throw new Error(`duplicate observation: ${key} run ${o.run}`);
    runs.add(o.run);
    keys.set(key, runs);
  }
  const cases = new Set(observations.map((o) => o.case));
  for (const c of cases) {
    const shipped = keys.get(`${c}|shipped`);
    const benchmark = keys.get(`${c}|benchmark`);
    if (!shipped || !benchmark || shipped.size !== benchmark.size || [...shipped].some((run) => !benchmark.has(run)))
      throw new Error(`incomplete paired trials for ${c}`);
  }
  const shapes = ["shipped", "benchmark"] as const;
  const out: Record<
    string,
    { cases: number; runs: number; medianScrolls: number; medianMs: number; confused: number }
  > = {};
  for (const shape of shapes) {
    const rows = observations.filter((o) => o.shape === shape);
    if (rows.length === 0) throw new Error(`no observations for ${shape}`);
    const perCaseScrolls = new Map<string, number[]>();
    const perCaseMs = new Map<string, number[]>();
    for (const r of rows) {
      perCaseScrolls.set(r.case, [...(perCaseScrolls.get(r.case) ?? []), r.scrolls]);
      perCaseMs.set(r.case, [...(perCaseMs.get(r.case) ?? []), r.ms]);
    }
    out[shape] = {
      cases: perCaseScrolls.size,
      runs: rows.length,
      medianScrolls: median([...perCaseScrolls.values()].map(median)),
      medianMs: Math.round(median([...perCaseMs.values()].map(median))),
      confused: rows.filter((o) => o.confused).length,
    };
  }
  return out;
}

async function main() {
  const file = join(import.meta.dirname, "phone-attribution-observations.json");
  if (!existsSync(file))
    throw new Error(
      "no observations: run PHONE_BENCH=1 pnpm exec vitest run --project browser test/node/phone-attribution-measure.test.tsx first",
    );
  const stored = JSON.parse(readFileSync(file, "utf8")) as {
    stimulusVersion?: string;
    revision?: string;
    collectedAt?: string;
    observations?: Observation[];
  };
  // Stale or provenance-free observations are not evidence: the collector records its own revision and time.
  if (stored.stimulusVersion !== STIMULUS_VERSION || !stored.revision || !stored.collectedAt || !stored.observations)
    throw new Error(
      "observations lack provenance: rerun the collector in test/node/phone-attribution-measure.test.tsx",
    );
  const observations = stored.observations;
  const summary = summarise(observations);
  const out = {
    stimulusVersion: STIMULUS_VERSION,
    revision: stored.revision,
    collectedAt: stored.collectedAt,
    ranAt: new Date().toISOString(),
    summary,
    observations,
  };
  writeFileSync(join(import.meta.dirname, "phone-attribution-results.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
