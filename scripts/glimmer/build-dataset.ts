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
// whose sample-derived lines hold a protected detail, is refused and never published. Sample pages enter only once the
// set is ready (`sampleReadiness`): a clean leak check over the pages stored now, the label rules run over them and the
// teacher's receipt current.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
  leakCheckProblem,
  leaks,
  MAX_MESSAGE_BYTES,
  messageFiles,
  personalDetail,
  readClientNames,
  recipientNames,
  redactionKey,
} from "./import-samples.ts";
import { canonicalBrand, completeLabel, readExcluded } from "./label-rules.ts";
import type { EntityConfig } from "./redact.ts";
import { PLATFORM_DOMAINS, SHARED_HOSTS } from "./shared-platforms.ts";
import { freezeFile, openStore, type StoredPage, storeDir } from "./store.ts";
import { type PageOutcome, readQueue, readTeacherState, receiptProblem, teacherState } from "./teacher-label.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const BRAND_CAP = 300;
export const NEAR_BITS = 6;
export const NEAR_TEXT = 0.8;
// Pages or lines scanned for the protected terms in one call: `leaks` makes each term's rule once a call.
const SCAN_BATCH = 500;
const READ_BACK_BATCH = 200;
export const LURE_SHARE = { min: 0.4, max: 0.6 };
export const EVAL_MINIMUMS = { total: 1000, southAfrica: 300, perLureType: 50 };
// The largest group the split may hold out of training, as a share of its pages. Operators running kits of several
// brands chain the common phishing brands into one group (18,880 of 129,886 pages in the 1.0 collection, holding
// Facebook, Google, Amazon, Apple and Microsoft): held out, training would never see the brands it meets most. Such a
// group trains, and §13's reference set is drawn only from groups that can be held out (`holdablePages`).
export const MAX_HELD_SHARE = 0.05;
// A group of this many pages can always be held, however small the collection (a share of a test's ten pages is less
// than one page).
export const MIN_HELD_LIMIT = 100;
const heldLimit = (pages: number, share = MAX_HELD_SHARE) => Math.max(pages * share, MIN_HELD_LIMIT);

// What a version must hold before it is published (§10, plan review finding 7). The sample floors keep the South
// African lures this product exists for in both splits (filed from §8's plan review, finding 2): evaluation holds at
// least `sampleEvaluation` trusted sample-derived lures, and training keeps at least `sampleTraining` of the trusted
// sample-derived lures the split receives (after every exclusion, deduplication and the brand cap), rounded up.
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

// Word 3-shingles of a page's text, hashed small, for its Jaccard similarity with another page's: sorted and distinct,
// in a typed array. A build holds every page's shingles at once, and a Set of numbers held 128,000 pages' in over 5 GB,
// past what the host's out-of-memory guard allows; the packed array holds the same values in about a tenth.
export function shingles(text: string): Uint32Array {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return new Uint32Array(0);
  const values = new Uint32Array(Math.max(1, words.length - 2));
  for (let i = 0; i < values.length; i++)
    values[i] = createHash("sha1")
      .update(words.slice(i, i + 3).join(" "))
      .digest()
      .readUInt32BE(0);
  values.sort();
  // Distinct values only, in place.
  let kept = 0;
  for (let i = 0; i < values.length; i++)
    if (i === 0 || values[i] !== values[i - 1]) values[kept++] = values[i] as number;
  return values.slice(0, kept);
}

// Exact Jaccard similarity of two sorted, distinct shingle arrays, by one merge walk.
// Whether two shingle sets of these sizes could reach `NEAR_TEXT`: their Jaccard is at most the smaller size over the
// larger, computed with the same division `jaccard` makes for a set inside another, so the cut agrees with it exactly.
export function sizesAllow(a: number, b: number): boolean {
  const large = Math.max(a, b);
  return large === 0 || Math.min(a, b) / large >= NEAR_TEXT;
}

