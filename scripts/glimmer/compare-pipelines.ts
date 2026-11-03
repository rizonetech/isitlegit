// Loupe's data pipelines measured against the conventional ones (D03 T04 §31). Local only: no training, no GPU.
//
//     node scripts/glimmer/compare-pipelines.ts <labels|split> [--check]
//
// Every figure comes from a machine-readable result `<store>/runs/compare/<name>.json` (written atomically) that names
// each input and its sha256; `docs/glimmer/training.md` is written from that file, never typed. A missing or partial
// input yields an `incomplete` result naming what is missing, never a completed comparison.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LURE_TYPES } from "../../src/vision/page-screen.ts";
import { brandIdentity, hamming, jaccard, NEAR_BITS, NEAR_TEXT, shingles } from "./build-dataset.ts";
import type { ListEntry } from "./render.ts";

// The Wilson 95 percent interval for k of n; (0, 1) for no observations.
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export type Input = { name: string; path: string; sha256: string | null; bytes: number | null; error?: string };
export type Complete<T> = { status: "complete"; name: string; inputs: Input[]; figures: T };
export type Incomplete = { status: "incomplete"; name: string; inputs: Input[]; missing: string[] };
export type Result<T> = Complete<T> | Incomplete;

// An input that is not there, or is there and cannot be read, has no digest and says why: it never throws, so the command
// can always record an `incomplete` result in place of an older complete one.
export function describeInput(name: string, path: string): Input {
  if (!existsSync(path)) return { name, path, sha256: null, bytes: null };
  try {
    const data = readFileSync(path);
    return { name, path, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
  } catch (error) {
    return { name, path, sha256: null, bytes: null, error: error instanceof Error ? error.message : String(error) };
  }
}
// An input that is not there makes the whole result incomplete, naming each one that is missing.
export function incompleteIfMissing(name: string, inputs: Input[]): Incomplete | null {
  const missing = inputs
    .filter((input) => input.sha256 === null)
    .map((input) => `${input.name} (${input.path})${input.error ? `: unreadable, ${input.error}` : ""}`);
  return missing.length ? { status: "incomplete", name, inputs, missing } : null;
}
export function writeResult(file: string, result: Result<unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, file);
}
export const resultFile = (store: string, name: string) => join(store, "runs", "compare", `${name}.json`);

// ---- Labels against independent annotations -------------------------------------------------------------------------

export type Unknown = "unknown" | "disputed";
// What a person who viewed the page found, field by field; a field left out was not judged.
export type Annotation = {
  id: string;
  brand?: string | null | Unknown;
  lure_type?: string | Unknown;
  lure?: boolean | Unknown;
};
export type Labels = { brand?: string | null; lure_type?: string; lure?: boolean };
export const FIELDS = ["brand", "lure_type", "lure"] as const;
export type Field = (typeof FIELDS)[number];

const same = (field: Field, label: unknown, truth: unknown) =>
  field === "brand"
    ? (label === null ? "" : brandIdentity(String(label))) === (truth === null ? "" : brandIdentity(String(truth)))
    : label === truth;

export type FieldFigures = {
  annotated: number; // pages whose annotation is a judgement on this field
  unknown: number;
  disputed: number;
  retained: number; // judged pages that carry a label for the field
  wrong: number; // retained and not equal to the annotation
  error: number | null; // wrong / retained
  interval: { low: number; high: number };
  coverage: number | null; // retained / annotated
};
export type LabelFigures = Record<string, Record<Field, FieldFigures>>;

// Each label set scored against the annotations, field by field. A page the set has no entry for is not retained.
export function scoreLabels(annotations: Annotation[], sets: Record<string, Map<string, Labels>>): LabelFigures {
  const out: LabelFigures = {};
  for (const [name, labels] of Object.entries(sets)) {
    out[name] = {} as Record<Field, FieldFigures>;
    for (const field of FIELDS) {
      let annotated = 0;
      let unknown = 0;
      let disputed = 0;
      let retained = 0;
      let wrong = 0;
      for (const annotation of annotations) {
        const truth = annotation[field];
        if (truth === undefined) continue;
        if (truth === "unknown") {
          unknown++;
          continue;
        }
        if (truth === "disputed") {
          disputed++;
          continue;
        }
        annotated++;
        const label = labels.get(annotation.id)?.[field];
        if (label === undefined) continue;
        retained++;
        if (!same(field, label, truth)) wrong++;
      }
      out[name][field] = {
        annotated,
        unknown,
        disputed,
        retained,
        wrong,
        error: retained ? wrong / retained : null,
        interval: wilson(wrong, retained),
        coverage: annotated ? retained / annotated : null,
      };
    }
  }
  return out;
}

// ---- Splits ----------------------------------------------------------------------------------------------------------

export type Page = {
  id: string;
  brand: string | null;
  site: string | null;
  lure: boolean;
  lureType?: string | null; // the lure type of a lure; null or absent for a benign page
  hash: bigint; // 64-bit difference hash of the screenshot
  words: Uint32Array; // sorted distinct text shingles
};
export type Side = "train" | "eval";

export type SplitFigures = {
  train: number;
  eval: number;
  dropped: number;
  lure_share_eval: number | null;
  lure_share_train?: number | null;
  cross_brand: number; // brands on both sides
  cross_site: number; // sites on both sides
  near_duplicate_eval_pages: number; // eval pages with a near-duplicate in train
  // The lure types of each side's lures, so a balance claim covers type as well as share (§39).
  lure_types?: { train: Record<string, number>; eval: Record<string, number> };
};

// Whether two pages are near-duplicates by the build's own rule: screenshots within NEAR_BITS and text at NEAR_TEXT.
export const near = (a: Page, b: Page) =>
  hamming(a.hash, b.hash) <= NEAR_BITS && jaccard(a.words, b.words) >= NEAR_TEXT;

// The conventional text test: MinHash, the estimate of Jaccard from the minimum of each of `MINHASH_PERMUTATIONS` seeded
// hashes of a page's shingles (the build itself uses the exact Jaccard). Signatures are made only for pages that share a
// screenshot band with another, and cached.
export const MINHASH_PERMUTATIONS = 128;
const mix = (x: number) => {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
const signatures = new WeakMap<Uint32Array, Uint32Array>();
export function signatureOf(words: Uint32Array): Uint32Array {
  const cached = signatures.get(words);
  if (cached) return cached;
  const signature = new Uint32Array(MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (let k = 0; k < MINHASH_PERMUTATIONS; k++) {
    const seed = mix(k + 1);
    let least = 0xffffffff;
    for (const word of words) {
      const value = mix(word ^ seed);
      if (value < least) least = value;
    }
    signature[k] = least;
  }
  signatures.set(words, signature);
  return signature;
}
export function minhashJaccard(a: Uint32Array, b: Uint32Array): number {
  if (!a.length && !b.length) return 1;
  const x = signatureOf(a);
  const y = signatureOf(b);
  let same = 0;
  for (let k = 0; k < MINHASH_PERMUTATIONS; k++) if (x[k] === y[k]) same++;
  return same / MINHASH_PERMUTATIONS;
}
// Whether two pages are near-duplicates by the conventional rule: screenshots within NEAR_BITS and MinHash at NEAR_TEXT.
export const nearConventional = (a: Page, b: Page) =>
  hamming(a.hash, b.hash) <= NEAR_BITS && minhashJaccard(a.words, b.words) >= NEAR_TEXT;

// Candidate neighbours by banding the hash into NEAR_BITS + 1 parts: two hashes within NEAR_BITS differ in at most
// NEAR_BITS bits, so they agree exactly on at least one part.
function bandKeys(hash: bigint): string[] {
  const parts = NEAR_BITS + 1;
  const width = Math.ceil(64 / parts);
  return Array.from({ length: parts }, (_, i) => `${i}:${(hash >> BigInt(i * width)) & ((1n << BigInt(width)) - 1n)}`);
}
function nearIndex(pages: Page[], test: (a: Page, b: Page) => boolean = near) {
  const bands = new Map<string, Page[]>();
  for (const page of pages)
    for (const key of bandKeys(page.hash)) (bands.get(key) ?? bands.set(key, []).get(key))?.push(page);
  return (page: Page): Page | null => {
    for (const key of bandKeys(page.hash))
      for (const other of bands.get(key) ?? []) if (other.id !== page.id && test(page, other)) return other;
    return null;
  };
}

const typeCounts = (list: Page[]) => {
  const out: Record<string, number> = {};
  for (const p of list) if (p.lure) out[p.lureType ?? "unspecified"] = (out[p.lureType ?? "unspecified"] ?? 0) + 1;
  return out;
};

// The permitted gap between a stratified seed's evaluation lure share and the built split's, in share points: whole
// groups cannot always hit a target exactly, and a seed outside it is reported as unmet rather than called matched.
export const BALANCE_TOLERANCE = 0.05;
// How far a stratified seed is from the build's balance on both sides: each side's lure-share gap and each lure
// type's share of that side's lures against the build's, and whether every gap is within `BALANCE_TOLERANCE`.
export function balanceOf(built: SplitFigures, other: SplitFigures) {
  const shares = (f: SplitFigures, side: "eval" | "train") => {
    const counts = f.lure_types?.[side] ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, total ? v / total : 0]));
  };
  const gaps = (side: "eval" | "train") => {
    const target = shares(built, side);
    const got = shares(other, side);
    const types = [...new Set([...Object.keys(target), ...Object.keys(got)])].sort();
    return Object.fromEntries(types.map((t) => [t, Math.abs((got[t] ?? 0) - (target[t] ?? 0))]));
  };
  const type_share_gap = gaps("eval");
  const train_type_share_gap = gaps("train");
  const share_gap = Math.abs((other.lure_share_eval ?? 0) - (built.lure_share_eval ?? 0));
  const train_share_gap = Math.abs((other.lure_share_train ?? 0) - (built.lure_share_train ?? 0));
  const all = [share_gap, train_share_gap, ...Object.values(type_share_gap), ...Object.values(train_type_share_gap)];
  return {
    share_gap,
    train_share_gap,
    within_tolerance: all.every((g) => g <= BALANCE_TOLERANCE),
    tolerance: BALANCE_TOLERANCE,
    type_share_gap,
    train_type_share_gap,
  };
}

