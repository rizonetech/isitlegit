import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { getDomain } from "tldts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerOf,
  balance,
  balanceEvaluation,
  balanceKeeping,
  brandIdentity,
  buildDataset,
  capBrands,
  checkFloors,
  dedupe,
  dhash,
  eachLine,
  evaluationPool,
  FLOORS,
  type Floors,
  freezeDigest,
  groupEntries,
  groupOf,
  hamming,
  hardNegativeKind,
  heldOutItemsFile,
  holdablePages,
  isHardNegative,
  jaccard,
  lureBrandSet,
  NEAR_TEXT,
  NO_FLOORS,
  netNewLures,
  PublicationRefused,
  previousHeldOut,
  previousHeldOutItems,
  referenceFile,
  referenceItemsFile,
  ShortfallError,
  sampleLure,
  sampleReadiness,
  sampleTerms,
  scanSampleLines,
  shingles,
  siteKey,
  siteOf,
  sizesAllow,
  split,
  splitBalanceReport,
  validateLine,
  writeLinesAtomic,
  writeReference,
} from "../../scripts/glimmer/build-dataset.ts";
import {
  CONSENT_HEADING,
  leakCheckFile,
  redactionKey,
  redactionState,
  samplePagesDigest,
} from "../../scripts/glimmer/import-samples.ts";
import { readExcluded } from "../../scripts/glimmer/label-rules.ts";
import { ENTITY_CONFIG } from "../../scripts/glimmer/redact.ts";
import { openStore, type PageInput, type StoredPage } from "../../scripts/glimmer/store.ts";
import { writeReceipt } from "../../scripts/glimmer/teacher-label.ts";
import { buildScreenRequest, buildTrainingLine, PageAnswer } from "../../src/vision/page-screen.ts";

// scripts/glimmer/build-dataset.ts (D03 T04 §10): duplicates go, no brand passes 300, lures stay within 40 to 60
// percent, and the evaluation set shares no brand, site, template or near duplicate with training and holds only
// labels known to be true.
let dir: string;
// A synthetic samples folder (no message in it) the current redaction key is computed from, as the command computes it
// from `samples/`: the sample set's recorded key and its leak check are written under it (§19 review gap 4).
const SAMPLES = mkdtempSync(join(tmpdir(), "glimmer-dataset-samples-"));
writeFileSync(join(SAMPLES, "client-names.txt"), "Kestrel Holdings\n");
const REDACTION = { samples: SAMPLES };
const KEY = redactionKey(SAMPLES);
afterAll(() => rmSync(SAMPLES, { recursive: true, force: true }));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-dataset-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A page-like picture: a coloured header band and text lines, distinct by seed.
async function shot(seed: number, width = 640, height = 800): Promise<Uint8Array> {
  const band = `hsl(${(seed * 47) % 360},70%,45%)`;
  const lines = Array.from(
    { length: 8 },
    (_, i) =>
      `<rect x="40" y="${200 + i * 60 + ((seed * 13) % 30)}" width="${200 + ((seed * (i + 3) * 37) % 360)}" height="18" fill="#333"/>`,
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/><rect width="100%" height="${120 + (seed % 5) * 20}" fill="${band}"/>${lines}</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg().toBuffer());
}

function page(id: string, over: Partial<StoredPage> = {}, labels: Partial<StoredPage["labels"]> = {}): StoredPage {
  const merged = {
    brand: null,
    has_login_form: false,
    has_payment_form: false,
    lure: false,
    lure_type: "none",
    ...labels,
  };
  return {
    id,
    source: "set",
    origin: "public",
    licence: "CC0",
    host: null,
    template: null,
    south_africa: false,
    labels: merged as StoredPage["labels"],
    label_source: Object.fromEntries(Object.keys(merged).map((k) => [k, "ground-truth"])),
    sha256: { screenshot: id.padEnd(64, "0"), text: id.padEnd(64, "1") },
    redacted: false,
    ...over,
  } as StoredPage;
}

describe("the taught confidence (§48)", () => {
  it("is P(lure): a lure carries its certainty, a benign page one minus it (URGENT loupe-confidence)", () => {
    expect(answerOf(page("lure", {}, { lure: true, lure_type: "credential" }))?.confidence).toBe(0.95);
    expect(answerOf(page("benign"))?.confidence).toBe(0.05);
    const unverified = page("u", {}, { lure: true, lure_type: "credential" });
    unverified.label_source.lure = "unverified";
    expect(answerOf(unverified)?.confidence).toBe(0.7);
    const unverifiedBenign = page("ub");
    unverifiedBenign.label_source.lure = "unverified";
    expect(answerOf(unverifiedBenign)?.confidence).toBe(0.3);
  });
});

describe("near duplicates", () => {
  it("drop a resized copy with the same text and keep a look-alike with other words", async () => {
    const original = await shot(1, 1280, 1600);
    const resized = new Uint8Array(await sharp(original).resize(640).jpeg({ quality: 60 }).toBuffer());
    expect(hamming(await dhash(original), await dhash(resized))).toBeLessThanOrEqual(6);
    const text = "Sign in to your bank account to verify a payment of R4,999 before it is released today";
    const entries = [
      {
        page: page("a"),
        answer: answerOf(page("a")) as PageAnswer,
        hash: await dhash(original),
        words: shingles(text),
      },
      { page: page("b"), answer: answerOf(page("b")) as PageAnswer, hash: await dhash(resized), words: shingles(text) },
      {
        page: page("c"),
        answer: answerOf(page("c")) as PageAnswer,
        hash: await dhash(resized),
        words: shingles("Annual report for shareholders of a mining company, with results for the year and a dividend"),
      },
    ];
    const { kept, near } = dedupe(entries);
    expect(near).toBe(1);
    expect(kept.map((e) => e.page.id)).toEqual(["a", "c"]);
    expect(jaccard(shingles(text), shingles(text))).toBe(1);
    // Packed, sorted and distinct, and the merge walk counts exactly what a set intersection would.
    const words = shingles("one two three one two three four");
    expect(words).toBeInstanceOf(Uint32Array);
    expect([...words]).toEqual([...new Set(words)].sort((x, y) => x - y));
    const a = shingles("the quick brown fox jumps over the lazy dog today");
    const b = shingles("the quick brown fox jumps over a lazy cat today");
    const both = [...a].filter((x) => b.includes(x)).length;
    expect(jaccard(a, b)).toBeCloseTo(both / (a.length + b.length - both), 12);
  });
});

describe("which copy of a duplicate is kept", () => {
  it("keeps the copy whose label the teacher verified, whatever its id, and a reserved copy before either", () => {
    const twin = (id: string) => ({ ...entryOf(page(id, {}, { lure: true, lure_type: "credential" })), hash: 7n });
    const [a, b, c] = [twin("a"), twin("b"), twin("c")];
    for (const e of [a, b, c]) e.page.sha256 = { screenshot: "s".repeat(64), text: "t".repeat(64) };
    const checked = (e: { page: StoredPage }) => e.page.id === "c";
    expect(dedupe([a, b, c], new Set(), [], undefined, checked).kept.map((e) => e.page.id)).toEqual(["c"]);
    expect(dedupe([a, b, c], new Set(["b"]), [], undefined, checked).kept.map((e) => e.page.id)).toEqual(["b"]);
    // Caught: without the teacher's verdict the lowest id survives.
    expect(dedupe([a, b, c]).kept.map((e) => e.page.id)).toEqual(["a"]);
  });
  it("keeps a brand's teacher-verified pages within its cap of 300", () => {
    const many = Array.from({ length: 320 }, (_, i) =>
      entryOf(page(`p${String(i).padStart(3, "0")}`, {}, { brand: "Big", lure: true, lure_type: "credential" })),
    );
    const checked = new Set(Array.from({ length: 10 }, (_, i) => `p${310 + i}`));
    const verified = (e: { page: StoredPage }) => checked.has(e.page.id);
    let lostBefore = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const kept = new Set(capBrands(many, lcg(seed), verified).map((e) => e.page.id));
      expect(kept.size).toBe(300);
      for (const id of checked) expect(kept.has(id)).toBe(true);
      // Caught: a cut that ignores the teacher drops some verified page.
      const blind = new Set(capBrands(many, lcg(seed)).map((e) => e.page.id));
      if ([...checked].some((id) => !blind.has(id))) lostBefore++;
    }
    expect(lostBefore).toBeGreaterThan(0);
  });
});

describe("caps and balance", () => {
  const entry = (id: string, labels: Partial<StoredPage["labels"]>) => {
    const p = page(id, {}, labels);
    return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Uint32Array(0) };
  };
  const random = () => 0.5;

  it("cuts a brand to 300 pages", () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      entry(`b${i}`, { brand: "FNB", lure: true, lure_type: "credential" }),
    );
    const capped = capBrands([...many, entry("x", {})], random);
    expect(capped.filter((e) => e.answer.brand === "FNB")).toHaveLength(300);
    expect(capped).toHaveLength(301);
  });

  it("keeps lures between 40 and 60 percent", () => {
    const lures = Array.from({ length: 900 }, (_, i) => entry(`l${i}`, { lure: true, lure_type: "credential" }));
    const benign = Array.from({ length: 100 }, (_, i) => entry(`n${i}`, {}));
    const share = (set: { answer: PageAnswer }[]) => set.filter((e) => e.answer.lure).length / set.length;
    expect(share(balance([...lures, ...benign], random))).toBeLessThanOrEqual(0.6);
    expect(share(balance([...lures.slice(0, 50), ...benign.concat(benign, benign)], random))).toBeGreaterThanOrEqual(
      0.4,
    );
  });
});

describe("caps and balance keep the sample-derived lures", () => {
  const credential = { lure: true, lure_type: "credential" as const };
  const make = (id: string, sample: boolean, labels: Partial<StoredPage["labels"]> = credential) => {
    const p = page(id, { origin: sample ? "samples" : "public" }, labels);
    return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Uint32Array(0) };
  };

  it("cuts a brand's other pages before a sample-derived lure", () => {
    const entries = [
      ...Array.from({ length: 400 }, (_, i) => make(`p${i}`, false, { brand: "FNB", ...credential })),
      ...Array.from({ length: 5 }, (_, i) => make(`s${i}`, true, { brand: "FNB", ...credential })),
    ];
    const capped = capBrands(entries, () => 0.1);
    expect(capped).toHaveLength(300);
    expect(capped.filter((e) => e.page.origin === "samples")).toHaveLength(5);
  });

  it("drops every other lure before a sample-derived one when it balances", () => {
    const lures = [
      ...Array.from({ length: 20 }, (_, i) => make(`p${i}`, false)),
      ...Array.from({ length: 3 }, (_, i) => make(`s${i}`, true)),
    ];
    const benign = Array.from({ length: 3 }, (_, i) => make(`n${i}`, false, {}));
    const balanced = balance([...lures, ...benign], () => 0.7);
    expect(balanced.filter((e) => e.answer.lure)).toHaveLength(4);
    expect(balanced.filter((e) => e.page.origin === "samples")).toHaveLength(3);
  });
});

describe("one brand identity and site-joined groups", () => {
  const entry = (id: string, over: Partial<StoredPage>, labels: Partial<StoredPage["labels"]>) => {
    const p = page(id, over, labels);
    return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Uint32Array(0) };
  };
  const credential = { lure: true, lure_type: "credential" as const };

  it("caps FNB and First National Bank together at 300", () => {
    const some = (brand: string, n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => entry(`${tag}${i}`, {}, { brand, ...credential }));
    const capped = capBrands([...some("FNB", 200, "a"), ...some("First National Bank", 200, "b")], () => 0.5);
    expect(capped).toHaveLength(300);
  });

  it("folds a domain spelling to its brand, and case and spacing for an unknown name", () => {
    expect(brandIdentity("standardbank.co.za")).toBe(brandIdentity("Standard Bank"));
    expect(brandIdentity("First National Bank")).toBe(brandIdentity("FNB"));
    expect(brandIdentity("Acme  Bank")).toBe(brandIdentity("acme bank"));
    expect(brandIdentity("Acme Bank")).not.toBe(brandIdentity("Acme Pay"));
    expect(new Set(["Acme  Bank", "acme bank", "ACME BANK"].map(brandIdentity)).size).toBe(1);
  });

  it("joins a branded and an unbranded page of one site, and pages of one brand on two sites", () => {
    const branded = entry("a", { host: "login.shop.example.co.za" }, { brand: "Acme Shop", ...credential });
    const bare = entry("b", { host: "cdn.shop.example.co.za" }, { brand: null, ...credential });
    const sibling = entry("c", { host: "other.example.com" }, { brand: "acme  shop", ...credential });
    const stranger = entry("d", { host: "stranger.example.net" }, { brand: "Other", ...credential });
    const groups = [...groupEntries([branded, bare, sibling, stranger]).values()];
    const together = groups.find((members) => members.includes(branded));
    expect(together?.map((e) => e.page.id).sort()).toEqual(["a", "b", "c"]);
    expect(groups).toHaveLength(2);
  });

  it("keeps both sites of one registrable domain in one split", () => {
    const entries = [];
    for (let b = 0; b < 30; b++)
      for (let i = 0; i < 4; i++)
        entries.push(
          entry(
            `p${b}-${i}`,
            { host: i === 0 ? `a.brand${b}.co.za` : `b.brand${b}.co.za` },
            { brand: i === 1 ? null : `Brand ${b}`, ...credential },
          ),
        );
    let state = 11;
    const random = () => {
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
    const parts = split(entries, random);
    expect(parts.evaluation.length).toBeGreaterThan(0);
    const sitesOf = (set: { page: StoredPage }[]) => new Set(set.map((e) => siteOf(e.page.host as string)));
    const brandsOf = (set: { page: StoredPage }[]) =>
      new Set(set.flatMap((e) => (e.page.labels.brand ? [brandIdentity(e.page.labels.brand)] : [])));
    for (const site of sitesOf(parts.evaluation)) expect(sitesOf(parts.train).has(site)).toBe(false);
    for (const brand of brandsOf(parts.evaluation)) expect(brandsOf(parts.train).has(brand)).toBe(false);
  });
});