export function jaccard(a: Uint32Array, b: Uint32Array): number {
  if (!a.length && !b.length) return 1;
  let both = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const x = a[i] as number;
    const y = b[j] as number;
    if (x === y) {
      both++;
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return both / (a.length + b.length - both);
}

// The answer a page teaches, or null while any field is still unknown. A label from a source whose spot check failed
// (`unverified`) is taught at lower confidence; every other label at 0.95. For Loupe 1.1 onward (`brandAsTruth`
// false, D03 T04 §45) brand is never taught as truth: the answer carries null, brand and host stay grouping and
// capping keys through the page's own labels, and no brand score is taken from the version.
export function answerOf(page: StoredPage, brandAsTruth = true): PageAnswer | null {
  const { labels } = page;
  if (labels.lure === undefined || labels.lure_type === undefined || labels.brand === undefined) return null;
  if (labels.has_login_form === undefined || labels.has_payment_form === undefined) return null;
  return {
    brand: brandAsTruth ? labels.brand : null,
    has_login_form: labels.has_login_form,
    has_payment_form: labels.has_payment_form,
    lure: labels.lure,
    lure_type: labels.lure_type,
    // Confidence is P(lure) (the screener prompt's definition, and what §48's escalation band reads): a lure
    // carries its label certainty, a benign page one minus it. A lure type resting on an untrusted form flag
    // (§18) teaches as little as an unverified lure. Until 2026-11-02 this taught label certainty whatever the
    // lure value, so no benign page could ever sit below the escalation band (URGENT loupe-confidence).
    confidence:
      page.label_source.lure === "unverified" || page.label_source.lure_type === "unverified"
        ? labels.lure
          ? 0.7
          : 0.3
        : labels.lure
          ? 0.95
          : 0.05,
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

// The site a host names (`shared-platforms.ts`): its registrable domain, except on a platform whose tenants are separate
// parties, where it is the full host (a tenant's or account's subdomain) or, on a shared service host where tenants
// are told apart by path or link, none. Joined by registrable domain alone, shared hosts chained unrelated brands into
// one group of 28,334 pages in the 1.0 collection.
export function siteKey(host: string): string | null {
  const full = host.toLowerCase();
  if (SHARED_HOSTS.has(full)) return null;
  const domain = siteOf(full);
  return PLATFORM_DOMAINS.has(domain) ? full : domain;
}

// Every identity a page shares with others: its canonical brand, its site and its template (plan review finding 3).
export function identities(page: StoredPage): string[] {
  const out: string[] = [];
  if (page.labels.brand) out.push(`brand:${brandIdentity(page.labels.brand)}`);
  const key = page.host ? siteKey(page.host) : null;
  if (key) out.push(`site:${key}`);
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
// The pages whose group (`groupEntries`) could be held out of training: groups within `heldLimit` of `pages`.
export function holdablePages(pages: StoredPage[]): StoredPage[] {
  const limit = heldLimit(pages.length);
  const groups = groupEntries(
    pages.map((page) => ({ page, answer: null as unknown as PageAnswer, hash: 0n, words: new Uint32Array(0) })),
  );
  return [...groups.values()].filter((group) => group.length <= limit).flatMap((group) => group.map((e) => e.page));
}

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

type Entry = { page: StoredPage; answer: PageAnswer; hash: bigint; words: Uint32Array };

// A build's page shingles, held on disk rather than in the heap (coordinator direction, 2026-11-02): loading
// 170 thousand pages' shingle sets is what grew the build until the machine's memory guard killed it, several
// times, before it could split. A batch streams through; the deduplicator asks for a page's shingles only
// when a near-duplicate candidate forces the comparison, and a small cache bounds what is held. The file is
// the build's own scratch: removed when the build ends, never an input a rebuild could read.
export class WordSpill {
  private fd: number | null = null;
  private end = 0;
  private cache = new Map<object, Uint32Array>();
  readonly refs = new Map<object, { offset: number; length: number }>();
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  private open(): number {
    if (this.fd === null) this.fd = openSync(this.path, "w+");
    return this.fd;
  }
  // Write one entry's shingles out and get its words back later by the entry itself; the entry's own array is
  // replaced with an empty one by the caller, so only the file (and cache) ever holds the set.
  add(entry: object, words: Uint32Array): void {
    const bytes = Buffer.from(words.buffer, words.byteOffset, words.byteLength);
    const fd = this.open();
    for (let at = 0; at < bytes.length; ) {
      const written = writeSync(fd, bytes, at, bytes.length - at, this.end + at);
      if (written <= 0) throw new Error(`a word spill write took no bytes at ${this.end + at}`);
      at += written;
    }
    this.refs.set(entry, { offset: this.end, length: words.length });
    this.end += bytes.length;
  }
  // A spilled set's length without reading it back: the size bar that rules a pair out before any comparison.
  length(entry: Entry): number {
    return this.refs.get(entry)?.length ?? entry.words.length;
  }
  get(entry: Entry): Uint32Array {
    const cached = this.cache.get(entry);
    if (cached) return cached;
    const ref = this.refs.get(entry);
    if (!ref) return entry.words;
    const words = new Uint32Array(ref.length);
    if (ref.length) {
      const bytes = Buffer.from(words.buffer, words.byteOffset, words.byteLength);
      let at = 0;
      while (at < bytes.length) {
        const read = readSync(this.open(), bytes, at, bytes.length - at, ref.offset + at);
        if (read <= 0) throw new Error(`a word spill read took no bytes at ${ref.offset + at}`);
        at += read;
      }
    }
    if (this.cache.size >= 256) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(entry, words);
    return words;
  }
  close(removeFile = true): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.cache.clear();
    if (removeFile) rmSync(this.path, { force: true });
  }
}

const NO_WORDS = new Uint32Array(0);

// Only the page fields the build reads after a page is admitted (its identity, labels, sources and content
// hashes): the descriptor the later phases hold, never the page's text, screenshot or evidence again.
export function compactPage(page: StoredPage): StoredPage {
  return {
    id: page.id,
    source: page.source,
    origin: page.origin,
    licence: page.licence,
    host: page.host,
    template: page.template,
    south_africa: page.south_africa,
    labels: { ...page.labels },
    label_source: { ...page.label_source },
    sha256: { ...page.sha256 },
    redacted: page.redacted,
    ...(page.item !== undefined ? { item: page.item } : {}),
    ...(page.items !== undefined ? { items: page.items.map((item) => ({ ...item })) } : {}),
  } as StoredPage;
}

// Pages kept after exact and near duplicates go: exact by screenshot and text hash; near when the screenshots are
// within 6 bits and the texts share 80 percent of their shingles. Screenshots alone are not enough: renders of dataset
// HTML carry no styles, so different pages often look alike at 9 by 8 pixels. Bands of the hash find candidates
// without comparing every pair (two hashes within 6 bits agree on at least one of 7 bands).
export function dedupe(
  entries: Entry[],
  prefer: Set<string> = new Set(),
  protectors: Entry[] = [],
  progress?: (line: string) => void,
  verified: (entry: Entry) => boolean = () => false,
  wordsOf: (entry: Entry) => Uint32Array = (entry) => entry.words,
  wordLength: (entry: Entry) => number = (entry) => entry.words.length,
): { kept: Entry[]; exact: number; near: number } {
  const seen = new Set<string>();
  const kept: Entry[] = [];
  const bands = Array.from({ length: 7 }, () => new Map<number, Entry[]>());
  let exact = 0;
  let near = 0;
  // The pages `prefer` names come first, so a twin is dropped in their place, never they in its; then the pages whose
  // label the teacher verified, so the copy kept is one evaluation may use (the 1.0 build fell 3 evaluation pages short
  // with agreed pages dropped for unchecked twins). One copy survives either way.
  const order = (a: Entry, b: Entry) =>
    Number(prefer.has(b.page.id)) - Number(prefer.has(a.page.id)) ||
    Number(verified(b)) - Number(verified(a)) ||
    a.page.id.localeCompare(b.page.id);
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
  let done = 0;
  for (const entry of [...entries].sort(order)) {
    if (++done % 10_000 === 0) progress?.(`build-dataset: ${done} of ${entries.length} pages compared`);
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
    // Two texts share at most the smaller one's shingles, so a pair whose sizes differ by more than the bar cannot reach
    // it: the check skips the merge for such a pair without changing which pages are twins.
    const twin = [...candidates].find((other) => {
      if (hamming(other.hash, entry.hash) > NEAR_BITS) return false;
      if (!sizesAllow(wordLength(other), wordLength(entry))) return false;
      return jaccard(wordsOf(other), wordsOf(entry)) >= NEAR_TEXT;
    });
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
// Within the cap, the trusted sample-derived lures are kept first, then the pages whose label the teacher verified (the
// pages evaluation may use), then a seeded draw.
export function capBrands(
  entries: Entry[],
  random: () => number,
  verified: (entry: Entry) => boolean = () => false,
): Entry[] {
  const byBrand = new Map<string, Entry[]>();
  const out: Entry[] = [];
  for (const entry of entries) {
    // The cap groups by the page's own brand label, so it holds from 1.1 on, where the taught answer carries none.
    const brand = entry.page.labels.brand ? brandIdentity(entry.page.labels.brand) : null;
    if (!brand) out.push(entry);
    else append(byBrand, brand, entry);
  }
  for (const group of byBrand.values()) {
    const ordered = samplesFirst(group, random);
    const rank = (e: Entry) => (sampleLure(e.page) ? 0 : verified(e) ? 1 : 2);
    out.push(...ordered.sort((a, b) => rank(a) - rank(b)).slice(0, BRAND_CAP));
  }
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

// A benign page that is hard for a screener (D03 T04 §45): its brand is absent from the lure pages' brands
// (`unseen-brand`), it names a brand (`brand-named`), or it names none (`unbranded`, the small real sites). 1.0
// flagged 19 of 20 unseen-brand benign pages, so 1.1 keeps every one of these in training through balancing.
export function hardNegativeKind(entry: Entry, lureBrands: Set<string>): string | null {
  if (entry.answer.lure) return null;
  const brand = entry.page.labels.brand ? brandIdentity(entry.page.labels.brand) : null;
  if (brand && !lureBrands.has(brand)) return "unseen-brand";
  if (brand) {
    const host = entry.page.host ? siteKey(entry.page.host) : null;
    const stem = host ? host.split(".")[0] : null;
    return stem && brandIdentity(stem) === brand ? "own-page" : "brand-named";
  }
  return "unbranded";
}

// The hard negatives balancing must not cut: the unseen-brand pages 1.0 flagged, and a brand's own pages.
export function isHardNegative(entry: Entry, lureBrands: Set<string>): boolean {
  const kind = hardNegativeKind(entry, lureBrands);
  return kind === "unseen-brand" || kind === "own-page";
}

export function lureBrandSet(entries: Entry[]): Set<string> {
  return new Set(
    entries.flatMap((e) => (e.answer.lure && e.page.labels.brand ? [brandIdentity(e.page.labels.brand)] : [])),
  );
}

// `balance`, with every entry `keep` accepts surviving the benign cut (D03 T04 §45's hard negatives).
export function balanceKeeping(entries: Entry[], random: () => number, keep: (entry: Entry) => boolean): Entry[] {
  const kept = entries.filter(keep);
  const rest = balance(
    entries.filter((e) => !keep(e)),
    random,
  );
  return [...kept, ...rest];
}

// How far each side sits from the other's lure and lure-type shares, in share points (D03 T04 §45, closing §39's
// reporting gaps for the real split): both sides' counts, the build's target share and a `met` flag at 5 points.
export function splitBalanceReport(train: Entry[], evaluation: Entry[]) {
  const share = (entries: Entry[], pick: (e: Entry) => boolean) =>
    entries.length ? entries.filter(pick).length / entries.length : 0;
  const byType = Object.fromEntries(
    LURE_TYPES.map((t) => {
      const trainShare = share(train, (e) => e.answer.lure_type === t);
      const evalShare = share(evaluation, (e) => e.answer.lure_type === t);
      return [t, { train: trainShare, evaluation: evalShare, gap: Math.abs(trainShare - evalShare) }];
    }),
  ) as Record<string, { train: number; evaluation: number; gap: number }>;
  const lureGap = Math.abs(share(train, (e) => e.answer.lure) - share(evaluation, (e) => e.answer.lure));
  const gaps = [lureGap, ...Object.values(byType).map((v) => v.gap)];
  return {
    target: LURE_SHARE,
    tolerance: 0.05,
    lure: {
      train: share(train, (e) => e.answer.lure),
      evaluation: share(evaluation, (e) => e.answer.lure),
      gap: lureGap,
    },
    byLureType: byType,
    met: gaps.every((g) => g <= 0.05),
  };
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
// balancing and before anything is published. `admittedSampleLures` is the trusted sample-derived lures the split received, after
// every exclusion, deduplication and the brand cap: the denominator of training's half.
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
    // The largest share of the pages one held group may be (`MAX_HELD_SHARE`); a test lifts it to show what it stops.
    maxHeldShare?: number;
  } = {},
): Split {
  const admit = options.admit ?? ((entry: Entry) => trusted(entry.page));
  const floors = options.floors ?? FLOORS;
  const reserved = options.reserved ?? new Set<string>();
  const phantoms = new Set(options.protect ?? []);
  const groups = new Map<string, Entry[]>();
  for (const [key, members] of groupEntries([...entries, ...phantoms])) groups.set(key, members);
  const real = (group: string) => (groups.get(group) ?? []).filter((e) => !phantoms.has(e));
  // A group past `heldLimit` trains: only the reference set's groups are held whatever their size.
  const limit = heldLimit(entries.length, options.maxHeldShare);
  const sizes = new Map([...groups.keys()].map((g) => [g, real(g).length]));
  const holdable = (group: string) => (sizes.get(group) ?? 0) <= limit;
  const templateHoldable = (template: string) =>
    [...groups].every(([g, members]) => holdable(g) || !members.some((e) => e.page.template === template));
  const templates = [...new Set(entries.map((e) => e.page.template).filter((t): t is string => !!t))]
    .sort()
    .filter(templateHoldable);
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
  // Training's floor of sample-derived lures (`checkFloors`), kept while the split chooses: a group whose sample lures
  // would take training below it is not chosen for evaluation, where a later group can meet the need instead. The groups
  // the reference set and the held template hold are taken whatever they hold.
  const samples = new Map([...groups.keys()].map((g) => [g, real(g).filter((e) => sampleLure(e.page)).length]));
  const samplesIn = (group: string) => samples.get(group) ?? 0;
  const trainingNeeds = Math.ceil(entries.filter((e) => sampleLure(e.page)).length * floors.sampleTraining);
  let trainingSamples = [...groups.keys()].filter((g) => !held.has(g)).reduce((sum, g) => sum + samplesIn(g), 0);
  const hold = (group: string) => {
    if (held.has(group)) return;
    held.add(group);
    trainingSamples -= samplesIn(group);
  };
  const spares = (group: string) => trainingSamples - samplesIn(group) >= trainingNeeds;
  const heldBrands = () => new Set([...held].flatMap((g) => [...brandsOf(g)]));
  const candidates = shuffle([...allBrands].sort(), random);
  const groupOfBrand = new Map<string, string>();
  for (const group of [...groups.keys()].sort()) for (const brand of brandsOf(group)) groupOfBrand.set(brand, group);
  for (const brand of candidates) {
    if (heldBrands().size >= wanted) break;
    const group = groupOfBrand.get(brand) as string;
    if (holdable(group) && (!samplesIn(group) || spares(group))) hold(group);
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
    hold(group);
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
    const allowed = (g: string) => holdable(g) && (!samplesIn(g) || spares(g));
    const preferred = rest.findIndex((g) => allowed(g) && real(g).some((e) => admit(e) && needs(e)));
    const index = preferred >= 0 ? preferred : rest.findIndex((g) => allowed(g) && real(g).some(admit));
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
  const shown = lines.map(({ id, origin, line }) => {
    const { answer, text } = validateLine(line, mode);
    const nonce = createHash("sha256").update(id).digest("hex").slice(0, 32);
    return { id, origin, text: `${text.split(nonce).join("")}\n${answer.brand ?? ""}` };
  });
  // One `leaks` call for each kind of line: it makes each term's rule once a call.
  const named = new Set(
    [
      ...leaks(
        shown.filter((s) => s.origin === "samples"),
        allTerms,
      ),
      ...leaks(
        shown.filter((s) => s.origin !== "samples"),
        publicTerms,
      ),
    ].map((hit) => hit.id),
  );
  for (const { id, origin, text } of shown) {
    if (named.has(id)) problems.push(`${id}: a protected sample term`);
    if (origin !== "samples") continue;
    const kind = personalDetail(text);
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
    // Only what the import itself could not read is passed over: a message over the size it reads, or one that does
    // not parse, made no page, so it has no recipient to guard. A file that cannot be read now (permissions, a disk
    // error) may have made pages earlier: its recipients would go unguarded, so the build refuses (§10 round 2).
    if (statSync(path).size > MAX_MESSAGE_BYTES) {
      unreadable++;
      continue;
    }
    const bytes = readFileSync(path);
    let email: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      email = await PostalMime.parse(bytes);
    } catch {
      unreadable++;
      continue;
    }
    const raw = bytes.toString("latin1");
    addressesSeen.push(...addresses(email, raw));
    for (const piece of recipientNames(email, raw, [])) pieces.add(piece);
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
  const metas = readFileSync(join(dir, `${name}.meta.jsonl`), "utf-8").split("\n");
  // Each file ends with a newline, so the last piece is empty.
  if (metas.pop() !== "") throw new PublicationRefused(`${name}: a file does not end with a newline`);
  const problems: string[] = [];
  // Lines are scanned in batches (their screenshots make a line about 235 KB), so the terms' rules are made once a batch.
  const batch: { id: string; origin: string; line: string }[] = [];
  const scan = () => {
    problems.push(...scanSampleLines(batch, terms, mode));
    batch.length = 0;
  };
  const read = eachLine(join(dir, `${name}.jsonl`), (line, index) => {
    if (index >= metas.length) return;
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
    batch.push({ id: meta.id, origin: meta.origin, line });
    if (batch.length >= READ_BACK_BATCH) scan();
  });
  scan();
  if (read.lines !== metas.length)
    throw new PublicationRefused(`${name}: ${read.lines} lines but ${metas.length} meta lines`);
  if (problems.length)
    throw new PublicationRefused(
      `${name}: ${problems.length} lines hold protected details (${problems.slice(0, 5).join("; ")})`,
    );
  return read;
}

// Written to a temporary name, flushed, renamed over the target and the folder flushed: a power cut leaves the old file
// or the whole new one, never an empty one a later build would trust.
function writeAtomic(path: string, text: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  const flush = (target: string) => {
    const fd = openSync(target, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  flush(temporary);
  renameSync(temporary, path);
  flush(dirname(path));
}

// A file of lines written one line at a time, temp then rename: a version's lines carry their screenshots (about
// 235 KB a line, some 20 GB for 1.0's training file), so they are never joined in memory (the third 1.0 build was
// stopped by the host's out-of-memory guard at 6 GB while it joined them).
export function writeLinesAtomic(path: string, lines: Iterable<string>): number {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  let count = 0;
  try {
    for (const line of lines) {
      writeSync(fd, `${line}\n`);
      count++;
    }
    fsyncSync(fd);
  } catch (error) {
    // A failed line leaves the destination as it was and no partial file behind.
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
  return count;
}

// Each line of a file, read in bounded chunks with the file's SHA-256 taken over the same bytes; the file must end
// with a newline.
export function eachLine(
  path: string,
  visit: (line: string, index: number) => void,
): { sha256: string; lines: number } {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(4 << 20);
  let pending: Buffer[] = [];
  let index = 0;
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      const bytes = chunk.subarray(0, read);
      hash.update(bytes);
      let start = 0;
      for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, start)) {
        pending.push(bytes.subarray(start, at));
        visit(Buffer.concat(pending).toString("utf-8"), index++);
        pending = [];
        start = at + 1;
      }
      if (start < read) pending.push(Buffer.from(bytes.subarray(start)));
    }
  } finally {
    closeSync(fd);
  }
  if (pending.length) throw new PublicationRefused(`${path}: the file does not end with a newline`);
  return { sha256: hash.digest("hex"), lines: index };
}

// Pages barred from every dataset that a split or evaluation file holds (the label rules' exclusion list):
// a build whose files hold one refuses, so a barred page can never slip in through a later pass
// (coordinator decision, 2026-11-02, for the leak-flagged sample pages among them).
export function excludedInFiles(excluded: Map<string, string>, ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => excluded.has(id));
}

// One teacher record as the 1.1 judge passes leave it (Astra pass 1 in `raw/astra`, Wonder pass 2 in
// `raw/wonder`, each tagged by its `test` field): the label it gave, never a brand.
export type JudgeRecord = { lure: boolean; lure_type: string; capture_valid: boolean };

// The 1.1 label rule (coordinator, 2026-11-01 23:55): where Astra and the source agree, the label stands;
// where they disagree, or Astra called a lure page's capture invalid, Wonder's pass 2 label decides; a page
// no judge settled, and a benign page Astra called an invalid capture, are left out.
export function judgeDecision(
  answer: PageAnswer,
  astra: JudgeRecord | undefined,
  wonder: JudgeRecord | undefined,
): { kind: "stand" } | { kind: "judged"; answer: PageAnswer } | { kind: "drop"; reason: string } {
  if (!astra) return { kind: "stand" };
  // A benign page Astra called an invalid capture is a wall or empty capture: left out. A lure page Astra
  // called invalid goes to the judge like a disagreement (pass 2, set b).
  if (!astra.capture_valid && !astra.lure && !answer.lure) return { kind: "drop", reason: "invalid-capture" };
  const needsJudge = astra.lure !== answer.lure || !astra.capture_valid;
  if (!needsJudge) return { kind: "stand" };
  if (!wonder || !wonder.capture_valid) return { kind: "drop", reason: "unresolved" };
  return {
    kind: "judged",
    answer: {
      ...answer,
      lure: wonder.lure,
      lure_type: wonder.lure ? (wonder.lure_type as PageAnswer["lure_type"]) : "none",
    },
  };
}

// The judge records of one pass: only records the pass tagged, so earlier comparison tests never judge.
export function readJudgeRecords(dir: string, ns: string, test: string): Map<string, JudgeRecord> {
  const out = new Map<string, JudgeRecord>();
  const folder = join(dir, "raw", ns);
  if (!existsSync(folder)) return out;
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(folder, name), "utf-8")) as JudgeRecord & {
        page: string;
        test?: string;
      };
      if (record.test === test) out.set(record.page, record);
    } catch {
      // a record that does not parse judges nothing
    }
  }
  return out;
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
    // Public pages that name the pilot client (a client name, address or domain of the protected terms): a version
    // leaves the machine, so they are never in one (the fourth 1.0 build was refused on 8 such lines).
    namesClient: number;
    // Sample pages left out because the set is not ready (`sampleReadiness`): no clean leak check over these very
    // pages, the label rules not run over them, or the teacher's receipt stale (§19, plan review finding 7).
    samplesUnready: number;
  };
  sha256: { train: string; evaluation: string };
};

