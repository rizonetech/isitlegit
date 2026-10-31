// What is specific to one synthetic population (D08 T01 §3 and §7): the main set and the challenge set run through the
// same runner (`eval/generate/run.ts`), each with its own folder, results file, ledger run and cap, scenarios, variants,
// prompt line for genuine mail, validation and count rules. Types only, so a set's module and the runner can import each
// other's values without a cycle.
import type { Generated } from "./realism.ts";
import type { Spec } from "./scenarios.ts";

export type Others = { total: number; genuine: number };

export type SetDef = {
  // The folder under eval/sets, and the CLI selector.
  name: string;
  // The results file (kept by scenario id) and the run in the shared ledger, so one cap covers every attempt the set makes.
  resultsFile: string;
  runName: string;
  capUsd: number;
  // The label source written for every message.
  source: string;
  specs: () => Spec[];
  // A fresh form of one scenario (`first` is its first form), for a replacement when a body fails its tries.
  variant: (first: Spec, v: number) => Spec;
  // What the prompt says of genuine mail: the main set's ordinary mail, or a challenge control's stated risk cues.
  genuineLine: (spec: Spec) => string;
  // What the prompt says of an attack, when the set says anything (the main set says nothing).
  attackLine?: (spec: Spec) => string;
  // The rule checks a body must pass; an empty list passes.
  problems: (spec: Spec, generated: Generated) => string[];
  // Why the accepted messages fall short of the population's counts; `others` are the other sets' totals.
  counts: (accepted: Spec[], others: Others) => string[];
};
