import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerOf,
  balance,
  buildDataset,
  capBrands,
  dedupe,
  dhash,
  groupOf,
  hamming,
  jaccard,
  shingles,
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

describe("the split", () => {
  it("shares no brand, site or template, and holds only trusted labels", () => {
    const entries = [];
    for (let b = 0; b < 40; b++)
      for (let i = 0; i < 10; i++) {
        const spark = b % 7 === 0 && i === 0;
        const p = page(
          `p${b}-${i}`,
          { host: `site${b}.example.co.za`, south_africa: b % 2 === 0, template: b === 3 ? "t1" : null },
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
  it("writes lines that validate, a meta line each, refuses unredacted samples, and counts shortfalls", async () => {
    const store = openStore(join(dir, "store"));
    const put = async (seed: number, input: Partial<PageInput>, labels: PageInput["labels"]) =>
      store.putPage("set", {
        screenshot: await shot(seed),
        text: `Page ${seed}: ${"distinct words ".repeat(3)}${seed * 7919}`,
        origin: "public",
        licence: "CC0",
        host: `site${seed}.example.com`,
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
    const built = await buildDataset({ store, version: "1.0", mode: "image", seed: 3 });
    expect(built.dropped.unredacted).toBe(1);
    expect(built.dropped.unlabelled).toBe(1);
    expect(built.dropped.disputed).toBe(1);
    expect(built.dropped.incomplete).toBe(1);
    expect(built.train + built.evaluation).toBeGreaterThan(0);
    expect(built.shortfalls.some((s) => s.startsWith("evaluation"))).toBe(true);
    const lines = readFileSync(join(built.dir, "train.jsonl"), "utf-8").trim().split("\n");
    const meta = readFileSync(join(built.dir, "train.meta.jsonl"), "utf-8").trim().split("\n");
    expect(meta).toHaveLength(lines.length);
    for (const line of lines) {
      const messages = JSON.parse(line).messages;
      expect(PageAnswer.safeParse(JSON.parse(messages.at(-1).content)).success).toBe(true);
      expect(messages[1].content.some((p: { type: string }) => p.type === "image_url")).toBe(true);
    }
    // A second build replaces the version whole: no building or previous folder is left beside it.
    const rebuilt = await buildDataset({ store, version: "1.0", mode: "image", seed: 3 });
    expect(rebuilt.dir).toBe(built.dir);
    expect(readdirSync(join(dir, "store", "dataset"))).toEqual(["1.0"]);
    const summary = JSON.parse(readFileSync(join(built.dir, "summary.json"), "utf-8"));
    expect(summary.train.lines + summary.evaluation.lines).toBe(built.train + built.evaluation);
    // Without the set's key (a sample run stopped between its two records), no sample page is used at all.
    writeFileSync(
      join(dir, "store", "raw", "samples", "REDACTION.json"),
      JSON.stringify({ key: null, building: "k2" }),
    );
    const unset = await buildDataset({ store, version: "1.0", mode: "image", seed: 3 });
    expect([unset.dropped.unredacted, unset.dropped.incomplete]).toEqual([0, 2]);
    // Built from a freeze (§18): a page the freeze does not name (stored after it) is left out, and counted.
    const named = store.manifest().map((p) => p.id);
    const frozen = await buildDataset({
      store,
      version: "1.0",
      mode: "image",
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
    const ruled = await buildDataset({ store, version: "1.0", mode: "image", seed: 3 });
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