// The figures of a split: sizes, the eval side's lure share, and every leak across the sides. `assignment` has no entry
// for a page the split dropped.
export function splitFigures(pages: Page[], assignment: Map<string, Side>): SplitFigures {
  const train = pages.filter((p) => assignment.get(p.id) === "train");
  const evals = pages.filter((p) => assignment.get(p.id) === "eval");
  const brands = (list: Page[]) => new Set(list.flatMap((p) => (p.brand ? [brandIdentity(p.brand)] : [])));
  const sites = (list: Page[]) => new Set(list.flatMap((p) => (p.site ? [p.site] : [])));
  const trainBrands = brands(train);
  const trainSites = sites(train);
  const findNear = nearIndex(train);
  return {
    train: train.length,
    eval: evals.length,
    dropped: pages.length - train.length - evals.length,
    lure_share_eval: evals.length ? evals.filter((p) => p.lure).length / evals.length : null,
    lure_share_train: train.length ? train.filter((p) => p.lure).length / train.length : null,
    cross_brand: [...brands(evals)].filter((b) => trainBrands.has(b)).length,
    cross_site: [...sites(evals)].filter((s) => trainSites.has(s)).length,
    near_duplicate_eval_pages: evals.filter((p) => findNear(p) !== null).length,
    lure_types: { train: typeCounts(train), eval: typeCounts(evals) },
  };
}

export type Witnesses = {
  brands: { brand: string; eval: string[]; train: string[] }[];
  sites: { site: string; eval: string[]; train: string[] }[];
  near: { eval: string; train: string }[];
};
// The leaks themselves: which brands and sites sit on both sides (with the pages on each) and which evaluation pages have
// a near-duplicate in training (with that page), so a figure can be checked without recomputing it.
export function leakWitnesses(pages: Page[], assignment: Map<string, Side>): Witnesses {
  const train = pages.filter((p) => assignment.get(p.id) === "train");
  const evals = pages.filter((p) => assignment.get(p.id) === "eval");
  const group = (list: Page[], key: (p: Page) => string | null) => {
    const out = new Map<string, string[]>();
    for (const p of list) {
      const k = key(p);
      if (k) (out.get(k) ?? out.set(k, []).get(k))?.push(p.id);
    }
    return out;
  };
  const brand = (p: Page) => (p.brand ? brandIdentity(p.brand) : null);
  const site = (p: Page) => p.site;
  const across = (key: (p: Page) => string | null) => {
    const t = group(train, key);
    return [...group(evals, key)]
      .filter(([k]) => t.has(k))
      .map(([k, ids]) => ({ key: k, eval: ids, train: t.get(k) as string[] }));
  };
  const findNear = nearIndex(train);
  return {
    brands: across(brand).map((x) => ({ brand: x.key, eval: x.eval, train: x.train })),
    sites: across(site).map((x) => ({ site: x.key, eval: x.eval, train: x.train })),
    near: evals.flatMap((p) => {
      const other = findNear(p);
      return other ? [{ eval: p.id, train: other.id }] : [];
    }),
  };
}

// A small deterministic generator, so a seed names a split.
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// The conventional alternative to §10's split: pages grouped by one key (brand, else site, else the page), the groups
// shuffled and filled into the evaluation side up to its share, and then near-duplicates removed from training (by
// perceptual hash and MinHash text similarity). The leak figures then count, by the build's exact rule, what that removal missed.
export function groupShuffleSplit(pages: Page[], random: () => number, evalShare: number): Map<string, Side> {
  const groups = new Map<string, Page[]>();
  for (const page of pages) {
    const key = page.brand ? `brand:${brandIdentity(page.brand)}` : page.site ? `site:${page.site}` : `page:${page.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(page);
  }
  const keys = [...groups.keys()].sort();
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
  }
  const target = Math.round(pages.length * evalShare);
  const assignment = new Map<string, Side>();
  let held = 0;
  for (const key of keys) {
    const side: Side = held < target ? "eval" : "train";
    for (const page of groups.get(key) ?? []) assignment.set(page.id, side);
    if (side === "eval") held += groups.get(key)?.length ?? 0;
  }
  const findNear = nearIndex(
    pages.filter((p) => assignment.get(p.id) === "eval"),
    nearConventional,
  );
  for (const page of pages) if (assignment.get(page.id) === "train" && findNear(page)) assignment.delete(page.id);
  return assignment;
}

// The stronger baseline (§39): the same whole groups, but class-aware, as StratifiedGroupKFold is: each step takes
// the remaining whole group whose addition brings the evaluation side nearest the built split's lure share and
// lure-type shares (the training side is then the complement). Candidates are scanned in a seeded shuffled order,
// at most 200 a step, so a large store stays bounded; near-duplicates of the evaluation side are then removed from
// training as in the plain baseline.
export function stratifiedGroupSplit(
  pages: Page[],
  random: () => number,
  evalShare: number,
  targetLureShare: number,
  targetTypeShares?: Record<string, number>,
): Map<string, Side> {
  const groups = new Map<string, Page[]>();
  for (const page of pages) {
    const key = page.brand ? `brand:${brandIdentity(page.brand)}` : page.site ? `site:${page.site}` : `page:${page.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(page);
  }
  const remaining = [...groups.keys()].sort();
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j] as string, remaining[i] as string];
  }
  const overallTypes: Record<string, number> = {};
  for (const p of pages)
    if (p.lure) overallTypes[p.lureType ?? "unspecified"] = (overallTypes[p.lureType ?? "unspecified"] ?? 0) + 1;
  const totalLures = Object.values(overallTypes).reduce((a, b) => a + b, 0);
  const typeTarget =
    targetTypeShares ??
    Object.fromEntries(Object.entries(overallTypes).map(([k, v]) => [k, totalLures ? v / totalLures : 0]));
  const types = Object.keys(typeTarget).sort();
  const target = Math.round(pages.length * evalShare);
  const assignment = new Map<string, Side>();
  let held = 0;
  let heldLures = 0;
  const heldTypes: Record<string, number> = {};
  for (const page of pages) assignment.set(page.id, "train");
  const score = (addPages: Page[]) => {
    const n = held + addPages.length;
    const lures = heldLures + addPages.filter((p) => p.lure).length;
    let s = Math.abs((n ? lures / n : 0) - targetLureShare);
    for (const t of types) {
      const c = (heldTypes[t] ?? 0) + addPages.filter((p) => p.lure && (p.lureType ?? "unspecified") === t).length;
      s += Math.abs((lures ? c / lures : 0) - (typeTarget[t] ?? 0));
    }
    return s;
  };
  while (held < target && remaining.length) {
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < Math.min(remaining.length, 200); i++) {
      const s = score(groups.get(remaining[i] as string) ?? []);
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const key = remaining.splice(best, 1)[0] as string;
    for (const page of groups.get(key) ?? []) {
      assignment.set(page.id, "eval");
      held++;
      if (page.lure) {
        heldLures++;
        heldTypes[page.lureType ?? "unspecified"] = (heldTypes[page.lureType ?? "unspecified"] ?? 0) + 1;
      }
    }
  }
  const findNear = nearIndex(
    pages.filter((p) => assignment.get(p.id) === "eval"),
    nearConventional,
  );
  for (const page of pages) if (assignment.get(page.id) === "train" && findNear(page)) assignment.delete(page.id);
  return assignment;
}

