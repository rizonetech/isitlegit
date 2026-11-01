// D03 T04 §31: the comparison core counts, divides and detects leaks the way its figures claim.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { shingles } from "../../scripts/glimmer/build-dataset.ts";
import {
  type Annotation,
  annotationSample,
  builtMembership,
  checkResult,
  compareLabels,
  compareSplit,
  describeInput,
  groupShuffleSplit,
  incompleteIfMissing,
  type LabelFigures,
  type Labels,
  leakWitnesses,
  measurementLine,
  type Page,
  parseArgs,
  recordMeasurement,
  report,
  resultFile,
  scoreLabels,
  seeded,
  splitFigures,
  validateAnnotations,
  wilson,
  writeResult,
} from "../../scripts/glimmer/compare-pipelines.ts";

describe("the Wilson interval", () => {
  it("matches known values and the empty case", () => {
    const { low, high } = wilson(5, 50);
    expect(low).toBeCloseTo(0.0435, 3);
    expect(high).toBeCloseTo(0.2133, 3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilson(0, 20).low).toBe(0);
    expect(wilson(20, 20).high).toBe(1);
  });
});

describe("scoring labels against annotations", () => {
  const annotations: Annotation[] = [
    { id: "a", brand: "FNB", lure_type: "none", lure: false },
    { id: "b", brand: "Standard Bank", lure_type: "credential", lure: true },
    { id: "c", brand: null, lure_type: "payment", lure: true },
    { id: "d", brand: "unknown", lure_type: "disputed", lure: true },
    { id: "e", brand: "Capitec" },
  ];
  const rule = new Map<string, Labels>([
    ["a", { brand: "First National Bank", lure_type: "none", lure: false }], // brand spelled differently, same identity
    ["b", { brand: "Nedbank", lure_type: "credential", lure: true }], // wrong brand
    ["c", { brand: null, lure_type: "credential", lure: true }], // wrong lure type; null brand right
    ["d", { brand: "X", lure_type: "none", lure: true }],
    // "e" has no label at all
  ]);

  it("counts denominators, exclusions, coverage and errors per field", () => {
    const figures = scoreLabels(annotations, { rule }).rule as LabelFigures[string];
    // Brand: a, b, c, e judged (d unknown); e is not retained; b is wrong.
    expect(figures.brand).toMatchObject({ annotated: 4, unknown: 1, disputed: 0, retained: 3, wrong: 1 });
    expect(figures.brand.error).toBeCloseTo(1 / 3);
    expect(figures.brand.coverage).toBeCloseTo(3 / 4);
    // Lure type: a, b, c judged (d disputed, e not annotated); c wrong.
    expect(figures.lure_type).toMatchObject({ annotated: 3, disputed: 1, retained: 3, wrong: 1 });
    // Lure: a, b, c, d judged; all right.
    expect(figures.lure).toMatchObject({ annotated: 4, retained: 4, wrong: 0, error: 0 });
    expect(figures.lure.interval.low).toBe(0);
  });

  it("scores each set apart, and a set with no labels retains nothing", () => {
    const figures = scoreLabels(annotations, { rule, empty: new Map() });
    expect(figures.empty?.brand).toMatchObject({ retained: 0, wrong: 0, error: null, coverage: 0 });
    expect(figures.rule?.brand.retained).toBe(3);
  });
});

