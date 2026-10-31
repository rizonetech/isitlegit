// The Outcome's totals (D08 T01): every evaluation set together holds at least 150 samples, at least 60 of them genuine,
// read through the loader the evaluation itself uses.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_GENUINE_ALL, MIN_TOTAL_ALL, totalsProblems } from "../../eval/generate/run.ts";
import { type LoadedSet, loadSets, type Sample } from "../../eval/load.ts";

const SETS = join(import.meta.dirname, "../../eval/sets");

const sample = (i: number, genuine: boolean): Sample => ({
  id: `planted/${i}.eml`,
  set: "planted",
  file: `${i}.eml`,
  path: `${i}.eml`,
  label: genuine ? "genuine" : "attack",
  category: genuine ? "genuine-business" : "credential-phishing",
  expected: genuine ? [] : ["auth.spf"],
  source: "planted",
});
const planted = (total: number, genuine: number): LoadedSet[] => [
  { name: "planted", dir: "planted", samples: Array.from({ length: total }, (_, i) => sample(i, i < genuine)) },
];

describe("the evaluation's totals", () => {
  it("reach at least 150 samples and 60 genuine across eval/sets", () => {
    const sets = loadSets(SETS);
    expect(totalsProblems(sets)).toEqual([]);
    const samples = sets.flatMap((s) => s.samples);
    expect(samples.length).toBeGreaterThanOrEqual(MIN_TOTAL_ALL);
    expect(samples.filter((s) => s.label === "genuine").length).toBeGreaterThanOrEqual(MIN_GENUINE_ALL);
  });

  it("fail below 150 samples or below 60 genuine", () => {
    expect(totalsProblems(planted(150, 60))).toEqual([]);
    expect(totalsProblems(planted(149, 60))).toEqual(["149 samples across the sets, fewer than 150"]);
    expect(totalsProblems(planted(200, 59))).toEqual(["59 genuine across the sets, fewer than 60"]);
  });
});