describe("the split", () => {
  it("shares no brand, site or template, and holds only trusted labels", () => {
    const entries = [];
    for (let b = 0; b < 40; b++)
      for (let i = 0; i < 10; i++) {
        const spark = b % 7 === 0 && i === 0;
        const p = page(
          `p${b}-${i}`,
          { host: `www.site${b}.co.za`, south_africa: b % 2 === 0, template: b === 3 ? "t1" : null },
          {
            brand: `Brand ${b}`,
            lure: i % 2 === 0,
            lure_type: i % 2 === 0 ? (["credential", "payment", "fake_shop", "impersonation"] as const)[b % 4] : "none",
          },
        );
        if (spark) p.label_source.brand = "spark";
        entries.push({
          page: p,
          answer: answerOf(p) as PageAnswer,
          hash: BigInt(b * 10 + i),
          words: new Uint32Array(0),
        });
      }
    let state = 7;
    const random = () => {
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
    const parts = split(entries, random);
    const trainGroups = new Set(parts.train.map((e) => groupOf(e.page)));
    for (const e of parts.evaluation) {
      expect(trainGroups.has(groupOf(e.page))).toBe(false);
      expect(e.page.label_source.brand).not.toBe("spark");
    }
    expect(parts.template).toBe("t1");
    expect(parts.evaluation.some((e) => e.page.template === "t1")).toBe(true);
    expect(parts.train.some((e) => e.page.template === "t1")).toBe(false);
  });
});

describe("buildDataset", () => {
  it("writes lines that validate, a meta line each, refuses unredacted samples, and builds on no floors", async () => {
    const store = openStore(join(dir, "store"));
    const put = async (seed: number, input: Partial<PageInput>, labels: PageInput["labels"]) =>
      store.putPage("set", {
        screenshot: await shot(seed),
        text: `Page ${seed}: ${"distinct words ".repeat(3)}${seed * 7919}`,
        origin: "public",
        licence: "CC0",
        host: `www.site${seed}.com`,
        template: null,
        south_africa: false,
        labels,
        label_source: Object.fromEntries(Object.keys(labels).map((k) => [k, "ground-truth"])),
        redacted: false,
        ...input,
      });
    const full = (lure: boolean, seed = 0) => ({
      brand: lure ? `Bank ${seed}` : null,
      has_login_form: lure,
      has_payment_form: false,
      lure,
      lure_type: lure ? ("credential" as const) : ("none" as const),
    });
    for (let i = 0; i < 12; i++) await put(i, {}, full(i % 2 === 0, i));
    await put(50, { origin: "samples", redacted: false }, full(true));
    await put(51, {}, { lure: true });
    const queued = await put(52, {}, full(true, 52));
    // The source's import reads complete; a second source whose import is still running is left out.
    mkdirSync(join(dir, "store", "raw", "set"), { recursive: true });
    writeFileSync(join(dir, "store", "raw", "set", "IMPORT.json"), JSON.stringify({ status: "complete" }));
    await store.putPage("running-set", {
      screenshot: await shot(60),
      text: "a page from an import still running",
      origin: "public",
      licence: "CC0",
      host: null,
      template: null,
      south_africa: false,
      labels: full(true, 60),
      label_source: Object.fromEntries(Object.keys(full(true, 60)).map((k) => [k, "ground-truth"])),
      redacted: false,
    });
    mkdirSync(join(dir, "store", "raw", "running-set"), { recursive: true });
    writeFileSync(join(dir, "store", "raw", "running-set", "IMPORT.json"), JSON.stringify({ status: "running" }));
    writeFileSync(
      join(dir, "store", "review-queue.jsonl"),
      `${JSON.stringify({ id: queued, spark: { lure: false } })}\n`,
    );
    // The sample set's redaction key is recorded, so its pages reach the redaction check.
    mkdirSync(join(dir, "store", "raw", "samples"), { recursive: true });
    writeFileSync(join(dir, "store", "raw", "samples", "REDACTION.json"), JSON.stringify({ key: KEY, building: null }));
    ready(store);
    const built = await buildDataset({
      redaction: REDACTION,
      store,
      version: "1.0",
      mode: "image",
      seed: 3,
      floors: NO_FLOORS,
      referenceSize: 0,
    });
    expect(built.dropped.unredacted).toBe(1);
    expect(built.dropped.unlabelled).toBe(1);
    expect(built.dropped.disputed).toBe(1);
    expect(built.dropped.incomplete).toBe(1);
    expect(built.train + built.evaluation).toBeGreaterThan(0);
    const lines = readFileSync(join(built.dir, "train.jsonl"), "utf-8").trim().split("\n");
    const meta = readFileSync(join(built.dir, "train.meta.jsonl"), "utf-8").trim().split("\n");
    expect(meta).toHaveLength(lines.length);
    for (const line of lines) {
      const messages = JSON.parse(line).messages;
      expect(PageAnswer.safeParse(JSON.parse(messages.at(-1).content)).success).toBe(true);
      expect(messages[1].content.some((p: { type: string }) => p.type === "image_url")).toBe(true);
    }
    // A second build under a new number is published beside it, whole: no staging folder is left, and the first is
    // never replaced.
    const rebuilt = await buildDataset({
      redaction: REDACTION,
      store,
      version: "1.1",
      mode: "image",
      seed: 3,
      floors: NO_FLOORS,
      referenceSize: 0,
    });
    expect(rebuilt.dir).toBe(join(dir, "store", "dataset", "1.1"));
    expect(readdirSync(join(dir, "store", "dataset"))).toEqual(["1.0", "1.1"]);
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.train.lines + summary.evaluation.lines).toBe(built.train + built.evaluation);
    // Without the set's key (a sample run stopped between its two records), no sample page is used at all.
    writeFileSync(
      join(dir, "store", "raw", "samples", "REDACTION.json"),
      JSON.stringify({ key: null, building: "k2" }),
    );
    const unset = await buildDataset({
      redaction: REDACTION,
      store,
      version: "1.2",
      mode: "image",
      seed: 3,
      floors: NO_FLOORS,
      referenceSize: 0,
    });
    expect([unset.dropped.unredacted, unset.dropped.incomplete]).toEqual([0, 2]);
    // Built from a freeze (§18): a page the freeze does not name (stored after it) is left out, and counted.
    const named = store.manifest().map((p) => p.id);
    const frozen = await buildDataset({
      redaction: REDACTION,
      store,
      version: "1.3",
      mode: "image",
      floors: NO_FLOORS,
      referenceSize: 0,
      seed: 3,
      frozen: new Set(named.slice(1)),
    });
    expect(frozen.dropped.afterFreeze).toBe(1);
    // A frozen page gone from the store refuses the build, never drops out of it unseen.
    await expect(
      buildDataset({
        redaction: REDACTION,
        store,
        version: "1.4",
        mode: "image",
        floors: NO_FLOORS,
        referenceSize: 0,
        seed: 3,
        frozen: new Set([...named, "set-ffffffffffffffff"]),
      }),
    ).rejects.toThrow(/1 frozen pages are no longer in the store \(first: set-ffffffffffffffff\)/);
    expect(unset.dropped.afterFreeze).toBe(0);
    // A page the label rules excluded (a parked capture, contradictory labels) never reaches either file (§18 G5).
    expect(unset.dropped.excluded).toBe(0);
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      `${JSON.stringify({ id: named[0], reason: "the capture is a parked, suspended or taken-down page" })}\n`,
    );
    const ruled = await buildDataset({
      redaction: REDACTION,
      store,
      version: "1.5",
      mode: "image",
      seed: 3,
      floors: NO_FLOORS,
      referenceSize: 0,
    });
    expect(ruled.dropped.excluded).toBe(1);
    const ids = [
      ...readFileSync(join(ruled.dir, "train.meta.jsonl"), "utf-8").split("\n"),
      ...readFileSync(join(ruled.dir, "eval.meta.jsonl"), "utf-8").split("\n"),
    ].filter((line) => line.includes(named[0] as string));
    expect(ids).toEqual([]);
  });
});

describe("evaluation trust", () => {
  it("needs a trusted lure and no Spark label, and allows a rule-filled brand or type", async () => {
    const { trusted, labelTrusted } = await import("../../scripts/glimmer/build-dataset.ts");
    const ruled = page("r", {}, { brand: "FNB", lure: true, lure_type: "credential" });
    ruled.label_source = { ...ruled.label_source, brand: "rule", lure_type: "rule" };
    expect(trusted(ruled)).toBe(true);
    expect(labelTrusted(ruled, "brand")).toBe(false);
    const unverified = page("u", {}, { lure: true, lure_type: "credential" });
    unverified.label_source.lure = "unverified";
    expect(trusted(unverified)).toBe(false);
    const spark = page("s", {}, { brand: "Bank", lure: false });
    spark.label_source.brand = "spark";
    expect(trusted(spark)).toBe(false);
  });
});

// A store of whole pages for the build tests: each page its own picture and words, every source's import complete.
type Spec = {
  seed: number;
  brand?: string | null;
  lure?: boolean;
  type?: "credential" | "payment" | "fake_shop" | "impersonation";
  host?: string | null;
  origin?: "public" | "samples";
  southAfrica?: boolean;
  text?: string;
  redacted?: boolean;
  source?: string;
  image?: Uint8Array;
  item?: string;
};
async function fill(root: string, specs: Spec[]) {
  const store = openStore(join(root, "store"));
  const ids: string[] = [];
  for (const spec of specs) {
    const lure = spec.lure ?? true;
    const labels = {
      brand: spec.brand === undefined ? `Brand ${spec.seed}` : spec.brand,
      has_login_form: lure,
      has_payment_form: false,
      lure,
      lure_type: lure ? (spec.type ?? "credential") : ("none" as const),
    };
    const source = spec.source ?? "set";
    ids.push(
      await store.putPage(source, {
        screenshot: spec.image ?? (await shot(spec.seed)),
        text: spec.text ?? `Page ${spec.seed}: ${"distinct words ".repeat(3)}${spec.seed * 7919}`,
        origin: spec.origin ?? "public",
        licence: "CC0",
        host: spec.host === undefined ? `www.site${spec.seed}.com` : spec.host,
        template: null,
        south_africa: spec.southAfrica ?? false,
        labels,
        label_source: Object.fromEntries(Object.keys(labels).map((k) => [k, "ground-truth"])),
        redacted: spec.redacted ?? spec.origin === "samples",
        ...(spec.item ? { item: spec.item } : {}),
      }),
    );
    mkdirSync(join(root, "store", "raw", source), { recursive: true });
    writeFileSync(join(root, "store", "raw", source, "IMPORT.json"), JSON.stringify({ status: "complete" }));
  }
  if (specs.some((s) => s.origin === "samples")) {
    mkdirSync(join(root, "store", "raw", "samples"), { recursive: true });
    writeFileSync(
      join(root, "store", "raw", "samples", "REDACTION.json"),
      JSON.stringify({ key: KEY, building: null }),
    );
  }
  return { store, ids };
}
// The teacher's saved state: one outcome for each page named.
function teach(root: string, outcomes: Record<string, unknown>) {
  mkdirSync(join(root, "store", "raw", "teacher"), { recursive: true });
  writeFileSync(join(root, "store", "raw", "teacher", "state.json"), JSON.stringify({ pages: outcomes }));
}
const AGREED = { status: "agreed" as const, answer: null, applied: true };
// The sample set as the operator's pipeline leaves it ready (§19): a clean leak check over the sample pages stored now,
// under the recorded redaction key, and the teacher's receipt written for the store as it is.
function ready(store: ReturnType<typeof openStore>, leak: { clean?: boolean } = {}) {
  const { key } = redactionState(store);
  if (key) {
    // The real check digests the dataset-eligible pages only, so this simulated verdict does the same.
    const excluded = readExcluded(store.dir);
    const pages = store.manifest({ tolerant: true }).filter((p) => p.origin === "samples" && !excluded.has(p.id));
    writeFileSync(
      leakCheckFile(store.dir),
      JSON.stringify({ clean: leak.clean ?? true, key, pages: samplePagesDigest(pages) }),
    );
  }
  writeReceipt(store, []);
}
let versions = 0;
const build = (store: ReturnType<typeof openStore>, extra: Partial<Parameters<typeof buildDataset>[0]> = {}) =>
  readyThenBuild(store, extra);
function readyThenBuild(store: ReturnType<typeof openStore>, extra: Partial<Parameters<typeof buildDataset>[0]>) {
  ready(store);
  return buildDataset({
    redaction: REDACTION,
    store,
    version: `2.${++versions}`,
    mode: "image",
    seed: 3,
    floors: NO_FLOORS,
    referenceSize: 0,
    protectedTerms: [],
    ...extra,
  });
}
const idsIn = (folder: string, name: string) =>
  readFileSync(join(folder, `${name}.meta.jsonl`), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id);

describe("teacher admission to evaluation", () => {
  it("keeps an unchecked, failed, refused, stale and disputed page out of evaluation and training", async () => {
    // Eight brands of six pages each; every group the split holds out has one page of each kind.
    const specs: Spec[] = [];
    for (let b = 0; b < 8; b++)
      for (let i = 0; i < 6; i++)
        specs.push({ seed: b * 10 + i, brand: `Brand ${b}`, host: `www.site${b}-${i}.com`, lure: i % 2 === 0 });
    const { store, ids } = await fill(dir, specs);
    const outcomes: Record<string, unknown> = {};
    const kind = (id: string) => ids.indexOf(id) % 6;
    for (const id of ids) {
      const k = kind(id);
      if (k === 0 || k === 5) outcomes[id] = AGREED;
      else if (k === 2) outcomes[id] = { status: "failed", reason: "no valid answer" };
      else if (k === 3) outcomes[id] = { status: "refused", reason: "budget" };
      else if (k === 4) outcomes[id] = { status: "disputed", answer: null, applied: false };
      // k === 1 stays unchecked.
    }
    // A stale agreement: the lure it checked is not the page's now.
    const stale = ids[6] as string;
    outcomes[stale] = {
      status: "agreed",
      answer: null,
      applied: true,
      checked: { lure: false, screenshot: "0".repeat(64), text: "0".repeat(64) },
    };
    teach(dir, outcomes);
    const built = await build(store, { floors: { ...NO_FLOORS, evaluation: 4 } });
    const evaluation = idsIn(built.dir, "eval");
    expect(evaluation.length).toBeGreaterThan(0);
    for (const id of evaluation) expect(outcomes[id]).toEqual(AGREED);
    expect(evaluation).not.toContain(stale);
    const disputed = ids.filter((id) => kind(id) === 4);
    for (const id of [...evaluation, ...idsIn(built.dir, "train")]) expect(disputed).not.toContain(id);
    expect(built.dropped.disputed).toBe(disputed.length);
  });

  it("puts two spellings of one brand in one group", () => {
    const lure = { lure: true, lure_type: "credential" as const };
    const fnb = entryOf(page("a", { host: "a.example.co.za" }, { brand: "FNB", ...lure }));
    const long = entryOf(page("b", { host: "b.example.net" }, { brand: "First National Bank", ...lure }));
    expect([...groupEntries([fnb, long]).values()]).toHaveLength(1);
  });
});