// ---- The command -----------------------------------------------------------------------------------------------------

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const lines = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim());
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// What a pinned page is: the digest of every consumed file of every page (its metadata, screenshot and text), so a page
// that is relabelled, repaired or replaced changes the identity the result records.
type PageRead = { meta: string; shot: Uint8Array; text: string };
function pageFiles(dir: string, id: string): PageRead {
  const folder = join(dir, "pages", id);
  const meta = readFileSync(join(folder, "meta.json"), "utf-8");
  return {
    meta,
    shot: readFileSync(join(folder, "screenshot.jpg")),
    text: readFileSync(join(folder, "text.txt"), "utf-8"),
  };
}
const pageLine = (id: string, p: PageRead) => `${id} ${sha(p.meta)} ${sha(p.shot)} ${sha(p.text)}`;
const pagesInput = (dir: string, entries: string[]): Input => ({
  name: `page files (${entries.length} pages: metadata, screenshot, text)`,
  path: join(dir, "pages"),
  sha256: sha([...entries].sort().join("\n")),
  bytes: entries.length,
});

// §10's split for a version, read from the dataset it wrote, validated: neither side empty, no id on both.
export function builtMembership(
  dir: string,
  version: string,
): { train: string[]; eval: string[]; inputs: Input[]; problems: string[] } {
  const files = {
    train: join(dir, "dataset", version, "train.meta.jsonl"),
    eval: join(dir, "dataset", version, "eval.meta.jsonl"),
  };
  const inputs = [describeInput("train.meta.jsonl", files.train), describeInput("eval.meta.jsonl", files.eval)];
  const problems: string[] = [];
  const ids = { train: [] as string[], eval: [] as string[] };
  for (const side of ["train", "eval"] as const) {
    if (inputs.find((i) => i.name === `${side}.meta.jsonl`)?.sha256 === null) continue;
    try {
      for (const line of lines(files[side])) {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (typeof id !== "string") throw new Error("a line has no id");
        ids[side].push(id);
      }
    } catch (error) {
      problems.push(`${side}.meta.jsonl is malformed (${message(error)})`);
    }
    if (!problems.length && !ids[side].length) problems.push(`${side}.meta.jsonl holds no pages`);
  }
  const both = ids.train.filter((id) => new Set(ids.eval).has(id));
  if (both.length) problems.push(`${both.length} ids are on both sides, first ${both.slice(0, 5).join(", ")}`);
  const duplicated = [...ids.train, ...ids.eval].length - new Set([...ids.train, ...ids.eval]).size;
  if (duplicated && !both.length) problems.push(`${duplicated} ids are listed more than once`);
  return { train: ids.train, eval: ids.eval, inputs, problems };
}

export type SplitResultFigures = {
  built: SplitFigures;
  conventional: SplitFigures;
  // The stratified grouped baseline (§39) at each predefined seed.
  stratified: {
    seed: number;
    figures: SplitFigures;
    balance: ReturnType<typeof balanceOf>;
    witnesses: Witnesses;
    // Every page's side under this seed, and the pages it dropped: nothing is recovered by subtraction (§39).
    assignment: { train: string[]; eval: string[]; dropped: string[] };
  }[];
  pages: number;
  eval_share: number;
  config: Record<string, unknown>;
  // Where the frozen collection went before the split saw it: the build's own selection, from its summary, so the
  // comparison states what it covers (the split step) and what it does not.
  population: {
    frozen: number | null;
    kept: number;
    dropped_before_split: Record<string, number>;
    unaccounted: number | null;
  };
  witnesses: { built: Witnesses; conventional: Witnesses };
  // Every page's side under each split: the whole population, so nothing is recovered by subtraction.
  assignments: {
    built: { train: string[]; eval: string[] };
    conventional: { train: string[]; eval: string[]; dropped: string[] };
  };
};

