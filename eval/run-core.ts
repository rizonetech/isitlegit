// The evaluation runner's pure core (D08 T02 §1): which samples a run takes and the identity of their content, what a
// run is estimated to cost and the caps and allowance it is refused against before any upload, how a sample's outcome
// is named, and when a run is complete. No file write, network or clock, so the runner's rules are tested on injected
// answers. A run is `complete` only when every selected sample ended `done` or `partial`; anything else is
// `incomplete`, never a smaller population read as a full one.
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { refusingCap } from "../src/meta/caps.ts";
import { type Sample as LoadedSample, loadSet, MAX_LABELS_BYTES } from "./load.ts";

export const SETS = ["nazario-2025", "synthetic-sa", "synthetic-challenge"] as const;
export const OUTCOMES = ["done", "partial", "refused", "capped", "timeout", "stale-repeat", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type RunStatus = "complete" | "incomplete" | "aborted";
// What a case costs when no earlier run says: the spec's figure with room (target median US$0.05).
export const DEFAULT_COST_PER_SAMPLE_USD = 0.08;
export const EXIT = { complete: 0, fault: 1, incomplete: 2, refused: 3 } as const;

export type RunSample = {
  // Set-qualified: `<set>/<path>`.
  id: string;
  set: string;
  path: string;
  file: string;
  label: "attack" | "genuine";
  category: string;
  // What finds an attack (D08 T01 §4): the deterministic checks, or a model reading the message; null for genuine mail.
  basis?: "checks" | "model" | undefined;
  sha256: string;
};

// One sample's coverage in a baseline manifest (D08 T02 §11): the batch that measured it, or the earlier run it was
// pooled from when this baseline's own row was a stale repeat.
export type ManifestEntry = {
  sample: string;
  set: string;
  runId: string;
  deployment: string;
  outcome: Outcome;
  verdict: string | null;
  ms: number | null;
  costUsd: number;
  pooledFrom?: string;
};

// The deduplicated coverage of one baseline (D08 T02 §11): every expected sample once, unmeasured ones explicit, each
// set's own version with the deployment the baseline was measured on.
export type BaselineManifest = {
  id: string;
  sets: string[];
  setVersions: Record<string, string>;
  deployment: string;
  caps: Record<string, number>;
  expected: string[];
  entries: ManifestEntry[];
  unmeasured: string[];
};

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// The largest sample hashed: the upload limit (25 MiB) with room, so a set cannot make the runner read without bound.
export const MAX_SAMPLE_BYTES = 26 * 1024 * 1024;

// A file's SHA-256 read in chunks, refused past the bound before it is read whole.
export function hashFile(file: string, limit = MAX_SAMPLE_BYTES): string {
  if (statSync(file).size > limit) throw new Error(`${file} is larger than ${limit} bytes`);
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) {
      total += n;
      if (total > limit) throw new Error(`${file} is larger than ${limit} bytes`);
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// The samples a run takes: the named sets in order (a set that cannot be loaded refuses the run whole), the first
// `limit` when one is given. `setVersion` is a SHA-256 over every selected set's labels file and the sorted
// `<id>:<SHA-256 of the file's bytes>` of every sample in it, so changed content is a changed version.
export function selectSamples(
  root: string,
  sets: readonly string[],
  limit: number | null = null,
): { samples: RunSample[]; setVersion: string } {
  const all: RunSample[] = [];
  const parts: string[] = [];
  for (const name of sets) {
    const loaded = loadSet(join(root, name), name);
    parts.push(`labels:${name}:${hashFile(join(root, name, "labels.json"), MAX_LABELS_BYTES)}`);
    for (const s of loaded.samples as LoadedSample[]) {
      all.push({
        id: `${name}/${s.path}`,
        set: name,
        path: s.path,
        file: s.file,
        label: s.label,
        category: s.category,
        basis: s.label === "attack" ? (s.basis ?? "checks") : undefined,
        sha256: hashFile(s.file),
      });
    }
  }
  for (const s of [...all].sort((a, b) => (a.id < b.id ? -1 : 1))) parts.push(`${s.id}:${s.sha256}`);
  const samples = limit === null ? all : all.slice(0, limit);
  // The identity covers what the run selected, not what it left out.
  const picked = new Set(samples.map((s) => s.id));
  const identity = parts.filter((p) => p.startsWith("labels:") || picked.has(p.slice(0, p.lastIndexOf(":"))));
  return { samples, setVersion: sha(identity.join("\n")) };
}

export const perSampleEstimate = (lastCostPerCase: number | null) =>
  lastCostPerCase !== null && Number.isFinite(lastCostPerCase) && lastCostPerCase > 0
    ? lastCostPerCase
    : DEFAULT_COST_PER_SAMPLE_USD;

export type Preflight = {
  selected: number;
  // The samples still to be uploaded (a resumed run polls stored cases without uploading); all of them by default.
  uploads?: number;
  capUsd: number;
  perSampleUsd: number;
  day: string;
  daySpentUsd: number;
  totalSpentUsd: number;
  allowance: { used: number; limit: number };
};

// Why a run is refused before it uploads anything: no samples, a missing or invalid cap, an estimate over the stated
// cap or over any shared cap (the total, the reserve held back for the demo days, the day), or more samples than the
// organisation may still be admitted today. Empty when it may start.
export function preflightProblems(p: Preflight): string[] {
  const problems: string[] = [];
  if (p.selected <= 0) problems.push("no samples selected");
  if (!Number.isFinite(p.capUsd) || p.capUsd <= 0) problems.push("--cap-usd must be a positive number");
  // Only a new upload is admitted against the caps: a case already opened is reconciled without headroom.
  const uploads = p.uploads ?? p.selected;
  const estimate = uploads * p.perSampleUsd;
  if (Number.isFinite(p.capUsd) && p.capUsd > 0 && estimate > p.capUsd)
    problems.push(`the estimate US$${estimate.toFixed(4)} passes the stated cap US$${p.capUsd.toFixed(4)}`);
  const cap = uploads > 0 ? refusingCap(p.daySpentUsd, p.totalSpentUsd, estimate, p.day) : null;
  if (cap) problems.push(`the estimate US$${estimate.toFixed(4)} passes the shared ${cap} cap`);
  // A stated cap the shared caps would refuse is no cap: it must fit the headroom too.
  const stated =
    uploads > 0 && Number.isFinite(p.capUsd) && p.capUsd > 0
      ? refusingCap(p.daySpentUsd, p.totalSpentUsd, p.capUsd, p.day)
      : null;
  if (stated && !cap) problems.push(`the stated cap US$${p.capUsd.toFixed(4)} passes the shared ${stated} cap`);
  const remaining = Math.max(0, p.allowance.limit - p.allowance.used);
  if (uploads > remaining)
    problems.push(
      `${uploads} samples pass the organisation's ${remaining} cases left today (${p.allowance.used} of ${p.allowance.limit} used)`,
    );
  return problems;
}

export const isTerminal = (o: Outcome) => o === "done" || o === "partial";

// The safe next step for a refusal or fault, so a refused run names what to do instead of only what failed. The
// caller prints each hint once; an unknown problem has none.
export function recoveryHint(problem: string): string | null {
  if (problem.includes("no samples selected"))
    return "select at least one set with --set (sets: nazario-2025, synthetic-sa, synthetic-challenge)";
  if (problem.includes("--cap-usd must be"))
    return "state a positive cap with --cap-usd, at or above the run's estimate";
  if (problem.includes("passes the stated cap"))
    return "state a larger cap that still fits the shared day headroom, never above it";
  if (problem.includes("passes the shared"))
    return "run fewer sets (one --set at a time), or wait for the fresh SAST day when the day spend resets";
  if (problem.includes("organisation's"))
    return "ask the coordinator to raise the eval organisation's daily-cases override, or run fewer samples";
  if (problem.includes("session is not signed in") || problem.includes("does not belong"))
    return "refresh the eval session in the vault item IsItLegit eval session and export EVAL_SESSION_COOKIE again";
  if (problem.includes("already complete"))
    return "resume needs the run id of an unfinished run; start a new run for a fresh measurement";
  if (problem.includes("deployment is "))
    return "a run is measured on one deployment; start a new run instead of resuming";
  if (problem.includes("was started with cap"))
    return "a resume keeps the run's cap: drop --cap-usd or repeat that figure";
  return null;
}

// A run is complete only when every selected sample ended `done` or `partial`.
export function runStatus(selected: number, outcomes: readonly Outcome[]): RunStatus {
  return outcomes.length === selected && outcomes.every(isTerminal) ? "complete" : "incomplete";
}

export const exitCode = (status: RunStatus | "refused") =>
  status === "complete"
    ? EXIT.complete
    : status === "incomplete"
      ? EXIT.incomplete
      : status === "refused"
        ? EXIT.refused
        : EXIT.fault;

export type Options = {
  sets: string[];
  limit: number | null;
  capUsd: number;
  resume: string | null;
  verify: string | null;
  replay: string | null;
  mode: string | null;
  dry: boolean;
  help: boolean;
};

// The command line, each option validated; a problem is a refusal (exit 3) named in the message.
export function parseArgs(argv: readonly string[]): Options | { error: string } {
  const o: Options = {
    sets: [],
    limit: null,
    capUsd: Number.NaN,
    resume: null,
    verify: null,
    replay: null,
    mode: null,
    dry: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = () => argv[++i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--dry") o.dry = true;
    else if (a === "--set") {
      const v = value();
      if (!v || !(SETS as readonly string[]).includes(v)) return { error: `--set must be one of ${SETS.join(", ")}` };
      if (!o.sets.includes(v)) o.sets.push(v);
    } else if (a === "--limit") {
      const v = value();
      if (!v || !/^[1-9][0-9]*$/.test(v)) return { error: "--limit must be a positive whole number" };
      o.limit = Number(v);
    } else if (a === "--cap-usd") {
      const v = value();
      if (!v || !/^[0-9]+(\.[0-9]+)?$/.test(v) || Number(v) <= 0)
        return { error: "--cap-usd must be a positive number" };
      o.capUsd = Number(v);
    } else if (a === "--resume" || a === "--verify") {
      const v = value();
      if (!v || !/^[a-z0-9-]{8,64}$/.test(v)) return { error: `${a} needs a run id` };
      if (a === "--resume") o.resume = v;
      else o.verify = v;
    } else if (a === "--replay") {
      const v = value();
      if (!v || !/^[a-z0-9-]{8,64}$/.test(v)) return { error: "--replay needs a run id" };
      o.replay = v;
    } else if (a === "--mode") {
      const v = value();
      if (!v) return { error: "--mode needs a value: full or ablate:<flag>" };
      o.mode = v;
    } else return { error: `unknown option ${a}` };
  }
  if (!o.sets.length) o.sets = [...SETS];
  if (!o.help && !o.verify && !o.dry && !o.resume && !Number.isFinite(o.capUsd))
    return { error: "--cap-usd is required" };
  return o;
}

export const USAGE = [
  "usage: pnpm eval:run --cap-usd <usd> [--set <name>]... [--limit <n>] [--mode <full|ablate:flag>] [--dry]",
  "       pnpm eval:run --resume <run id>   (keeps the cap, the selection and the mode the run began with)",
  "       pnpm eval:run --replay <run id> --cap-usd <usd>   (remeasures the stored run's whole population on the current deployment under a fresh run id; the stored selection is restored and verified first, and a drifted population is refused with nothing sent)",
  "       pnpm eval:run --verify <run id>",
  `sets: ${SETS.join(", ")} (all by default). Needs EVAL_SESSION_COOKIE; exit 0 complete, 1 fault, 2 incomplete, 3 refused.`,
].join("\n");
