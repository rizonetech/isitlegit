// Loupe's training and held-out evaluation files from the store (D03 T04 §10).
//
//   node scripts/glimmer/build-dataset.ts <version> [--seed <n>]
//
// Writes `<store>/dataset/<version>/` (each file temp-then-rename): `train.jsonl` and `eval.jsonl` (one training line
// a page, the production request and its answer), `train.meta.jsonl` and `eval.meta.jsonl` (each line's page id,
// source, origin, lure type, brand and region, in the same order), and `summary.json`. Duplicates go, no brand passes
// 300 pages, lures stay within 40 to 60 percent of each split, and the evaluation set shares no brand, template, site
// or near duplicate with training and holds only labels known to be true.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { getDomain } from "tldts";
import {
  assertLineFits,
  buildScreenRequest,
  buildTrainingLine,
  LURE_TYPES,
  type PageAnswer,
  type ScreenMode,
} from "../../src/vision/page-screen.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const BRAND_CAP = 300;
export const NEAR_BITS = 6;
export const NEAR_TEXT = 0.8;
export const LURE_SHARE = { min: 0.4, max: 0.6 };
export const EVAL_MINIMUMS = { total: 1000, southAfrica: 300, perLureType: 50 };
// Label sources an evaluation page may carry: what is known to be true, never a model's fill-in (§9).
const TRUSTED = new Set(["ground-truth", "construction", "dom", "claude", "astra+claude"]);

// A 64-bit difference hash: the screenshot at 9 by 8 grey pixels, one bit for each pixel brighter than its right-hand
// neighbour.
export async function dhash(jpeg: Uint8Array): Promise<bigint> {
  const pixels = await sharp(jpeg).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hash = 0n;
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++)
      hash = (hash << 1n) | ((pixels[row * 9 + col] ?? 0) > (pixels[row * 9 + col + 1] ?? 0) ? 1n : 0n);
  return hash;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

// Word 3-shingles of a page's text, hashed small, for its Jaccard similarity with another page's.
export function shingles(text: string): Set<number> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<number>();
  if (!words.length) return out;
  for (let i = 0; i < Math.max(1, words.length - 2); i++)
    out.add(
      createHash("sha1")
        .update(words.slice(i, i + 3).join(" "))
        .digest()
        .readUInt32BE(0),
    );
  return out;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const value of a) if (b.has(value)) both++;
  return both / (a.size + b.size - both);
}

// The answer a page teaches, or null while any field is still unknown. A label from a source whose spot check failed
// (`unverified`) is taught at lower confidence; every other label at 0.95.
export function answerOf(page: StoredPage): PageAnswer | null {
  const { labels } = page;
  if (labels.lure === undefined || labels.lure_type === undefined || labels.brand === undefined) return null;
  if (labels.has_login_form === undefined || labels.has_payment_form === undefined) return null;
  return {
    brand: labels.brand,
    has_login_form: labels.has_login_form,
    has_payment_form: labels.has_payment_form,
    lure: labels.lure,
    lure_type: labels.lure_type,
    confidence: page.label_source.lure === "unverified" ? 0.7 : 0.95,
  };
}

// Whether a page may be evaluated on: its `lure` is known to be true (detections and false alarms are what Loupe is
// judged on, operator 2026-10-28 21:36 SAST) and no label came from Spark. A brand or lure type filled by rule is
// allowed; §13 scores brand and lure type only on pages whose own label for them is trusted (`labelTrusted`).
export function trusted(page: StoredPage): boolean {
  const sources = Object.values(page.label_source);
  return TRUSTED.has(page.label_source.lure ?? "") && sources.every((source) => source !== "spark");
}

export function labelTrusted(page: StoredPage, field: keyof StoredPage["labels"]): boolean {
  return TRUSTED.has(page.label_source[field] ?? "");
}

// The group a page is held out with: its brand, else its site, else itself.
export function groupOf(page: StoredPage): string {
  if (page.labels.brand) return `brand:${page.labels.brand.toLowerCase()}`;
  if (page.host) return `site:${getDomain(page.host) ?? page.host}`;
  return `page:${page.id}`;
}

function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

type Entry = { page: StoredPage; answer: PageAnswer; hash: bigint; words: Set<number> };