export const SPLIT_SEED = 20261101;
// The seeds the stratified baseline is run at: fixed, so a figure names its draw.
export const STRATIFIED_SEEDS = [20261101, 20261102, 20261103, 20261104, 20261105] as const;
export async function compareSplit(
  dir: string,
  version = "1.0",
  progress: (line: string) => void = () => {},
): Promise<Result<SplitResultFigures>> {
  const name = `split-${version}`;
  const summaryFile = join(dir, "dataset", version, "summary.json");
  const membership = builtMembership(dir, version);
  const inputs = [...membership.inputs, describeInput("summary.json", summaryFile)];
  const absent = incompleteIfMissing(name, inputs);
  if (absent) return absent;
  if (membership.problems.length) return { status: "incomplete", name, inputs, missing: membership.problems };
  try {
    const { dhash, siteKey, shingles } = await import("./build-dataset.ts");
    const sides = new Map<string, Side>([
      ...membership.train.map((id) => [id, "train"] as [string, Side]),
      ...membership.eval.map((id) => [id, "eval"] as [string, Side]),
    ]);
    const pages: Page[] = [];
    const entries: string[] = [];
    const unreadable: string[] = [];
    let done = 0;
    for (const id of sides.keys()) {
      try {
        const files = pageFiles(dir, id);
        const meta = JSON.parse(files.meta) as {
          host: string | null;
          labels: { brand?: string | null; lure?: boolean; lure_type?: string | null };
        };
        pages.push({
          id,
          brand: meta.labels.brand ?? null,
          site: meta.host ? siteKey(meta.host) : null,
          lure: meta.labels.lure === true,
          lureType: meta.labels.lure === true ? (meta.labels.lure_type ?? null) : null,
          hash: await dhash(files.shot),
          words: shingles(files.text),
        });
        entries.push(pageLine(id, files));
      } catch (error) {
        unreadable.push(`${id} (${message(error).slice(0, 80)})`);
      }
      if (++done % 5000 === 0) progress(`${done} of ${sides.size} pages read`);
    }
    // A page the dataset names that cannot be read makes the comparison partial, not smaller.
    if (unreadable.length)
      return {
        status: "incomplete",
        name,
        inputs,
        missing: [`${unreadable.length} pages unreadable or malformed, first ${unreadable.slice(0, 3).join("; ")}`],
      };
    const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
      dropped?: Record<string, number>;
      freeze?: { pages?: number };
    };
    const dropped = summary.dropped ?? {};
    const frozen = summary.freeze?.pages ?? null;
    const evalShare = membership.eval.length / pages.length;
    const conventional = groupShuffleSplit(pages, seeded(SPLIT_SEED), evalShare);
    const idsOn = (a: Map<string, Side>, side: Side) => pages.filter((p) => a.get(p.id) === side).map((p) => p.id);
    const builtFigures = splitFigures(pages, sides);
    const stratified = STRATIFIED_SEEDS.map((seed) => {
      const builtEvalTypes = builtFigures.lure_types?.eval ?? {};
      const builtEvalLures = Object.values(builtEvalTypes).reduce((a, b) => a + b, 0);
      const assignment = stratifiedGroupSplit(
        pages,
        seeded(seed),
        evalShare,
        builtFigures.lure_share_eval ?? 0.5,
        Object.fromEntries(
          Object.entries(builtEvalTypes).map(([k, v]) => [k, builtEvalLures ? v / builtEvalLures : 0]),
        ),
      );
      const figures = splitFigures(pages, assignment);
      return {
        seed,
        figures,
        balance: balanceOf(builtFigures, figures),
        witnesses: leakWitnesses(pages, assignment),
        assignment: {
          train: idsOn(assignment, "train"),
          eval: idsOn(assignment, "eval"),
          dropped: pages.filter((p) => !assignment.has(p.id)).map((p) => p.id),
        },
      };
    });
    return {
      status: "complete",
      name,
      inputs: [...inputs, pagesInput(dir, entries)],
      figures: {
        built: builtFigures,
        conventional: splitFigures(pages, conventional),
        stratified,
        pages: pages.length,
        eval_share: evalShare,
        config: {
          seed: SPLIT_SEED,
          near_bits: NEAR_BITS,
          near_text: NEAR_TEXT,
          minhash_permutations: MINHASH_PERMUTATIONS,
          conventional:
            "group by brand identity, else site, else page; shuffle groups; fill the evaluation side to the built split's share; drop training pages that are near-duplicates of an evaluation page (screenshot hash and MinHash)",
          stratified:
            "the same whole groups, class-aware: each step takes the remaining whole group bringing the evaluation side nearest the built split's lure share and lure-type shares (training is the complement), near-duplicates of the evaluation side removed from training; run at the seeds listed in `stratified`",
          stratified_seeds: [...STRATIFIED_SEEDS],
          leaks_counted_by: "the build's own exact rule (screenshot hash and exact text Jaccard)",
        },
        population: {
          frozen,
          kept: pages.length,
          dropped_before_split: dropped,
          unaccounted:
            frozen === null ? null : frozen - pages.length - Object.values(dropped).reduce((a, b) => a + b, 0),
        },
        witnesses: { built: leakWitnesses(pages, sides), conventional: leakWitnesses(pages, conventional) },
        assignments: {
          built: { train: idsOn(sides, "train"), eval: idsOn(sides, "eval") },
          conventional: {
            train: idsOn(conventional, "train"),
            eval: idsOn(conventional, "eval"),
            dropped: pages.filter((p) => !conventional.has(p.id)).map((p) => p.id),
          },
        },
      },
    };
  } catch (error) {
    return { status: "incomplete", name, inputs, missing: [`the comparison could not run: ${message(error)}`] };
  }
}

// ---- The benign render against a conventional crawl-and-filter pipeline (§38) ---------------------------------------

export type BenignForm = "login" | "payment" | "none" | Unknown;
export type BenignLabel = {
  wall: boolean | Unknown;
  form: BenignForm;
  eligible: boolean | Unknown;
  eligibility_reason?: string;
  // Who assigned the label by viewing the page (absent on a pending label).
  source?: string;
};
// The capture an annotation was made from: replay must reproduce it before either pipeline is scored on the page.
export type ViewedCapture = {
  status: number;
  text: string;
  has_login_form: boolean;
  has_payment_form: boolean;
  title?: string;
  finalUrl?: string;
  overlays?: string;
  // The production renderer's wall evidence on the recorded visit (a CAPTCHA frame, a consent wall, a challenge or
  // image cover), and the screenshot an annotator viewed with its difference hash.
  walls?: { captcha: boolean; consentWall: boolean; challengeCover: boolean; imageCover: boolean };
  screenshot?: { file: string; sha256: string; dhash: string };
};
// What one pipeline's replay of a page showed, checked against the viewed capture before it is scored.
export type ReplayedCapture = Omit<ViewedCapture, "screenshot"> & { admitted: boolean; dhash?: string };
export type CorpusPage = {
  id: string;
  url: string;
  // The list context the page was listed under, so production admission keeps its brand, kind and allowed redirects.
  entry?: { kind: string; brand?: string; also: string[] };
  archive: Record<string, { status?: number; headers?: Record<string, string>; bodyBase64: string }>;
  viewed: ViewedCapture;
  label: BenignLabel;
};
export type BenignPipelinePage = {
  id: string;
  label: BenignLabel;
  replay_failure: boolean;
  replay_reason?: string;
  production: { admitted: boolean; form: BenignForm } | null;
  conventional: { admitted: boolean; form: BenignForm } | null;
};
// The vendor wording a conventional crawl-and-filter pipeline blocks on, pinned so a figure names its filter.
export const BENIGN_BLOCKLIST = [
  "just a moment",
  "verify you are human",
  "checking your browser",
  "are you a robot",
  "cloudflare",
  "captcha",
  "press & hold",
  "access denied",
] as const;
export const BENIGN_MIN_STRATUM = 20;
const evaluable = (v: unknown) => v !== "unknown" && v !== "disputed";
// Whether the corpus can support the comparison at all: each blocking stratum needs its minimum of evaluable
// pages. Payment forms and walls are reported, not blocking: the benign lists almost never show a payment form
// without a cart session (1 of 114 recorded pages, 3 of 8,734 stored benign pages), and a wall is transient at
// record time (10 of 177 recorded pages showed one, the October journal's wall exclusions mostly rendering clean
// today; both measured 2026-11-02), so a minimum there would make the comparison impossible rather than honest;
// the shortfalls stand in the figures.
export function benignCoverage(pages: CorpusPage[]): { strata: Record<string, number>; insufficient: string[] } {
  const strata: Record<string, number> = {
    walls: pages.filter((p) => p.label.wall === true).length,
    genuine: pages.filter((p) => p.label.eligible === true && p.label.wall === false).length,
    login_forms: pages.filter((p) => p.label.form === "login").length,
    payment_forms: pages.filter((p) => p.label.form === "payment").length,
  };
  return {
    strata,
    insufficient: Object.entries(strata)
      .filter(([k, n]) => k !== "payment_forms" && k !== "walls" && n < BENIGN_MIN_STRATUM)
      .map(([k, n]) => `${k} has ${n} evaluable pages, under the minimum ${BENIGN_MIN_STRATUM}`),
  };
}
// The form a capture shows, in the label's terms.
export const formOf = (c: { has_login_form: boolean; has_payment_form: boolean }): BenignForm =>
  c.has_payment_form ? "payment" : c.has_login_form ? "login" : "none";