const lcg = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
};

describe("the split's targets are counted on what is published", () => {
  it("holds out ten percent of the distinct canonical brands, not of the joined groups", () => {
    const entries = [];
    // One site hosts 91 brands (one joined group); nine other brands stand alone: 100 brands, ten groups.
    for (let b = 0; b < 91; b++)
      entries.push(
        entryOf(
          page(`big${b}`, { host: "www.hub.co.za" }, { brand: `Hub Brand ${b}`, lure: true, lure_type: "credential" }),
        ),
      );
    for (let b = 0; b < 9; b++)
      entries.push(
        entryOf(
          page(`one${b}`, { host: `www.solo${b}.co.za` }, { brand: `Solo ${b}`, lure: true, lure_type: "credential" }),
        ),
      );
    for (const seed of [3, 5, 7, 11, 13, 17]) {
      const parts = split(entries, lcg(seed), { floors: NO_FLOORS });
      const held = new Set(parts.evaluation.map((e) => brandIdentity(e.page.labels.brand as string)));
      expect(held.size).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps meeting the floors after balancing when lures are in excess", () => {
    const entries = Array.from({ length: 300 }, (_, i) =>
      entryOf(
        i % 10 < 7
          ? page(`l${i}`, { host: `www.l${i}.co.za` }, { brand: `L${i}`, lure: true, lure_type: "credential" })
          : page(`n${i}`, { host: `www.n${i}.co.za` }, { brand: `N${i}`, lure: false }),
      ),
    );
    const floors = { ...NO_FLOORS, evaluation: 60, lureShare: FLOORS.lureShare };
    for (const seed of [3, 5, 7, 11]) {
      const parts = split(entries, lcg(seed), { floors });
      const published = balanceEvaluation(parts.evaluation);
      expect(published.length).toBeGreaterThanOrEqual(60);
      expect(
        checkFloors({ train: balance(parts.train, lcg(1)), evaluation: published, admittedSampleLures: 0 }, floors),
      ).toEqual([]);
    }
  });
});

describe("a site names an operator; a verified shared platform names none (1.0 build: 28,334 pages chained)", () => {
  const lure = { lure: true, lure_type: "credential" as const };
  const pages = [
    // One operator's lure domain serving a kit of three brands from one host (review round 5): one site, one group.
    page("op1", { host: "secure.kestrel-pay.shop" }, { brand: "Alpha", ...lure }),
    page("op2", { host: "secure.kestrel-pay.shop" }, { brand: "Beta", ...lure }),
    page("op3", { host: "login.kestrel-pay.shop" }, { brand: "Gamma", ...lure }),
    // A site builder whose tenants have their own subdomains: three tenants, three groups.
    page("free1", { host: "one.weebly.com" }, { brand: "Delta", ...lure }),
    page("free2", { host: "two.weebly.com" }, { brand: "Epsilon", ...lure }),
    page("free3", { host: "three.weebly.com" }, { brand: "Zeta", ...lure }),
    // A form platform whose tenants differ by path: no site, so only brands join.
    page("form1", { host: "forms.gle" }, { brand: "Eta", ...lure }),
    page("form2", { host: "forms.gle" }, { brand: "Theta", ...lure }),
    page("form3", { host: "www.eta.example" }, { brand: "Eta", ...lure }),
    // An account's own subdomain on a form platform is one operator (review round 6): one site, one group.
    page("acct1", { host: "kestrel.formstack.com" }, { brand: "Iota", ...lure }),
    page("acct2", { host: "kestrel.formstack.com" }, { brand: "Kappa", ...lure }),
    page("acct3", { host: "kestrel.formstack.com" }, { brand: "Lambda", ...lure }),
  ];
  it("keeps one operator's brands together and parts a platform's tenants", () => {
    const groupOfId = new Map<string, string>();
    for (const [key, members] of groupEntries(pages.map(entryOf)))
      for (const e of members) groupOfId.set(e.page.id, key);
    expect(new Set(["op1", "op2", "op3"].map((id) => groupOfId.get(id))).size).toBe(1);
    expect(new Set(["acct1", "acct2", "acct3"].map((id) => groupOfId.get(id))).size).toBe(1);
    expect(new Set(["free1", "free2", "free3"].map((id) => groupOfId.get(id))).size).toBe(3);
    expect(groupOfId.get("form1")).not.toBe(groupOfId.get("form2"));
    expect(groupOfId.get("form1")).toBe(groupOfId.get("form3")); // the brand still joins them
    expect(
      ["secure.kestrel-pay.shop", "One.Weebly.com", "forms.gle", "kestrel.formstack.com", "www.formstack.com"].map(
        siteKey,
      ),
    ).toEqual(["kestrel-pay.shop", "one.weebly.com", null, "kestrel.formstack.com", null]);
  });
  it("never lets the operator cross the split when one of its pages is reserved", () => {
    for (const seed of [1, 2, 3, 5, 8]) {
      for (const [reserved, operator] of [
        ["op1", ["op1", "op2", "op3"]],
        ["acct1", ["acct1", "acct2", "acct3"]],
      ] as const) {
        const parts = split(pages.map(entryOf), lcg(seed), { floors: NO_FLOORS, reserved: new Set([reserved]) });
        const training = new Set(parts.train.map((e) => e.page.id));
        for (const id of operator) expect(training.has(id)).toBe(false);
      }
    }
  });
});

describe("a group too large to hold out trains (1.0 build: 18,880 pages of the common brands)", () => {
  const lure = { lure: true, lure_type: "credential" as const };
  // One group of 101 pages (a brand on many hosts, one past the 100-page minimum limit, which is above 5 percent of
  // the 1,101 pages) and 1,000 single-brand groups: the smallest pool where the size limit, not the floor, decides.
  // (Was 200 and 2,800, 28 s in the gate for the same property.)
  const pages = [
    ...Array.from({ length: 101 }, (_, i) =>
      page(`m${i}`, { host: `www.mega${i}.example` }, { brand: "Mega", ...lure }),
    ),
    ...Array.from({ length: 1000 }, (_, i) =>
      page(`s${i}`, { host: `www.small${i}.example` }, { brand: `Small ${i}`, ...lure }),
    ),
  ];
  it("is never held for the brand share or the floors, whatever the seed", () => {
    // The brand share holds about 100 single pages; a floor of 120 sends the loop after more.
    const floors = { ...NO_FLOORS, evaluation: 120 };
    let heldBefore = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const parts = split(pages.map(entryOf), lcg(seed), { floors });
      expect(parts.evaluation.some((e) => e.page.labels.brand === "Mega")).toBe(false);
      expect(parts.train.filter((e) => e.page.labels.brand === "Mega").length).toBe(101);
      // Caught: with the size limit lifted, some seed holds the large group out.
      const lifted = split(pages.map(entryOf), lcg(seed), { floors, maxHeldShare: 1 });
      if (lifted.evaluation.some((e) => e.page.labels.brand === "Mega")) heldBefore++;
    }
    expect(heldBefore).toBeGreaterThan(0);
  }, 120_000);
  it("is left out of the reference draw, so no reference page forces it out of training", () => {
    const drawn = new Set(holdablePages(pages).map((p) => p.id));
    expect(drawn.has("m0")).toBe(false);
    expect(drawn.size).toBe(1000);
  });
});

describe("training's sample floor while the split chooses (1.0 build: 29 of 100 kept)", () => {
  it("does not take sample lures into evaluation past what training must keep, however short South Africa is", () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, i) =>
        entryOf(
          page(
            `s${i}`,
            { origin: "samples", redacted: true, south_africa: true },
            { lure: true, lure_type: "credential" },
          ),
        ),
      ),
      ...Array.from({ length: 200 }, (_, i) =>
        entryOf(
          page(
            `b${i}`,
            { host: `www.b${i}.co.za` },
            { brand: `B${i}`, lure: i % 2 === 0, lure_type: i % 2 === 0 ? "payment" : "none" },
          ),
        ),
      ),
    ];
    // South Africa's floor can never be met here, so the loop wants every South African page it can find.
    const floors = { ...NO_FLOORS, southAfrica: 500, sampleEvaluation: 5, sampleTraining: 0.5 };
    for (const seed of [3, 5, 7, 11]) {
      const parts = split(entries, lcg(seed), { floors });
      const training = parts.train.filter((e) => sampleLure(e.page)).length;
      expect(training).toBeGreaterThanOrEqual(10);
      expect(parts.evaluation.filter((e) => sampleLure(e.page)).length).toBeGreaterThanOrEqual(5);
      expect(
        checkFloors(
          { train: parts.train, evaluation: parts.evaluation, admittedSampleLures: 20 },
          { ...floors, southAfrica: 0 },
        ),
      ).toEqual([]);
    }
  });
});

describe("the split without admissible pages", () => {
  it("does not hold training groups out for an evaluation nothing can enter", () => {
    const entries = Array.from({ length: 40 }, (_, b) =>
      entryOf(
        page(`p${b}`, { host: `www.site${b}.co.za` }, { brand: `Brand ${b}`, lure: true, lure_type: "credential" }),
      ),
    );
    const parts = split(entries, () => 0.5, { admit: () => false });
    expect(parts.evaluation).toHaveLength(0);
    // Only the tenth of brands held out at the start leaves training.
    expect(parts.train.length).toBe(36);
  });
});

function entryOf(p: StoredPage) {
  return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Uint32Array(0) };
}

describe("a dispute known only to the teacher's state", () => {
  it("keeps the page out of training and evaluation although no queue entry was written", async () => {
    const specs: Spec[] = Array.from({ length: 10 }, (_, i) => ({ seed: i, lure: i % 2 === 0 }));
    const { store, ids } = await fill(dir, specs);
    teach(dir, { [ids[2] as string]: { status: "disputed", answer: null, applied: false } });
    const built = await build(store);
    expect(built.dropped.disputed).toBe(1);
    for (const name of ["train", "eval"]) expect(idsIn(built.dir, name)).not.toContain(ids[2]);
  });
});

describe("verified bytes", () => {
  it("refuses the build on a page whose text was altered", async () => {
    const { store, ids } = await fill(dir, [{ seed: 1 }, { seed: 2 }, { seed: 3, lure: false }]);
    writeFileSync(join(dir, "store", "pages", ids[0] as string, "text.txt"), "altered words");
    await expect(build(store)).rejects.toThrow(/1 pages' files do not match their records \(first: set-/);
  });

  it("refuses the build on a valid JPEG substituted under a frozen id", async () => {
    const { store, ids } = await fill(dir, [{ seed: 1 }, { seed: 2 }, { seed: 3, lure: false }]);
    writeFileSync(join(dir, "store", "pages", ids[1] as string, "screenshot.jpg"), await shot(99));
    await expect(build(store, { frozen: new Set(ids) })).rejects.toThrow(/do not match their records/);
  });

  it("records the freeze's digest and size in summary.json", async () => {
    const { store, ids } = await fill(dir, [{ seed: 1 }, { seed: 2 }, { seed: 3, lure: false }]);
    const built = await build(store, { frozen: new Set(ids) });
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.freeze).toEqual({ pages: 3, sha256: freezeDigest(new Set(ids)) });
    expect(freezeDigest(new Set(ids))).not.toBe(freezeDigest(new Set(ids.slice(1))));
  });
});

type Kind = { lure: boolean; type?: "credential" | "payment" | "fake_shop" | "impersonation"; sa?: boolean };
function shaped(i: number, kind: Kind, sample = false) {
  const labels = kind.lure
    ? { brand: `B${i}`, has_login_form: true, lure: true, lure_type: kind.type ?? "credential" }
    : {};
  return entryOf(page(`q${i}`, { south_africa: !!kind.sa, origin: sample ? "samples" : "public" }, labels));
}
const AGREED_STATE = (entries: { page: StoredPage }[]) => new Map(entries.map((e) => [e.page.id, AGREED]));