// Pages kept after exact and near duplicates go: exact by screenshot and text hash; near when the screenshots are
// within 6 bits and the texts share 80 percent of their shingles. Screenshots alone are not enough: renders of dataset
// HTML carry no styles, so different pages often look alike at 9 by 8 pixels. Bands of the hash find candidates
// without comparing every pair (two hashes within 6 bits agree on at least one of 7 bands).
export function dedupe(entries: Entry[]): { kept: Entry[]; exact: number; near: number } {
  const seen = new Set<string>();
  const kept: Entry[] = [];
  const bands = Array.from({ length: 7 }, () => new Map<number, Entry[]>());
  let exact = 0;
  let near = 0;
  for (const entry of [...entries].sort((a, b) => a.page.id.localeCompare(b.page.id))) {
    const key = `${entry.page.sha256.screenshot}:${entry.page.sha256.text}`;
    if (seen.has(key)) {
      exact++;
      continue;
    }
    seen.add(key);
    const keys = Array.from({ length: 7 }, (_, band) => Number((entry.hash >> BigInt(band * 9)) & 0x1ffn));
    const candidates = new Set<Entry>();
    keys.forEach((value, band) => {
      for (const other of bands[band]?.get(value) ?? []) candidates.add(other);
    });
    const twin = [...candidates].find(
      (other) => hamming(other.hash, entry.hash) <= NEAR_BITS && jaccard(other.words, entry.words) >= NEAR_TEXT,
    );
    if (twin) {
      near++;
      continue;
    }
    kept.push(entry);
    keys.forEach((value, band) => {
      const bucket = bands[band] as Map<number, Entry[]>;
      bucket.set(value, [...(bucket.get(value) ?? []), entry]);
    });
  }
  return { kept, exact, near };
}

// At most 300 pages a brand, chosen with the seed.
export function capBrands(entries: Entry[], random: () => number): Entry[] {
  const byBrand = new Map<string, Entry[]>();
  const out: Entry[] = [];
  for (const entry of entries) {
    const brand = entry.answer.brand?.toLowerCase();
    if (!brand) out.push(entry);
    else byBrand.set(brand, [...(byBrand.get(brand) ?? []), entry]);
  }
  for (const group of byBrand.values()) out.push(...shuffle(group, random).slice(0, BRAND_CAP));
  return out;
}

// Lures held within 40 to 60 percent by dropping the larger side, chosen with the seed.
export function balance(entries: Entry[], random: () => number): Entry[] {
  const lures = entries.filter((e) => e.answer.lure);
  const benign = entries.filter((e) => !e.answer.lure);
  const most = (other: number, share: number) => Math.floor((other * share) / (1 - share));
  if (lures.length > most(benign.length, LURE_SHARE.max))
    return [...shuffle(lures, random).slice(0, most(benign.length, LURE_SHARE.max)), ...benign];
  if (benign.length > most(lures.length, 1 - LURE_SHARE.min))
    return [...lures, ...shuffle(benign, random).slice(0, most(lures.length, 1 - LURE_SHARE.min))];
  return entries;
}

export type Split = { train: Entry[]; evaluation: Entry[]; heldOut: string[]; template: string | null };

