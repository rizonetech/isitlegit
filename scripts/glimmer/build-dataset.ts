// Loupe's training and held-out evaluation files from the store (D03 T04 §10).
//
//   node scripts/glimmer/build-dataset.ts <version> [--seed <n>]
//
// Writes `<store>/dataset/<version>/` (each file temp-then-rename, the folder staged as `<version>.staging`, read back
// and checked, then renamed; a published version is never replaced): `train.jsonl` and `eval.jsonl` (one training line
// a page, the production request and its answer), `train.meta.jsonl` and `eval.meta.jsonl` (each line's page id,
// source, origin, lure type, brand and region, in the same order), and `summary.json`. Duplicates go, no brand passes
// 300 pages, lures stay within 40 to 60 percent of each split, the evaluation set shares no brand, template, site or
// near duplicate with training and holds only pages the teacher agreed with, and a version short of any floor, or
// whose sample-derived lines hold a protected detail, is refused and never published.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import PostalMime from "postal-mime";
import sharp from "sharp";
import { getDomain } from "tldts";
import {
  assertLineFits,
  buildScreenRequest,
  buildTrainingLine,
  LURE_TYPES,
  PageAnswer,
  SCREENER_SYSTEM_PROMPT,
  type ScreenMode,
} from "../../src/vision/page-screen.ts";
import {
  addresses,
  assertConsent,
  clientDomains,
  leaks,
  MAX_MESSAGE_BYTES,
  messageFiles,
  personalDetail,
  readClientNames,
  recipientNames,
} from "./import-samples.ts";
import { canonicalBrand, readExcluded } from "./label-rules.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";
import { type PageOutcome, readQueue, readTeacherState, teacherState } from "./teacher-label.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const BRAND_CAP = 300;
export const NEAR_BITS = 6;
export const NEAR_TEXT = 0.8;
export const LURE_SHARE = { min: 0.4, max: 0.6 };
export const EVAL_MINIMUMS = { total: 1000, southAfrica: 300, perLureType: 50 };

// What a version must hold before it is published (§10, plan review finding 7). The sample floors keep the South
// African lures this product exists for in both splits (filed from §8's plan review, finding 2): evaluation holds at
// least `sampleEvaluation` trusted sample-derived lures, and training keeps at least `sampleTraining` of the trusted
// sample-derived lures admitted after every exclusion, rounded up.
export type Floors = {
  evaluation: number;
  southAfrica: number;
  perLureType: number;
  sampleEvaluation: number;
  sampleTraining: number;
  // The lure share each split must stay within; null for none (a test of something else).
  lureShare: { min: number; max: number } | null;
};
export const FLOORS: Floors = {
  evaluation: EVAL_MINIMUMS.total,
  southAfrica: EVAL_MINIMUMS.southAfrica,
  perLureType: EVAL_MINIMUMS.perLureType,
  sampleEvaluation: 30,
  sampleTraining: 0.5,
  lureShare: LURE_SHARE,
};
// No floor at all: for a test of something other than the floors, never for a real build.
export const NO_FLOORS: Floors = {
  evaluation: 0,
  southAfrica: 0,
  perLureType: 0,
  sampleEvaluation: 0,
  sampleTraining: 0,
  lureShare: null,
};

// A refused publication: every floor the version misses, named.
export class ShortfallError extends Error {
  readonly shortfalls: string[];
  constructor(shortfalls: string[]) {
    super(`refused: ${shortfalls.length} shortfalls: ${shortfalls.join("; ")}`);
    this.name = "ShortfallError";
    this.shortfalls = shortfalls;
  }
}
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
    // A lure type resting on an untrusted form flag (§18) teaches as little as an unverified lure.
    confidence: page.label_source.lure === "unverified" || page.label_source.lure_type === "unverified" ? 0.7 : 0.95,
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

// The one identity a brand goes by, for caps, groups and counts (plan review finding 4): a known spelling or long form
// is its canonical name (`First National Bank` is `FNB`), a domain spelling is its brand (`standardbank.co.za` is
// `Standard Bank`), and case, spacing and punctuation are folded, so `Acme  Bank` and `acme bank` are one brand.
export function brandIdentity(name: string): string {
  const spelled = name.trim();
  const stem = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(spelled)
    ? getDomain(spelled.toLowerCase())?.split(".")[0]
    : undefined;
  const canonical = canonicalBrand(stem ?? spelled);
  return canonical.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") || canonical.toLowerCase();
}