describe("evaluationPool", () => {
  const TYPES = ["credential", "payment", "fake_shop", "impersonation"] as const;
  // Exactly the floors: 500 lures (350 credential, 50 each of the other types, 300 South African, 30 sample-derived) and
  // 500 benign pages.
  const exact = (change: (i: number, kind: Kind, sample: boolean) => [Kind, boolean] | null = (_, k, s) => [k, s]) => {
    const out = [];
    for (let i = 0; i < 1000; i++) {
      const kind: Kind =
        i < 500
          ? { lure: true, type: TYPES[Math.max(0, Math.floor(i / 50) - 6)] as (typeof TYPES)[number], sa: i < 300 }
          : { lure: false };
      const changed = change(i, kind, i >= 300 && i < 330);
      if (changed) out.push(shaped(i, changed[0], changed[1]));
    }
    return out;
  };

  it("passes a pool that meets every floor", () => {
    const entries = exact();
    const pool = evaluationPool(entries, AGREED_STATE(entries));
    expect(pool.shortfalls).toEqual([]);
    expect([pool.total, pool.lures, pool.benign, pool.southAfrica, pool.sampleLures, pool.balanced]).toEqual([
      1000, 500, 500, 300, 30, 1000,
    ]);
  });

  it("refuses a pool one page short of each floor, naming it", () => {
    const short = (entries: ReturnType<typeof exact>, state?: Map<string, unknown>) =>
      evaluationPool(entries, (state ?? AGREED_STATE(entries)) as Map<string, never>).shortfalls;
    // 999 pages in all.
    expect(short(exact((i, k, s) => (i === 700 ? null : [k, s])))).toEqual([
      expect.stringMatching(/^evaluation pool 999 of 1000/),
    ]);
    // 299 South African pages.
    expect(short(exact((i, k, s) => [i === 0 ? { ...k, sa: false } : k, s]))).toEqual([
      "South African evaluation pool 299 of 300",
    ]);
    // 49 payment lures (one became a credential lure).
    expect(short(exact((i, k, s) => [i === 350 ? { ...k, type: "credential" } : k, s]))).toEqual([
      "payment evaluation pool 49 of 50",
    ]);
    // 29 sample-derived lures.
    expect(short(exact((i, k, s) => [k, i === 300 ? false : s]))).toEqual([
      "sample-derived lure evaluation pool 29 of 30",
    ]);
    // 49 benign pages: the only floor "none" is held to.
    expect(short(exact((i, k, s) => (i >= 500 && i < 951 ? null : [k, s])))).toEqual([
      expect.stringMatching(/^evaluation pool \d+ of 1000/),
      "none evaluation pool 49 of 50",
    ]);
    // A page the teacher did not agree with is no part of the pool.
    const all = exact();
    const state = AGREED_STATE(all);
    state.delete("q700");
    expect(short(all, state)).toEqual([expect.stringMatching(/^evaluation pool 999 of 1000/)]);
  });

  it("refuses a pool whose lures cannot be held within 40 to 60 percent", () => {
    // 300 lures and 700 benign pages: 1,000 pages, but the share allows 750 at most.
    const entries = [];
    for (let i = 0; i < 1000; i++) entries.push(shaped(i, i < 300 ? { lure: true, sa: true } : { lure: false }));
    const pool = evaluationPool(entries, AGREED_STATE(entries), {
      ...NO_FLOORS,
      evaluation: 1000,
      lureShare: FLOORS.lureShare,
    });
    expect(pool.balanced).toBe(750);
    expect(pool.shortfalls).toEqual([expect.stringMatching(/^evaluation pool 750 of 1000 pages/)]);
  });
});

describe("the floors a version must meet", () => {
  const lures = (n: number, sample: boolean, from = 0) =>
    Array.from({ length: n }, (_, i) => shaped(from + i, { lure: true }, sample));

  it("pins the sample floors the item names", () => {
    expect([FLOORS.sampleEvaluation, FLOORS.sampleTraining]).toEqual([30, 0.5]);
  });

  it("refuses 29 evaluation sample lures and passes 30", () => {
    const floors = { ...NO_FLOORS, sampleEvaluation: FLOORS.sampleEvaluation };
    expect(checkFloors({ train: [], evaluation: lures(29, true), admittedSampleLures: 60 }, floors)).toEqual([
      "sample-derived lure evaluation 29 of 30",
    ]);
    expect(checkFloors({ train: [], evaluation: lures(30, true), admittedSampleLures: 60 }, floors)).toEqual([]);
  });

  it("refuses one below the training half of the admitted sample lures, rounded up", () => {
    const floors = { ...NO_FLOORS, sampleTraining: FLOORS.sampleTraining };
    expect(checkFloors({ train: lures(9, true), evaluation: [], admittedSampleLures: 20 }, floors)).toEqual([
      "training keeps 9 of 20 sample-derived lures, at least 10 needed",
    ]);
    expect(checkFloors({ train: lures(10, true), evaluation: [], admittedSampleLures: 20 }, floors)).toEqual([]);
    // Half of 21 rounds up to 11.
    expect(checkFloors({ train: lures(10, true), evaluation: [], admittedSampleLures: 21 }, floors)).toHaveLength(1);
    expect(checkFloors({ train: lures(11, true), evaluation: [], admittedSampleLures: 21 }, floors)).toEqual([]);
  });

  it("refuses each general shortfall of the finished splits, all named", () => {
    const floors = { ...NO_FLOORS, evaluation: 20, southAfrica: 3, perLureType: 2, lureShare: FLOORS.lureShare };
    const TYPES = ["credential", "payment", "fake_shop", "impersonation"] as const;
    const evaluationOf = (change: (i: number, kind: Kind) => Kind | null) => {
      const out = [];
      for (let i = 0; i < 20; i++) {
        // 10 lures (3, 3, 2, 2 by type) and 10 benign pages, 3 of the lures South African.
        const kind: Kind =
          i < 10
            ? {
                lure: true,
                type: TYPES[[0, 0, 0, 1, 1, 1, 2, 2, 3, 3][i] as number] as (typeof TYPES)[number],
                sa: i < 3,
              }
            : { lure: false };
        const changed = change(i, kind);
        if (changed) out.push(shaped(i, changed));
      }
      return out;
    };
    const train = lures(5, false, 100).concat(Array.from({ length: 5 }, (_, i) => shaped(200 + i, { lure: false })));
    const check = (evaluation: ReturnType<typeof evaluationOf>, over = train) =>
      checkFloors({ train: over, evaluation, admittedSampleLures: 0 }, floors);
    expect(check(evaluationOf((_, k) => k))).toEqual([]);
    expect(check(evaluationOf((i, k) => (i === 15 ? null : k)))).toEqual(["evaluation 19 of 20"]);
    expect(check(evaluationOf((i, k) => (i === 0 ? { ...k, sa: false } : k)))).toEqual([
      "South African evaluation 2 of 3",
    ]);
    expect(check(evaluationOf((i, k) => (i === 8 ? { ...k, type: "credential" } : k)))).toEqual([
      "fake_shop evaluation 1 of 2".replace("fake_shop", "impersonation"),
    ]);
    // A split with 61 percent lures.
    expect(
      check(
        evaluationOf((_i, k) => k),
        lures(7, false, 300)
          .concat(lures(0, false))
          .concat([shaped(900, { lure: false }), shaped(901, { lure: false }), shaped(902, { lure: false })]),
      ),
    ).toEqual(["training lures 7 of 10, outside 40 to 60 percent"]);
    // Several at once are all named.
    expect(check([], [])).toEqual(
      expect.arrayContaining(["evaluation 0 of 20", "training holds no lines", "evaluation holds no lines"]),
    );
  });
});

describe("the reference set reserved for §13", () => {
  const referenceIds = () =>
    (JSON.parse(readFileSync(referenceFile(join(dir, "store")), "utf-8")) as { pages: string[] }).pages;

  it("does not move when the teacher's outcomes change", async () => {
    const specs: Spec[] = Array.from({ length: 24 }, (_, i) => ({ seed: i, lure: i % 3 !== 0 }));
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    await build(store, { referenceSize: 5 });
    const first = referenceIds();
    expect(first).toHaveLength(5);
    // Drawn again from nothing, with every outcome changed (agreed pages disputed, the rest agreed), it is the same.
    rmSync(referenceFile(join(dir, "store")));
    teach(
      dir,
      Object.fromEntries(
        ids.map((id, i) => [id, i % 2 ? { status: "disputed", answer: null, applied: false } : AGREED]),
      ),
    );
    await build(store, { referenceSize: 5 });
    expect(referenceIds()).toEqual(first);
  });

  it("is kept once saved, whatever a later build is asked for", async () => {
    const { store } = await fill(
      dir,
      Array.from({ length: 12 }, (_, i) => ({ seed: i })),
    );
    await build(store, { referenceSize: 3 });
    const first = readFileSync(referenceFile(join(dir, "store")), "utf-8");
    const built = await build(store, { referenceSize: 6, seed: 99 });
    expect(readFileSync(referenceFile(join(dir, "store")), "utf-8")).toBe(first);
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.reference.pages).toBe(3);
  });

  it("keeps every group it holds out of training", async () => {
    // Twelve brands of two pages on two subdomains of one site, one of them unbranded.
    const specs: Spec[] = [];
    for (let b = 0; b < 12; b++) {
      specs.push({ seed: b * 2, brand: `Brand ${b}`, host: `a.brand${b}.co.za` });
      specs.push({ seed: b * 2 + 1, brand: null, host: `b.brand${b}.co.za`, lure: false });
    }
    const { store } = await fill(dir, specs);
    const built = await build(store, { referenceSize: 3 });
    const reference = new Set(referenceIds());
    const byId = new Map(store.manifest().map((p) => [p.id, p]));
    const sites = (ids: string[]) => new Set(ids.map((id) => siteOf(byId.get(id)?.host as string)));
    const train = idsIn(built.dir, "train");
    expect(train.length).toBeGreaterThan(0);
    for (const site of sites([...reference])) expect(sites(train).has(site)).toBe(false);
    for (const id of train) expect(reference.has(id)).toBe(false);
  });

  it("keeps a near duplicate of a reference page out of training, whichever page is the reference", async () => {
    const original = await shot(1, 1280, 1600);
    const resized = new Uint8Array(await sharp(original).resize(640).jpeg({ quality: 60 }).toBuffer());
    const text = "Sign in to your bank account to verify a payment of R4,999 before it is released today";
    for (const [which, other] of [
      [0, 1],
      [1, 0],
    ] as const) {
      rmSync(join(dir, "store"), { recursive: true, force: true });
      const pair: Spec[] = [
        { seed: 1, brand: "Twin A", host: "login.twin-a.co.za", text, image: original },
        { seed: 2, brand: "Twin B", host: "login.twin-b.co.za", text, image: resized },
        { seed: 3, brand: "Twin A", host: "www.twin-a.co.za", lure: false },
        { seed: 4, brand: "Twin B", host: "www.twin-b.co.za", lure: false },
      ];
      const { store, ids } = await fill(dir, [...pair, ...Array.from({ length: 10 }, (_, i) => ({ seed: 20 + i }))]);
      teach(dir, Object.fromEntries(ids.slice(0, 4).map((id) => [id, AGREED])));
      mkdirSync(dirname(referenceFile(join(dir, "store"))), { recursive: true });
      writeFileSync(referenceFile(join(dir, "store")), JSON.stringify({ pages: [ids[which]] }));
      const built = await build(store);
      // The reference page is the one kept (its group is held out and, agreed, evaluated); its twin is gone.
      expect(idsIn(built.dir, "eval")).toContain(ids[which]);
      expect(idsIn(built.dir, "train")).not.toContain(ids[other]);
      expect(built.dropped.near).toBe(1);
    }
  });
});

describe("reference protection outlives the reference page's candidacy", () => {
  const words = Uint32Array.from([1, 2, 3, 4, 5]);
  const at = (id: string, hash: bigint) => ({
    ...entryOf(page(id, { host: `www.${id}.co.za` }, { brand: `Brand ${id}`, lure: true, lure_type: "credential" })),
    hash,
    words,
  });

  it("drops a near duplicate of a reserved page that was itself dropped as a near duplicate", () => {
    // B is six bits from A, C six bits from B and twelve from A: only B's index entry catches C.
    const a = at("a", 0n);
    const b = at("b", 0b111111n);
    const c = at("c", 0b111111111111n);
    const { kept } = dedupe([c, b, a], new Set(["a", "b"]));
    expect(kept.map((e) => e.page.id)).toEqual(["a"]);
  });

  it("holds the site of a protected entry out of training though it is no candidate", () => {
    const protectedEntry = entryOf(
      page("gone", { host: "a.shared.co.za" }, { brand: "Gone", lure: true, lure_type: "credential" }),
    );
    const sibling = entryOf(
      page("sib", { host: "b.shared.co.za" }, { brand: "Sibling", lure: true, lure_type: "credential" }),
    );
    const others = Array.from({ length: 12 }, (_, i) =>
      entryOf(page(`o${i}`, { host: `www.o${i}.co.za` }, { brand: `Other ${i}`, lure: true, lure_type: "credential" })),
    );
    for (const seed of [101, 2027, 86421, 1234567, 99991, 31337]) {
      const parts = split([sibling, ...others], lcg(seed), {
        floors: NO_FLOORS,
        reserved: new Set(["gone"]),
        protect: [protectedEntry],
      });
      expect(parts.train.map((e) => e.page.id)).not.toContain("sib");
      expect(parts.train.map((e) => e.page.id)).not.toContain("gone");
    }
  });

  it("holds out the site of a reference page the label rules excluded", async () => {
    const specs: Spec[] = [
      { seed: 1, brand: "Brand X", host: "a.shared.co.za" },
      { seed: 2, brand: "Brand Y", host: "b.shared.co.za" },
      ...Array.from({ length: 14 }, (_, i) => ({ seed: 20 + i, lure: i % 2 === 0 })),
    ];
    const { store, ids } = await fill(dir, specs);
    mkdirSync(dirname(referenceFile(join(dir, "store"))), { recursive: true });
    writeFileSync(referenceFile(join(dir, "store")), JSON.stringify({ pages: [ids[0]] }));
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      `${JSON.stringify({ id: ids[0], reason: "a parked capture" })}\n`,
    );
    for (const seed of [101, 2027, 86421, 1234567, 99991, 31337]) {
      const built = await build(store, { seed });
      expect(idsIn(built.dir, "train")).not.toContain(ids[1]);
    }
  });
});

// The finished output audited without the builder's own grouping: no brand, site, template or near duplicate in both
// files, and no reference page, nor a brand or site of one, in training (completion review G6).
async function assertIndependent(store: ReturnType<typeof openStore>, folder: string) {
  const byId = new Map(store.manifest().map((p) => [p.id, p]));
  const reference = (JSON.parse(readFileSync(referenceFile(store.dir), "utf-8")) as { pages: string[] }).pages;
  const train = idsIn(folder, "train");
  const evaluation = idsIn(folder, "eval");
  const site = (id: string) => getDomain(byId.get(id)?.host ?? "") ?? `none:${id}`;
  const brand = (id: string) =>
    byId
      .get(id)
      ?.labels.brand?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") ?? `none:${id}`;
  const template = (id: string) => byId.get(id)?.template ?? `none:${id}`;
  for (const [name, key] of [
    ["brand", brand],
    ["site", site],
    ["template", template],
  ] as const) {
    const inTrain = new Set(train.map(key));
    expect(evaluation.filter((id) => inTrain.has(key(id))).map((id) => `${name}:${key(id)}`)).toEqual([]);
  }
  const inReference = new Set(reference.filter((id) => byId.has(id)));
  for (const id of train) expect(inReference.has(id)).toBe(false);
  const referenceBrands = new Set([...inReference].map(brand));
  const referenceSites = new Set([...inReference].map(site));
  expect(train.filter((id) => referenceBrands.has(brand(id)) || referenceSites.has(site(id)))).toEqual([]);
  // Near duplicates: pages whose screenshots are within 6 bits and whose texts share 80 percent of their shingles.
  const measure = async (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        const { screenshot, text } = store.readPage(id);
        return { id, hash: await dhash(screenshot), words: shingles(text) };
      }),
    );
  const [a, b] = [await measure(train), await measure(evaluation)];
  const pairs = [];
  for (const x of a)
    for (const y of b) if (hamming(x.hash, y.hash) <= 6 && jaccard(x.words, y.words) >= 0.8) pairs.push([x.id, y.id]);
  expect(pairs).toEqual([]);
}