// Whole groups go to evaluation: 10 percent of brands, every page of one synthetic template, and further groups until
// the minimums hold; only pages whose every label is trusted. A held-out group's untrusted pages are dropped, never
// trained on, so no brand, site or template is on both sides.
export function split(entries: Entry[], random: () => number): Split {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) groups.set(groupOf(entry.page), [...(groups.get(groupOf(entry.page)) ?? []), entry]);
  const templates = [...new Set(entries.map((e) => e.page.template).filter((t): t is string => !!t))].sort();
  const template = templates.length ? (templates[Math.floor(random() * templates.length)] as string) : null;
  const brands = shuffle(
    [...groups.keys()].filter((g) => g.startsWith("brand:")),
    random,
  );
  const held = new Set(brands.slice(0, Math.ceil(brands.length * 0.1)));
  const evaluation: Entry[] = [];
  const counts = () => ({
    total: evaluation.length,
    southAfrica: evaluation.filter((e) => e.page.south_africa).length,
    lureTypes: Object.fromEntries(
      LURE_TYPES.map((t) => [t, evaluation.filter((e) => e.answer.lure_type === t).length]),
    ),
  });
  const take = (group: string) => {
    held.add(group);
    evaluation.push(...(groups.get(group) ?? []).filter((e) => trusted(e.page)));
  };
  for (const group of held) evaluation.push(...(groups.get(group) ?? []).filter((e) => trusted(e.page)));
  if (template)
    for (const [group, members] of groups)
      if (!held.has(group) && members.some((e) => e.page.template === template)) take(group);
  const short = () => {
    const now = counts();
    return (
      now.total < EVAL_MINIMUMS.total ||
      now.southAfrica < EVAL_MINIMUMS.southAfrica ||
      LURE_TYPES.some((t) => (now.lureTypes[t] ?? 0) < EVAL_MINIMUMS.perLureType)
    );
  };
  // Further groups, the ones that fill the scarcest shortfall first, until every minimum holds or none is left. At
  // most a third of the pages go to evaluation.
  const rest = shuffle(
    [...groups.keys()].filter((g) => !held.has(g)),
    random,
  );
  while (short() && rest.length && evaluation.length < entries.length / 3) {
    const now = counts();
    const needs = (e: Entry) =>
      (now.southAfrica < EVAL_MINIMUMS.southAfrica && e.page.south_africa) ||
      (now.lureTypes[e.answer.lure_type] ?? 0) < EVAL_MINIMUMS.perLureType;
    const index = rest.findIndex((g) => (groups.get(g) ?? []).some((e) => trusted(e.page) && needs(e)));
    take(rest.splice(index >= 0 ? index : 0, 1)[0] as string);
  }
  const train = [...groups.entries()].filter(([group]) => !held.has(group)).flatMap(([, members]) => members);
  return { train, evaluation, heldOut: [...held].sort(), template };
}