// Why the store's sample pages may not enter a version yet, or nothing when they may: after a rebuild under a changed
// redaction, the leak check must have passed over the pages stored now (`leakCheckProblem`), the label rules must have
// run over them (each has a complete label or an exclusion), and the teacher's receipt must cover the store as it is
// now, not as it was before the rebuild (§19, plan review finding 7). The leak check must also have run under the
// redaction the code, model and configuration give now (`redactionKey()` over `redaction.samples` and
// `redaction.config`), so a build after a change to the redaction and before the re-import admits none of the old
// pages (§19 completion review gap 4). Without `redaction` the current key cannot be known, and no sample page is ready.
export function sampleReadiness(
  store: ReturnType<typeof openStore>,
  redaction?: { samples: string; config?: EntityConfig },
): string[] {
  const problems: string[] = [];
  if (!redaction) problems.push("the current redaction is not known: the build was given no samples folder");
  else {
    const leak = leakCheckProblem(store, redactionKey(redaction.samples, undefined, redaction.config));
    if (leak) problems.push(leak);
  }
  const pages = store.manifest({ tolerant: true });
  const excluded = readExcluded(store.dir);
  const loose = pages.filter((p) => p.origin === "samples" && !excluded.has(p.id) && !completeLabel(p.labels)).length;
  if (loose) problems.push(`${loose} sample pages have neither a complete label nor an exclusion: run label-rules.ts`);
  const receipt = receiptProblem(store, pages);
  if (receipt) problems.push(`the teacher's checks are not current (${receipt})`);
  return problems;
}

