import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerOf,
  balance,
  brandIdentity,
  buildDataset,
  capBrands,
  checkFloors,
  dedupe,
  dhash,
  evaluationPool,
  FLOORS,
  freezeDigest,
  groupEntries,
  groupOf,
  hamming,
  jaccard,
  NO_FLOORS,
  ShortfallError,
  shingles,
  siteOf,
  split,
} from "../../scripts/glimmer/build-dataset.ts";
import { openStore, type PageInput, type StoredPage } from "../../scripts/glimmer/store.ts";
import { PageAnswer } from "../../src/vision/page-screen.ts";

// scripts/glimmer/build-dataset.ts (D03 T04 §10): duplicates go, no brand passes 300, lures stay within 40 to 60
// percent, and the evaluation set shares no brand, site, template or near duplicate with training and holds only
// labels known to be true.
let dir: string;
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
  });
});

describe("caps and balance", () => {
  const entry = (id: string, labels: Partial<StoredPage["labels"]>) => {
    const p = page(id, {}, labels);
    return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Set<number>() };
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
    return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Set<number>() };
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
    return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Set<number>() };
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
          words: new Set<number>(),
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
    writeFileSync(join(dir, "store", "raw", "samples", "REDACTION.json"), JSON.stringify({ key: "k", building: null }));
    const built = await buildDataset({ store, version: "1.0", mode: "image", seed: 3, floors: NO_FLOORS });
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
    // A second build replaces the version whole: no building or previous folder is left beside it.
    const rebuilt = await buildDataset({ store, version: "1.0", mode: "image", seed: 3, floors: NO_FLOORS });
    expect(rebuilt.dir).toBe(built.dir);
    expect(readdirSync(join(dir, "store", "dataset"))).toEqual(["1.0"]);
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.train.lines + summary.evaluation.lines).toBe(built.train + built.evaluation);
    // Without the set's key (a sample run stopped between its two records), no sample page is used at all.
    writeFileSync(
      join(dir, "store", "raw", "samples", "REDACTION.json"),
      JSON.stringify({ key: null, building: "k2" }),
    );
    const unset = await buildDataset({ store, version: "1.0", mode: "image", seed: 3, floors: NO_FLOORS });
    expect([unset.dropped.unredacted, unset.dropped.incomplete]).toEqual([0, 2]);
    // Built from a freeze (§18): a page the freeze does not name (stored after it) is left out, and counted.
    const named = store.manifest().map((p) => p.id);
    const frozen = await buildDataset({
      store,
      version: "1.0",
      mode: "image",
      floors: NO_FLOORS,
      seed: 3,
      frozen: new Set(named.slice(1)),
    });
    expect(frozen.dropped.afterFreeze).toBe(1);
    // A frozen page gone from the store refuses the build, never drops out of it unseen.
    await expect(
      buildDataset({
        store,
        version: "1.0",
        mode: "image",
        floors: NO_FLOORS,
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
    const ruled = await buildDataset({ store, version: "1.0", mode: "image", seed: 3, floors: NO_FLOORS });
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
        screenshot: await shot(spec.seed),
        text: spec.text ?? `Page ${spec.seed}: ${"distinct words ".repeat(3)}${spec.seed * 7919}`,
        origin: spec.origin ?? "public",
        licence: "CC0",
        host: spec.host === undefined ? `www.site${spec.seed}.com` : spec.host,
        template: null,
        south_africa: spec.southAfrica ?? false,
        labels,
        label_source: Object.fromEntries(Object.keys(labels).map((k) => [k, "ground-truth"])),
        redacted: spec.redacted ?? spec.origin === "samples",
      }),
    );
    mkdirSync(join(root, "store", "raw", source), { recursive: true });
    writeFileSync(join(root, "store", "raw", source, "IMPORT.json"), JSON.stringify({ status: "complete" }));
  }
  if (specs.some((s) => s.origin === "samples")) {
    mkdirSync(join(root, "store", "raw", "samples"), { recursive: true });
    writeFileSync(
      join(root, "store", "raw", "samples", "REDACTION.json"),
      JSON.stringify({ key: "k", building: null }),
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
let versions = 0;
const build = (store: ReturnType<typeof openStore>, extra: Partial<Parameters<typeof buildDataset>[0]> = {}) =>
  buildDataset({ store, version: `2.${++versions}`, mode: "image", seed: 3, floors: NO_FLOORS, ...extra });
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
  return { page: p, answer: answerOf(p) as PageAnswer, hash: 0n, words: new Set<number>() };
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
        evaluationOf((i, k) => k),
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

  it("refuses a build with every sample-derived lure in evaluation", async () => {
    // All four in one group, agreed: evaluation takes the whole group and training keeps none.
    const { store, ids } = await fill(dir, [...group("S One", 1, 4), ...publics]);
    teach(dir, Object.fromEntries(ids.slice(0, 8).map((id) => [id, AGREED])));
    await expect(build(store, { floors })).rejects.toThrow(
      /training keeps 0 of 4 sample-derived lures, at least 2 needed/,
    );
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