// The conventional pipeline over a main-world read: HTTP 2xx, enough text, and no vendor blocklist wording.
export function conventionalBenign(
  c: Pick<ViewedCapture, "status" | "text" | "has_login_form" | "has_payment_form" | "title">,
): { admitted: boolean; form: BenignForm } {
  const text = `${c.title ?? ""}\n${c.text}`.toLowerCase();
  const admitted =
    c.status >= 200 && c.status <= 299 && c.text.trim().length >= 50 && !BENIGN_BLOCKLIST.some((w) => text.includes(w));
  return { admitted, form: formOf(c) };
}
export type BenignFigures = ReturnType<typeof scoreBenign>;
// Both pipelines on the same replayed pages. Retained is eligible pages admitted; contaminated is admitted pages
// annotated wall or ineligible; a mislabelled form is a shown form that differs from the annotated one.
export function scoreBenign(pages: BenignPipelinePage[]) {
  const scored = pages.filter((p) => !p.replay_failure);
  const pipeline = (key: "production" | "conventional") => {
    const rows = scored.filter((p) => p[key] !== null);
    const eligible = rows.filter((p) => p.label.eligible === true);
    const retained = eligible.filter((p) => p[key]?.admitted);
    const walls = rows.filter((p) => p.label.wall === true);
    const admittedWalls = walls.filter((p) => p[key]?.admitted);
    // Unresolved annotations (unknown or disputed) enter no rate: they are counted as uncertainty, never
    // treated as clean pages that dilute contamination.
    const admitted = rows.filter((p) => p[key]?.admitted && evaluable(p.label.eligible) && evaluable(p.label.wall));
    const contaminated = admitted.filter((p) => p.label.wall === true || p.label.eligible === false);
    const forms = rows.filter((p) => evaluable(p.label.form));
    const mislabelled = forms.filter((p) => p[key]?.form !== p.label.form);
    const rate = (k: number, n: number) => ({ k, n, rate: n ? k / n : null, interval: wilson(k, n) });
    return {
      retained: rate(retained.length, eligible.length),
      admitted_walls: rate(admittedWalls.length, walls.length),
      contaminated: rate(contaminated.length, admitted.length),
      mislabelled_forms: rate(mislabelled.length, forms.length),
    };
  };
  return {
    pages: pages.length,
    replay_failures: pages.length - scored.length,
    unresolved: {
      wall: scored.filter((p) => !evaluable(p.label.wall)).length,
      eligible: scored.filter((p) => !evaluable(p.label.eligible)).length,
      form: scored.filter((p) => !evaluable(p.label.form)).length,
    },
    config: { blocklist: [...BENIGN_BLOCKLIST], min_stratum: BENIGN_MIN_STRATUM },
    production: pipeline("production"),
    conventional: pipeline("conventional"),
  };
}
// Where a replayed capture differs from the viewed one in anything admission or a label reads: the status, the
// visible text (word-shingle Jaccard at the near-duplicate threshold: a rotating banner or a date line is not a
// different page), the forms, the title, the final URL, the wall evidence, and the picture itself (difference hash
// within the near-duplicate distance), so an image-based challenge that replay lost is a mismatch even when the text
// and forms hold. A field the viewed capture did not record is not compared.
export function replayMismatches(viewed: ViewedCapture, got: ReplayedCapture): string[] {
  const reasons: string[] = [];
  if (got.status !== viewed.status) reasons.push(`status ${got.status} against viewed ${viewed.status}`);
  if (jaccard(shingles(got.text), shingles(viewed.text)) < NEAR_TEXT)
    reasons.push("visible text differs from the viewed capture");
  if (got.has_login_form !== viewed.has_login_form || got.has_payment_form !== viewed.has_payment_form)
    reasons.push("forms differ from the viewed capture");
  if (viewed.title !== undefined && got.title !== viewed.title) reasons.push("title differs from the viewed capture");
  if (viewed.finalUrl !== undefined && got.finalUrl !== viewed.finalUrl)
    reasons.push(`landed on ${got.finalUrl ?? "nothing"} against viewed ${viewed.finalUrl}`);
  if (viewed.overlays !== undefined) {
    const vOverlays = viewed.overlays.trim();
    const gOverlays = (got.overlays ?? "").trim();
    if (
      Boolean(vOverlays) !== Boolean(gOverlays) ||
      (vOverlays && jaccard(shingles(gOverlays), shingles(vOverlays)) < NEAR_TEXT)
    )
      reasons.push("overlays differ from the viewed capture");
  }
  if (viewed.walls) {
    const changed = (Object.keys(viewed.walls) as (keyof NonNullable<ViewedCapture["walls"]>)[]).filter(
      (k) => got.walls?.[k] !== viewed.walls?.[k],
    );
    if (changed.length) reasons.push(`wall evidence differs from the viewed capture (${changed.join(", ")})`);
  }
  if (viewed.screenshot) {
    const distance = got.dhash ? hamming(BigInt(`0x${got.dhash}`), BigInt(`0x${viewed.screenshot.dhash}`)) : null;
    if (distance === null || distance > NEAR_BITS)
      reasons.push(`the picture differs from the viewed screenshot (${distance ?? "no"} bits)`);
  }
  return reasons;
}
export const corpusDir = (dir: string) => join(dir, "runs", "compare", "corpus");
export const corpusPageFile = (dir: string, id: string) => join(corpusDir(dir), "pages", `${id}.json`);
// The corpus is a manifest (`corpus.json`, naming each page file and its sha256) plus one file a page: a single
// file for the whole corpus exceeds the runtime's string limit once archives are embedded.
export function readCorpus(dir: string): {
  pages: CorpusPage[];
  seed: number | null;
  file: string;
  pageFiles: { id: string; file: string }[];
} {
  const file = join(corpusDir(dir), "corpus.json");
  if (!existsSync(file)) return { pages: [], seed: null, file, pageFiles: [] };
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
    seed?: number;
    pages?: CorpusPage[];
    page_files?: { id: string; sha256?: string }[];
  };
  if (parsed.page_files) {
    // One page file per id: a manifest naming an id twice would score one file as two observations.
    const repeated = parsed.page_files.map((p) => p.id).filter((id, i, ids) => ids.indexOf(id) !== i);
    if (repeated.length)
      throw new Error(`the benign corpus manifest names ${[...new Set(repeated)].join(", ")} more than once`);
    return {
      pages: parsed.page_files.map((p) => {
        const raw = readFileSync(corpusPageFile(dir, p.id));
        if (p.sha256 && sha(raw) !== p.sha256)
          throw new Error(`benign corpus page ${p.id} does not match the manifest's sha256`);
        const page = JSON.parse(raw.toString("utf-8")) as CorpusPage;
        const label = page.label as BenignLabel | undefined;
        if (
          !label ||
          !(label.wall === true || label.wall === false || label.wall === "unknown" || label.wall === "disputed") ||
          !["login", "payment", "none", "unknown", "disputed"].includes(label.form) ||
          !(
            label.eligible === true ||
            label.eligible === false ||
            label.eligible === "unknown" ||
            label.eligible === "disputed"
          )
        )
          throw new Error(`benign corpus page ${p.id} has no valid wall, form and eligibility label`);
        return page;
      }),
      seed: parsed.seed ?? null,
      file,
      pageFiles: parsed.page_files.map((p) => ({ id: p.id, file: corpusPageFile(dir, p.id) })),
    };
  }
  return { pages: parsed.pages ?? [], seed: parsed.seed ?? null, file, pageFiles: [] };
}
// Run both pipelines over the recorded corpus. The production side renders each page through the replay seam and
// applies `unusable()` unchanged; a replayed capture that differs from the viewed one is a replay failure, counted
// apart and never scored. An injected renderer keeps the test off the browser.
export async function compareBenign(
  dir: string,
  renderPage?: (page: CorpusPage) => Promise<ReplayedCapture>,
): Promise<
  Result<BenignFigures & { seed: number | null; strata: Record<string, number>; decisions: BenignPipelinePage[] }>