// The evaluation pages of every version published before `version` (their `eval.meta.jsonl`), which a later version
// holds out of its training (§27). Empty for the first version.
export function previousHeldOut(dir: string, version: string): Set<string> {
  const held = new Set<string>();
  const root = join(dir, "dataset");
  if (!existsSync(root)) return held;
  const [major, minor] = version.split(".").map(Number) as [number, number];
  for (const name of readdirSync(root)) {
    const match = /^(\d+)\.(\d+)$/.exec(name);
    if (!match) continue;
    const [, a, b] = match;
    if (Number(a) > major || (Number(a) === major && Number(b) >= minor)) continue;
    const meta = join(root, name, "eval.meta.jsonl");
    if (!existsSync(meta)) continue;
    for (const line of readFileSync(meta, "utf-8").split("\n"))
      if (line.trim()) held.add((JSON.parse(line) as { id: string }).id);
  }
  return held;
}

// The metadata a published version's evaluation list holds for one page: the identities a later build can still
// protect when the page itself has left the store (a benign capture removed as a wall on recheck, coordinator
// decision 2026-11-02, option b). Its brand identity and its screenshot hash are what a copy is matched by.
export type HeldOutMeta = { id: string; brand_identity: string | null; screenshot: string };

// Every earlier version's evaluation metadata, by page id (`previousHeldOut` reads the same files for the ids).
export function previousHeldOutMeta(dir: string, version: string): Map<string, HeldOutMeta> {
  const out = new Map<string, HeldOutMeta>();
  const root = join(dir, "dataset");
  if (!existsSync(root)) return out;
  const [major, minor] = version.split(".").map(Number) as [number, number];
  for (const name of readdirSync(root)) {
    const match = /^(\d+)\.(\d+)$/.exec(name);
    if (!match) continue;
    const [, a, b] = match;
    if (Number(a) > major || (Number(a) === major && Number(b) >= minor)) continue;
    const meta = join(root, name, "eval.meta.jsonl");
    if (!existsSync(meta)) continue;
    for (const line of readFileSync(meta, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { id: string; brand_identity?: string | null; screenshot?: string };
      out.set(row.id, { id: row.id, brand_identity: row.brand_identity ?? null, screenshot: row.screenshot ?? "" });
    }
  }
  return out;
}

// The protection a set of gone held-out pages still gets from their metadata: their pages, the brand identities
// and screenshot hashes a copy is matched by, and the pages no identity survives for (a build refuses those).
export function metadataProtectionFor(rows: HeldOutMeta[]): {
  pages: string[];
  brands: Set<string>;
  screenshots: Set<string>;
  unprotectable: string[];
} {
  return {
    pages: rows.map((r) => r.id),
    brands: new Set(rows.flatMap((r) => (r.brand_identity ? [r.brand_identity] : []))),
    screenshots: new Set(rows.flatMap((r) => (r.screenshot ? [r.screenshot] : []))),
    unprotectable: rows.filter((r) => !r.brand_identity && !r.screenshot).map((r) => r.id),
  };
}

// Each published version's evaluation pages by source item (`<store>/raw/dataset/<version>.heldout-items.jsonl`): a
// redaction-key change remakes a sample page under a new id with new text but the same source item, so a later
// version keeps it out of training by its item as well as by id (§19, §27).
export const heldOutItemsFile = (dir: string, version: string) =>
  join(dir, "raw", "dataset", `${version}.heldout-items.jsonl`);
const itemKey = (source: string, item: string) => `${source}\n${item}`;
// Every source item a page stands for: its own, and each a second item with the same content brought (§28 G3).
export const pageItems = (page: Pick<StoredPage, "item" | "items">): string[] => [
  ...(page.item ? [page.item] : []),
  ...(page.items ?? []).map((i) => i.id),
];
// The independent reference set by source item too, written once the set is first used: its pages are reserved by id
// for every version, and a sample page remade under a new id would otherwise leave the set (§27).
export const referenceItemsFile = (dir: string) => join(dir, "raw", "dataset", "reference.items.jsonl");

// Adds the reference pages now in the store to the reference items list, keeping every entry already recorded: a page
// remade under a new id later still has its source items listed here.
export function recordReferenceItems(dir: string, ids: Set<string>, pages: StoredPage[]): void {
  const file = referenceItemsFile(dir);
  const recorded = new Map<string, { id: string; source: string; item: string | null; items: string[] }>();
  if (existsSync(file))
    for (const line of readFileSync(file, "utf-8").split("\n"))
      if (line.trim()) {
        const row = JSON.parse(line) as { id: string; source: string; item: string | null; items: string[] };
        recorded.set(row.id, row);
      }
  let changed = false;
  for (const page of pages) {
    if (!ids.has(page.id) || recorded.has(page.id)) continue;
    recorded.set(page.id, {
      id: page.id,
      source: page.source,
      item: page.item ?? null,
      items: (page.items ?? []).map((i) => i.id),
    });
    changed = true;
  }
  if (!changed) return;
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, [...recorded.values()].map((r) => `${JSON.stringify(r)}\n`).join(""));
}