// A page's site: the registrable domain of its host. A host under a shared platform's own suffix (`x.blogspot.com`) is
// a site of its own, not the platform's, so one hosting service does not join every page it serves.
export function siteOf(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

// Every identity a page shares with others: its canonical brand, its site and its template (plan review finding 3).
export function identities(page: StoredPage): string[] {
  const out: string[] = [];
  if (page.labels.brand) out.push(`brand:${brandIdentity(page.labels.brand)}`);
  if (page.host) out.push(`site:${siteOf(page.host)}`);
  if (page.template) out.push(`template:${page.template}`);
  return out;
}

// The first identity a page has: its brand, else its site, else itself. The split holds out every identity a page
// shares, joined (`groupEntries`); this is the key a page would take alone.
export function groupOf(page: StoredPage): string {
  return identities(page)[0] ?? `page:${page.id}`;
}

// A value added to its key's list in place: copying the list for each value made grouping quadratic.
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Pages grouped by every identity they share: two pages are one group when they share a canonical brand, a site or a
// template, directly or through others, so a branded and an unbranded page of one site never cross the split. A group
// is named by its first identity in sorted order (a brand's before a site's before a template's).
export function groupEntries(entries: Entry[]): Map<string, Entry[]> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    for (let at = key; at !== root; ) {
      const next = parent.get(at) as string;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const named = new Map<Entry, string[]>();
  for (const entry of entries) {
    const own = identities(entry.page);
    const keys = own.length ? own : [`page:${entry.page.id}`];
    named.set(entry, keys);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) parent.set(find(key), find(keys[0] as string));
  }
  const members = new Map<string, Entry[]>();
  for (const entry of entries) append(members, find((named.get(entry) as string[])[0] as string), entry);
  const groups = new Map<string, Entry[]>();
  for (const group of members.values()) {
    const keys = new Set(group.flatMap((entry) => named.get(entry) as string[]));
    groups.set([...keys].sort()[0] as string, group);
  }
  return groups;
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

// A shuffle with the trusted sample-derived lures first, for a cut that must keep them: the South African lures the
// sample floors protect are dropped only when nothing else is left to drop.
function samplesFirst(items: Entry[], random: () => number): Entry[] {
  return shuffle(items, random).sort((a, b) => Number(sampleLure(b.page)) - Number(sampleLure(a.page)));
}

type Entry = { page: StoredPage; answer: PageAnswer; hash: bigint; words: Set<number> };

// Pages kept after exact and near duplicates go: exact by screenshot and text hash; near when the screenshots are
// within 6 bits and the texts share 80 percent of their shingles. Screenshots alone are not enough: renders of dataset
// HTML carry no styles, so different pages often look alike at 9 by 8 pixels. Bands of the hash find candidates
// without comparing every pair (two hashes within 6 bits agree on at least one of 7 bands).
export function dedupe(
  entries: Entry[],
  prefer: Set<string> = new Set(),
  protectors: Entry[] = [],
): { kept: Entry[]; exact: number; near: number } {
  const seen = new Set<string>();
  const kept: Entry[] = [];
  const bands = Array.from({ length: 7 }, () => new Map<number, Entry[]>());
  let exact = 0;
  let near = 0;
  // The pages `prefer` names come first, so a twin is dropped in their place, never they in its.
  const order = (a: Entry, b: Entry) =>
    Number(prefer.has(b.page.id)) - Number(prefer.has(a.page.id)) || a.page.id.localeCompare(b.page.id);
  const index = (entry: Entry, keys: number[]) =>
    keys.forEach((value, band) => {
      append(bands[band] as Map<number, Entry[]>, value, entry);
    });
  // Pages that are never candidates (a reference page the rules excluded) still guard their exact and near duplicates:
  // they are in the comparison before any candidate is (completion review round 1).
  for (const protector of protectors) {
    seen.add(`${protector.page.sha256.screenshot}:${protector.page.sha256.text}`);
    index(
      protector,
      Array.from({ length: 7 }, (_, band) => Number((protector.hash >> BigInt(band * 9)) & 0x1ffn)),
    );
  }
  for (const entry of [...entries].sort(order)) {
    const key = `${entry.page.sha256.screenshot}:${entry.page.sha256.text}`;
    const reserved = prefer.has(entry.page.id);
    const keys = Array.from({ length: 7 }, (_, band) => Number((entry.hash >> BigInt(band * 9)) & 0x1ffn));
    if (seen.has(key)) {
      exact++;
      // A reserved page dropped as a copy still guards its near duplicates (completion review G3).
      if (reserved) index(entry, keys);
      continue;
    }
    seen.add(key);
    const candidates = new Set<Entry>();
    keys.forEach((value, band) => {
      for (const other of bands[band]?.get(value) ?? []) candidates.add(other);
    });
    const twin = [...candidates].find(
      (other) => hamming(other.hash, entry.hash) <= NEAR_BITS && jaccard(other.words, entry.words) >= NEAR_TEXT,
    );
    if (twin) {
      near++;
      if (reserved) index(entry, keys);
      continue;
    }
    kept.push(entry);
    index(entry, keys);
  }
  return { kept, exact, near };
}

// At most 300 pages a brand, chosen with the seed, by the one brand identity (`FNB` and `First National Bank` share
// their 300).
export function capBrands(entries: Entry[], random: () => number): Entry[] {
  const byBrand = new Map<string, Entry[]>();
  const out: Entry[] = [];
  for (const entry of entries) {
    const brand = entry.answer.brand ? brandIdentity(entry.answer.brand) : null;
    if (!brand) out.push(entry);
    else append(byBrand, brand, entry);
  }
  for (const group of byBrand.values()) out.push(...samplesFirst(group, random).slice(0, BRAND_CAP));
  return out;
}

// Lures held within 40 to 60 percent by dropping the larger side, chosen with the seed; a cut drops every other lure
// before a sample-derived one.
export function balance(entries: Entry[], random: () => number): Entry[] {
  const lures = entries.filter((e) => e.answer.lure);
  const benign = entries.filter((e) => !e.answer.lure);
  const most = (other: number, share: number) => Math.floor((other * share) / (1 - share));
  if (lures.length > most(benign.length, LURE_SHARE.max))
    return [...samplesFirst(lures, random).slice(0, most(benign.length, LURE_SHARE.max)), ...benign];
  if (benign.length > most(lures.length, 1 - LURE_SHARE.min))
    return [...lures, ...shuffle(benign, random).slice(0, most(lures.length, 1 - LURE_SHARE.min))];
  return entries;
}

// A page that is a trusted sample-derived lure: the South African lures the sample floors protect.
export function sampleLure(page: StoredPage): boolean {
  return page.origin === "samples" && page.labels.lure === true && trusted(page);
}

// The most pages a pool of `lures` and `benign` can give with the lure share held within `share`: both sides cut as
// `balance` cuts them.
function balancedTotal(lures: number, benign: number, share: Floors["lureShare"]): number {
  if (!share) return lures + benign;
  const benignFor = (l: number) => Math.min(benign, Math.floor((l * (1 - share.min)) / share.min));
  const luresFor = (b: number) => Math.min(lures, Math.floor((b * share.max) / (1 - share.max)));
  const l = luresFor(benignFor(lures));
  const b = benignFor(l);
  return l > 0 && b > 0 ? l + b : 0;
}

export type Pool = {
  total: number;
  lures: number;
  benign: number;
  southAfrica: number;
  byLureType: Record<string, number>;
  sampleLures: number;
  // The pages the pool gives once its lure share is held within 40 to 60 percent.
  balanced: number;
  shortfalls: string[];
};

// The feasibility check before the split (plan review finding 1): the pages evaluation could be built from, those a
// trusted label and the teacher's agreement admit, counted by lure type and South African slice. It names every floor
// the pool cannot meet, however the groups fall, so a build the teacher has not made possible stops before it splits.
export function evaluationPool(
  entries: Pick<Entry, "page" | "answer">[],
  state: Map<string, PageOutcome>,
  floors: Floors = FLOORS,
): Pool {
  const admitted = entries.filter((e) => trusted(e.page) && teacherState(state, e.page) === "agreed");
  const lures = admitted.filter((e) => e.answer.lure).length;
  const benign = admitted.length - lures;
  const byLureType = Object.fromEntries(
    LURE_TYPES.map((t) => [t, admitted.filter((e) => e.answer.lure_type === t).length]),
  );
  const southAfrica = admitted.filter((e) => e.page.south_africa).length;
  const sampleLures = admitted.filter((e) => sampleLure(e.page)).length;
  const balanced = balancedTotal(lures, benign, floors.lureShare);
  const shortfalls: string[] = [];
  if (balanced < floors.evaluation)
    shortfalls.push(
      `evaluation pool ${balanced} of ${floors.evaluation} pages once lures are held within the share (${lures} lures, ${benign} benign)`,
    );
  else if (floors.lureShare && admitted.length && !balanced)
    shortfalls.push(`evaluation pool cannot hold its lures within the share (${lures} lures, ${benign} benign)`);
  if (southAfrica < floors.southAfrica)
    shortfalls.push(`South African evaluation pool ${southAfrica} of ${floors.southAfrica}`);
  for (const type of LURE_TYPES)
    if ((byLureType[type] ?? 0) < floors.perLureType)
      shortfalls.push(`${type} evaluation pool ${byLureType[type] ?? 0} of ${floors.perLureType}`);
  if (sampleLures < floors.sampleEvaluation)
    shortfalls.push(`sample-derived lure evaluation pool ${sampleLures} of ${floors.sampleEvaluation}`);
  return { total: admitted.length, lures, benign, southAfrica, byLureType, sampleLures, balanced, shortfalls };
}

// Every floor a finished split misses, named (plan review finding 7), checked after deduplication, capping and
// balancing and before anything is published. `admittedSampleLures` is the trusted sample-derived lures admitted after
// every exclusion, the denominator of training's half.
export function checkFloors(
  input: { train: Entry[]; evaluation: Entry[]; admittedSampleLures: number },
  floors: Floors = FLOORS,
): string[] {
  const { train, evaluation } = input;
  const out: string[] = [];
  if (evaluation.length < floors.evaluation) out.push(`evaluation ${evaluation.length} of ${floors.evaluation}`);
  const share = floors.lureShare;
  if (share)
    for (const [name, lines] of [
      ["training", train],
      ["evaluation", evaluation],
    ] as const) {
      const lures = lines.filter((e) => e.answer.lure).length;
      if (!lines.length) out.push(`${name} holds no lines`);
      else if (lures / lines.length < share.min || lures / lines.length > share.max)
        out.push(`${name} lures ${lures} of ${lines.length}, outside ${share.min * 100} to ${share.max * 100} percent`);
    }
  const southAfrica = evaluation.filter((e) => e.page.south_africa).length;
  if (southAfrica < floors.southAfrica) out.push(`South African evaluation ${southAfrica} of ${floors.southAfrica}`);
  for (const type of LURE_TYPES) {
    const n = evaluation.filter((e) => e.answer.lure_type === type).length;
    if (n < floors.perLureType) out.push(`${type} evaluation ${n} of ${floors.perLureType}`);
  }
  const sampleEvaluation = evaluation.filter((e) => sampleLure(e.page)).length;
  if (sampleEvaluation < floors.sampleEvaluation)
    out.push(`sample-derived lure evaluation ${sampleEvaluation} of ${floors.sampleEvaluation}`);
  const sampleTraining = train.filter((e) => sampleLure(e.page)).length;
  const half = Math.ceil(input.admittedSampleLures * floors.sampleTraining);
  if (sampleTraining < half)
    out.push(
      `training keeps ${sampleTraining} of ${input.admittedSampleLures} sample-derived lures, at least ${half} needed`,
    );
  return out;
}

export type Split = { train: Entry[]; evaluation: Entry[]; heldOut: string[]; template: string | null };

// The evaluation set as it is published: its lures balanced with a seed of its own, so the split can count the
// balanced pages it is choosing and the build then publishes exactly those (completion review G2).
const EVALUATION_BALANCE_SEED = 20261030;
export function balanceEvaluation(entries: Entry[]): Entry[] {
  return balance(entries, seeded(EVALUATION_BALANCE_SEED));
}

// Whole groups go to evaluation: 10 percent of the distinct canonical brands (the groups holding them), every page of
// one synthetic template, and further groups until the floors hold on the evaluation set as it will be published, after
// balancing; only pages `admit` accepts (by default those with trusted labels; `buildDataset` also requires the
// teacher's agreement). A held-out group's other pages are dropped, never trained on, so no brand, site or template is
// on both sides. `protect` are entries that are no longer candidates (a reference page excluded, deduplicated or capped
// away) and still join their groups, so their brand, site and template stay out of training (completion review G3).
export function split(
  entries: Entry[],
  random: () => number,
  options: {
    admit?: (entry: Entry) => boolean;
    floors?: Floors;
    reserved?: Set<string>;
    protect?: Entry[];
  } = {},
): Split {
  const admit = options.admit ?? ((entry: Entry) => trusted(entry.page));
  const floors = options.floors ?? FLOORS;
  const reserved = options.reserved ?? new Set<string>();
  const phantoms = new Set(options.protect ?? []);
  const groups = new Map<string, Entry[]>();
  for (const [key, members] of groupEntries([...entries, ...phantoms])) groups.set(key, members);
  const real = (group: string) => (groups.get(group) ?? []).filter((e) => !phantoms.has(e));
  const templates = [...new Set(entries.map((e) => e.page.template).filter((t): t is string => !!t))].sort();
  const template = templates.length ? (templates[Math.floor(random() * templates.length)] as string) : null;
  // Ten percent of the distinct canonical brands, not of the joined groups: a group can hold many brands.
  const brandsOf = (group: string) =>
    new Set(
      (groups.get(group) ?? []).flatMap((e) => (e.page.labels.brand ? [brandIdentity(e.page.labels.brand)] : [])),
    );
  const allBrands = new Set([...groups.keys()].flatMap((g) => [...brandsOf(g)]));
  const wanted = Math.ceil(allBrands.size * 0.1);
  const held = new Set<string>();
  // Every group holding a page of §13's reference set stays out of training (plan review finding 6).
  for (const [group, members] of groups) if (members.some((e) => reserved.has(e.page.id))) held.add(group);
  const heldBrands = () => new Set([...held].flatMap((g) => [...brandsOf(g)]));
  const candidates = shuffle([...allBrands].sort(), random);
  const groupOfBrand = new Map<string, string>();
  for (const group of [...groups.keys()].sort()) for (const brand of brandsOf(group)) groupOfBrand.set(brand, group);
  for (const brand of candidates) {
    if (heldBrands().size >= wanted) break;
    held.add(groupOfBrand.get(brand) as string);
  }
  const evaluation: Entry[] = [];
  // The counts the published evaluation set would have: balanced as `balanceEvaluation` balances it.
  const counts = () => {
    const shown = balanceEvaluation(evaluation);
    return {
      total: shown.length,
      southAfrica: shown.filter((e) => e.page.south_africa).length,
      sampleLures: shown.filter((e) => sampleLure(e.page)).length,
      lureTypes: Object.fromEntries(LURE_TYPES.map((t) => [t, shown.filter((e) => e.answer.lure_type === t).length])),
      lures: evaluation.filter((e) => e.answer.lure).length,
      benign: evaluation.filter((e) => !e.answer.lure).length,
    };
  };
  const take = (group: string) => {
    held.add(group);
    evaluation.push(...real(group).filter((e) => admit(e)));
  };
  for (const group of held) evaluation.push(...real(group).filter((e) => admit(e)));
  if (template)
    for (const [group, members] of groups)
      if (!held.has(group) && members.some((e) => e.page.template === template)) take(group);
  const short = () => {
    const now = counts();
    return (
      now.total < floors.evaluation ||
      now.southAfrica < floors.southAfrica ||
      now.sampleLures < floors.sampleEvaluation ||
      LURE_TYPES.some((t) => (now.lureTypes[t] ?? 0) < floors.perLureType)
    );
  };
  // Further groups, the ones that fill the scarcest shortfall first, until every floor holds on the balanced set or none
  // is left. At most a third of the pages go to evaluation.
  const rest = shuffle(
    [...groups.keys()].filter((g) => !held.has(g)),
    random,
  );
  while (short() && rest.length && evaluation.length < entries.length / 3) {
    const now = counts();
    const share = floors.lureShare ?? LURE_SHARE;
    // Balancing cuts the larger side, so once one side is in excess only the other side adds to the published set.
    const needsBenign = now.lures > (now.benign * share.max) / (1 - share.max);
    const needsLures = now.benign > (now.lures * (1 - share.min)) / share.min;
    const needs = (e: Entry) =>
      (now.southAfrica < floors.southAfrica && e.page.south_africa) ||
      (now.sampleLures < floors.sampleEvaluation && sampleLure(e.page)) ||
      (now.lureTypes[e.answer.lure_type] ?? 0) < floors.perLureType ||
      (needsBenign && !e.answer.lure) ||
      (needsLures && e.answer.lure);
    const preferred = rest.findIndex((g) => real(g).some((e) => admit(e) && needs(e)));
    const index = preferred >= 0 ? preferred : rest.findIndex((g) => real(g).some(admit));
    // A group with nothing to admit adds nothing to evaluation and would only take its pages from training.
    if (index < 0) break;
    take(rest.splice(index, 1)[0] as string);
  }
  const train = [...groups.keys()].filter((group) => !held.has(group)).flatMap((group) => real(group));
  return { train, evaluation, heldOut: [...held].sort(), template };
}

// A line or version refused on inspection: it is removed, never left to be uploaded.
export class PublicationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationRefused";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// One training line checked as Fireworks and the screener will read it (plan review finding 9): the JSONL's message
// structure (the screener's system prompt, one user turn made of the page's text part and, in image mode, one JPEG
// data URL, then one assistant turn), the assistant's answer parsed with `PageAnswer` (strict, so a runtime `screener`
// field or any other is refused) and the token limit for the mode. `PageScreen` is a type, not a validator, and holds
// the runtime-owned `screener` a training answer must not carry.
export function validateLine(line: string, mode: ScreenMode): { answer: PageAnswer; text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new PublicationRefused("a training line is not JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).join() !== "messages" || !Array.isArray(parsed.messages))
    throw new PublicationRefused("a training line is not one object holding `messages`");
  const [system, user, assistant, ...extra] = parsed.messages as unknown[];
  if (!isRecord(system) || system.role !== "system" || system.content !== SCREENER_SYSTEM_PROMPT)
    throw new PublicationRefused("a training line does not open with the screener's system prompt");
  if (!isRecord(user) || user.role !== "user" || !Array.isArray(user.content))
    throw new PublicationRefused("a training line's second message is not a user turn of parts");
  const [text, image, ...more] = user.content as unknown[];
  if (!isRecord(text) || text.type !== "text" || typeof text.text !== "string" || !text.text.startsWith("Host: "))
    throw new PublicationRefused("a training line's user turn does not open with the host and page text");
  const shown = mode === "image";
  const imageOk =
    isRecord(image) &&
    image.type === "image_url" &&
    isRecord(image.image_url) &&
    typeof image.image_url.url === "string" &&
    image.image_url.url.startsWith("data:image/jpeg;base64,");
  if (more.length || (shown ? !imageOk : image !== undefined))
    throw new PublicationRefused(`a training line's user turn does not suit the ${mode} mode`);
  if (!isRecord(assistant) || assistant.role !== "assistant" || typeof assistant.content !== "string" || extra.length)
    throw new PublicationRefused("a training line does not end with one assistant answer");
  let answer: PageAnswer;
  try {
    answer = PageAnswer.parse(JSON.parse(assistant.content));
  } catch {
    throw new PublicationRefused("a training line's answer is not a PageAnswer");
  }
  try {
    assertLineFits(line, mode);
  } catch (error) {
    throw new PublicationRefused((error as Error).message);
  }
  return { answer, text: text.text };
}

// Where a protected term shows in any line, and where an address, phone or long number shows in a line made from a
// sample page (§7, filed from its completion review, gap 12; review G4): the page text as the line states it and the
// answer, never the screenshot (the import read those by OCR). A client's name can reach a public page's line as well,
// so the terms are looked for in every line; the generic personal-detail patterns would fire on any public page's
// phone numbers, so they read sample lines only. The problems name the line's page and the kind of detail, never the
// detail. The nonce is left out of what is read: a run of hex digits is no phone number.
export type ProtectedTerms = { client: string[]; addresses: string[]; domains: string[]; pieces: string[] };

// A plain list is read as client names: every one of them is scanned on every line.
const termKinds = (terms: string[] | ProtectedTerms): ProtectedTerms =>
  Array.isArray(terms) ? { client: terms, addresses: [], domains: [], pieces: [] } : terms;

export function scanSampleLines(
  lines: { id: string; origin: string; line: string }[],
  terms: string[] | ProtectedTerms,
  mode: ScreenMode,
): string[] {
  const problems: string[] = [];
  // A public page cannot carry the client's mail, but it can carry an ordinary first name that is also one recipient's
  // name piece: on a public line the client's names (every one, of any form), addresses and domains are read, and only
  // the recipients' single name pieces are left out; a sample line is read for every term.
  const kinds = termKinds(terms);
  const publicTerms = [...kinds.client, ...kinds.addresses, ...kinds.domains];
  const allTerms = [...publicTerms, ...kinds.pieces];
  for (const { id, origin, line } of lines) {
    const { answer, text } = validateLine(line, mode);
    const nonce = createHash("sha256").update(id).digest("hex").slice(0, 32);
    const shown = `${text.split(nonce).join("")}\n${answer.brand ?? ""}`;
    if (leaks([{ id, text: shown }], origin === "samples" ? allTerms : publicTerms).length)
      problems.push(`${id}: a protected sample term`);
    if (origin !== "samples") continue;
    const kind = personalDetail(shown);
    if (kind) problems.push(`${id}: ${kind}`);
  }
  return problems;
}

// The protected terms of the pilot client's samples, derived as `leakCheck()` derives them (import-samples.ts): the
// client names, every recipient's name pieces and address, and the client's domains. A message over 25 MB or one that
// does not parse is counted, not read: the import records it as failed and makes no page from it, so it has no
// recipient to guard on any page.
export async function sampleTerms(samples: string): Promise<{ terms: ProtectedTerms; unreadable: number }> {
  assertConsent(samples);
  const clientNames = readClientNames(samples);
  const addressesSeen: string[] = [];
  const pieces = new Set<string>();
  let unreadable = 0;
  for (const file of messageFiles(samples)) {
    const path = join(samples, file);
    try {
      if (statSync(path).size > MAX_MESSAGE_BYTES) throw new RangeError("over the size the import reads");
      const bytes = readFileSync(path);
      const email = await PostalMime.parse(bytes);
      const raw = bytes.toString("latin1");
      addressesSeen.push(...addresses(email, raw));
      for (const piece of recipientNames(email, raw, [])) pieces.add(piece);
    } catch {
      unreadable++;
    }
  }
  // The terms `leakCheck()` guards, kept by kind so a scan can tell a company name from a recipient's first name.
  const domains = clientDomains(addressesSeen);
  return { terms: { client: clientNames, addresses: addressesSeen, domains, pieces: [...pieces] }, unreadable };
}

// A staged split read back from disk (plan review finding 8): every line validated, every meta line aligned with its
// line (the line's own nonce, answer type and brand are the meta line's page's), the sample-derived lines scanned, and
// the SHA-256 taken from the bytes read, not from the string written.
function readBack(
  dir: string,
  name: string,
  mode: ScreenMode,
  terms: string[] | ProtectedTerms,
): { sha256: string; lines: number } {
  const body = readFileSync(join(dir, `${name}.jsonl`));
  const lines = body.toString("utf-8").split("\n");
  const metas = readFileSync(join(dir, `${name}.meta.jsonl`), "utf-8").split("\n");
  // Each file ends with a newline, so the last piece is empty.
  if (lines.pop() !== "" || metas.pop() !== "")
    throw new PublicationRefused(`${name}: a file does not end with a newline`);
  if (lines.length !== metas.length)
    throw new PublicationRefused(`${name}: ${lines.length} lines but ${metas.length} meta lines`);
  const checked = lines.map((line, index) => {
    const meta = JSON.parse(metas[index] as string) as {
      id: string;
      origin: string;
      lure_type: string;
      brand: string | null;
      brand_identity: string | null;
    };
    const { answer, text } = validateLine(line, mode);
    const nonce = createHash("sha256").update(meta.id).digest("hex").slice(0, 32);
    const identity = answer.brand ? brandIdentity(answer.brand) : null;
    if (
      !text.includes(nonce) ||
      answer.lure_type !== meta.lure_type ||
      answer.brand !== meta.brand ||
      identity !== meta.brand_identity
    )
      throw new PublicationRefused(`${name}: line ${index + 1} is not the page its meta line names`);
    return { id: meta.id, origin: meta.origin, line };
  });
  const problems = scanSampleLines(checked, terms, mode);
  if (problems.length)
    throw new PublicationRefused(
      `${name}: ${problems.length} lines hold protected details (${problems.slice(0, 5).join("; ")})`,
    );
  return { sha256: createHash("sha256").update(body).digest("hex"), lines: lines.length };
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
    // Pages the collection freeze does not name (stored after it, §18).
    afterFreeze: number;
    // Pages the label rules excluded (`raw/labels/excluded.jsonl`): a capture of something else, contradictory or
    // incomplete labels, a lost teacher answer (§9, §18).
    excluded: number;
  };
  sha256: { train: string; evaluation: string };
};

// The pages a version is built from: those `sources.ts freeze` named, once each frozen source's import record is still
// the one it recorded (an import run since would put other pages or labels behind the same ids) and both benign lists
// were rendered. Throws with the reason otherwise.
export function readFreeze(dir: string): Set<string> {
  const file = join(dir, "raw", "FROZEN.json");
  if (!existsSync(file))
    throw new Error("no raw/FROZEN.json: freeze the collection first (node scripts/glimmer/sources.ts freeze)");
  const record = JSON.parse(readFileSync(file, "utf-8")) as {
    pages?: string[];
    sources?: Record<string, { import_sha256?: string }>;
    renders?: Record<string, unknown>;
  };
  if (!Array.isArray(record.pages) || !record.sources || !record.renders?.majestic || !record.renders["benign-sa"])
    throw new Error("raw/FROZEN.json is not a whole freeze (its pages, sources or both renders are missing)");
  const drifted = Object.entries(record.sources).filter(([source, frozenSource]) => {
    const importFile = join(dir, "raw", source, "IMPORT.json");
    return (
      !existsSync(importFile) ||
      createHash("sha256").update(readFileSync(importFile)).digest("hex") !== frozenSource.import_sha256
    );
  });
  if (drifted.length)
    throw new Error(`imported again since the freeze: ${drifted.map(([source]) => source).join(", ")}`);
  return new Set(record.pages);
}

// The freeze's identity for a version's summary: the SHA-256 of its page ids in sorted order, one a line, so a version
// names the exact collection it was built from.
export function freezeDigest(frozen: Set<string>): string {
  return createHash("sha256")
    .update(
      [...frozen]
        .sort()
        .map((id) => `${id}\n`)
        .join(""),
    )
    .digest("hex");
}

// §13's independent reference set: how many pages are drawn the first time, and the seed of the draw. The draw is
// seeded by these alone, never by the build's seed or any label the teacher touched, so every build finds it unchanged.
export const REFERENCE_SIZE = 500;
const REFERENCE_SEED = "glimmer-reference-2026-10-30";
export const referenceFile = (dir: string) => join(dir, "raw", "dataset", "reference.json");

// The reference set: the saved membership when `raw/dataset/reference.json` exists, else a seeded draw from `pool`,
// saved temp-then-replace before it is used. Its pages and every group and near duplicate they have are kept out of
// training (`split`, `dedupe`).
export function reserveReference(
  dir: string,
  pool: StoredPage[],
  size = REFERENCE_SIZE,
): { ids: Set<string>; sha256: string } {
  const file = referenceFile(dir);
  if (!existsSync(file)) {
    const order = (id: string) => createHash("sha256").update(`${REFERENCE_SEED}\n${id}`).digest("hex");
    const pages = pool
      .map((page) => page.id)
      .sort((a, b) => order(a).localeCompare(order(b)))
      .slice(0, size)
      .sort();
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify({ seed: REFERENCE_SEED, size, drawn_from: pool.length, pages }, null, 2)}\n`);
  }
  const bytes = readFileSync(file);
  const saved = JSON.parse(bytes.toString("utf-8")) as { pages?: unknown };
  if (!Array.isArray(saved.pages) || !saved.pages.every((id) => typeof id === "string"))
    throw new Error(`${file} does not name its pages`);
  return { ids: new Set(saved.pages as string[]), sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function buildDataset(options: {
  store: ReturnType<typeof openStore>;
  version: string;
  mode: ScreenMode;
  seed?: number;
  // Loupe's collection freeze (§18, `sources.ts freeze`): only pages it names are built from. Left out (a test with no
  // freeze), every stored page is a candidate; the command refuses to build without one.
  frozen?: Set<string>;
  // The floors a version must meet to be published; `FLOORS` unless a test of something else lowers them.
  floors?: Floors;
  // How many pages the reference set holds when it is first drawn (`REFERENCE_SIZE`); a set already saved is kept.
  referenceSize?: number;
  // The protected terms of the sample mail (`sampleTerms`), which the lines made from sample pages are scanned for
  // before the version is published. Required once the version holds such a line.
  protectedTerms?: string[] | ProtectedTerms;
  // The two writes publication makes, replaceable so a test can fail one: a file's write (temp then rename) and the
  // rename of the staged folder into place.
  io?: { write?: (path: string, text: string) => void; rename?: (from: string, to: string) => void };
}): Promise<Built> {
  const { store, version, mode } = options;
  // A published version is never replaced: a new number is required, so a model trained on one never finds its files
  // changed under it.
  const final = join(store.dir, "dataset", version);
  if (existsSync(final))
    throw new Error(`dataset version ${version} is already published at ${final}; use a new version number`);
  const floors = options.floors ?? FLOORS;
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
    afterFreeze: 0,
    excluded: 0,
  };
  // Every frozen page still in the store, whole: one remade under a new id since the freeze (a sample re-import after a
  // change to the redaction) would otherwise drop out of this version unseen.
  if (options.frozen) {
    const stored = new Set(store.manifest({ tolerant: true }).map((page) => page.id));
    const gone = [...options.frozen].filter((id) => !stored.has(id));
    if (gone.length)
      throw new Error(
        `${gone.length} frozen pages are no longer in the store (first: ${gone[0]}): freeze again or restore them`,
      );
  }
  const excluded = readExcluded(store.dir);
  const entries: Entry[] = [];
  const unverified: string[] = [];
  // Reference pages that are not candidates (excluded, unlabelled), kept to guard their duplicates.
  const protectorPages: StoredPage[] = [];
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
    if (importStatus.get(page.source) !== "complete") return false;
    // The pilot client's samples are one set: both imports are used only once the set's redaction key is recorded,
    // which the importer writes last (§7), so a run stopped between its two records publishes neither.
    if (page.origin === "samples") {
      const file = join(store.dir, "raw", "samples", "REDACTION.json");
      const state = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf-8")) as { key?: string | null; building?: string | null })
        : {};
      if (!state.key || state.building) return false;
    }
    return true;
  };
  // §13's reference set is reserved before any teacher outcome is read (plan review finding 6): a seeded draw from the
  // frozen, usable pages whose `lure` has a trusted source, whatever the teacher answered, kept in
  // `raw/dataset/reference.json` so every later version holds out the same pages. The pool does not consult the
  // exclusions either: those include pages the teacher lost, which would let its outcomes move the draw.
  const pages = store.manifest();
  const reference = reserveReference(
    store.dir,
    pages.filter(
      (page) =>
        (!options.frozen || options.frozen.has(page.id)) &&
        page.labels.lure !== undefined &&
        TRUSTED.has(page.label_source.lure ?? "") &&
        !(page.origin === "samples" && !page.redacted) &&
        usable(page),
    ),
    options.referenceSize,
  );
  // A page whose `lure` the teacher disputed is left out of both files (§9), whether or not its queue entry was written:
  // the teacher saves a disputed outcome before it queues the page, so a stop between the two writes leaves a dispute
  // known only to its state (plan review finding 5). The queue's own entries count too.
  const teacher = readTeacherState(store.dir);
  const disputed = new Set([
    ...readQueue(store.dir).map((entry) => entry.id),
    ...[...teacher].filter(([, outcome]) => outcome.status === "disputed").map(([id]) => id),
  ]);
  // The inputs the split read, kept with the version as digests (review G11): the labels and label sources of every
  // frozen page, the teacher's outcomes, the review queue and the exclusions. A rebuild from the same store state, seed
  // and freeze reproduces the version exactly when each digest still matches.
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const byKey = (a: [string, unknown], b: [string, unknown]) => a[0].localeCompare(b[0]);
  const queued = [...new Set(readQueue(store.dir).map((entry) => entry.id))].sort();
  const labelled = pages
    .filter((page) => !options.frozen || options.frozen.has(page.id))
    .map((page): [string, unknown] => [page.id, [page.labels, page.label_source, page.sha256]]);
  const inputs = {
    labels: { pages: labelled.length, sha256: digest(labelled.sort(byKey)) },
    teacher: { pages: teacher.size, sha256: digest([...teacher].sort(byKey)) },
    queue: { pages: queued.length, sha256: digest(queued) },
    excluded: { pages: excluded.size, sha256: digest([...excluded].sort(byKey)) },
  };
  for (const page of pages) {
    // A page stored after the collection froze, or an input never frozen, cannot enter this version.
    if (options.frozen && !options.frozen.has(page.id)) {
      dropped.afterFreeze++;
      continue;
    }
    if (excluded.has(page.id)) {
      dropped.excluded++;
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    if (!usable(page)) {
      dropped.incomplete++;
      continue;
    }
    // A disputed page in the reference set stays an entry, so its groups are held out; it is never admitted anywhere.
    if (disputed.has(page.id) && !reference.ids.has(page.id)) {
      dropped.disputed++;
      continue;
    }
    const answer = answerOf(page);
    if (!answer) {
      dropped.unlabelled++;
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    // A sample-derived page is trained on only once redacted (§7).
    if (page.origin === "samples" && !page.redacted) {
      dropped.unredacted++;
      continue;
    }
    // The bytes are checked against the SHA-256 the record holds before anything is derived from them (plan review
    // finding 2): the near-duplicate hash and shingles below come from these exact bytes, and the line is built from
    // them again, verified again, in `write`. A page that fails is no page of this collection, so the build stops.
    const verified = store.readVerifiedPage(page.id);
    if (!verified) {
      unverified.push(page.id);
      continue;
    }
    entries.push({
      page: verified.page,
      answer,
      hash: await dhash(verified.screenshot),
      words: shingles(verified.text),
    });
  }
  if (unverified.length)
    throw new Error(
      `${unverified.length} pages' files do not match their records (first: ${unverified[0]}): repair or remove them before building`,
    );
  // The trusted sample-derived lures admitted after every exclusion: the denominator of training's half.
  const admittedSampleLures = entries.filter((e) => sampleLure(e.page)).length;
  const protectors: Entry[] = [];
  for (const page of protectorPages) {
    const verified = store.readVerifiedPage(page.id);
    if (!verified) throw new Error(`reference page ${page.id}'s files do not match its record`);
    protectors.push({
      page: verified.page,
      answer: null as unknown as PageAnswer,
      hash: await dhash(verified.screenshot),
      words: shingles(verified.text),
    });
  }
  const deduped = dedupe(entries, reference.ids, protectors);
  dropped.exact = deduped.exact;
  dropped.near = deduped.near;
  const capped = capBrands(deduped.kept, random);
  dropped.capped = deduped.kept.length - capped.length;
  // Only a page the teacher checked and agreed with, whose lure and files are still the ones it checked, may be
  // evaluated on (§9; the teacher's `stale` and `unchecked` states both fail this).
  const admit = (entry: Entry) => trusted(entry.page) && teacherState(teacher, entry.page) === "agreed";
  // Before the split: can the teacher's agreed pages meet every floor at all? A build that cannot stops here, naming
  // each shortfall, instead of splitting a pool that was never enough.
  const pool = evaluationPool(capped, teacher, floors);
  if (pool.shortfalls.length) throw new ShortfallError(pool.shortfalls);
  // A reference page that is no candidate any more (excluded, deduplicated or capped away) still holds its brand, site
  // and template out of training, and its near duplicates were dropped above (completion review G3).
  const candidateIds = new Set(capped.map((e) => e.page.id));
  const byId = new Map([...entries, ...protectors].map((e) => [e.page.id, e]));
  const recordOf = new Map(pages.map((p) => [p.id, p]));
  const protect: Entry[] = [...reference.ids].flatMap((id) => {
    if (candidateIds.has(id)) return [];
    const entry = byId.get(id);
    const record = recordOf.get(id);
    if (entry) return [entry];
    // No entry was made of it (excluded, unlabelled): its record alone gives its identities.
    return record ? [{ page: record, answer: null as unknown as PageAnswer, hash: 0n, words: new Set<number>() }] : [];
  });
  const parts = split(capped, random, { admit, floors, reserved: reference.ids, protect });
  const train = balance(parts.train, random);
  const evaluation = balanceEvaluation(parts.evaluation);
  dropped.balanced = parts.train.length - train.length + parts.evaluation.length - evaluation.length;
  // Every floor, checked on the finished splits before anything is written: a version short of one is never published
  // and the previous version stays in place (plan review finding 7).
  const shortfalls = checkFloors({ train, evaluation, admittedSampleLures }, floors);
  if (shortfalls.length) throw new ShortfallError(shortfalls);

  // The version is staged beside its final place, each file read back from disk and checked there, and only then
  // renamed into place (plan review finding 8), so a stopped build never leaves new training lines beside an earlier
  // run's evaluation lines and summary, and a version already published is never touched.
  const staging = `${final}.staging`;
  const write = options.io?.write ?? writeAtomic;
  const rename = options.io?.rename ?? renameSync;
  // Lines made from sample pages are scanned for the protected terms; a build with such lines and no terms to scan for
  // cannot show they are clean, so it is refused.
  if ([...train, ...evaluation].some((e) => e.page.origin === "samples") && !options.protectedTerms)
    throw new Error("the version holds sample-derived lines but no protected terms were given to scan them for");
  // A staging folder an earlier run left (a failed write or rename) is made again from nothing: the build is
  // deterministic, and the folder was never a published version.
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const written = new Map<string, number>();
    for (const [name, chosen] of [
      ["train", train],
      ["eval", evaluation],
    ] as const) {
      const lines: string[] = [];
      const meta: string[] = [];
      for (const entry of shuffle(chosen, random)) {
        const verified = store.readVerifiedPage(entry.page.id);
        if (
          !verified ||
          verified.page.sha256.screenshot !== entry.page.sha256.screenshot ||
          verified.page.sha256.text !== entry.page.sha256.text
        )
          throw new Error(`page ${entry.page.id} changed on disk during the build`);
        const { screenshot, text } = verified;
        // The nonce comes from the page, so a rebuild writes the same line (and the read-back finds it again).
        const nonce = createHash("sha256").update(entry.page.id).digest("hex").slice(0, 32);
        lines.push(
          buildTrainingLine(
            buildScreenRequest({ image: screenshot, host: entry.page.host, text, mode, nonce }),
            entry.answer,
          ),
        );
        meta.push(
          JSON.stringify({
            id: entry.page.id,
            source: entry.page.source,
            origin: entry.page.origin,
            lure_type: entry.answer.lure_type,
            brand: entry.answer.brand,
            brand_identity: entry.answer.brand ? brandIdentity(entry.answer.brand) : null,
            south_africa: entry.page.south_africa,
            screenshot: entry.page.sha256.screenshot,
          }),
        );
      }
      write(join(staging, `${name}.jsonl`), lines.map((line) => `${line}\n`).join(""));
      write(join(staging, `${name}.meta.jsonl`), meta.map((m) => `${m}\n`).join(""));
      written.set(name, chosen.length);
    }
    // What is on disk is what is checked and hashed: every line validated, every meta line aligned with its line, and
    // the sample-derived lines scanned, all over the bytes that will be uploaded.
    const sha256 = { train: "", evaluation: "" };
    for (const [name, key] of [
      ["train", "train"],
      ["eval", "evaluation"],
    ] as const) {
      const back = readBack(staging, name, mode, options.protectedTerms ?? []);
      if (back.lines !== written.get(name))
        throw new PublicationRefused(`${name}: ${back.lines} lines read back, ${written.get(name)} written`);
      sha256[key] = back.sha256;
    }
    const built: Built = { dir: final, train: train.length, evaluation: evaluation.length, dropped, sha256 };
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
      brands: new Set(chosen.flatMap((e) => (e.answer.brand ? [brandIdentity(e.answer.brand)] : []))).size,
    });
    const summary = `${JSON.stringify({ version, mode, seed: options.seed ?? 20261101, freeze: options.frozen ? { pages: options.frozen.size, sha256: freezeDigest(options.frozen) } : null, inputs, ...built, floors, pool, reference: { pages: reference.ids.size, sha256: reference.sha256 }, sampleLures: { admitted: admittedSampleLures, training: train.filter((e) => sampleLure(e.page)).length, evaluation: evaluation.filter((e) => sampleLure(e.page)).length }, train: describe(train), evaluation: describe(evaluation), heldOut: parts.heldOut.length, template: parts.template }, null, 2)}\n`;
    write(join(staging, "summary.json"), summary);
    // The summary is read back like the other files (review G5): the bytes on disk are the ones intended, and the figures
    // in them are the figures of the files that were just read back.
    const onDisk = readFileSync(join(staging, "summary.json"), "utf-8");
    if (onDisk !== summary) throw new PublicationRefused("summary.json read back differs from what was written");
    const recorded = JSON.parse(onDisk) as {
      version: string;
      sha256: typeof sha256;
      train: { lines: number };
      evaluation: { lines: number };
    };
    if (
      recorded.version !== version ||
      recorded.sha256.train !== sha256.train ||
      recorded.sha256.evaluation !== sha256.evaluation ||
      recorded.train.lines !== written.get("train") ||
      recorded.evaluation.lines !== written.get("eval")
    )
      throw new PublicationRefused("summary.json does not match the files it describes");
    // Checked once more at the last moment: a version that appeared while this one was built is not replaced either.
    if (existsSync(final))
      throw new Error(`dataset version ${version} was published meanwhile; use a new version number`);
    rename(staging, final);
    return built;
  } catch (error) {
    // Lines that fail inspection are removed, never left where they could be uploaded; a failed write or rename leaves
    // the staging folder, and the next build of the version starts it again.
    if (error instanceof PublicationRefused) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
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
  const store = openStore(storeDir());
  let frozen: Set<string>;
  try {
    frozen = readFreeze(store.dir);
  } catch (error) {
    console.error(`build-dataset: ${(error as Error).message}`);
    process.exit(2);
  }
  // The terms the sample-derived lines are scanned for before the version is published, derived from samples/ as the
  // leak check derives them. Without them the scan cannot run, so the build does not either.
  let protectedTerms: ProtectedTerms;
  try {
    const derived = await sampleTerms(join(ROOT, "samples"));
    protectedTerms = derived.terms;
    const count = Object.values(derived.terms).reduce((sum, list) => sum + list.length, 0);
    console.error(`build-dataset: ${count} protected terms, ${derived.unreadable} messages unreadable`);
  } catch (error) {
    console.error(`build-dataset: the protected terms cannot be derived: ${(error as Error).message}`);
    process.exit(2);
  }
  try {
    const built = await buildDataset({
      store,
      version,
      mode: recorded,
      frozen,
      protectedTerms,
      ...(seed ? { seed: Number(seed) } : {}),
    });
    console.log(JSON.stringify(built, null, 2));
  } catch (error) {
    if (!(error instanceof ShortfallError || error instanceof PublicationRefused)) throw error;
    // A refused version names every floor it missed, or the lines it holds that must not be uploaded; nothing was
    // published.
    console.error(`build-dataset: ${error.message}`);
    process.exit(1);
  }
}