> {
  const name = "benign";
  let corpus: ReturnType<typeof readCorpus>;
  try {
    corpus = readCorpus(dir);
  } catch (error) {
    // A malformed corpus is a structured refusal naming the file, never a crash.
    return {
      status: "incomplete",
      name,
      inputs: [describeInput("benign corpus manifest", join(corpusDir(dir), "corpus.json"))],
      missing: [`the benign corpus cannot be read: ${message(error)}`],
    };
  }
  const { pages, seed, file, pageFiles } = corpus;
  // One combined digest over every page file, so the result names the whole corpus in one input while a changed
  // or missing archive body, viewed capture or label still changes it (and a missing file names itself).
  const pageInputs = pageFiles.map((p) => describeInput(`benign corpus page ${p.id}`, p.file));
  const missingPage = pageInputs.find((i) => i.sha256 === null);
  const combined: Input = {
    name: `benign corpus pages (${pageFiles.length} files: archives, viewed captures, labels)`,
    path: join(corpusDir(dir), "pages"),
    sha256: missingPage ? null : sha(pageInputs.map((i) => `${i.name} ${i.sha256}`).join("\n")),
    bytes: pageInputs.reduce((a, i) => a + (i.bytes ?? 0), 0),
    ...(missingPage ? { error: `a corpus page file is missing or unreadable: ${missingPage.name}` } : {}),
  };
  const inputs = [describeInput("benign corpus manifest", file), combined];
  const missing = incompleteIfMissing(name, inputs);
  if (missing) return missing;
  const coverage = benignCoverage(pages);
  if (coverage.insufficient.length) return { status: "incomplete", name, inputs, missing: coverage.insufficient };
  const { openRenderer, replayResponder, unusable } = await import("./render.ts");
  const { dhash } = await import("./build-dataset.ts");
  const { chromium } = await import("playwright-core");
  const { chromiumPath } = await import("../lib/chromium.ts");
  // One production renderer and one plain browser for the whole run. The conventional pipeline reads the main
  // world itself (its own navigation, text and form reads over the same archive), never the production capture.
  const executablePath = chromiumPath();
  const browser =
    renderPage || !executablePath ? null : await chromium.launch({ executablePath, chromiumSandbox: true });
  const conventionalRead = async (page: CorpusPage): Promise<ViewedCapture & { title?: string }> => {
    if (!browser) throw new Error("no browser for the conventional read");
    const context = await browser.newContext();
    const respond = replayResponder(page.archive);
    try {
      await context.route("**/*", async (route) => {
        const req = route.request();
        const entry = respond(req.url(), req.method(), req.postData() ?? "");
        if (!entry) return route.abort();
        return route.fulfill({
          status: entry.status ?? 200,
          headers: entry.headers ?? {},
          body: Buffer.from(entry.bodyBase64, "base64"),
        });
      });
      const tab = await context.newPage();
      const response = await tab.goto(page.url, { waitUntil: "load", timeout: 20_000 }).catch(() => null);
      // Main-world reads in the page and every frame it shows: a sign-in form inside a frame is still shown.
      const read = await tab.evaluate(() => ({
        // biome-ignore lint/performance/useDomNodeTextContent: conventional crawler reads rendered text
        text: document.body?.innerText ?? "",
        title: document.title,
        has_login_form: false,
        has_payment_form: false,
      }));
      for (const frame of tab.frames()) {
        const forms = await frame
          .evaluate(() => {
            const inputs = [...document.querySelectorAll("input")];
            return {
              has_login_form: inputs.some((i) => ["password", "email"].includes(i.type)),
              has_payment_form: inputs.some(
                (i) => i.autocomplete === "cc-number" || i.name.toLowerCase().includes("card"),
              ),
            };
          })
          .catch(() => ({ has_login_form: false, has_payment_form: false }));
        read.has_login_form = read.has_login_form || forms.has_login_form;
        read.has_payment_form = read.has_payment_form || forms.has_payment_form;
      }
      return { status: response?.status() ?? 0, ...read };
    } finally {
      await context.close();
    }
  };
  const replaying = renderPage ? null : await openRenderer({ replay: {} });
  const rows: BenignPipelinePage[] = new Array(pages.length);
  try {
    let next = 0;
    const worker = async () => {
      while (next < pages.length) {
        const index = next++;
        const page = pages[index] as CorpusPage;
        try {
          // One page's replay is bounded: a hung render or read is that page's replay failure, never the run's.
          const work = (async (): Promise<ReplayedCapture> =>
            renderPage
              ? await renderPage(page)
              : await (async () => {
                  if (!replaying) throw new Error("no renderer for replay");
                  const capture = await replaying.render(page.url, { replay: page.archive });
                  const entry = page.entry ?? { kind: "home", also: [] as string[] };
                  return {
                    status: capture.status,
                    text: capture.text,
                    title: capture.title,
                    finalUrl: capture.finalUrl,
                    overlays: capture.overlays,
                    has_login_form: capture.has_login_form,
                    has_payment_form: capture.has_payment_form,
                    walls: {
                      captcha: capture.captcha,
                      consentWall: capture.consentWall,
                      challengeCover: capture.challengeCover,
                      imageCover: capture.imageCover,
                    },
                    dhash: (await dhash(capture.screenshot)).toString(16).padStart(16, "0"),
                    admitted:
                      unusable(capture, {
                        url: page.url,
                        kind: entry.kind as ListEntry["kind"],
                        ...(entry.brand ? { brand: entry.brand } : {}),
                        also: entry.also ?? [],
                      }) === null,
                  };
                })())();
          const got = await Promise.race([
            work,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("the replay passed 60 seconds")), 60_000),
            ),
          ]);
          // Fidelity: the same status and forms, and substantially the same visible text (word-shingle Jaccard at
          // the near-duplicate threshold). Exact text equality would fail every page with a rotating banner or a
          // date line, which is a different page in no respect that scoring cares about.
          const reasons: string[] = [];
          reasons.push(...replayMismatches(page.viewed, got));
          const replayFailure = reasons.length > 0;
          rows[index] = {
            id: page.id,
            label: page.label,
            replay_failure: replayFailure,
            ...(replayFailure ? { replay_reason: reasons.join("; ") } : {}),
            production: replayFailure ? null : { admitted: got.admitted, form: formOf(got) },
            conventional: replayFailure
              ? null
              : conventionalBenign(
                  renderPage
                    ? got
                    : await Promise.race([
                        conventionalRead(page),
                        new Promise<never>((_, reject) =>
                          setTimeout(() => reject(new Error("the conventional read passed 60 seconds")), 60_000),
                        ),
                      ]),
                ),
          };
        } catch (error) {
          rows[index] = {
            id: page.id,
            label: page.label,
            replay_failure: true,
            replay_reason: `the replay render failed: ${message(error).split("\n")[0]}`,
            production: null,
            conventional: null,
          };
        }
      }
    };
    await Promise.all(Array.from({ length: renderPage ? 1 : Math.min(4, Math.max(1, pages.length)) }, worker));
  } finally {
    if (replaying) await replaying.close();
    if (browser) await browser.close();
  }
  // Scored coverage: replay may thin a stratum below its minimum, and then the comparison has not measured it.
  const scoredCoverage = benignCoverage(
    rows.filter((r) => !r.replay_failure).map((r) => ({ label: r.label }) as CorpusPage),
  );
  if (scoredCoverage.insufficient.length)
    return {
      status: "incomplete",
      name,
      inputs,
      missing: scoredCoverage.insufficient.map((s) => `after replay, ${s}`),
    };
  return {
    status: "complete",
    name,
    inputs,
    figures: { ...scoreBenign(rows), seed, strata: coverage.strata, decisions: rows },
  };
}

export const SAMPLE_SIZE = 40;
export const SAMPLE_SEED = 20261101;

// The pages to annotate: a fixed-seed draw from the independent reference set, ids sorted so the draw replays.
export function annotationSample(dir: string, size = SAMPLE_SIZE, seed = SAMPLE_SEED): string[] {
  const reference = JSON.parse(readFileSync(join(dir, "raw", "dataset", "reference.json"), "utf-8")) as {
    pages: string[];
  };
  const ids = [...reference.pages].sort();
  const random = seeded(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
  }
  return ids.slice(0, size).sort();
}
export const annotationsFile = (dir: string) => join(dir, "runs", "compare", "annotations.jsonl");

const judged = (value: unknown, allowed: (v: unknown) => boolean) =>
  value === "unknown" || value === "disputed" || allowed(value);
// Every sampled page has exactly one annotation that judges all three fields (a value, `unknown` or `disputed`).
export function validateAnnotations(sample: string[], annotations: Annotation[]): string[] {
  const problems: string[] = [];
  const count = new Map<string, number>();
  for (const a of annotations) count.set(a.id, (count.get(a.id) ?? 0) + 1);
  const duplicated = sample.filter((id) => (count.get(id) ?? 0) > 1);
  if (duplicated.length)
    problems.push(
      `${duplicated.length} sampled pages are annotated more than once, first ${duplicated.slice(0, 3).join(", ")}`,
    );
  const absent = sample.filter((id) => !count.has(id));
  if (absent.length)
    problems.push(`${absent.length} sampled pages have no annotation, first ${absent.slice(0, 3).join(", ")}`);
  const invalid = annotations.filter(
    (a) =>
      sample.includes(a.id) &&
      !(
        judged(a.brand, (v) => v === null || typeof v === "string") &&
        a.brand !== undefined &&
        judged(a.lure_type, (v) => (LURE_TYPES as readonly unknown[]).includes(v)) &&
        a.lure_type !== undefined &&
        judged(a.lure, (v) => typeof v === "boolean") &&
        a.lure !== undefined
      ),
  );
  if (invalid.length)
    problems.push(
      `${invalid.length} annotations do not judge every field, first ${invalid
        .slice(0, 3)
        .map((a) => a.id)
        .join(", ")}`,
    );
  return problems;
}