// The source items of every version published before `version`, from their lists.
export function previousHeldOutItems(dir: string, version: string): Set<string> {
  const held = new Set<string>();
  const readList = (list: string) => {
    for (const line of readFileSync(list, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { source: string; item: string | null; items?: string[] };
      for (const item of [row.item, ...(row.items ?? [])]) if (item) held.add(itemKey(row.source, item));
    }
  };
  if (existsSync(referenceItemsFile(dir))) readList(referenceItemsFile(dir));
  const root = join(dir, "dataset");
  if (!existsSync(root)) return held;
  const [major, minor] = version.split(".").map(Number) as [number, number];
  for (const name of readdirSync(root)) {
    const match = /^(\d+)\.(\d+)$/.exec(name);
    if (!match) continue;
    const [, a, b] = match;
    if (Number(a) > major || (Number(a) === major && Number(b) >= minor)) continue;
    const list = heldOutItemsFile(dir, name);
    // A published version without its list would let a page remade under a new id train a later version.
    if (!existsSync(list)) {
      if (existsSync(join(root, name, "eval.meta.jsonl")))
        throw new Error(
          `dataset version ${name} is published without its held-out source items (${list}); rebuild its list before building ${version}`,
        );
      continue;
    }
    // A list that does not hold one row for each of the version's evaluation lines was cut short.
    const evalMeta = join(root, name, "eval.meta.jsonl");
    if (existsSync(evalMeta)) {
      const rows = (file: string) =>
        readFileSync(file, "utf-8")
          .split("\n")
          .filter((l) => l.trim()).length;
      if (rows(list) !== rows(evalMeta))
        throw new Error(
          `dataset version ${name}'s held-out source items hold ${rows(list)} of its ${rows(evalMeta)} evaluation pages (${list})`,
        );
    }
    readList(list);
  }
  return held;
}

// The pages a version is built from: those `sources.ts freeze` named, once each frozen source's import record is still
// the one it recorded (an import run since would put other pages or labels behind the same ids) and both benign lists
// were rendered. Throws with the reason otherwise.
// The lures a set of sources adds to a published version (§27 finding 6): its lines by kind in training and in
// evaluation, read from the version's `summary.json`, so they count only what survived the exclusions, the held-out
// protection and deduplication. A source with no lure left reads zero.
export function netNewLures(
  datasetDir: string,
  sources: string[],
): { training: Record<string, number>; evaluation: Record<string, number>; total: number } {
  const summary = JSON.parse(readFileSync(join(datasetDir, "summary.json"), "utf-8")) as Record<
    "train" | "evaluation",
    { luresBySource?: Record<string, Record<string, number>> }
  >;
  const count = (part: "train" | "evaluation") => {
    const bySource = summary[part].luresBySource;
    if (!bySource) throw new Error(`${datasetDir}/summary.json records no lures by source (built before §27)`);
    const kinds: Record<string, number> = {};
    for (const source of sources)
      for (const [kind, n] of Object.entries(bySource[source] ?? {})) kinds[kind] = (kinds[kind] ?? 0) + n;
    return kinds;
  };
  const training = count("train");
  const evaluation = count("evaluation");
  const total = [...Object.values(training), ...Object.values(evaluation)].reduce((a, b) => a + b, 0);
  return { training, evaluation, total };
}

export function readFreeze(dir: string, version = "1.0"): Set<string> {
  const file = freezeFile(dir, version);
  if (!existsSync(file))
    throw new Error(
      `no ${file}: freeze the collection for ${version} first (node scripts/glimmer/sources.ts freeze --version ${version})`,
    );
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

// The build itself, wrapped so its streaming scratch (candidate lines and spilled shingles in the store's
// transient `build-scratch` folder) never outlives it: removed on success and on every refusal alike, so a
// refused build publishes nothing and leaves nothing, exactly as before the streaming change.
export async function buildDataset(options: Parameters<typeof buildDatasetRun>[0]): ReturnType<typeof buildDatasetRun> {
  try {
    return await buildDatasetRun(options);
  } finally {
    const scratchDir = join(options.store.dir, "build-scratch");
    if (existsSync(scratchDir)) {
      for (const stale of readdirSync(scratchDir))
        if (stale.startsWith(`.build-${options.version}-`)) rmSync(join(scratchDir, stale), { force: true });
      if (!readdirSync(scratchDir).length) rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

async function buildDatasetRun(options: {
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
  // The samples folder and the entity pass's configuration the current redaction key is computed from
  // (`sampleReadiness`): the command passes `samples/` and the shipped configuration. Left out, no sample page is ready.
  redaction?: { samples: string; config?: EntityConfig };
  // The two writes publication makes, replaceable so a test can fail one: a file's write (temp then rename) and the
  // rename of the staged folder into place.
  io?: { write?: (path: string, text: string) => void; rename?: (from: string, to: string) => void };
  // Where the build says how far it has come (each stage, and every 10,000 pages read): the command passes stderr, since
  // a build of the whole collection runs for over an hour.
  progress?: (line: string) => void;
  // Every page an earlier version held out (its evaluation pages, `previousHeldOut()`): reserved like the reference set,
  // so it, its groups and its near duplicates never train this version, and it may sit in this version's evaluation,
  // which the version gate (§13) compares on (§27, plan review finding 2).
  heldOut?: Set<string>;
  // The source items of those pages (`previousHeldOutItems`): a page now in the store with one of them is reserved too.
  heldOutItems?: Set<string>;
  // Whether the taught answer may carry brand as truth: true for Loupe 1.0, false from 1.1 on (D03 T04 §45).
  // The command sets it from the version; a direct caller defaults to 1.0's behaviour.
  brandAsTruth?: boolean;
}): Promise<Built> {
  const { store, version, mode } = options;
  // A published version is never replaced: a new number is required, so a model trained on one never finds its files
  // changed under it.
  const final = join(store.dir, "dataset", version);
  if (existsSync(final))
    throw new Error(`dataset version ${version} is already published at ${final}; use a new version number`);
  const floors = options.floors ?? FLOORS;
  // Loupe 1.1 onward: brand is grouping only, never taught or scored as truth (D03 T04 §45); 1.0 keeps its answer.
  const brandAsTruth = options.brandAsTruth ?? true;
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
    namesClient: 0,
    samplesUnready: 0,
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
  // The loading phase streams (coordinator direction, 2026-11-02): a page is read, screened and its shingles
  // spilled, then only its compact descriptor line is written out in bounded batches. The whole store's pages,
  // texts, screenshots and shingle sets are never held at once; later phases hold the descriptors and the
  // split's assignments. Both scratch files are this build's own and are removed before it returns (a failed
  // build's are removed by the next build's start, below).
  mkdirSync(join(store.dir, "build-scratch"), { recursive: true });
  for (const stale of readdirSync(join(store.dir, "build-scratch")))
    if (stale.startsWith(".build-")) rmSync(join(store.dir, "build-scratch", stale), { force: true });
  const spill = new WordSpill(join(store.dir, "build-scratch", `.build-${version}-${process.pid}.words`));
  const candidateFile = join(store.dir, "build-scratch", `.build-${version}-${process.pid}.candidates.jsonl`);
  const candidateFd = openSync(candidateFile, "w");
  const entries: Entry[] = [];
  let candidateBatch: Entry[] = [];
  const flushCandidates = () => {
    if (!candidateBatch.length) return;
    const lines = candidateBatch
      .map((entry) =>
        JSON.stringify({
          page: entry.page,
          answer: entry.answer,
          hash: entry.hash.toString(),
          word: spill.refs.get(entry) ?? { offset: 0, length: 0 },
        }),
      )
      .join("\n");
    writeFileSync(candidateFd, `${lines}\n`);
    candidateBatch = [];
  };
  const acceptEntry = (entry: Entry) => {
    candidateBatch.push(entry);
    if (candidateBatch.length >= SCAN_BATCH) flushCandidates();
  };
  const unverified: string[] = [];
  // Reference pages that are not candidates (excluded, unlabelled), kept to guard their duplicates.
  const protectorPages: StoredPage[] = [];
  // A public or sample source is used only once its import reads `complete` (§5): a running, stopped or failed import
  // is not trained on or evaluated, whatever pages it already stored.
  const importStatus = new Map<string, string>();
  // The sample set's readiness, read once, on its first sample page.
  let unready: string[] | null = null;
  const samplesReady = () => {
    if (!unready) {
      unready = sampleReadiness(store, options.redaction);
      if (unready.length) options.progress?.(`build-dataset: sample pages left out: ${unready.join("; ")}`);
    }
    return unready.length === 0;
  };
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
  let pages = store.manifest();
  // Only pages whose group can be held out are drawn: each reference page's group is held out of training.
  const reference = reserveReference(
    store.dir,
    holdablePages(
      pages.filter(
        (page) =>
          (!options.frozen || options.frozen.has(page.id)) &&
          page.labels.lure !== undefined &&
          TRUSTED.has(page.label_source.lure ?? "") &&
          !(page.origin === "samples" && !page.redacted) &&
          usable(page) &&
          !(page.origin === "samples" && !samplesReady()),
      ),
    ),
    options.referenceSize,
  );
  recordReferenceItems(store.dir, reference.ids, pages);
  // An earlier version's held-out page that is no longer in the store (its source removed, or a benign capture
  // removed as a wall on recheck) is protected from its published metadata instead (coordinator, 2026-11-02,
  // option b): a candidate matching its brand identity or screenshot hash is reserved out of training exactly
  // as if the page were present. A gone page no identity survives for still refuses the build.
  const stored = new Set(pages.map((page) => page.id));
  const gone = [...(options.heldOut ?? [])].filter((id) => !stored.has(id));
  const heldOutMeta = previousHeldOutMeta(store.dir, version);
  const metadata = metadataProtectionFor(
    gone.map((id) => heldOutMeta.get(id) ?? { id, brand_identity: null, screenshot: "" }),
  );
  if (metadata.unprotectable.length)
    throw new Error(
      `${metadata.unprotectable.length} held-out page(s) of an earlier version are no longer in the store (${metadata.unprotectable.slice(0, 3).join(", ")}); ` +
        "their copies could train this version, so it is not built",
    );
  const metadataReserved = new Set<string>();
  for (const id of options.heldOut ?? []) reference.ids.add(id);
  if (options.heldOutItems?.size)
    for (const page of pages)
      if (pageItems(page).some((item) => options.heldOutItems?.has(itemKey(page.source, item))))
        reference.ids.add(page.id);
  // A page whose `lure` the teacher disputed is left out of both files (§9), whether or not its queue entry was written:
  // the teacher saves a disputed outcome before it queues the page, so a stop between the two writes leaves a dispute
  // known only to its state (plan review finding 5). The queue's own entries count too.
  const teacher = readTeacherState(store.dir);
  // The 1.1 judge passes (Astra pass 1, Wonder pass 2), read only for a version that does not teach brand.
  const astraJudge = brandAsTruth ? new Map<string, JudgeRecord>() : readJudgeRecords(store.dir, "astra", "pass-1");
  const wonderJudge = brandAsTruth ? new Map<string, JudgeRecord>() : readJudgeRecords(store.dir, "wonder", "pass-2");
  const judges = { astraRecords: astraJudge.size, stood: 0, wonderDecided: 0, unresolved: 0, invalidCapture: 0 };
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
  // A public page naming the client is left out before anything is built from it, scanned in batches so the terms'
  // rules are made once a batch (`leaks` makes them a call). A sample page is redacted already, and one that still
  // holds a term is refused at publication, never dropped quietly.
  const kinds = options.protectedTerms ? termKinds(options.protectedTerms) : null;
  const clientTerms = kinds ? [...kinds.client, ...kinds.addresses, ...kinds.domains] : [];
  const pending: { entry: Entry; text: string }[] = [];
  const screenPublic = () => {
    const named = new Set(
      leaks(
        pending.map(({ entry, text }) => ({ id: entry.page.id, text })),
        clientTerms,
      ).map((hit) => hit.id),
    );
    for (const { entry } of pending) {
      if (!named.has(entry.page.id)) acceptEntry(entry);
      else {
        dropped.namesClient++;
        if (reference.ids.has(entry.page.id)) protectorPages.push(entry.page);
      }
    }
    pending.length = 0;
  };
  let read = 0;
  for (const page of pages) {
    if (++read % 10_000 === 0) options.progress?.(`build-dataset: ${read} of ${pages.length} pages read`);
    // A page stored after the collection froze, or an input never frozen, cannot enter this version.
    if (options.frozen && !options.frozen.has(page.id)) {
      dropped.afterFreeze++;
      // An earlier version's held-out page outside this freeze still protects: a copy of it must not train (§27).
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    if (excluded.has(page.id)) {
      dropped.excluded++;
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    if (!usable(page)) {
      dropped.incomplete++;
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    if (page.origin === "samples" && !samplesReady()) {
      dropped.samplesUnready++;
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    // A disputed page in the reference set stays an entry, so its groups are held out; it is never admitted anywhere.
    if (disputed.has(page.id) && !reference.ids.has(page.id)) {
      dropped.disputed++;
      continue;
    }
    let answer = answerOf(page, brandAsTruth);
    if (!answer) {
      dropped.unlabelled++;
      if (reference.ids.has(page.id)) protectorPages.push(page);
      continue;
    }
    // From 1.1 on, the two judge passes settle a labelled page before it enters (never in 1.0, whose
    // published files stay byte for byte what they were).
    if (!brandAsTruth) {
      const decision = judgeDecision(answer, astraJudge.get(page.id), wonderJudge.get(page.id));
      if (decision.kind === "drop") {
        judges[decision.reason === "invalid-capture" ? "invalidCapture" : "unresolved"]++;
        dropped.disputed++;
        continue;
      }
      if (decision.kind === "judged") {
        answer = decision.answer;
        judges.wonderDecided++;
      } else if (astraJudge.has(page.id)) judges.stood++;
    }
    // A sample-derived page is trained on only once redacted (§7).
    if (page.origin === "samples" && !page.redacted) {
      dropped.unredacted++;
      continue;
    }
    // (the answer below carries no brand as truth from 1.1 on)
    // The bytes are checked against the SHA-256 the record holds before anything is derived from them (plan review
    // finding 2): the near-duplicate hash and shingles below come from these exact bytes, and the line is built from
    // them again, verified again, in `write`. A page that fails is no page of this collection, so the build stops.
    const verified = store.readVerifiedPage(page.id);
    if (!verified) {
      unverified.push(page.id);
      continue;
    }
    const entry: Entry = {
      page: compactPage(verified.page),
      answer,
      hash: await dhash(verified.screenshot),
      words: NO_WORDS,
    };
    spill.add(entry, shingles(verified.text));
    if (page.origin === "samples" || !clientTerms.length) acceptEntry(entry);
    else {
      pending.push({ entry, text: `${page.host ?? ""}\n${verified.text}\n${answer.brand ?? ""}` });
      if (pending.length >= SCAN_BATCH) screenPublic();
    }
  }
  screenPublic();
  if (unverified.length)
    throw new Error(
      `${unverified.length} pages' files do not match their records (first: ${unverified[0]}): repair or remove them before building`,
    );
  // The candidate lines back in, one at a time: descriptors only, their shingles still on disk. The manifest's
  // full page objects are released with them read.
  flushCandidates();
  closeSync(candidateFd);
  {
    const fd = openSync(candidateFile, "r");
    const chunk = Buffer.alloc(1 << 20);
    let carry = "";
    const take = (line: string) => {
      if (!line.trim()) return;
      const row = JSON.parse(line) as {
        page: StoredPage;
        answer: PageAnswer;
        hash: string;
        word: { offset: number; length: number };
      };
      const entry: Entry = { page: row.page, answer: row.answer, hash: BigInt(row.hash), words: NO_WORDS };
      spill.refs.set(entry, row.word);
      entries.push(entry);
    };
    for (let at = 0; ; ) {
      const read = readSync(fd, chunk, 0, chunk.length, at);
      if (!read) break;
      at += read;
      const text = carry + chunk.toString("utf-8", 0, read);
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    take(carry);
    closeSync(fd);
  }
  rmSync(candidateFile, { force: true });
  const protectors: Entry[] = [];
  for (const page of protectorPages) {
    const verified = store.readVerifiedPage(page.id);
    if (!verified) throw new Error(`reference page ${page.id}'s files do not match its record`);
    const protector: Entry = {
      page: compactPage(verified.page),
      answer: null as unknown as PageAnswer,
      hash: await dhash(verified.screenshot),
      words: NO_WORDS,
    };
    spill.add(protector, shingles(verified.text));
    protectors.push(protector);
  }
  protectorPages.length = 0;
  pages = [];
  // (The split and the written files work from the descriptors and each chosen page read back on its own.)
  options.progress?.(`build-dataset: ${entries.length} pages admitted; removing duplicates`);
  const deduped = dedupe(
    entries,
    reference.ids,
    protectors,
    options.progress,
    (entry) => teacherState(teacher, entry.page) === "agreed",
    (entry) => spill.get(entry),
    (entry) => spill.length(entry),
  );
  dropped.exact = deduped.exact;
  dropped.near = deduped.near;
  const capped = capBrands(deduped.kept, random, (entry) => teacherState(teacher, entry.page) === "agreed");
  dropped.capped = deduped.kept.length - capped.length;
  // The trusted sample-derived lures the split receives, after every exclusion, deduplication and the brand cap: the
  // denominator of training's half. A copy deduplication dropped can be in neither split, so it does not count against
  // training.
  const admittedSampleLures = capped.filter((e) => sampleLure(e.page)).length;
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
    return record ? [{ page: record, answer: null as unknown as PageAnswer, hash: 0n, words: new Uint32Array(0) }] : [];
  });
  options.progress?.(`build-dataset: ${capped.length} pages after duplicates and caps; splitting`);
  // Metadata protection for gone held-out pages (option b above): their brand and screenshot families are
  // reserved out of training like the reference pages, and counted in the summary apart from stored pages.
  for (const entry of capped)
    if (
      metadata.screenshots.has(entry.page.sha256.screenshot) ||
      (entry.page.labels.brand && metadata.brands.has(brandIdentity(entry.page.labels.brand)))
    )
      metadataReserved.add(entry.page.id);
  const parts = split(capped, random, {
    admit,
    floors,
    reserved: new Set([...reference.ids, ...metadataReserved]),
    protect,
  });
  // From 1.1 on, balancing keeps the hard benign negatives (unseen brands, a brand's own pages) in training.
  const trainBrands = lureBrandSet(parts.train);
  const train = brandAsTruth
    ? balance(parts.train, random)
    : balanceKeeping(parts.train, random, (e) => isHardNegative(e, trainBrands));
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
      const meta: string[] = [];
      const ordered = shuffle(chosen, random);
      function* lines() {
        for (const entry of ordered) {
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
          yield buildTrainingLine(
            buildScreenRequest({ image: screenshot, host: entry.page.host, text, mode, nonce }),
            entry.answer,
          );
        }
      }
      writeLinesAtomic(join(staging, `${name}.jsonl`), lines());
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
    // No barred page in any file that will be uploaded (above): the split kept them out, and this stands
    // guard over every later pass that touches the written files.
    const planted = excludedInFiles(
      excluded,
      [...train, ...evaluation].map((e) => e.page.id),
    );
    if (planted.length)
      throw new PublicationRefused(
        `${planted.length} excluded page(s) in the written files (${planted.slice(0, 3).join(", ")}); a barred page never trains or is evaluated on`,
      );
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
      luresBySource: chosen.reduce<Record<string, Record<string, number>>>((acc, e) => {
        if (!e.answer.lure) return acc;
        const kinds = acc[e.page.source] ?? {};
        kinds[e.answer.lure_type] = (kinds[e.answer.lure_type] ?? 0) + 1;
        acc[e.page.source] = kinds;
        return acc;
      }, {}),
      southAfrica: chosen.filter((e) => e.page.south_africa).length,
      brands: new Set(chosen.flatMap((e) => (e.answer.brand ? [brandIdentity(e.answer.brand)] : []))).size,
    });
    const hardNegatives = (chosen: Entry[]) => {
      const brands = lureBrandSet(chosen);
      return by(chosen, (e) => hardNegativeKind(e, brands) ?? "lure");
    };
    const summary = `${JSON.stringify({ version, mode, seed: options.seed ?? 20261101, freeze: options.frozen ? { pages: options.frozen.size, sha256: freezeDigest(options.frozen) } : null, inputs, ...built, judges, metadataProtection: { pages: metadata.pages, brands: metadata.brands.size, screenshots: metadata.screenshots.size, excludedFromTraining: [...metadataReserved].filter((id) => !train.some((e) => e.page.id === id)).length }, floors, pool, brandAsTruth, splitBalance: splitBalanceReport(train, evaluation), hardNegatives: { training: hardNegatives(train), evaluation: hardNegatives(evaluation) }, reference: { pages: reference.ids.size, sha256: reference.sha256 }, sampleLures: { admitted: admittedSampleLures, training: train.filter((e) => sampleLure(e.page)).length, evaluation: evaluation.filter((e) => sampleLure(e.page)).length }, train: describe(train), evaluation: describe(evaluation), heldOut: parts.heldOut.length, template: parts.template }, null, 2)}\n`;
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
    // The version's evaluation pages by source item, for the versions after it, written before the version is published:
    // a failure here leaves nothing published, and a list left for a version that never appeared is read by no one
    // (`previousHeldOutItems` reads only published versions), so a published version always has its protection.
    write(
      heldOutItemsFile(store.dir, version),
      evaluation
        .map(
          (e) =>
            `${JSON.stringify({ id: e.page.id, source: e.page.source, item: e.page.item ?? null, items: (e.page.items ?? []).map((i) => i.id) })}\n`,
        )
        .join(""),
    );
    rename(staging, final);
    spill.close();
    return built;
  } catch (error) {
    // Lines that fail inspection are removed, never left where they could be uploaded; a failed write or rename leaves
    // the staging folder, and the next build of the version starts it again.
    if (error instanceof PublicationRefused) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// §13's independent reference set as evaluation lines, beside the version: `<store>/dataset/<version>/reference/`
// holds `eval.jsonl`, `eval.meta.jsonl` and `summary.json` in the version's own shape, so `evaluate.ts --set
// reference` asks both screeners about them. Every page of `raw/dataset/reference.json` with a trusted truth goes in,
// a page Spark disputed included (the set exists so Spark's errors stay in what it is scored on); a page excluded, with
// no complete or trusted label, sample-derived and unredacted, whose files do not match, or (public) naming the client is
// left out and counted by reason. Lines are built as the version's are and read back the same way; the folder is
// written once (staging, then renamed) and never replaced.
export function writeReference(options: {
  store: ReturnType<typeof openStore>;
  version: string;
  mode: ScreenMode;
  protectedTerms: string[] | ProtectedTerms;
}): { dir: string; pages: number; skipped: Record<string, number>; sha256: string } {
  const { store, version, mode, protectedTerms } = options;
  const final = join(store.dir, "dataset", version, "reference");
  if (existsSync(final)) throw new Error(`${final} exists; a reference export is never replaced`);
  // The membership is drawn by the first dataset build, from the pool it sees; an export never draws it, or it would
  // draw from nothing and fix the reference set empty for good (§13 round 1).
  if (!existsSync(referenceFile(store.dir)))
    throw new Error("refused: no reference membership yet; build the dataset first, which draws it");
  const { ids, sha256: membership } = reserveReference(store.dir, []);
  const records = new Map(store.manifest().map((page) => [page.id, page]));
  const excluded = readExcluded(store.dir);
  const kinds = termKinds(protectedTerms);
  const clientTerms = [...kinds.client, ...kinds.addresses, ...kinds.domains];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const chosen: { page: StoredPage; answer: PageAnswer; screenshot: Uint8Array; text: string }[] = [];
  for (const id of [...ids].sort()) {
    const page = records.get(id);
    if (!page) skip("not in the store");
    else if (excluded.has(id)) skip("excluded");
    else if (!trusted(page)) skip("no trusted lure label");
    else if (page.origin === "samples" && !page.redacted) skip("sample not redacted");
    else {
      const answer = answerOf(page);
      const verified = answer ? store.readVerifiedPage(id) : null;
      if (!answer) skip("label incomplete");
      else if (!verified) skip("files do not match the record");
      else if (
        page.origin !== "samples" &&
        clientTerms.length &&
        leaks([{ id, text: `${page.host ?? ""}\n${verified.text}\n${answer.brand ?? ""}` }], clientTerms).length
      )
        skip("names the client");
      else chosen.push({ page: verified.page, answer, screenshot: verified.screenshot, text: verified.text });
    }
  }
  const staging = `${final}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const meta = chosen.map(({ page, answer }) =>
      JSON.stringify({
        id: page.id,
        source: page.source,
        origin: page.origin,
        lure_type: answer.lure_type,
        brand: answer.brand,
        brand_identity: answer.brand ? brandIdentity(answer.brand) : null,
        south_africa: page.south_africa,
        screenshot: page.sha256.screenshot,
      }),
    );
    writeLinesAtomic(
      join(staging, "eval.jsonl"),
      (function* () {
        for (const { page, answer, screenshot, text } of chosen) {
          const nonce = createHash("sha256").update(page.id).digest("hex").slice(0, 32);
          yield buildTrainingLine(
            buildScreenRequest({ image: screenshot, host: page.host, text, mode, nonce }),
            answer,
          );
        }
      })(),
    );
    writeAtomic(join(staging, "eval.meta.jsonl"), meta.map((m) => `${m}\n`).join(""));
    const back = readBack(staging, "eval", mode, protectedTerms);
    if (back.lines !== chosen.length)
      throw new PublicationRefused(`reference: ${back.lines} lines read back, ${chosen.length} written`);
    writeAtomic(
      join(staging, "summary.json"),
      `${JSON.stringify({ version, set: "reference", membership, pages: chosen.length, skipped, sha256: { evaluation: back.sha256 } }, null, 2)}\n`,
    );
    renameSync(staging, final);
    return { dir: final, pages: chosen.length, skipped, sha256: back.sha256 };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.filename === process.argv[1] && process.argv[2] === "reference") {
  const version = process.argv[3];
  if (!version || !/^[1-9]\d?\.\d{1,2}$/.test(version) || process.argv.length !== 4) {
    console.error("usage: node scripts/glimmer/build-dataset.ts reference <version>");
    process.exit(2);
  }
  const recorded = /training mode: (image|text-only)/.exec(
    readFileSync(join(ROOT, "docs/glimmer/training.md"), "utf-8"),
  )?.[1] as ScreenMode | undefined;
  if (!recorded) {
    console.error("build-dataset: docs/glimmer/training.md records no `training mode:`");
    process.exit(2);
  }
  const derived = await sampleTerms(join(ROOT, "samples"));
  try {
    console.log(
      JSON.stringify(
        writeReference({ store: openStore(storeDir()), version, mode: recorded, protectedTerms: derived.terms }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`build-dataset: ${(error as Error).message}`);
    process.exit(1);
  }
} else if (import.meta.filename === process.argv[1]) {
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
    frozen = readFreeze(store.dir, version);
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
      redaction: { samples: join(ROOT, "samples") },
      progress: (line) => console.error(line),
      heldOut: previousHeldOut(store.dir, version),
      heldOutItems: previousHeldOutItems(store.dir, version),
      brandAsTruth: version === "1.0",
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