describe("split figures and the conventional split", () => {
  const word = (n: number) => shingles(Array.from({ length: 40 }, (_, i) => `w${n}x${i}`).join(" "));
  const page = (
    id: string,
    brand: string | null,
    site: string | null,
    lure: boolean,
    hash: bigint,
    n: number,
  ): Page => ({
    id,
    brand,
    site,
    lure,
    hash,
    words: word(n),
  });

  it("counts brand, site and near-duplicate leaks across the sides, and none on a clean split", () => {
    const pages = [
      page("t1", "FNB", "fnb.co.za", true, 0n, 1),
      page("t2", "Capitec", "capitec.co.za", false, 1n << 40n, 2),
      page("e1", "FNB", "other.com", true, 1n << 20n, 3), // brand leak
      page("e2", "Nedbank", "capitec.co.za", false, 1n << 50n, 4), // site leak
      page("e3", "Absa", "absa.co.za", true, 0n, 1), // near-duplicate of t1 (same hash, same text)
      page("e4", "Discovery", "discovery.co.za", false, (1n << 63n) - 1n, 5), // clean
    ];
    const sides = new Map<string, "train" | "eval">([
      ["t1", "train"],
      ["t2", "train"],
      ["e1", "eval"],
      ["e2", "eval"],
      ["e3", "eval"],
      ["e4", "eval"],
    ]);
    const figures = splitFigures(pages, sides);
    expect(figures).toMatchObject({
      train: 2,
      eval: 4,
      dropped: 0,
      cross_brand: 1,
      cross_site: 1,
      near_duplicate_eval_pages: 1,
    });
    expect(figures.lure_share_eval).toBeCloseTo(0.5);
    // Without the three planted leaks nothing is counted.
    const clean = splitFigures(
      pages.filter((p) => ["t2", "e4"].includes(p.id)),
      sides,
    );
    expect(clean).toMatchObject({ cross_brand: 0, cross_site: 0, near_duplicate_eval_pages: 0 });
  });

  it("a hash one bit away with different text is not a near-duplicate", () => {
    const a = page("a", "A", null, true, 0n, 1);
    const b = page("b", "B", null, true, 1n, 2);
    const figures = splitFigures(
      [a, b],
      new Map([
        ["a", "train"],
        ["b", "eval"],
      ]),
    );
    expect(figures.near_duplicate_eval_pages).toBe(0);
  });

  it("the group-shuffle split leaves no brand or site across the sides and removes near-duplicate twins", () => {
    const pages: Page[] = [];
    for (let i = 0; i < 60; i++)
      pages.push(page(`p${i}`, `Brand${i % 20}`, `site${i % 15}.com`, i % 2 === 0, BigInt(i) << 8n, i));
    // A twin of p0 under another brand and site: it must not stay in training beside p0 if p0 is held out, or the reverse.
    pages.push({ ...(pages[0] as Page), id: "twin", brand: "TwinBrand", site: "twin.com" });
    const sides = groupShuffleSplit(pages, seeded(7), 0.3);
    const figures = splitFigures(pages, sides);
    // Brands and sites are grouped by brand only, so a site shared across brands can still cross: the figures count it.
    expect(figures.cross_brand).toBe(0);
    expect(figures.near_duplicate_eval_pages).toBe(0);
    expect(figures.eval).toBeGreaterThan(0);
    expect(figures.train).toBeGreaterThan(0);
    // Deterministic for a seed.
    expect([...groupShuffleSplit(pages, seeded(7), 0.3)]).toEqual([...sides]);
  });
});