export type Outcome = "right" | "wrong" | "unretained" | "unknown" | "disputed";
export type LabelPage = {
  id: string;
  annotation: Annotation;
  finished: Labels;
  source: Labels;
  outcomes: Record<string, Record<Field, Outcome>>;
};
export function outcomeOf(field: Field, truth: unknown, label: unknown): Outcome {
  if (truth === "unknown" || truth === "disputed") return truth;
  if (label === undefined) return "unretained";
  return same(field, label, truth) ? "right" : "wrong";
}

// The finished labels (rule, teacher and source together) against the labels a source itself gave, each scored against the
// annotations made by viewing the pages.
export function compareLabels(dir: string): Result<{
  sample: number;
  annotated: number;
  sets: LabelFigures;
  pages: LabelPage[];
  config: Record<string, unknown>;
}> {
  const file = annotationsFile(dir);
  const reference = join(dir, "raw", "dataset", "reference.json");
  const inputs = [describeInput("annotations", file), describeInput("reference set", reference)];
  const absent = incompleteIfMissing("labels", inputs);
  if (absent) return absent;
  try {
    const annotations = lines(file).map((line) => JSON.parse(line) as Annotation);
    const sample = annotationSample(dir);
    const problems = validateAnnotations(sample, annotations);
    if (problems.length) return { status: "incomplete", name: "labels", inputs, missing: problems };
    const chosen = sample.map((id) => annotations.find((a) => a.id === id) as Annotation);
    const finished = new Map<string, Labels>();
    const source = new Map<string, Labels>();
    const entries: string[] = [];
    const missingPages: string[] = [];
    for (const id of sample) {
      let files: PageRead;
      try {
        files = pageFiles(dir, id);
      } catch (error) {
        missingPages.push(`${id} (${message(error).slice(0, 60)})`);
        continue;
      }
      entries.push(pageLine(id, files));
      const meta = JSON.parse(files.meta) as { labels: Labels; label_source: Record<string, string> };
      finished.set(id, meta.labels);
      // The source's own labels: only the fields it gave (ground truth), not a rule's or the teacher's fill-in.
      const own: Labels = {};
      for (const field of FIELDS)
        if (meta.label_source[field] === "ground-truth" && meta.labels[field] !== undefined)
          (own as Record<string, unknown>)[field] = meta.labels[field];
      source.set(id, own);
    }
    if (missingPages.length)
      return {
        status: "incomplete",
        name: "labels",
        inputs,
        missing: [`${missingPages.length} sampled pages cannot be read, first ${missingPages.slice(0, 3).join("; ")}`],
      };
    const sets = { finished, source };
    const pages: LabelPage[] = chosen.map((annotation) => ({
      id: annotation.id,
      annotation,
      finished: finished.get(annotation.id) as Labels,
      source: source.get(annotation.id) as Labels,
      outcomes: Object.fromEntries(
        Object.entries(sets).map(([set, map]) => [
          set,
          Object.fromEntries(
            FIELDS.map((f) => [f, outcomeOf(f, annotation[f], map.get(annotation.id)?.[f])]),
          ) as Record<Field, Outcome>,
        ]),
      ),
    }));
    return {
      status: "complete",
      name: "labels",
      inputs: [...inputs, pagesInput(dir, entries)],
      figures: {
        sample: sample.length,
        annotated: chosen.length,
        sets: scoreLabels(chosen, sets),
        pages,
        config: {
          sample_size: SAMPLE_SIZE,
          seed: SAMPLE_SEED,
          drawn_from: "raw/dataset/reference.json",
          annotated_by: "viewing each page's screenshot and text, independently of every stored label",
        },
      },
    };
  } catch (error) {
    return {
      status: "incomplete",
      name: "labels",
      inputs,
      missing: [`the comparison could not run: ${message(error)}`],
    };
  }
}

// ---- Checking a saved result -----------------------------------------------------------------------------------------

export type Check = { name: string; status: "current" | "stale" | "missing"; changed: string[] };
// Whether a saved result's recorded inputs still are what they were: every file input re-hashed, and the page files
// re-read and re-digested. Nothing is recomputed, so a `stale` says what changed, not what the figures would now be.
export function checkResult(dir: string, name: string): Check {
  const file = resultFile(dir, name);
  if (!existsSync(file)) return { name, status: "missing", changed: [] };
  const saved = JSON.parse(readFileSync(file, "utf-8")) as Result<unknown>;
  // A comparison that could not finish has no figures to be current: automation never accepts it, and it stays
  // refused until a complete result replaces it, whatever its recorded inputs still hash to.
  if (saved.status === "incomplete")
    return { name, status: "stale", changed: [`the saved result is incomplete: ${saved.missing.join("; ")}`] };
  const changed: string[] = [];
  const ids: string[] | null =
    name === "labels"
      ? annotationSample(dir)
      : (() => {
          const m = builtMembership(dir, name.replace(/^split-/, ""));
          return m.problems.length ? null : [...m.train, ...m.eval];
        })();
  for (const input of saved.inputs) {
    if (input.name.startsWith("page files")) {
      if (!ids) {
        changed.push(`${input.name}: the membership can no longer be read`);
        continue;
      }
      try {
        const entries = ids.map((id) => pageLine(id, pageFiles(dir, id)));
        if (pagesInput(dir, entries).sha256 !== input.sha256) changed.push(input.name);
      } catch (error) {
        changed.push(`${input.name}: ${message(error)}`);
      }
    } else if (name === "benign" && input.name.startsWith("benign corpus pages")) {
      // Recompute the combined corpus digest from the manifest's page files (§38).
      try {
        const { pageFiles } = readCorpus(dir);
        const digests = pageFiles.map((p) => describeInput(`benign corpus page ${p.id}`, p.file));
        const combined = digests.some((d) => d.sha256 === null)
          ? null
          : sha(digests.map((d) => `${d.name} ${d.sha256}`).join("\n"));
        if (combined !== input.sha256) changed.push(input.name);
      } catch (error) {
        changed.push(`${input.name}: ${message(error)}`);
      }
    } else if (describeInput(input.name, input.path).sha256 !== input.sha256) changed.push(input.name);
  }
  return { name, status: changed.length ? "stale" : "current", changed };
}

// ---- The record --------------------------------------------------------------------------------------------------------

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const ci = (f: { low: number; high: number }) => `${pct(f.low)} to ${pct(f.high)}`;