describe("the finished output, audited independently", () => {
  it("holds no brand, site, template, near duplicate or reference group on both sides", async () => {
    const specs: Spec[] = [];
    for (let b = 0; b < 14; b++) {
      specs.push({ seed: b * 4, brand: `Brand ${b}`, host: `a.brand${b}.co.za`, lure: true });
      specs.push({ seed: b * 4 + 1, brand: null, host: `b.brand${b}.co.za`, lure: false });
      specs.push({ seed: b * 4 + 2, brand: `Brand ${b}`, host: `c.other${b}.com`, lure: false });
      specs.push({ seed: b * 4 + 3, brand: `Spare ${b}`, host: `www.spare${b}.com`, lure: b % 2 === 0 });
    }
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    const built = await build(store, { referenceSize: 6 });
    expect(idsIn(built.dir, "eval").length).toBeGreaterThan(0);
    await assertIndependent(store, built.dir);
  });
});

// The production floors (FLOORS) need a pool of thousands of pages, about a minute to build: that real-sized proof is
// a bench run (`GLIMMER_BENCH=1 pnpm exec vitest run --project node test/node/glimmer-dataset.test.ts`), and the gate
// builds the same pool at a tenth of its size against floors a tenth of the production ones, which proves the same
// properties: every floor met, evaluation's lures cut by the balancing, the sample floors, the reference draw, and an
// output that audits clean.
const TENTH: Floors = {
  ...FLOORS,
  evaluation: FLOORS.evaluation / 10,
  southAfrica: FLOORS.southAfrica / 10,
  perLureType: FLOORS.perLureType / 10,
  sampleEvaluation: FLOORS.sampleEvaluation / 10,
};
for (const [name, pool, floors, referenceSize, bench] of [
  ["a build at the production floors", 4200, FLOORS, 500, true],
  ["a build at a tenth of the production floors", 420, TENTH, 50, false],
] as const)
  describe.skipIf(bench && !process.env.GLIMMER_BENCH)(name, () => {
    // Words of letters only, so no page text can read as a phone or a long number, unique to the page.
    const wordsFor = (n: number) => {
      const random = lcg(n * 7919 + 13);
      return Array.from({ length: 12 }, () =>
        Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join(""),
      ).join(" ");
    };

    it("publishes a version that meets every floor, and the output audits clean", async () => {
      const images = await Promise.all(Array.from({ length: 12 }, (_, i) => shot(i + 1)));
      const types = ["credential", "payment", "fake_shop", "impersonation"] as const;
      const specs: Spec[] = [];
      for (let i = 0; i < pool; i++) {
        // Lures are 65 percent of the pool, so balancing must cut evaluation's lures (review G2).
        const lure = i % 20 < 13;
        const sample = lure && i % 36 === 0;
        specs.push({
          seed: i,
          image: images[i % images.length] as Uint8Array,
          text: wordsFor(i),
          lure,
          type: types[i % 4] as (typeof types)[number],
          southAfrica: i % 3 === 0 || sample,
          brand: `Brand ${i}`,
          host: `www.site${i}.com`,
          ...(sample ? { origin: "samples" as const, source: "samples-body", host: null } : {}),
        });
      }
      const { store, ids } = await fill(dir, specs);
      teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
      const built = await build(store, { floors, referenceSize });
      const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
      expect(summary.evaluation.lines).toBeGreaterThanOrEqual(floors.evaluation);
      expect(summary.sampleLures.evaluation).toBeGreaterThanOrEqual(floors.sampleEvaluation);
      expect(summary.sampleLures.training).toBeGreaterThanOrEqual(Math.ceil(summary.sampleLures.admitted / 2));
      expect(summary.reference.pages).toBe(referenceSize);
      await assertIndependent(store, built.dir);
    }, 240_000);
  });

describe("an excluded reference page still guards its duplicates", () => {
  it("keeps a near copy of it, from another source, out of training", async () => {
    const original = await shot(1, 1280, 1600);
    const resized = new Uint8Array(await sharp(original).resize(640).jpeg({ quality: 60 }).toBuffer());
    const text = "Sign in to your bank account to verify a payment of R4,999 before it is released today";
    const specs: Spec[] = [
      { seed: 1, brand: "Brand X", host: "login.x.co.za", text, image: original },
      { seed: 2, brand: "Copy Brand", host: "login.copy.example", text, image: resized, source: "other" },
      ...Array.from({ length: 14 }, (_, i) => ({ seed: 20 + i, lure: i % 2 === 0 })),
    ];
    const { store, ids } = await fill(dir, specs);
    mkdirSync(dirname(referenceFile(join(dir, "store"))), { recursive: true });
    writeFileSync(referenceFile(join(dir, "store")), JSON.stringify({ pages: [ids[0]] }));
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      `${JSON.stringify({ id: ids[0], reason: "a parked capture" })}\n`,
    );
    for (const seed of [101, 2027, 86421, 1234567, 99991, 31337]) {
      const built = await build(store, { seed });
      expect(idsIn(built.dir, "train")).not.toContain(ids[1]);
      expect(idsIn(built.dir, "train")).not.toContain(ids[0]);
      expect(idsIn(built.dir, "eval")).not.toContain(ids[0]);
      expect(built.dropped.near).toBe(1);
    }
  });
});

describe("a build short of a floor", () => {
  it("is refused with the shortfalls named and nothing published", async () => {
    const { store, ids } = await fill(dir, [{ seed: 1 }, { seed: 2 }, { seed: 3, lure: false }]);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    const refusal = build(store, { floors: FLOORS });
    await expect(refusal).rejects.toBeInstanceOf(ShortfallError);
    await expect(refusal).rejects.toThrow(/evaluation pool 2 of 1000.*South African evaluation pool 0 of 300/);
    expect(existsSync(join(dir, "store", "dataset"))).toBe(false);
  });

  // A group of one brand: `lures` sample-derived lures and as many benign public pages, so the lure share holds.
  const group = (brand: string, first: number, lures: number): Spec[] => [
    ...Array.from({ length: lures }, (_, i) => ({
      seed: first + i,
      brand,
      origin: "samples" as const,
      source: "samples-body",
      southAfrica: true,
      host: null,
    })),
    ...Array.from({ length: lures }, (_, i) => ({ seed: first + 50 + i, brand, lure: false })),
  ];
  const publics: Spec[] = Array.from({ length: 6 }, (_, i) => ({ seed: 300 + i }));
  const floors = { ...NO_FLOORS, sampleEvaluation: 2, sampleTraining: 0.5 };

  it("refuses a build with no sample-derived lure in evaluation", async () => {
    // Four sample lures the teacher never agreed with: none can enter evaluation.
    const { store } = await fill(dir, [...group("S One", 1, 2), ...group("S Two", 11, 2), ...publics]);
    teach(dir, {});
    await expect(build(store, { floors })).rejects.toThrow(/sample-derived lure evaluation pool 0 of 2/);
  });

  it("refuses a build whose sample-derived lures cannot be split, one group holding all four", async () => {
    // All four in one group, agreed: the group cannot go to evaluation without leaving training none, so the split keeps
    // it in training and evaluation falls short instead. Either way the version is never published.
    const { store, ids } = await fill(dir, [...group("S One", 1, 4), ...publics]);
    teach(dir, Object.fromEntries(ids.slice(0, 8).map((id) => [id, AGREED])));
    await expect(build(store, { floors })).rejects.toThrow(/sample-derived lure evaluation 0 of 2/);
  });

  it("publishes a build with half of them in training, and records both counts in summary.json", async () => {
    const { store, ids } = await fill(dir, [...group("S One", 1, 2), ...group("S Two", 11, 2), ...publics]);
    teach(dir, Object.fromEntries(ids.slice(0, 8).map((id) => [id, AGREED])));
    const built = await build(store, { floors });
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.sampleLures).toEqual({ admitted: 4, training: 2, evaluation: 2 });
    expect(summary.floors.sampleEvaluation).toBe(2);
  });
});

describe("validateLine", () => {
  const goodLine = async (mode: "image" | "text-only" = "image") =>
    buildTrainingLine(
      buildScreenRequest({
        ...(mode === "image" ? { image: await shot(1) } : {}),
        host: "login.example.com",
        text: "Sign in to your account",
        mode,
        nonce: "0123456789abcdef0123456789abcdef",
      }),
      {
        brand: "Acme",
        has_login_form: true,
        has_payment_form: false,
        lure: true,
        lure_type: "credential",
        confidence: 0.95,
      },
    );
  const edited = (line: string, change: (parsed: { messages: Record<string, unknown>[] }) => void) => {
    const parsed = JSON.parse(line);
    change(parsed);
    return JSON.stringify(parsed);
  };

  it("accepts a line the builder wrote, in both modes", async () => {
    expect(validateLine(await goodLine(), "image").answer.brand).toBe("Acme");
    expect(validateLine(await goodLine("text-only"), "text-only").answer.lure).toBe(true);
  });

  it("rejects a line whose answer carries a runtime `screener` field", async () => {
    const line = edited(await goodLine(), (p) => {
      const answer = JSON.parse(p.messages[2]?.content as string);
      p.messages[2] = {
        ...(p.messages[2] as object),
        content: JSON.stringify({ ...answer, screener: "glimmer" }),
      } as never;
    });
    expect(() => validateLine(line, "image")).toThrow(/not a PageAnswer/);
  });

  it("rejects a line over the token limit for its mode", async () => {
    const line = edited(await goodLine("text-only"), (p) => {
      p.messages[1] = { role: "user", content: [{ type: "text", text: `Host: none\n\n${"word ".repeat(60_000)}` }] };
    });
    expect(() => validateLine(line, "text-only")).toThrow(/over the 30000-token limit/);
  });

  it("rejects a line of the wrong structure", async () => {
    const good = await goodLine();
    expect(() => validateLine("not json", "image")).toThrow(/not JSON/);
    expect(() => validateLine(good, "text-only")).toThrow(/does not suit the text-only mode/);
    const textOnly = await goodLine("text-only");
    expect(() => validateLine(textOnly, "image")).toThrow(/does not suit the image mode/);
    expect(() =>
      validateLine(
        edited(good, (p) => (p.messages[0] = { role: "system", content: "x" })),
        "image",
      ),
    ).toThrow(/system prompt/);
    expect(() =>
      validateLine(
        edited(good, (p) => p.messages.pop()),
        "image",
      ),
    ).toThrow(/assistant answer/);
  });
});

describe("a sample page not marked redacted", () => {
  it("is in neither file", async () => {
    const { store, ids } = await fill(dir, [
      ...Array.from({ length: 6 }, (_, i) => ({ seed: i })),
      { seed: 40, origin: "samples" as const, source: "samples-body", redacted: false },
    ]);
    const built = await build(store);
    expect(built.dropped.unredacted).toBe(1);
    for (const name of ["train", "eval"]) expect(idsIn(built.dir, name)).not.toContain(ids[6]);
  });
});