function writeAtomic(path: string, text: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export type Built = {
  dir: string;
  train: number;
  evaluation: number;
  dropped: {
    unlabelled: number;
    incomplete: number;
    disputed: number;
    exact: number;
    near: number;
    unredacted: number;
    capped: number;
    balanced: number;
  };
  shortfalls: string[];
  sha256: { train: string; evaluation: string };
};

export async function buildDataset(options: {
  store: ReturnType<typeof openStore>;
  version: string;
  mode: ScreenMode;
  seed?: number;
}): Promise<Built> {
  const { store, version, mode } = options;
  const random = seeded(options.seed ?? 20261101);
  const dropped = {
    unlabelled: 0,
    incomplete: 0,
    disputed: 0,
    exact: 0,
    near: 0,
    unredacted: 0,
    capped: 0,
    balanced: 0,
  };
  // A page whose `lure` the teacher disputed waits in the review queue and is left out of both files (§9).
  const queue = join(store.dir, "review-queue.jsonl");
  const disputed = new Set(
    existsSync(queue)
      ? readFileSync(queue, "utf-8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => (JSON.parse(line) as { id: string }).id)
      : [],
  );
  const entries: Entry[] = [];
  // A public or sample source is used only once its import reads `complete` (§5): a running, stopped or failed import
  // is not trained on or evaluated, whatever pages it already stored.
  const importStatus = new Map<string, string>();
  const usable = (page: StoredPage) => {
    if (page.origin !== "public" && page.origin !== "samples") return true;
    if (!importStatus.has(page.source)) {
      const file = join(store.dir, "raw", page.source, "IMPORT.json");
      importStatus.set(
        page.source,
        existsSync(file) ? ((JSON.parse(readFileSync(file, "utf-8")) as { status?: string }).status ?? "none") : "none",
      );
    }
    return importStatus.get(page.source) === "complete";
  };
  for (const page of store.manifest()) {
    if (!usable(page)) {
      dropped.incomplete++;
      continue;
    }
    if (disputed.has(page.id)) {
      dropped.disputed++;
      continue;
    }
    const answer = answerOf(page);
    if (!answer) {
      dropped.unlabelled++;
      continue;
    }
    // A sample-derived page is trained on only once redacted (§7).
    if (page.origin === "samples" && !page.redacted) {
      dropped.unredacted++;
      continue;
    }
    const { screenshot, text } = store.readPage(page.id);
    entries.push({ page, answer, hash: await dhash(screenshot), words: shingles(text) });
  }
  const deduped = dedupe(entries);
  dropped.exact = deduped.exact;
  dropped.near = deduped.near;
  const capped = capBrands(deduped.kept, random);
  dropped.capped = deduped.kept.length - capped.length;
  const parts = split(capped, random);
  const train = balance(parts.train, random);
  const evaluation = balance(parts.evaluation, random);
  dropped.balanced = parts.train.length - train.length + parts.evaluation.length - evaluation.length;

  const dir = join(store.dir, "dataset", version);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, chosen: Entry[]) => {
    const lines: string[] = [];
    const meta: string[] = [];
    for (const entry of shuffle(chosen, random)) {
      const { screenshot, text } = store.readPage(entry.page.id);
      // The nonce comes from the page, so a rebuild writes the same line.
      const nonce = createHash("sha256").update(entry.page.id).digest("hex").slice(0, 32);
      const line = buildTrainingLine(
        buildScreenRequest({ image: screenshot, host: entry.page.host, text, mode, nonce }),
        entry.answer,
      );
      assertLineFits(line, mode);
      lines.push(line);
      meta.push(
        JSON.stringify({
          id: entry.page.id,
          source: entry.page.source,
          origin: entry.page.origin,
          lure_type: entry.answer.lure_type,
          brand: entry.answer.brand,
          south_africa: entry.page.south_africa,
          screenshot: entry.page.sha256.screenshot,
        }),
      );
    }
    const body = lines.map((line) => `${line}\n`).join("");
    writeAtomic(join(dir, `${name}.jsonl`), body);
    writeAtomic(join(dir, `${name}.meta.jsonl`), meta.map((m) => `${m}\n`).join(""));
    return createHash("sha256").update(body).digest("hex");
  };
  const sha256 = { train: write("train", train), evaluation: write("eval", evaluation) };
  const shortfalls: string[] = [];
  const sa = evaluation.filter((e) => e.page.south_africa).length;
  if (evaluation.length < EVAL_MINIMUMS.total)
    shortfalls.push(`evaluation ${evaluation.length} of ${EVAL_MINIMUMS.total}`);
  if (sa < EVAL_MINIMUMS.southAfrica) shortfalls.push(`South African evaluation ${sa} of ${EVAL_MINIMUMS.southAfrica}`);
  for (const type of LURE_TYPES) {
    const n = evaluation.filter((e) => e.answer.lure_type === type).length;
    if (n < EVAL_MINIMUMS.perLureType) shortfalls.push(`${type} evaluation ${n} of ${EVAL_MINIMUMS.perLureType}`);
  }
  const built: Built = { dir, train: train.length, evaluation: evaluation.length, dropped, shortfalls, sha256 };
  const by = (chosen: Entry[], key: (e: Entry) => string) =>
    chosen.reduce<Record<string, number>>((acc, e) => {
      acc[key(e)] = (acc[key(e)] ?? 0) + 1;
      return acc;
    }, {});
  const describe = (chosen: Entry[]) => ({
    lines: chosen.length,
    byOrigin: by(chosen, (e) => e.page.origin),
    bySource: by(chosen, (e) => e.page.source),
    byLureType: by(chosen, (e) => e.answer.lure_type),
    southAfrica: chosen.filter((e) => e.page.south_africa).length,
    brands: new Set(chosen.map((e) => e.answer.brand?.toLowerCase()).filter(Boolean)).size,
  });
  writeAtomic(
    join(dir, "summary.json"),
    `${JSON.stringify({ version, mode, seed: options.seed ?? 20261101, ...built, train: describe(train), evaluation: describe(evaluation), heldOut: parts.heldOut.length, template: parts.template }, null, 2)}\n`,
  );
  return built;
}

if (import.meta.filename === process.argv[1]) {
  const [version, flag, seed] = process.argv.slice(2);
  if (!version || !/^[1-9]\d?\.\d{1,2}$/.test(version) || (flag && flag !== "--seed")) {
    console.error("usage: node scripts/glimmer/build-dataset.ts <version> [--seed <n>]");
    process.exit(2);
  }
  // The mode §2's probe proved, as docs/glimmer/training.md records it.
  const recorded = /training mode: (image|text-only)/.exec(
    readFileSync(join(ROOT, "docs/glimmer/training.md"), "utf-8"),
  )?.[1] as ScreenMode | undefined;
  if (!recorded) {
    console.error("build-dataset: docs/glimmer/training.md records no `training mode:`");
    process.exit(2);
  }
  const built = await buildDataset({
    store: openStore(storeDir()),
    version,
    mode: recorded,
    ...(seed ? { seed: Number(seed) } : {}),
  });
  console.log(JSON.stringify(built, null, 2));
  process.exit(built.shortfalls.length ? 1 : 0);
}
