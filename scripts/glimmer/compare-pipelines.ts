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
import { brandIdentity, hamming, jaccard, NEAR_BITS, NEAR_TEXT } from "./build-dataset.ts";

// The Wilson 95 percent interval for k of n; (0, 1) for no observations.
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export type Input = { name: string; path: string; sha256: string | null; bytes: number | null };
export type Complete<T> = { status: "complete"; name: string; inputs: Input[]; figures: T };
export type Incomplete = { status: "incomplete"; name: string; inputs: Input[]; missing: string[] };
export type Result<T> = Complete<T> | Incomplete;

export function describeInput(name: string, path: string): Input {
  if (!existsSync(path)) return { name, path, sha256: null, bytes: null };
  const data = readFileSync(path);
  return { name, path, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}
// An input that is not there makes the whole result incomplete, naming each one that is missing.
export function incompleteIfMissing(name: string, inputs: Input[]): Incomplete | null {
  const missing = inputs.filter((input) => input.sha256 === null).map((input) => `${input.name} (${input.path})`);
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

// Candidate neighbours by banding the hash into NEAR_BITS + 1 parts: two hashes within NEAR_BITS differ in at most
// NEAR_BITS bits, so they agree exactly on at least one part.
function bandKeys(hash: bigint): string[] {
  const parts = NEAR_BITS + 1;
  const width = Math.ceil(64 / parts);
  return Array.from({ length: parts }, (_, i) => `${i}:${(hash >> BigInt(i * width)) & ((1n << BigInt(width)) - 1n)}`);
}
function nearIndex(pages: Page[]) {
  const bands = new Map<string, Page[]>();
  for (const page of pages)
    for (const key of bandKeys(page.hash)) (bands.get(key) ?? bands.set(key, []).get(key))?.push(page);
  return (page: Page): Page | null => {
    for (const key of bandKeys(page.hash))
      for (const other of bands.get(key) ?? []) if (other.id !== page.id && near(page, other)) return other;
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
// perceptual hash and text similarity) so no evaluation page has a twin on the training side.
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
  const findNear = nearIndex(pages.filter((p) => assignment.get(p.id) === "eval"));
  for (const page of pages) if (assignment.get(page.id) === "train" && findNear(page)) assignment.delete(page.id);
  return assignment;
}

// ---- The command -----------------------------------------------------------------------------------------------------

const lines = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim());

// §10's split for a version, read from the dataset it wrote: the ids on each side (the rest of the freeze was dropped).
function builtAssignment(dir: string, version: string): { assignment: Map<string, Side>; inputs: Input[] } {
  const train = join(dir, "dataset", version, "train.meta.jsonl");
  const evaluation = join(dir, "dataset", version, "eval.meta.jsonl");
  const inputs = [describeInput("train.meta.jsonl", train), describeInput("eval.meta.jsonl", evaluation)];
  const assignment = new Map<string, Side>();
  if (inputs.every((input) => input.sha256 !== null)) {
    for (const [file, side] of [
      [train, "train"],
      [evaluation, "eval"],
    ] as const)
      for (const line of lines(file)) assignment.set((JSON.parse(line) as { id: string }).id, side);
  }
  return { assignment, inputs };
}

export async function compareSplit(
  dir: string,
  version = "1.0",
  progress: (line: string) => void = () => {},
): Promise<Result<{ built: SplitFigures; conventional: SplitFigures; pages: number; eval_share: number }>> {
  const { assignment, inputs } = builtAssignment(dir, version);
  const name = `split-${version}`;
  const missing = incompleteIfMissing(name, inputs);
  if (missing) return missing;
  const { dhash, siteKey, shingles } = await import("./build-dataset.ts");
  const pages: Page[] = [];
  const unreadable: string[] = [];
  let done = 0;
  for (const id of assignment.keys()) {
    const folder = join(dir, "pages", id);
    try {
      const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf-8")) as {
        host: string | null;
        labels: { brand?: string | null; lure?: boolean };
      };
      pages.push({
        id,
        brand: meta.labels.brand ?? null,
        site: meta.host ? siteKey(meta.host) : null,
        lure: meta.labels.lure === true,
        hash: await dhash(readFileSync(join(folder, "screenshot.jpg"))),
        words: shingles(readFileSync(join(folder, "text.txt"), "utf-8")),
      });
    } catch {
      unreadable.push(id);
    }
    if (++done % 5000 === 0) progress(`${done} of ${assignment.size} pages read`);
  }
  // A page the dataset names that cannot be read makes the comparison partial, not smaller.
  if (unreadable.length)
    return {
      status: "incomplete",
      name,
      inputs,
      missing: [`${unreadable.length} pages unreadable, first ${unreadable.slice(0, 5).join(", ")}`],
    };
  const evalShare = pages.filter((p) => assignment.get(p.id) === "eval").length / pages.length;
  const conventional = groupShuffleSplit(pages, seeded(20261101), evalShare);
  return {
    status: "complete",
    name,
    inputs,
    figures: {
      built: splitFigures(pages, assignment),
      conventional: splitFigures(pages, conventional),
      pages: pages.length,
      eval_share: evalShare,
    },
  };
}

if (import.meta.filename === process.argv[1]) {
  const [command] = process.argv.slice(2);
  const { storeDir } = await import("./store.ts");
  const dir = storeDir();
  if (command === "split") {
    const result = await compareSplit(dir, "1.0", (line) => console.error(`compare: ${line}`));
    writeResult(resultFile(dir, result.name), result);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "complete" ? 0 : 1);
  }
  console.error("usage: node scripts/glimmer/compare-pipelines.ts split");
  process.exit(2);
}