// §19 (plan review finding 7): after a rebuild under a changed redaction, sample pages wait for the leak check over the
// pages stored now, the label rules over them and a teacher's receipt that is not stale.
describe("sample pages wait for a clean leak check, the label rules and a current receipt", () => {
  it("keeps every sample page out while any of the three is missing or stale, and admits them once all hold", async () => {
    const { store, ids } = await fill(dir, [
      ...Array.from({ length: 4 }, (_, i) => ({
        seed: i,
        origin: "samples" as const,
        source: "samples-body",
        host: null,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({ seed: 10 + i, lure: i % 2 === 0 })),
    ]);
    const samples = ids.slice(0, 4) as string[];
    const directOptions = () => ({
      redaction: REDACTION,
      store,
      version: `3.${++versions}`,
      mode: "image" as const,
      seed: 3,
      floors: NO_FLOORS,
      referenceSize: 0,
      protectedTerms: [],
    });
    const direct = () => buildDataset(directOptions());
    const sampleLines = (built: { dir: string }) =>
      [...idsIn(built.dir, "train"), ...idsIn(built.dir, "eval")].filter((id) => samples.includes(id)).length;
    const keptOut = async (problem: RegExp) => {
      expect(sampleReadiness(store, REDACTION)).toEqual(expect.arrayContaining([expect.stringMatching(problem)]));
      const built = await direct();
      expect(built.dropped.samplesUnready).toBe(samples.length);
      expect(sampleLines(built)).toBe(0);
    };
    ready(store);
    expect(sampleReadiness(store, REDACTION)).toEqual([]);
    const admitted = await direct();
    expect(admitted.dropped.samplesUnready).toBe(0);
    expect(sampleLines(admitted)).toBeGreaterThan(0);
    // The redaction changes after the clean leak check (here the entity pass's time limit) and the build runs before
    // any re-import: the stored pages and the verdict still agree with each other, but not with what the importer
    // would make now, so no sample page is admitted (§19 completion review gap 4).
    const changed = {
      samples: SAMPLES,
      config: { ...ENTITY_CONFIG, limits: { ...ENTITY_CONFIG.limits, seconds: ENTITY_CONFIG.limits.seconds + 1 } },
    };
    expect(sampleReadiness(store, changed)).toEqual([
      "the sample leak check ran under another redaction than the current one: import, then leak-check again",
    ]);
    const stale = await buildDataset({ ...directOptions(), redaction: changed });
    expect(stale.dropped.samplesUnready).toBe(samples.length);
    expect(sampleLines(stale)).toBe(0);
    // A build that is not told where the samples are cannot know the current redaction, and admits none either.
    expect(sampleReadiness(store)).toEqual([
      "the current redaction is not known: the build was given no samples folder",
    ]);
    const { redaction: _given, ...unknown } = directOptions();
    const blind = await buildDataset(unknown);
    expect(blind.dropped.samplesUnready).toBe(samples.length);
    // Stale teacher evidence: an outcome recorded after the receipt was written; then no receipt at all.
    teach(dir, { [samples[0] as string]: AGREED });
    await keptOut(/^the teacher's checks are not current \(the receipt covers/);
    rmSync(join(dir, "store", "raw", "teacher", "receipt.json"));
    await keptOut(/^the teacher's checks are not current \(no receipt/);
    // A leak check that failed, never ran, or ran under another redaction than the pages were made under.
    ready(store, { clean: false });
    await keptOut(/^the sample leak check is not clean$/);
    rmSync(leakCheckFile(store.dir));
    await keptOut(/^the sample leak check has not run$/);
    ready(store);
    writeFileSync(
      join(dir, "store", "raw", "samples", "REDACTION.json"),
      JSON.stringify({ key: null, building: "k2", cleaned: true }),
    );
    expect(sampleReadiness(store, REDACTION)).toContain(
      "the sample leak check ran under another redaction than the stored pages'",
    );
    writeFileSync(join(dir, "store", "raw", "samples", "REDACTION.json"), JSON.stringify({ key: KEY, building: null }));
    // A clean leak check over other pages than the store holds now: a sample page stored after it.
    const late = await store.putPage("samples-body", {
      screenshot: await shot(90),
      text: "A sample page stored after the leak check",
      origin: "samples",
      licence: "CC0",
      host: null,
      template: null,
      south_africa: true,
      labels: { brand: null, has_login_form: false, has_payment_form: false, lure: false, lure_type: "none" },
      label_source: {
        brand: "ground-truth",
        has_login_form: "ground-truth",
        has_payment_form: "ground-truth",
        lure: "ground-truth",
        lure_type: "ground-truth",
      },
      redacted: true,
    });
    samples.push(late);
    writeReceipt(store, []);
    await keptOut(/^the sample pages changed after the leak check$/);
    // The label rules not yet run over a remade page: a lure label alone and no exclusion.
    ready(store);
    store.setLabels(samples[0] as string, { lure: true }, { lure: "ground-truth" });
    writeReceipt(store, []);
    await keptOut(/^1 sample pages have neither a complete label nor an exclusion: run label-rules\.ts$/);
    // The rules exclude it, the leak check and the teacher are current again: the sample pages are built from.
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      `${JSON.stringify({ id: samples[0], reason: "incomplete after the rules (missing brand)" })}\n`,
    );
    ready(store);
    expect(sampleReadiness(store, REDACTION)).toEqual([]);
    const again = await direct();
    expect(again.dropped.samplesUnready).toBe(0);
    expect(sampleLines(again)).toBeGreaterThan(0);
  });
});

describe("the scan of the built files for protected sample details", () => {
  const sampleLine = async (id: string, text: string) => {
    const nonce = createHash("sha256").update(id).digest("hex").slice(0, 32);
    return buildTrainingLine(buildScreenRequest({ image: await shot(2), host: null, text, mode: "image", nonce }), {
      brand: null,
      has_login_form: false,
      has_payment_form: false,
      lure: false,
      lure_type: "none",
      confidence: 0.95,
    });
  };

  it("finds a protected term, an address, a phone and a long number, naming the kind and never the detail", async () => {
    const lines = [
      { id: "samples-a", origin: "samples", line: await sampleLine("samples-a", "Pay Kestrel Holdings today") },
      { id: "samples-b", origin: "samples", line: await sampleLine("samples-b", "Write to someone@clientco.example") },
      { id: "samples-c", origin: "samples", line: await sampleLine("samples-c", "Call 082 555 1234 now") },
      { id: "samples-d", origin: "samples", line: await sampleLine("samples-d", "Reference 4012888888881881") },
      { id: "samples-e", origin: "samples", line: await sampleLine("samples-e", "A clean page about invoices") },
    ];
    const problems = scanSampleLines(lines, ["Kestrel Holdings"], "image");
    expect(problems).toEqual([
      "samples-a: a protected sample term",
      "samples-b: an address",
      "samples-c: a phone number",
      "samples-d: a long number",
    ]);
    expect(problems.join()).not.toMatch(/Kestrel|clientco|555|4012/);
  });

  it("reads the generic details of sample lines only, and the protected terms of every line", async () => {
    const line = await sampleLine("p-1", "Call 082 555 1234 now");
    expect(scanSampleLines([{ id: "p-1", origin: "public", line }], ["Kestrel"], "image")).toEqual([]);
    const named = await sampleLine("p-2", "Pay Kestrel Holdings today");
    expect(scanSampleLines([{ id: "p-2", origin: "public", line: named }], ["Kestrel Holdings"], "image")).toEqual([
      "p-2: a protected sample term",
    ]);
    // A recipient's first name alone on a public page is a stranger's name, not a leak; on a sample line it is one.
    const firstName = await sampleLine("p-3", "Dear Thandiwe, your parcel is waiting");
    const kinds = { client: ["Kestrel"], addresses: [], domains: [], pieces: ["Thandiwe"] };
    expect(scanSampleLines([{ id: "p-3", origin: "public", line: firstName }], kinds, "image")).toEqual([]);
    expect(scanSampleLines([{ id: "p-3", origin: "samples", line: firstName }], kinds, "image")).toEqual([
      "p-3: a protected sample term",
    ]);
  });

  it("scans a one-word client name on a public line, whatever the form of the name", async () => {
    const kinds = { client: ["Kestrel"], addresses: ["a@b.example"], domains: ["b.example"], pieces: [] };
    const public_ = await sampleLine("p-4", "Welcome to Kestrel");
    expect(scanSampleLines([{ id: "p-4", origin: "public", line: public_ }], kinds, "image")).toEqual([
      "p-4: a protected sample term",
    ]);
    expect(scanSampleLines([{ id: "p-4", origin: "samples", line: public_ }], kinds, "image")).toEqual([
      "p-4: a protected sample term",
    ]);
    const domain = await sampleLine("p-5", "Visit www.b.example today");
    expect(scanSampleLines([{ id: "p-5", origin: "public", line: domain }], kinds, "image")).toHaveLength(1);
  });

  it("leaves a public page that names a protected client out of the version, counted (fourth 1.0 build)", async () => {
    const { store, ids } = await fill(dir, [
      ...Array.from({ length: 3 }, (_, i) => ({ seed: i + 1, text: `Invoice from Kestrel Holdings ${i}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ seed: 10 + i, lure: false })),
      ...Array.from({ length: 3 }, (_, i) => ({ seed: 20 + i, text: `Your parcel is waiting ${i}` })),
    ]);
    const built = await build(store, { protectedTerms: ["Kestrel Holdings"] });
    expect(built.dropped.namesClient).toBe(3);
    const published = [...idsIn(built.dir, "train"), ...idsIn(built.dir, "eval")];
    for (const id of ids.slice(0, 3)) expect(published).not.toContain(id);
    expect(published.length).toBeGreaterThan(0);
    for (const name of ["train.jsonl", "eval.jsonl"])
      expect(readFileSync(join(built.dir, name), "utf-8")).not.toContain("Kestrel Holdings");
  });

  const planted = (text: string) =>
    Array.from({ length: 4 }, (_, i) => ({
      seed: i,
      origin: "samples" as const,
      source: "samples-body",
      text: `${text} ${i}`,
    }));

  it("refuses to write a version whose sample-derived lines hold a planted phone, and leaves nothing behind", async () => {
    const { store } = await fill(dir, [...planted("Call 082 555 1234 about invoice"), { seed: 30, lure: false }]);
    const refusal = build(store);
    await expect(refusal).rejects.toBeInstanceOf(PublicationRefused);
    await expect(refusal).rejects.toThrow(/lines hold protected details \(samples-body-[0-9a-f]+: a phone number/);
    expect(readdirSync(join(dir, "store", "dataset"))).toEqual([]);
  });

  it("refuses a planted protected term, and publishes the same pages once the term is absent", async () => {
    const { store } = await fill(dir, [...planted("Invoice from Kestrel Holdings"), { seed: 30, lure: false }]);
    await expect(build(store, { protectedTerms: ["Kestrel Holdings"] })).rejects.toThrow(/a protected sample term/);
    const clean = await build(store, { protectedTerms: ["Someone Else"] });
    expect(clean.train).toBeGreaterThan(0);
  });

  it("refuses a version with sample-derived lines when no terms were given to scan for", async () => {
    const { store } = await fill(dir, [...planted("An invoice"), { seed: 30, lure: false }]);
    ready(store);
    await expect(
      buildDataset({
        redaction: REDACTION,
        store,
        version: "9.9",
        mode: "image",
        seed: 3,
        floors: NO_FLOORS,
        referenceSize: 0,
      }),
    ).rejects.toThrow(/no protected terms were given/);
  });

  it("derives the terms from a samples folder as the leak check does", async () => {
    const samples = join(dir, "samples");
    mkdirSync(join(samples, "client-set"), { recursive: true });
    writeFileSync(join(samples, "pilot-consent.md"), `# Consent\n\n## ${CONSENT_HEADING}\n\nyes\n`);
    writeFileSync(join(samples, "client-names.txt"), "Kestrel Holdings\n");
    writeFileSync(
      join(samples, "client-set", "one.eml"),
      "From: sender@elsewhere.example\r\nTo: Thandi Mokoena <thandi.mokoena@kestrel.example>\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nhello\r\n",
    );
    const { terms, unreadable } = await sampleTerms(samples);
    expect(unreadable).toBe(0);
    expect(terms.client).toEqual(["Kestrel Holdings"]);
    expect(terms.addresses).toEqual(["thandi.mokoena@kestrel.example"]);
    expect(terms.domains).toEqual(["kestrel.example"]);
    expect(terms.pieces).toEqual(expect.arrayContaining(["Thandi", "Mokoena"]));
    // A message that cannot be read now (it may have made pages earlier) refuses: its recipients would go unguarded.
    // One the import itself could not parse is passed over and counted, as it made no page.
    writeFileSync(join(samples, "client-set", "two.eml"), "\u0000not a message");
    const parsed = await sampleTerms(samples);
    expect(parsed.terms.client).toEqual(["Kestrel Holdings"]);
    chmodSync(join(samples, "client-set", "one.eml"), 0o000);
    try {
      await expect(sampleTerms(samples)).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(join(samples, "client-set", "one.eml"), 0o644);
    }
    // Without the consent section nothing is read.
    writeFileSync(join(samples, "pilot-consent.md"), "# Consent\n");
    await expect(sampleTerms(samples)).rejects.toThrow(/no sample is read without it/);
  });
});

describe("a later version keeps the earlier one's held-out pages out of its training (§27)", () => {
  it("reserves every page an earlier version evaluated on, so none trains the later version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-heldout-"));
    try {
      const specs: Spec[] = Array.from({ length: 24 }, (_, i) => ({
        seed: i,
        lure: i % 2 === 0,
        brand: `Brand ${i}`,
        host: `site${i}.example`,
      }));
      const { store, ids } = await fill(dir, specs);
      teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
      const first = await buildDataset({
        redaction: REDACTION,
        store,
        version: "1.0",
        mode: "image",
        seed: 3,
        floors: NO_FLOORS,
        referenceSize: 0,
        protectedTerms: [],
      });
      const held = idsIn(first.dir, "eval");
      expect(held.length).toBeGreaterThan(0);
      expect([...previousHeldOut(store.dir, "1.1")].sort()).toEqual([...held].sort());
      expect(previousHeldOut(store.dir, "1.0").size).toBe(0);
      // Another seed would hold out other pages; the earlier version's held-out pages still never train.
      const second = await buildDataset({
        redaction: REDACTION,
        store,
        version: "1.1",
        mode: "image",
        seed: 11,
        floors: NO_FLOORS,
        referenceSize: 0,
        protectedTerms: [],
        heldOut: previousHeldOut(store.dir, "1.1"),
      });
      const trained = new Set(idsIn(second.dir, "train"));
      for (const id of held) expect(trained.has(id)).toBe(false);
      // Without the earlier version's pages reserved, the other seed does train some of them.
      const unguarded = await buildDataset({
        redaction: REDACTION,
        store,
        version: "1.2",
        mode: "image",
        seed: 11,
        floors: NO_FLOORS,
        referenceSize: 0,
        protectedTerms: [],
      });
      expect(held.some((id) => idsIn(unguarded.dir, "train").includes(id))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a version's held-out protection is published with it (§27)", () => {
  const specs: Spec[] = Array.from({ length: 24 }, (_, i) => ({
    seed: i,
    lure: i % 2 === 0,
    brand: `Brand ${i}`,
    host: `site${i}.example`,
    item: `msg-${i}`,
  }));
  const common = { mode: "image" as const, floors: NO_FLOORS, referenceSize: 0, protectedTerms: [] };

  it("publishes nothing when the list cannot be written, and a rerun publishes both", async () => {
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    await expect(
      buildDataset({
        redaction: REDACTION,
        store,
        ...common,
        version: "1.0",
        seed: 3,
        io: {
          write: (path, text) => {
            if (path.endsWith(".heldout-items.jsonl")) throw new Error("disk full");
            writeFileSync(path, text);
          },
        },
      }),
    ).rejects.toThrow(/disk full/);
    // The version was not published, so no later build is left unprotected by it.
    expect(existsSync(join(store.dir, "dataset", "1.0"))).toBe(false);
    const again = await buildDataset({ redaction: REDACTION, store, ...common, version: "1.0", seed: 3 });
    expect(existsSync(heldOutItemsFile(store.dir, "1.0"))).toBe(true);
    expect(idsIn(again.dir, "eval").length).toBeGreaterThan(0);
  });

  it("refuses to build past a published version that has no list", async () => {
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    await buildDataset({ redaction: REDACTION, store, ...common, version: "1.0", seed: 3 });
    rmSync(heldOutItemsFile(store.dir, "1.0"));
    expect(() => previousHeldOutItems(store.dir, "1.1")).toThrow(/published without its held-out source items/);
  });
});

describe("held-out protection covers every item and the reference set (§27)", () => {
  const specs: Spec[] = Array.from({ length: 24 }, (_, i) => ({
    seed: i,
    lure: i % 2 === 0,
    brand: `Brand ${i}`,
    host: `site${i}.example`,
    item: `msg-${i}`,
  }));
  const remake = async (store: Awaited<ReturnType<typeof fill>>["store"], n: number, item: string) =>
    store.putPage("set", {
      screenshot: await shot(500),
      text: `Remade page ${n} with other words entirely ${n * 104729}`,
      origin: "public",
      licence: "CC0",
      host: "remade.example",
      template: null,
      south_africa: false,
      labels: {
        brand: "Remade",
        has_login_form: false,
        has_payment_form: false,
        lure: n % 2 === 0,
        lure_type: n % 2 === 0 ? "credential" : "none",
      },
      label_source: {
        brand: "ground-truth",
        has_login_form: "ground-truth",
        has_payment_form: "ground-truth",
        lure: "ground-truth",
        lure_type: "ground-truth",
      },
      redacted: false,
      item,
    });

  it("lists a page's second item too, so a page remade from that item stays out of later training", async () => {
    const { store, ids } = await fill(dir, specs);
    for (const [n, id] of ids.entries()) await store.addItem(id, { id: `alt-${n}`, lure: n % 2 === 0 });
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    const base = { store, mode: "image" as const, floors: NO_FLOORS, referenceSize: 0, protectedTerms: [] };
    const first = await buildDataset({ redaction: REDACTION, ...base, version: "1.0", seed: 3 });
    const held = idsIn(first.dir, "eval");
    const n = ids.indexOf(held[0] as string);
    // The remade page's own item is another; only its second item is the held-out page's.
    const remade = await remake(store, n, `fresh-${n}`);
    await store.addItem(remade, { id: `alt-${n}`, lure: n % 2 === 0 });
    teach(dir, Object.fromEntries([...ids, remade].map((id) => [id, AGREED])));
    expect(previousHeldOutItems(store.dir, "1.1").has(`set\nalt-${n}`)).toBe(true);
    for (const seed of [5, 7, 11]) {
      const later = await buildDataset({
        redaction: REDACTION,
        ...base,
        version: `1.${seed}`,
        seed,
        heldOut: previousHeldOut(store.dir, "1.1"),
        heldOutItems: previousHeldOutItems(store.dir, "1.1"),
      });
      expect(idsIn(later.dir, "train")).not.toContain(remade);
    }
  });

  it("keeps a near copy of an earlier held-out page out of training even when that page is outside the new freeze", async () => {
    const original = await shot(1, 1280, 1600);
    const resized = new Uint8Array(await sharp(original).resize(640).jpeg({ quality: 60 }).toBuffer());
    const text = "Sign in to your bank account to verify a payment of R4,999 before it is released today";
    const pair: Spec[] = [
      { seed: 1, brand: "Twin A", host: "login.twin-a.co.za", text, image: original },
      { seed: 2, brand: "Twin B", host: "login.twin-b.co.za", text, image: resized },
      { seed: 3, brand: "Twin A", host: "www.twin-a.co.za", lure: false },
      { seed: 4, brand: "Twin B", host: "www.twin-b.co.za", lure: false },
    ];
    const { store, ids } = await fill(dir, [...pair, ...Array.from({ length: 10 }, (_, i) => ({ seed: 20 + i }))]);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    // The earlier version's held-out page is stored but outside this version's freeze; its near copy is inside.
    const built = await build(store, {
      frozen: new Set(ids.filter((id) => id !== ids[0])),
      heldOut: new Set([ids[0] as string]),
    });
    expect(idsIn(built.dir, "train")).not.toContain(ids[1]);
    expect(built.dropped.near).toBe(1);
  });

  it("refuses a list cut short by a crash, and protects a gone held-out page from its metadata", async () => {
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    const base = { store, mode: "image" as const, floors: NO_FLOORS, referenceSize: 0, protectedTerms: [] };
    const first = await buildDataset({ redaction: REDACTION, ...base, version: "1.0", seed: 3 });
    const held = idsIn(first.dir, "eval");
    // The source of a held-out page is removed (a wall capture on recheck, coordinator 2026-11-02 option b):
    // the build no longer refuses, it protects the page's identities from the 1.0 evaluation metadata.
    const heldMeta = readFileSync(join(first.dir, "eval.meta.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { id: string; screenshot: string });
    const goneShot = heldMeta.find((row) => row.id === held[0])?.screenshot;
    store.removePage(held[0] as string);
    const second = await buildDataset({
      redaction: REDACTION,
      ...base,
      version: "1.1",
      seed: 5,
      heldOut: previousHeldOut(store.dir, "1.1"),
    });
    const summary = JSON.parse(readFileSync(join(second.dir, "summary.json"), "utf-8")) as {
      metadataProtection: { pages: string[]; excludedFromTraining: number };
    };
    expect(summary.metadataProtection.pages).toContain(held[0]);
    const trainShots = readFileSync(join(second.dir, "train.meta.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => (JSON.parse(line) as { screenshot: string }).screenshot);
    expect(trainShots).not.toContain(goneShot);
    // A gone page no identity survives for still refuses the build.
    const metaFile = join(first.dir, "eval.meta.jsonl");
    const rows = heldMeta.map((row) => (row.id === held[0] ? { id: row.id } : row));
    writeFileSync(metaFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await expect(
      buildDataset({
        redaction: REDACTION,
        ...base,
        version: "1.2",
        seed: 5,
        heldOut: previousHeldOut(store.dir, "1.2"),
      }),
    ).rejects.toThrow(/no longer in the store/);
    // A list with fewer rows than the version has evaluation pages (an empty file after a power cut) is refused.
    writeFileSync(heldOutItemsFile(store.dir, "1.0"), "");
    expect(() => previousHeldOutItems(store.dir, "1.1")).toThrow(/hold 0 of its/);
  });

  it("reads the reference items list, whatever the evaluation lists hold", () => {
    mkdirSync(dirname(referenceItemsFile(dir)), { recursive: true });
    writeFileSync(
      referenceItemsFile(dir),
      `${JSON.stringify({ id: "a", source: "set", item: "ref-1", items: ["ref-2"] })}\n`,
    );
    const held = previousHeldOutItems(dir, "1.0");
    expect(held.has("set\nref-1")).toBe(true);
    expect(held.has("set\nref-2")).toBe(true);
  });

  it("keeps a reference page's source items, so a reference page remade under a new id stays out of training", async () => {
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    const base = { store, mode: "image" as const, floors: NO_FLOORS, protectedTerms: [] };
    await buildDataset({ redaction: REDACTION, ...base, referenceSize: 6, version: "1.0", seed: 3 });
    expect(existsSync(referenceItemsFile(store.dir))).toBe(true);
    const referenced = (JSON.parse(readFileSync(referenceFile(store.dir), "utf-8")) as { pages: string[] }).pages;
    const n = ids.indexOf(referenced[0] as string);
    const remade = await remake(store, n, `msg-${n}`);
    teach(dir, Object.fromEntries([...ids, remade].map((id) => [id, AGREED])));
    expect(previousHeldOutItems(store.dir, "1.1").has(`set\nmsg-${n}`)).toBe(true);
    for (const seed of [5, 7, 11, 13]) {
      const later = await buildDataset({
        redaction: REDACTION,
        ...base,
        referenceSize: 6,
        version: `1.${seed}`,
        seed,
        heldOut: previousHeldOut(store.dir, "1.1"),
        heldOutItems: previousHeldOutItems(store.dir, "1.1"),
      });
      expect(idsIn(later.dir, "train")).not.toContain(remade);
    }
  });
});

describe("a held-out page remade under a new id stays out of later training (§19, §27)", () => {
  it("is found again by its source item, and each published version writes its list", async () => {
    const specs: Spec[] = Array.from({ length: 24 }, (_, i) => ({
      seed: i,
      lure: i % 2 === 0,
      brand: `Brand ${i}`,
      host: `site${i}.example`,
      item: `msg-${i}`,
    }));
    const { store, ids } = await fill(dir, specs);
    teach(dir, Object.fromEntries(ids.map((id) => [id, AGREED])));
    const base = { store, mode: "image" as const, floors: NO_FLOORS, referenceSize: 0, protectedTerms: [] };
    const first = await buildDataset({ redaction: REDACTION, ...base, version: "1.0", seed: 3 });
    const held = idsIn(first.dir, "eval");
    const listed = readFileSync(heldOutItemsFile(store.dir, "1.0"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(listed.map((r) => r.id).sort()).toEqual([...held].sort());
    // A redaction change remakes one held-out page: same source and item, new text, new id, and nothing else shared.
    const old = held[0] as string;
    const n = ids.indexOf(old);
    const remade = await store.putPage("set", {
      screenshot: await shot(500),
      text: `Remade page ${n} with other words entirely ${n * 104729}`,
      origin: "public",
      licence: "CC0",
      host: "remade.example",
      template: null,
      south_africa: false,
      labels: {
        brand: "Remade",
        has_login_form: false,
        has_payment_form: false,
        lure: n % 2 === 0,
        lure_type: n % 2 === 0 ? "credential" : "none",
      },
      label_source: {
        brand: "ground-truth",
        has_login_form: "ground-truth",
        has_payment_form: "ground-truth",
        lure: "ground-truth",
        lure_type: "ground-truth",
      },
      redacted: false,
      item: `msg-${n}`,
    });
    teach(dir, Object.fromEntries([...ids, remade].map((id) => [id, AGREED])));
    expect(previousHeldOutItems(store.dir, "1.1").has(`set\nmsg-${n}`)).toBe(true);
    for (const seed of [5, 7, 11]) {
      const later = await buildDataset({
        redaction: REDACTION,
        ...base,
        version: `1.${seed}`,
        seed,
        heldOut: previousHeldOut(store.dir, "1.1"),
        heldOutItems: previousHeldOutItems(store.dir, "1.1"),
      });
      expect(idsIn(later.dir, "train")).not.toContain(remade);
    }
    // Caught: held out by id alone, the remade page trains under some seed.
    let trained = 0;
    for (const seed of [5, 7, 11, 13, 17]) {
      const blind = await buildDataset({
        redaction: REDACTION,
        ...base,
        version: `2.${seed}`,
        seed,
        heldOut: previousHeldOut(store.dir, "1.1"),
      });
      if (idsIn(blind.dir, "train").includes(remade)) trained++;
    }
    expect(trained).toBeGreaterThan(0);
  });
});

describe("the lures a sweep adds, after everything that drops pages (§27)", () => {
  it("counts a new source's surviving lures by kind, and reads zero for a source whose lures all fall away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-netnew-"));
    try {
      const specs: Spec[] = [
        ...Array.from({ length: 12 }, (_, i) => ({
          seed: i,
          lure: i % 2 === 0,
          brand: `Brand ${i}`,
          host: `site${i}.example`,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          seed: 40 + i,
          lure: true,
          type: "payment" as const,
          brand: `Kept ${i}`,
          host: `kept${i}.example`,
          source: "sweep-kept",
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          seed: 60 + i,
          lure: true,
          type: "fake_shop" as const,
          brand: `Gone ${i}`,
          host: `gone${i}.example`,
          source: "sweep-gone",
        })),
      ];
      const { store, ids } = await fill(dir, specs);
      const gone = ids.slice(16);
      teach(
        dir,
        Object.fromEntries(
          ids.map((id) => [id, gone.includes(id) ? { status: "disputed", answer: null, applied: false } : AGREED]),
        ),
      );
      const built = await build(store);
      expect(netNewLures(built.dir, ["sweep-gone"])).toEqual({ training: {}, evaluation: {}, total: 0 });
      const kept = netNewLures(built.dir, ["sweep-kept"]);
      expect(kept.total).toBe(4);
      expect((kept.training.payment ?? 0) + (kept.evaluation.payment ?? 0)).toBe(4);
      expect(netNewLures(built.dir, ["sweep-kept", "sweep-gone"]).total).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the size cut before the shingle merge", () => {
  it("skips only pairs whose Jaccard cannot reach the bar, agreeing with jaccard at the boundary", () => {
    const set = (n: number, from = 0) => Uint32Array.from({ length: n }, (_, i) => from + i);
    // 12 inside 15 is exactly the bar (0.8 * 15 is 12.000000000000002 in floating point, 12 / 15 is not).
    expect(jaccard(set(12), set(15))).toBeGreaterThanOrEqual(NEAR_TEXT);
    expect(sizesAllow(12, 15)).toBe(true);
    for (let small = 0; small <= 60; small++)
      for (let large = small; large <= 60; large++)
        if (jaccard(set(small), set(large)) >= NEAR_TEXT) expect(sizesAllow(small, large)).toBe(true);
    expect(sizesAllow(11, 15)).toBe(false);
    expect(sizesAllow(0, 0)).toBe(true);
  });
});

describe("progress", () => {
  it("says each stage as the build reaches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-progress-"));
    try {
      const { store } = await fill(
        dir,
        Array.from({ length: 6 }, (_, i) => ({ seed: i, lure: i % 2 === 0 })),
      );
      const lines: string[] = [];
      await buildDataset({
        redaction: REDACTION,
        store,
        version: "1.0",
        mode: "image",
        seed: 3,
        floors: NO_FLOORS,
        referenceSize: 0,
        progress: (line) => lines.push(line),
      });
      expect(lines.some((line) => /pages admitted; removing duplicates/.test(line))).toBe(true);
      expect(lines.some((line) => /after duplicates and caps; splitting/.test(line))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summary.json is read back, and records the inputs the version was built from", () => {
  const specs: Spec[] = Array.from({ length: 10 }, (_, i) => ({ seed: i, lure: i % 2 === 0 }));
  const summaryOf = (built: { dir: string }) =>
    JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8")) as {
      inputs: Record<string, { pages: number; sha256: string }>;
    };

  it("refuses a summary whose bytes on disk are not the ones written, and removes the staging folder", async () => {
    const { store } = await fill(dir, specs);
    const crooked = {
      write: (path: string, text: string) => writeFileSync(path, path.endsWith("summary.json") ? `${text} ` : text),
    };
    await expect(build(store, { io: crooked })).rejects.toThrow(/summary.json read back differs/);
    expect(readdirSync(join(dir, "store", "dataset"))).toEqual([]);
  });

  it("carries a digest of the labels, the teacher's state, the queue and the exclusions", async () => {
    const { store, ids } = await fill(dir, specs);
    teach(dir, { [ids[0] as string]: AGREED });
    const first = summaryOf(await build(store));
    expect(first.inputs.labels?.pages).toBe(10);
    expect(first.inputs.teacher?.pages).toBe(1);
    // The same inputs give the same digests under another version number.
    expect(summaryOf(await build(store)).inputs).toEqual(first.inputs);
    // A changed label moves the labels digest alone.
    const page = store.manifest()[2] as StoredPage;
    store.setLabels(page.id, { ...page.labels, brand: "Changed Brand" }, page.label_source);
    const relabelled = summaryOf(await build(store));
    expect(relabelled.inputs.labels?.sha256).not.toBe(first.inputs.labels?.sha256);
    expect(relabelled.inputs.teacher).toEqual(first.inputs.teacher);
    // A changed teacher outcome moves the teacher digest, a new exclusion the exclusion digest.
    teach(dir, { [ids[0] as string]: AGREED, [ids[1] as string]: { status: "failed", reason: "no answer" } });
    const retaught = summaryOf(await build(store));
    expect(retaught.inputs.teacher?.sha256).not.toBe(relabelled.inputs.teacher?.sha256);
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      `${JSON.stringify({ id: ids[3], reason: "parked" })}\n`,
    );
    const excluded = summaryOf(await build(store));
    expect(excluded.inputs.excluded?.sha256).not.toBe(retaught.inputs.excluded?.sha256);
    expect(excluded.inputs.excluded?.pages).toBe(1);
  });

  it("names a brand once in the meta lines and the brand counts, whatever its spelling", async () => {
    const { store } = await fill(dir, [
      { seed: 1, brand: "FNB" },
      { seed: 2, brand: "First National Bank" },
      { seed: 3, brand: "First National Bank" },
      ...Array.from({ length: 6 }, (_, i) => ({ seed: 10 + i, lure: false })),
    ]);
    const built = await build(store);
    const metas = [...idsIn(built.dir, "train"), ...idsIn(built.dir, "eval")];
    expect(metas.length).toBeGreaterThan(0);
    const lines = ["train", "eval"].flatMap((name) =>
      readFileSync(join(built.dir, `${name}.meta.jsonl`), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { brand: string | null; brand_identity: string | null }),
    );
    for (const meta of lines.filter((m) => m.brand === "FNB" || m.brand === "First National Bank"))
      expect(meta.brand_identity).toBe(brandIdentity("FNB"));
    expect(lines.filter((m) => m.brand === null).every((m) => m.brand_identity === null)).toBe(true);
  });
});

describe("line files streamed to and from disk (1.0's training file is some 20 GB)", () => {
  it("writes and reads back every line across chunk boundaries, hashing the bytes on disk", () => {
    const folder = mkdtempSync(join(tmpdir(), "glimmer-lines-"));
    try {
      // Lines of 300 KB to 1.3 MB, so several cross the reader's 4 MB chunks.
      const lines = Array.from({ length: 14 }, (_, i) => `${i}:${"x".repeat(300_000 + i * 77_777)}é`);
      const path = join(folder, "train.jsonl");
      expect(writeLinesAtomic(path, lines)).toBe(14);
      const seen: string[] = [];
      const read = eachLine(path, (line, index) => {
        expect(index).toBe(seen.length);
        seen.push(line);
      });
      expect(seen).toEqual(lines);
      expect(read).toEqual({ sha256: hashOfFile(path), lines: 14 });
      expect(readdirSync(folder)).toEqual(["train.jsonl"]);
      // A line that fails part-way leaves the file as it was and no partial file behind (round 9).
      const before = hashOfFile(path);
      function* failing() {
        yield "replacement";
        throw new Error("page changed on disk");
      }
      expect(() => writeLinesAtomic(path, failing())).toThrow(/page changed on disk/);
      expect(hashOfFile(path)).toBe(before);
      expect(readdirSync(folder)).toEqual(["train.jsonl"]);
      expect(writeLinesAtomic(path, ["again"])).toBe(1);
      expect(readFileSync(path, "utf-8")).toBe("again\n");
      writeFileSync(path, "a\nb");
      expect(() => eachLine(path, () => {})).toThrow(/does not end with a newline/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

const hashOfFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("staged publication with read-back", () => {
  const specs: Spec[] = Array.from({ length: 10 }, (_, i) => ({ seed: i, lure: i % 2 === 0 }));
  const versionDir = (version: string) => join(dir, "store", "dataset", version);
  const hashOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

  it("takes the files' hashes from disk and leaves no staging folder", async () => {
    const { store } = await fill(dir, specs);
    const built = await build(store);
    expect(built.sha256.train).toBe(hashOf(join(built.dir, "train.jsonl")));
    expect(built.sha256.evaluation).toBe(hashOf(join(built.dir, "eval.jsonl")));
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.sha256).toEqual(built.sha256);
    expect(readdirSync(join(dir, "store", "dataset")).filter((name) => name.includes("staging"))).toEqual([]);
  });

  it("never replaces a version already published", async () => {
    const { store } = await fill(dir, specs);
    const first = await build(store, { version: "3.0" });
    const before = hashOf(join(first.dir, "train.jsonl"));
    await expect(build(store, { version: "3.0", seed: 99 })).rejects.toThrow(/already published/);
    expect(hashOf(join(first.dir, "train.jsonl"))).toBe(before);
  });

  it("keeps the earlier version intact and the staging folder recoverable when a write fails", async () => {
    const { store } = await fill(dir, specs);
    const first = await build(store, { version: "3.0" });
    const before = hashOf(join(first.dir, "train.jsonl"));
    let calls = 0;
    const failing = {
      write: (path: string, text: string) => {
        if (++calls === 3) throw new Error("disk full");
        writeFileSync(path, text);
      },
    };
    await expect(build(store, { version: "3.1", io: failing })).rejects.toThrow(/disk full/);
    expect(hashOf(join(first.dir, "train.jsonl"))).toBe(before);
    expect(existsSync(versionDir("3.1"))).toBe(false);
    expect(existsSync(`${versionDir("3.1")}.staging`)).toBe(true);
    // The next build of the version starts the staging folder again and publishes it.
    const recovered = await build(store, { version: "3.1" });
    expect(recovered.train).toBe(first.train);
    expect(existsSync(`${versionDir("3.1")}.staging`)).toBe(false);
  });

  it("keeps the earlier version intact and a whole, checked staging folder when the rename fails", async () => {
    const { store } = await fill(dir, specs);
    const first = await build(store, { version: "3.0" });
    const before = hashOf(join(first.dir, "train.jsonl"));
    const failing = {
      rename: () => {
        throw new Error("rename refused");
      },
    };
    await expect(build(store, { version: "3.1", io: failing })).rejects.toThrow(/rename refused/);
    expect(hashOf(join(first.dir, "train.jsonl"))).toBe(before);
    expect(existsSync(versionDir("3.1"))).toBe(false);
    expect(readdirSync(`${versionDir("3.1")}.staging`).sort()).toEqual([
      "eval.jsonl",
      "eval.meta.jsonl",
      "summary.json",
      "train.jsonl",
      "train.meta.jsonl",
    ]);
    const recovered = await build(store, { version: "3.1" });
    expect(recovered.sha256.train).toBe(first.sha256.train);
  });

  it("refuses a staged file whose meta lines are not aligned with its lines, and removes the staging folder", async () => {
    const { store } = await fill(dir, specs);
    const crooked = {
      write: (path: string, text: string) => {
        const lines = text.split("\n").filter(Boolean);
        writeFileSync(path, path.endsWith("train.meta.jsonl") ? `${lines.reverse().join("\n")}\n` : text);
      },
    };
    await expect(build(store, { io: crooked })).rejects.toThrow(/is not the page its meta line names/);
    expect(readdirSync(join(dir, "store", "dataset"))).toEqual([]);
  });
});

// §13 (filed from §9's completion review, E3): the reference membership is drawn before any teacher outcome is read.
describe("the reference draw and the teacher (§13)", () => {
  it("draws the same reference pages whatever the teacher answered", async () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({ seed: 300 + i, lure: i % 3 !== 0 }));
    const drawn: string[][] = [];
    for (const disputed of [false, true]) {
      const root = join(dir, disputed ? "disputed" : "plain");
      const { store, ids } = await fill(root, specs);
      // The second store's teacher disputed half its pages and lost one.
      if (disputed)
        teach(
          root,
          Object.fromEntries(
            ids.map((id, i) => [
              id,
              i % 2
                ? { status: "disputed", answer: null, applied: true }
                : i === 0
                  ? { status: "quarantined", reason: "lost" }
                  : AGREED,
            ]),
          ),
        );
      await build(store, { referenceSize: 5 }).catch(() => undefined); // a floor may stop the build after the draw
      const saved = JSON.parse(readFileSync(join(root, "store", "raw", "dataset", "reference.json"), "utf-8"));
      // Page ids are content digests, the same in both stores.
      drawn.push(saved.pages);
    }
    expect(drawn[0]).toHaveLength(5);
    expect(drawn[1]).toEqual(drawn[0]);
  }, 120_000);
});

// §13's independent reference set as evaluation lines: every page with a trusted truth, a page Spark disputed included.
describe("the reference export (§13)", () => {
  it("writes the reference pages as evaluation lines, keeps a disputed one, and leaves out the rest by reason", async () => {
    const { store, ids } = await fill(dir, [{ seed: 1 }, { seed: 2, lure: false }, { seed: 3 }, { seed: 4 }]);
    // Page 3's lure came from Spark: no trusted truth. Page 4 is excluded. Page 1 Spark disputed.
    const third = store.manifest().find((p) => p.id === ids[2]) as StoredPage;
    store.setLabels(third.id, third.labels, { ...third.label_source, lure: "spark" });
    // Round 1: an export before the first build is refused, and draws no membership (which would fix it empty).
    expect(() => writeReference({ store, version: "1.0", mode: "image", protectedTerms: [] })).toThrow(
      /no reference membership yet; build the dataset first/,
    );
    expect(existsSync(join(dir, "store", "raw", "dataset", "reference.json"))).toBe(false);
    mkdirSync(join(dir, "store", "raw", "dataset"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "dataset", "reference.json"),
      JSON.stringify({ seed: "s", size: 5, drawn_from: 4, pages: [...ids, "gone-page"] }),
    );
    mkdirSync(join(dir, "store", "raw", "labels"), { recursive: true });
    writeFileSync(
      join(dir, "store", "raw", "labels", "excluded.jsonl"),
      `${JSON.stringify({ id: ids[3], reason: "a test exclusion" })}\n`,
    );
    teach(dir, { [ids[0] as string]: { status: "disputed", answer: null, applied: true } });
    const made = writeReference({
      store,
      version: "1.0",
      mode: "image",
      protectedTerms: ["Kestrel Holdings"],
    });
    expect(made.pages).toBe(2);
    expect(made.skipped).toEqual({ "not in the store": 1, "no trusted lure label": 1, excluded: 1 });
    const metas = readFileSync(join(made.dir, "eval.meta.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(metas.map((m) => m.id).sort()).toEqual([ids[0], ids[1]].sort());
    const summary = JSON.parse(readFileSync(join(made.dir, "summary.json"), "utf-8"));
    expect(summary).toMatchObject({ set: "reference", pages: 2, sha256: { evaluation: made.sha256 } });
    expect(readFileSync(join(made.dir, "eval.jsonl"), "utf-8").trim().split("\n")).toHaveLength(2);
    // Written once: a second export is refused, the first left as it was.
    expect(() =>
      writeReference({
        store,
        version: "1.0",
        mode: "image",
        protectedTerms: ["Kestrel Holdings"],
      }),
    ).toThrow(/never replaced/);
  });
});

describe("Loupe 1.1: brand as grouping only, hard negatives, split balance (D03 T04 §45)", () => {
  const entry = (id: string, over: Partial<StoredPage> = {}, labels: Partial<StoredPage["labels"]> = {}) => {
    const p = page(id, over, labels);
    return { page: p, answer: answerOf(p, false) as PageAnswer, hash: 0n, words: new Uint32Array(0) };
  };

  it("teaches no brand from 1.1 on, and keeps 1.0's taught brand", () => {
    const p = page("b1", {}, { brand: "Acme Bank", lure: true, lure_type: "credential" });
    expect(answerOf(p)?.brand).toBe("Acme Bank");
    expect(answerOf(p, false)?.brand).toBeNull();
    // Grouping still sees the brand through the page's own labels.
    expect(groupOf(p)).toBe("brand:acmebank");
  });

  it("keeps unseen-brand and own-page benign pages through balancing", () => {
    const lure = entry("l1", {}, { brand: "Acme Bank", lure: true, lure_type: "credential" });
    const unseen = entry("n1", { host: "other.example" }, { brand: "New Bank" });
    const own = entry("n2", { host: "acmebank.example" }, { brand: "Acme Bank" });
    const plain = entry("n3", { host: "plain.example" }, {});
    const brands = lureBrandSet([lure, unseen, own, plain]);
    expect(hardNegativeKind(unseen, brands)).toBe("unseen-brand");
    expect(hardNegativeKind(own, brands)).toBe("own-page");
    expect(isHardNegative(unseen, brands)).toBe(true);
    expect(isHardNegative(own, brands)).toBe(true);
    expect(isHardNegative(plain, brands)).toBe(false);
    const many = [
      lure,
      unseen,
      own,
      ...Array.from({ length: 20 }, (_, i) => entry(`x${i}`, { host: `x${i}.example` }, {})),
    ];
    const kept = balanceKeeping(
      many,
      () => 0.5,
      (e) => isHardNegative(e, brands),
    );
    expect(kept.map((e) => e.page.id)).toEqual(expect.arrayContaining(["n1", "n2"]));
  });

  it("reports both sides' shares and calls an imbalance UNMET", () => {
    const lure = (id: string) => entry(id, {}, { brand: "Acme Bank", lure: true, lure_type: "credential" });
    const benign = (id: string) => entry(id, {}, {});
    const met = splitBalanceReport([lure("a"), benign("b")], [lure("c"), benign("d")]);
    expect(met.met).toBe(true);
    expect(met.byLureType.credential?.train).toBe(0.5);
    const unmet = splitBalanceReport([lure("a"), lure("b")], [benign("c"), benign("d")]);
    expect(unmet.met).toBe(false);
    expect(unmet.lure.gap).toBe(1);
  });
});