describe("results and missing inputs", () => {
  it("names a missing input and never reports a completed comparison for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-"));
    try {
      const present = join(dir, "annotations.jsonl");
      writeFileSync(present, "{}\n");
      const inputs = [describeInput("annotations", present), describeInput("labels", join(dir, "labels.jsonl"))];
      expect(inputs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      const result = incompleteIfMissing("labels", inputs);
      expect(result).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("labels")] });
      writeResult(resultFile(dir, "labels"), result as NonNullable<typeof result>);
      expect(JSON.parse(readFileSync(resultFile(dir, "labels"), "utf-8")).status).toBe("incomplete");
      expect(incompleteIfMissing("labels", [inputs[0] as (typeof inputs)[number]])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the split comparison over a store", () => {
  const build = async (
    dir: string,
    ids: { id: string; side: "train" | "eval"; brand: string; host: string; lure: boolean; shade: number }[],
  ) => {
    mkdirSync(join(dir, "dataset", "1.0"), { recursive: true });
    const meta = (side: string) =>
      ids
        .filter((p) => p.side === side)
        .map((p) => JSON.stringify({ id: p.id }))
        .join("\n");
    writeFileSync(join(dir, "dataset", "1.0", "train.meta.jsonl"), `${meta("train")}\n`);
    writeFileSync(join(dir, "dataset", "1.0", "eval.meta.jsonl"), `${meta("eval")}\n`);
    writeFileSync(
      join(dir, "dataset", "1.0", "summary.json"),
      JSON.stringify({ dropped: { near: 2 }, freeze: { pages: 10 } }),
    );
    for (const p of ids) {
      const folder = join(dir, "pages", p.id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "meta.json"),
        JSON.stringify({ host: p.host, labels: { brand: p.brand, lure: p.lure } }),
      );
      // A distinct picture per shade: left half dark, right half bright by a different split point.
      const raw = Buffer.alloc(64 * 64, 0);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw[y * 64 + x] = x < p.shade ? 20 : 230;
      writeFileSync(
        join(folder, "screenshot.jpg"),
        await sharp(raw, { raw: { width: 64, height: 64, channels: 1 } })
          .jpeg()
          .toBuffer(),
      );
      writeFileSync(join(folder, "text.txt"), Array.from({ length: 30 }, (_, i) => `${p.id}word${i}`).join(" "));
    }
  };

  it("measures a built split against the conventional one over the same pages, and is incomplete when a page is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-split-"));
    try {
      await build(dir, [
        { id: "a", side: "train", brand: "FNB", host: "fnb.co.za", lure: true, shade: 8 },
        { id: "b", side: "train", brand: "Capitec", host: "capitec.co.za", lure: false, shade: 24 },
        { id: "c", side: "eval", brand: "FNB", host: "other.com", lure: true, shade: 40 },
        { id: "d", side: "eval", brand: "Absa", host: "absa.co.za", lure: false, shade: 56 },
      ]);
      const result = await compareSplit(dir);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      // The planted brand leak (FNB on both sides) is counted in the built split.
      expect(result.figures.built).toMatchObject({ train: 2, eval: 2, cross_brand: 1 });
      expect(result.figures.pages).toBe(4);
      expect(result.figures.eval_share).toBe(0.5);
      expect(result.figures.conventional.cross_brand).toBe(0);
      // The artifact holds every page's side under each split: nothing is recovered by subtraction.
      const a = result.figures.assignments;
      expect([...a.built.train, ...a.built.eval].sort()).toEqual(["a", "b", "c", "d"]);
      expect([...a.conventional.train, ...a.conventional.eval, ...a.conventional.dropped].sort()).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
      expect(result.inputs.every((input) => input.sha256 !== null)).toBe(true);
      // A page the dataset names but the store lacks: incomplete, naming it.
      rmSync(join(dir, "pages", "b"), { recursive: true });
      const partial = await compareSplit(dir);
      expect(partial).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("1 pages unreadable")] });
      // The dataset's own files missing: incomplete too.
      rmSync(join(dir, "dataset"), { recursive: true });
      expect(await compareSplit(dir)).toMatchObject({
        status: "incomplete",
        missing: [
          expect.stringContaining("train.meta.jsonl"),
          expect.stringContaining("eval.meta.jsonl"),
          expect.stringContaining("summary.json"),
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("recording a result", () => {
  const split = {
    status: "complete" as const,
    name: "split-1.0",
    inputs: [{ name: "train.meta.jsonl", path: "p", sha256: "a".repeat(64), bytes: 1 }],
    figures: {
      pages: 100,
      eval_share: 0.1,
      config: {},
      population: { frozen: 120, kept: 100, dropped_before_split: { near: 15 }, unaccounted: 5 },
      witnesses: { built: { brands: [], sites: [], near: [] }, conventional: { brands: [], sites: [], near: [] } },
      assignments: { built: { train: [], eval: [] }, conventional: { train: [], eval: [], dropped: [] } },
      built: {
        train: 90,
        eval: 10,
        dropped: 0,
        lure_share_eval: 0.5,
        cross_brand: 0,
        cross_site: 0,
        near_duplicate_eval_pages: 0,
      },
      conventional: {
        train: 85,
        eval: 10,
        dropped: 5,
        lure_share_eval: 0.4,
        cross_brand: 0,
        cross_site: 3,
        near_duplicate_eval_pages: 0,
      },
    },
  };
  it("writes the figures of the result and nothing typed, once per input digest", () => {
    const line = measurementLine(split, "2026-11-01", "f".repeat(64));
    expect(line).toContain("the same 100 pages");
    expect(line).toContain("train 85, eval 10, 5 dropped, eval lure share 40.0%, 0 brands, 3 sites");
    expect(line).toContain("train.meta.jsonl aaaaaaaaaaaa");
    const doc = "# T\n\n## Measurements\n\n- old\n\n## Decisions\n";
    const once = recordMeasurement(doc, line) as string;
    expect(once).toContain(line);
    expect(once.indexOf(line)).toBeLessThan(once.indexOf("- old"));
    // The same inputs write nothing more; a changed input writes a new line.
    expect(recordMeasurement(once, line)).toBeNull();
    const changed = { ...split, inputs: [{ name: "train.meta.jsonl", path: "p", sha256: "b".repeat(64), bytes: 1 }] };
    expect(recordMeasurement(once, measurementLine(changed, "2026-11-02", "e".repeat(64)))).not.toBeNull();
  });
  it("records an incomplete result as incomplete, with what is missing", () => {
    const line = measurementLine(
      {
        status: "incomplete",
        name: "labels",
        inputs: [{ name: "annotations", path: "x", sha256: null, bytes: null }],
        missing: ["annotations (x)"],
      },
      "2026-11-01",
      "d".repeat(64),
    );
    expect(line).toContain("INCOMPLETE");
    expect(line).toContain("annotations (x)");
    expect(line).toContain("annotations missing");
  });
});

describe("the command line", () => {
  it("takes one command, and --check only on a comparison", () => {
    expect(parseArgs(["labels"])).toEqual({ command: "labels", check: false });
    expect(parseArgs(["split", "--check"])).toEqual({ command: "split", check: true });
    expect(parseArgs(["sample", "--check"])).toBeNull();
    expect(parseArgs(["report", "--check"])).toBeNull();
    expect(parseArgs(["labels", "--force"])).toBeNull();
    expect(parseArgs(["labels", "--check", "x"])).toBeNull();
    expect(parseArgs([])).toBeNull();
  });
});

describe("annotations and membership are validated", () => {
  const sample = ["a", "b"];
  const full = (id: string): Annotation => ({ id, brand: "X", lure_type: "none", lure: false });
  it("wants exactly one complete annotation per sampled page", () => {
    expect(validateAnnotations(sample, [full("a"), full("b")])).toEqual([]);
    expect(validateAnnotations(sample, [full("a")])).toEqual([expect.stringContaining("no annotation")]);
    expect(validateAnnotations(sample, [full("a"), full("a"), full("b")])).toEqual([
      expect.stringContaining("more than once"),
    ]);
    // A typo in a lure type is not a judgement: only the store's types, `unknown` and `disputed` are.
    expect(validateAnnotations(sample, [full("a"), { ...full("b"), lure_type: "credentail" }])).toEqual([
      expect.stringContaining("do not judge every field"),
    ]);
    expect(validateAnnotations(sample, [full("a"), { id: "b" }])).toEqual([
      expect.stringContaining("do not judge every field"),
    ]);
    expect(validateAnnotations(sample, [full("a"), { ...full("b"), lure: "maybe" as unknown as boolean }])).toEqual([
      expect.stringContaining("do not judge every field"),
    ]);
  });
  it("rejects an empty side, an id on both sides, and malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-membership-"));
    try {
      mkdirSync(join(dir, "dataset", "1.0"), { recursive: true });
      const write = (train: string, evaluation: string) => {
        writeFileSync(join(dir, "dataset", "1.0", "train.meta.jsonl"), train);
        writeFileSync(join(dir, "dataset", "1.0", "eval.meta.jsonl"), evaluation);
      };
      write('{"id":"a"}\n', "");
      expect(builtMembership(dir, "1.0").problems).toEqual([expect.stringContaining("eval.meta.jsonl holds no pages")]);
      write('{"id":"a"}\n{"id":"b"}\n', '{"id":"b"}\n');
      expect(builtMembership(dir, "1.0").problems).toEqual([
        expect.stringContaining("1 ids are on both sides, first b"),
      ]);
      write("not json\n", '{"id":"b"}\n');
      expect(builtMembership(dir, "1.0").problems[0]).toContain("malformed");
      write('{"id":"a"}\n', '{"id":"b"}\n');
      expect(builtMembership(dir, "1.0").problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("witnesses name the pages behind a figure", () => {
  it("names the brand, site and near-duplicate pages across the sides", () => {
    const w = (n: number) => shingles(Array.from({ length: 40 }, (_, i) => `w${n}x${i}`).join(" "));
    const pages: Page[] = [
      { id: "t1", brand: "FNB", site: "a.com", lure: true, hash: 0n, words: w(1) },
      { id: "e1", brand: "FNB", site: "b.com", lure: true, hash: 1n << 30n, words: w(2) },
      { id: "e2", brand: "Z", site: "a.com", lure: false, hash: 1n << 50n, words: w(3) },
      { id: "e3", brand: "Y", site: "c.com", lure: false, hash: 0n, words: w(1) },
    ];
    const sides = new Map<string, "train" | "eval">([
      ["t1", "train"],
      ["e1", "eval"],
      ["e2", "eval"],
      ["e3", "eval"],
    ]);
    const witnesses = leakWitnesses(pages, sides);
    expect(witnesses.brands).toEqual([{ brand: "fnb", eval: ["e1"], train: ["t1"] }]);
    expect(witnesses.sites).toEqual([{ site: "a.com", eval: ["e2"], train: ["t1"] }]);
    expect(witnesses.near).toEqual([{ eval: "e3", train: "t1" }]);
  });
});

describe("the labels comparison over a store, and checking a saved result", () => {
  const store = async (dir: string) => {
    mkdirSync(join(dir, "raw", "dataset"), { recursive: true });
    mkdirSync(join(dir, "runs", "compare"), { recursive: true });
    const ids = Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    writeFileSync(
      join(dir, "raw", "dataset", "reference.json"),
      JSON.stringify({ seed: 1, size: 60, drawn_from: "x", pages: ids }),
    );
    for (const id of ids) {
      const folder = join(dir, "pages", id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "meta.json"),
        JSON.stringify({
          labels: { brand: "Brand", lure: false, lure_type: "none" },
          label_source: { brand: "rule", lure: "ground-truth", lure_type: "ground-truth" },
        }),
      );
      writeFileSync(join(folder, "screenshot.jpg"), "jpg");
      writeFileSync(join(folder, "text.txt"), "text");
    }
    return annotationSample(dir);
  };
  const annotate = (dir: string, ids: string[], brand: string) =>
    writeFileSync(
      join(dir, "runs", "compare", "annotations.jsonl"),
      `${ids.map((id) => JSON.stringify({ id, brand, lure_type: "none", lure: false })).join("\n")}\n`,
    );

  it("scores per page, pins the pages, and goes stale when a page changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-labels-"));
    try {
      const ids = await store(dir);
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("annotations")],
      });
      annotate(dir, ids.slice(1), "Brand");
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("1 sampled pages have no annotation")],
      });
      annotate(dir, ids, "Other");
      const result = compareLabels(dir);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      // Every page is wrong on brand, right on lure type and lure; the per-page outcomes say so.
      expect(result.figures.sets.finished?.brand).toMatchObject({ wrong: 40, retained: 40 });
      expect(result.figures.pages).toHaveLength(40);
      // An input that cannot be read is incomplete, naming why, never an error (a directory where a file belongs).
      rmSync(join(dir, "runs", "compare", "annotations.jsonl"));
      mkdirSync(join(dir, "runs", "compare", "annotations.jsonl"));
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("unreadable")],
      });
      rmSync(join(dir, "runs", "compare", "annotations.jsonl"), { recursive: true });
      annotate(dir, ids, "Other");
      expect(result.figures.pages[0]?.outcomes.finished).toEqual({ brand: "wrong", lure_type: "right", lure: "right" });
      expect(result.figures.pages[0]?.outcomes.source).toEqual({
        brand: "unretained",
        lure_type: "right",
        lure: "right",
      });
      expect(result.inputs.some((i) => i.name.startsWith("page files"))).toBe(true);
      writeResult(resultFile(dir, "labels"), result);
      expect(checkResult(dir, "labels")).toEqual({ name: "labels", status: "current", changed: [] });
      // A repaired page, a changed annotation: stale, naming what changed.
      writeFileSync(join(dir, "pages", ids[0] as string, "text.txt"), "changed");
      expect(checkResult(dir, "labels")).toMatchObject({
        status: "stale",
        changed: [expect.stringContaining("page files")],
      });
      expect(checkResult(dir, "split-1.0").status).toBe("missing");
      // A saved incomplete comparison is never current, though its inputs are unchanged (round 2).
      const incomplete = { ...result, status: "incomplete", missing: ["a sampled page is missing"] };
      writeResult(resultFile(dir, "labels"), incomplete as never);
      expect(checkResult(dir, "labels")).toMatchObject({
        status: "stale",
        changed: [expect.stringContaining("the saved result is incomplete: a sampled page is missing")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is incomplete for a sampled page that is missing, and report refuses while a result is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-report-"));
    try {
      const ids = await store(dir);
      annotate(dir, ids, "Brand");
      rmSync(join(dir, "pages", ids[3] as string), { recursive: true });
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("1 sampled pages cannot be read")],
      });
      expect(() => report(dir, "## Measurements\n", "2026-11-01")).toThrow(/no result for labels, split-1.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
