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
import { brandIdentity, hamming, jaccard, NEAR_BITS, NEAR_TEXT } from "./build-dataset.ts";

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
  hash: bigint; // 64-bit difference hash of the screenshot
  words: Uint32Array; // sorted distinct text shingles
};
export type Side = "train" | "eval";

export type SplitFigures = {
  train: number;
  eval: number;
  dropped: number;
  lure_share_eval: number | null;
  cross_brand: number; // brands on both sides
  cross_site: number; // sites on both sides
  near_duplicate_eval_pages: number; // eval pages with a near-duplicate in train
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
    cross_brand: [...brands(evals)].filter((b) => trainBrands.has(b)).length,
    cross_site: [...sites(evals)].filter((s) => trainSites.has(s)).length,
    near_duplicate_eval_pages: evals.filter((p) => findNear(p) !== null).length,
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

// The stronger baseline (§39): the same whole groups, but each side's lure share is matched to the built split's, so the
// comparison does not credit §10 for a balance a conventional split also reaches. Groups are drawn in turn from the
// lure-leaning and the benign-leaning ones, whichever keeps the evaluation side's lure share nearest the target, and
// near-duplicates of the evaluation side are then removed from training as in the plain baseline.
export function stratifiedGroupSplit(
  pages: Page[],
  random: () => number,
  evalShare: number,
  targetLureShare: number,
): Map<string, Side> {
  const groups = new Map<string, Page[]>();
  for (const page of pages) {
    const key = page.brand ? `brand:${brandIdentity(page.brand)}` : page.site ? `site:${page.site}` : `page:${page.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(page);
  }
  const shuffled = (keys: string[]) => {
    const out = [...keys].sort();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j] as string, out[i] as string];
    }
    return out;
  };
  const lureShare = (key: string) =>
    (groups.get(key) ?? []).filter((p) => p.lure).length / (groups.get(key)?.length || 1);
  const all = [...groups.keys()];
  const leaning = shuffled(all.filter((k) => lureShare(k) >= 0.5));
  const benign = shuffled(all.filter((k) => lureShare(k) < 0.5));
  const target = Math.round(pages.length * evalShare);
  const assignment = new Map<string, Side>();
  let held = 0;
  let heldLures = 0;
  for (const page of pages) assignment.set(page.id, "train");
  while (held < target && (leaning.length || benign.length)) {
    const wantLure = held === 0 ? targetLureShare >= 0.5 : heldLures / held < targetLureShare;
    const key = (wantLure ? (leaning.shift() ?? benign.shift()) : (benign.shift() ?? leaning.shift())) as string;
    for (const page of groups.get(key) ?? []) {
      assignment.set(page.id, "eval");
      held++;
      if (page.lure) heldLures++;
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
  stratified: { seed: number; figures: SplitFigures; witnesses: Witnesses }[];
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
          labels: { brand?: string | null; lure?: boolean };
        };
        pages.push({
          id,
          brand: meta.labels.brand ?? null,
          site: meta.host ? siteKey(meta.host) : null,
          lure: meta.labels.lure === true,
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
    const builtFigures = splitFigures(pages, sides);
    const stratified = STRATIFIED_SEEDS.map((seed) => {
      const assignment = stratifiedGroupSplit(pages, seeded(seed), evalShare, builtFigures.lure_share_eval ?? 0.5);
      return { seed, figures: splitFigures(pages, assignment), witnesses: leakWitnesses(pages, assignment) };
    });
    const idsOn = (a: Map<string, Side>, side: Side) => pages.filter((p) => a.get(p.id) === side).map((p) => p.id);
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
            "the same whole groups, each side's lure share matched to the built split's (groups drawn from the lure-leaning and benign-leaning ones to keep the evaluation lure share on target), near-duplicates of the evaluation side removed from training; run at the seeds listed in `stratified`",
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
  const f = (result as Complete<SplitResultFigures>).figures;
  const side = (x: SplitFigures) =>
    `train ${x.train}, eval ${x.eval}, ${x.dropped} dropped, eval lure share ${pct(x.lure_share_eval)}, ${x.cross_brand} brands, ${x.cross_site} sites and ${x.near_duplicate_eval_pages} eval pages with a near-duplicate across the sides`;
  const population = f.population;
  return `- ${date}, §10's split against group-shuffle with MinHash near-duplicate removal (D03 T04 §31; \`node scripts/glimmer/compare-pipelines.ts split\`, result \`runs/compare/${result.name}.json\`; ${id}): both split the same ${f.pages} pages, the ones the build kept after its own selection (frozen ${population.frozen ?? "n/a"}; dropped before the split: ${Object.entries(
    population.dropped_before_split,
  )
    .map(([k, v]) => `${k} ${v}`)
    .join(
      ", ",
    )}; unaccounted ${population.unaccounted ?? "n/a"}), so this compares the split step only. §10: ${side(f.built)}. Group-shuffle (brand else site groups, seed ${SPLIT_SEED}, the same eval share ${pct(f.eval_share)}, near-duplicates of eval removed from training by screenshot hash within ${NEAR_BITS} bits and MinHash ${MINHASH_PERMUTATIONS} permutations at ${NEAR_TEXT}; leaks counted by the build's exact rule): ${side(f.conventional)}. Stratified grouped baseline (the same groups, lure share matched to the build's ${pct(f.built.lure_share_eval)}): ${f.stratified.map((x) => `seed ${x.seed}: ${side(x.figures)}`).join(" | ")}. The brands, sites and pages behind every figure are in the result file.`;
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

export const REPORTED = ["labels", "split-1.0"] as const;
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
): { command: "split" | "labels" | "sample" | "report"; check: boolean } | null {
  const [command, ...rest] = args;
  if (command !== "split" && command !== "labels" && command !== "sample" && command !== "report") return null;
  if (!rest.length) return { command, check: false };
  if (rest.length === 1 && rest[0] === "--check" && (command === "split" || command === "labels"))
    return { command, check: true };
  return null;
}
export const USAGE = "usage: node scripts/glimmer/compare-pipelines.ts <split|labels> [--check] | sample | report";

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
    const check = checkResult(dir, command === "labels" ? "labels" : "split-1.0");
    console.log(JSON.stringify(check, null, 2));
    process.exit(check.status === "current" ? 0 : 1);
  }
  if (command === "split" || command === "labels") {
    const result =
      command === "labels"
        ? compareLabels(dir)
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