// A comparison's result as the line `docs/glimmer/training.md` records, derived from the result and from nothing else.
// Its first words carry the result file's own digest, so changed figures write a new line and an unchanged result none.
export function measurementLine(result: Result<unknown>, date: string, resultSha: string): string {
  const digest = result.inputs.map((i) => `${i.name.split(" (")[0]} ${i.sha256?.slice(0, 12) ?? "missing"}`).join(", ");
  const id = `result ${resultSha.slice(0, 12)}; inputs: ${digest}`;
  if (result.status === "incomplete")
    return `- ${date}, ${result.name} comparison INCOMPLETE (D03 T04 §31; ${id}): ${result.missing.join("; ")}.`;
  if (result.name === "labels") {
    const f = (result as Complete<{ sample: number; annotated: number; sets: LabelFigures }>).figures;
    const row = (set: string) =>
      FIELDS.map((field) => {
        const x = f.sets[set]?.[field] as FieldFigures;
        return `${field} ${x.wrong} wrong of ${x.retained} labelled (error ${pct(x.error)}, 95% ${ci(x.interval)}; coverage ${pct(x.coverage)} of ${x.annotated} judged; ${x.unknown} unknown, ${x.disputed} disputed)`;
      }).join("; ");
    return `- ${date}, labels against annotations (D03 T04 §31; \`node scripts/glimmer/compare-pipelines.ts labels\`, result \`runs/compare/labels.json\`; ${id}): ${f.sample} pages drawn from the independent reference set with seed ${SAMPLE_SEED} and annotated by viewing each page (brand, lure type and lure judged independently; a lure the page alone cannot show is \`unknown\`). Finished labels (rule, teacher and source together): ${row("finished")}. The source's own labels alone: ${row("source")}. Every page's annotation, labels and outcome are in the result file.`;
  }
  if (result.name === "benign") {
    const f = (result as Complete<BenignFigures & { seed: number | null; strata: Record<string, number> }>).figures;
    const row = (p: BenignFigures["production"]) =>
      `retained ${p.retained.k} of ${p.retained.n} eligible (95% ${ci(p.retained.interval)}), admitted walls ${p.admitted_walls.k} of ${p.admitted_walls.n} (95% ${ci(p.admitted_walls.interval)}), contaminated ${p.contaminated.k} of ${p.contaminated.n} admitted (95% ${ci(p.contaminated.interval)}), mislabelled forms ${p.mislabelled_forms.k} of ${p.mislabelled_forms.n} (95% ${ci(p.mislabelled_forms.interval)})`;
    return `- ${date}, the benign render against a conventional crawl-and-filter pipeline (D03 T04 §38; \`node scripts/glimmer/compare-pipelines.ts benign\`, result \`runs/compare/benign.json\`; ${id}): ${f.pages} recorded pages (seed ${f.seed ?? "n/a"}; strata ${Object.entries(
      f.strata,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ", ",
      )}), ${f.replay_failures} replay failures counted apart. Production renderer: ${row(f.production)}. Conventional (main-world reads, vendor-wording blocklist pinned in the result): ${row(f.conventional)}.`;
  }
  const f = (result as Complete<SplitResultFigures>).figures;
  const typesOf = (x: SplitFigures, s: "train" | "eval") =>
    Object.entries(x.lure_types?.[s] ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(" ");
  const side = (x: SplitFigures) =>
    `train ${x.train}, eval ${x.eval}, ${x.dropped} dropped, eval lure share ${pct(x.lure_share_eval)}, train lure share ${pct(x.lure_share_train ?? null)}, ${x.cross_brand} brands, ${x.cross_site} sites and ${x.near_duplicate_eval_pages} eval pages with a near-duplicate across the sides, eval lure types ${typesOf(x, "eval")}, train lure types ${typesOf(x, "train")}`;
  const population = f.population;
  return `- ${date}, §10's split against group-shuffle with MinHash near-duplicate removal (D03 T04 §31; \`node scripts/glimmer/compare-pipelines.ts split\`, result \`runs/compare/${result.name}.json\`; ${id}): both split the same ${f.pages} pages, the ones the build kept after its own selection (frozen ${population.frozen ?? "n/a"}; dropped before the split: ${Object.entries(
    population.dropped_before_split,
  )
    .map(([k, v]) => `${k} ${v}`)
    .join(
      ", ",
    )}; unaccounted ${population.unaccounted ?? "n/a"}), so this compares the split step only. §10: ${side(f.built)}. Group-shuffle (brand else site groups, seed ${SPLIT_SEED}, the same eval share ${pct(f.eval_share)}, near-duplicates of eval removed from training by screenshot hash within ${NEAR_BITS} bits and MinHash ${MINHASH_PERMUTATIONS} permutations at ${NEAR_TEXT}; leaks counted by the build's exact rule): ${side(f.conventional)}. Stratified grouped baseline (the same groups, aiming at the build's evaluation lure share of ${pct(f.built.lure_share_eval)} within ${BALANCE_TOLERANCE * 100} share points; a seed outside it is called UNMET): ${f.stratified
    .map(
      (x) =>
        `seed ${x.seed}: ${side(x.figures)}, share gap ${(x.balance.share_gap * 100).toFixed(1)} points, train share gap ${((x.balance.train_share_gap ?? 0) * 100).toFixed(1)} points, eval type gaps ${Object.entries(
          x.balance.type_share_gap,
        )
          .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}`)
          .join(" ")}, train type gaps ${Object.entries(x.balance.train_type_share_gap ?? {})
          .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}`)
          .join(" ")} (${x.balance.within_tolerance ? "met" : "UNMET"})`,
    )
    .join(" | ")}. The brands, sites and pages behind every figure are in the result file.`;
}

// Records a result under `## Measurements` unless a line with its digests is already there; null when nothing is new.
export function recordMeasurement(doc: string, line: string): string | null {
  const marker = line.slice(line.indexOf("("), line.indexOf("):") + 2);
  if (doc.includes(marker)) return null;
  const at = doc.indexOf("## Measurements\n");
  if (at < 0) throw new Error("docs/glimmer/training.md has no Measurements section");
  const start = at + "## Measurements\n".length;
  return `${doc.slice(0, start)}\n${line}\n${doc.slice(start)}`;
}

export const REPORTED = ["labels", "split-1.0", "benign"] as const;
// Records every required result, or none: a result that is missing stops the report and is named.
export function report(dir: string, doc: string, date: string): { text: string; written: number } {
  const missing = REPORTED.filter((name) => !existsSync(resultFile(dir, name)));
  if (missing.length) throw new Error(`no result for ${missing.join(", ")}; run those comparisons first`);
  let text = doc;
  let written = 0;
  for (const name of REPORTED) {
    const raw = readFileSync(resultFile(dir, name));
    const next = recordMeasurement(
      text,
      measurementLine(JSON.parse(raw.toString()) as Result<unknown>, date, sha(raw)),
    );
    if (next) {
      text = next;
      written++;
    }
  }
  return { text, written };
}

// The command line: one command, and `--check` only where it means something; anything else is usage.
export function parseArgs(
  args: string[],
): { command: "split" | "labels" | "sample" | "report" | "benign"; check: boolean } | null {
  const [command, ...rest] = args;
  if (
    command !== "split" &&
    command !== "labels" &&
    command !== "sample" &&
    command !== "report" &&
    command !== "benign"
  )
    return null;
  if (!rest.length) return { command, check: false };
  if (
    rest.length === 1 &&
    rest[0] === "--check" &&
    (command === "split" || command === "labels" || command === "benign")
  )
    return { command, check: true };
  return null;
}
export const USAGE =
  "usage: node scripts/glimmer/compare-pipelines.ts <split|labels|benign> [--check] | sample | report";

if (import.meta.filename === process.argv[1]) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exit(2);
  }
  const { storeDir } = await import("./store.ts");
  const dir = storeDir();
  const { command } = parsed;
  if (parsed.check) {
    const check = checkResult(dir, command === "labels" ? "labels" : command === "benign" ? "benign" : "split-1.0");
    console.log(JSON.stringify(check, null, 2));
    process.exit(check.status === "current" ? 0 : 1);
  }
  if (command === "split" || command === "labels" || command === "benign") {
    const result =
      command === "labels"
        ? compareLabels(dir)
        : command === "benign"
          ? await compareBenign(dir)
          : await compareSplit(dir, "1.0", (line) => console.error(`compare: ${line}`));
    writeResult(resultFile(dir, result.name), result);
    console.log(
      JSON.stringify(
        {
          name: result.name,
          status: result.status,
          ...(result.status === "incomplete" ? { missing: result.missing } : {}),
        },
        null,
        2,
      ),
    );
    process.exit(result.status === "complete" ? 0 : 1);
  }
  if (command === "sample") {
    for (const id of annotationSample(dir)) console.log(id);
    process.exit(0);
  }
  try {
    const doc = join(process.cwd(), "docs", "glimmer", "training.md");
    const done = report(dir, readFileSync(doc, "utf-8"), new Date().toISOString().slice(0, 10));
    writeFileSync(`${doc}.tmp`, done.text);
    renameSync(`${doc}.tmp`, doc);
    console.log(JSON.stringify({ written: done.written }));
  } catch (error) {
    console.error(`compare: ${message(error)}`);
    process.exit(1);
  }
}
