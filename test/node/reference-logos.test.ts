import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDomain } from "tldts";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUCKET,
  capture,
  check,
  coverage,
  FICTIONAL,
  type Grab,
  INDEX_KEY,
  imageInfo,
  LoadRefused,
  LogoIndex,
  load,
  logoKey,
  PREVIOUS_KEY,
  type Run,
  SelectorTable,
  sha256,
  slugOf,
} from "../../scripts/load-reference-logos.ts";

// D03 T03 §2: the reference logo store. Real brands' logos never reach the repository: these tests build their own
// image bytes and fictional brands.
const ROOT = join(import.meta.dirname, "../..");
const temps: string[] = [];
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `reference-logos-${name}-`));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// --- Image bytes built here ---------------------------------------------------------------------------------------------

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
// A PNG header (signature and IHDR) of the given size, plus a tag so two images of one size differ.
const png = (width: number, height: number, tag = 0) =>
  new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
    tag,
  ]);
// A JPEG: SOI, an APP0 segment, then SOF0 with height and width.
const jpeg = (width: number, height: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    74,
    70,
    73,
    70,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
// A WebP with a VP8X chunk (sizes stored minus one, 24-bit little endian).
const webp = (width: number, height: number) => {
  const w = width - 1;
  const h = height - 1;
  return new Uint8Array([
    ...[82, 73, 70, 70],
    30,
    0,
    0,
    0,
    ...[87, 69, 66, 80],
    ...[86, 80, 56, 88],
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    w & 255,
    (w >> 8) & 255,
    (w >> 16) & 255,
    h & 255,
    (h >> 8) & 255,
    (h >> 16) & 255,
  ]);
};
const text = (s: string) => new TextEncoder().encode(s);

describe("imageInfo", () => {
  it("reads PNG, JPEG and WebP sizes from the bytes", () => {
    expect(imageInfo(png(600, 120))).toEqual({ type: "image/png", width: 600, height: 120 });
    expect(imageInfo(jpeg(512, 300))).toEqual({ type: "image/jpeg", width: 512, height: 300 });
    expect(imageInfo(webp(1024, 257))).toEqual({ type: "image/webp", width: 1024, height: 257 });
  });

  it("refuses SVG, HTML, ICO and empty or truncated bytes", () => {
    expect(imageInfo(text('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100"></svg>'))).toBeNull();
    expect(imageInfo(text("<!doctype html><title>Access Denied</title>"))).toBeNull();
    expect(imageInfo(new Uint8Array([0, 0, 1, 0, 1, 0, 32, 32]))).toBeNull();
    expect(imageInfo(new Uint8Array())).toBeNull();
    expect(imageInfo(png(600, 120).subarray(0, 20))).toBeNull();
    expect(imageInfo(png(0, 120))).toBeNull();
  });

  it("reads the committed fictional logos at 256 px or more", () => {
    for (const f of FICTIONAL) {
      const info = imageInfo(new Uint8Array(readFileSync(join(ROOT, f.path))));
      expect(info?.type, f.path).toBe("image/png");
      expect(Math.max(info?.width ?? 0, info?.height ?? 0), f.path).toBeGreaterThanOrEqual(256);
    }
  });
});

describe("logoKey", () => {
  it("builds a key inside its generation and refuses a slug or generation out of form", () => {
    expect(logoKey("20261031T100000Z", "fnb", "image/png")).toBe("ref/logos/20261031T100000Z/fnb.png");
    expect(logoKey("20261031T100000Z", "fnb", "image/jpeg")).toBe("ref/logos/20261031T100000Z/fnb.jpg");
    expect(() => logoKey("20261031T100000Z", "../x", "image/png")).toThrow(LoadRefused);
    expect(() => logoKey("20261031T100000Z", "FNB", "image/png")).toThrow(LoadRefused);
    expect(() => logoKey("latest", "fnb", "image/png")).toThrow(LoadRefused);
  });
});

// --- The committed selector table --------------------------------------------------------------------------------------

describe("data/reference-logos.json", () => {
  const table = SelectorTable.parse(JSON.parse(readFileSync(join(ROOT, "data/reference-logos.json"), "utf8")));
  const brands = (
    JSON.parse(readFileSync(join(ROOT, "data/brands.json"), "utf8")) as {
      brands: { name: string; domains: string[] }[];
    }
  ).brands;

  it("has exactly one entry per brand of the brand table, and nothing else", () => {
    for (const brand of brands)
      expect(
        table.logos.filter((e) => e.brand === brand.name),
        brand.name,
      ).toHaveLength(1);
    expect(table.logos).toHaveLength(brands.length);
  });

  it("names each brand's page on one of that brand's own domains, under the brand's slug", () => {
    const slugs = new Set<string>();
    for (const entry of table.logos) {
      const brand = brands.find((b) => b.name === entry.brand);
      expect(brand?.domains, entry.brand).toContain(getDomain(entry.url));
      expect(entry.slug).toBe(slugOf(entry.brand));
      expect(slugs.has(entry.slug)).toBe(false);
      slugs.add(entry.slug);
    }
  });
});

// --- The index ---------------------------------------------------------------------------------------------------------

const GEN = "20261031T100000Z";
const logo = (slug: string, brand: string, over: Partial<LogoIndex["logos"][number]> = {}) => ({
  slug,
  brand,
  key: `ref/logos/${GEN}/${slug}.png`,
  page_url: `https://www.${slug}.example/`,
  source_url: `https://www.${slug}.example/`,
  source_kind: "header" as const,
  use: "detection-reference" as const,
  fetched_at: "2026-10-31T10:00:00.000Z",
  media_type: "image/png" as const,
  width: 600,
  height: 120,
  sha256: "a".repeat(64),
  fictional: false,
  ...over,
});
const index = (logos: ReturnType<typeof logo>[], missing: { slug: string; brand: string; reason: string }[] = []) => ({
  version: 1,
  generation: GEN,
  generated_at: "2026-10-31T10:00:00.000Z",
  logos,
  missing,
});

describe("LogoIndex", () => {
  it("accepts a well-formed index", () => {
    expect(
      LogoIndex.safeParse(index([logo("one", "One")], [{ slug: "two", brand: "Two", reason: "blocked" }])).success,
    ).toBe(true);
  });

  it("refuses a logo under 256 px, a duplicate slug, a slug both stored and missing, and a key outside its generation", () => {
    expect(LogoIndex.safeParse(index([logo("one", "One", { width: 255, height: 100 })])).success).toBe(false);
    expect(LogoIndex.safeParse(index([logo("one", "One"), logo("one", "One")])).success).toBe(false);
    expect(LogoIndex.safeParse(index([logo("one", "One")], [{ slug: "one", brand: "One", reason: "x" }])).success).toBe(
      false,
    );
    expect(
      LogoIndex.safeParse(index([logo("one", "One", { key: "ref/logos/20261030T100000Z/one.png" })])).success,
    ).toBe(false);
    expect(LogoIndex.safeParse(index([logo("one", "One", { key: `ref/logos/${GEN}/one.jpg` })])).success).toBe(false);
  });
});

describe("coverage", () => {
  const names = Array.from({ length: 20 }, (_, i) => `Brand ${i + 1}`);
  const real = (n: number) => names.slice(0, n).map((name) => logo(slugOf(name), name));
  const fictional = [
    logo("protea-bank", "Protea Bank", { fictional: true }),
    logo("nimbusmail", "NimbusMail", { fictional: true }),
  ];

  it("counts real brands apart from fictional ones", () => {
    const parsed = LogoIndex.parse(
      index(
        [...real(18), ...fictional],
        names.slice(18).map((name) => ({ slug: slugOf(name), brand: name, reason: "blocked" })),
      ),
    );
    expect(coverage(parsed, names)).toEqual({ real: 18, fictional: 2, missing: 2 });
  });

  it("refuses an index that leaves a brand out, lists one twice, or names one the table does not", () => {
    expect(() => coverage(LogoIndex.parse(index(real(19))), names)).toThrow(/Brand 20 is listed 0 times/);
    const twice = LogoIndex.parse(index(real(20), [{ slug: "brand-1-again", brand: "Brand 1", reason: "x" }]));
    expect(() => coverage(twice, names)).toThrow(/Brand 1 is listed 2 times/);
    const stranger = LogoIndex.parse(index([...real(20), logo("stranger", "Stranger")]));
    expect(() => coverage(stranger, names)).toThrow(/not in the brand table: Stranger/);
  });
});

// --- Capture -----------------------------------------------------------------------------------------------------------

describe("capture", () => {
  const brands = [
    { name: "Alpha", domains: ["alpha.example"] },
    { name: "Beta", domains: ["beta.example"] },
    { name: "Gamma", domains: ["gamma.example"] },
    { name: "Delta", domains: ["delta.example"] },
    { name: "Epsilon", domains: ["epsilon.example"] },
    { name: "Zeta", domains: ["zeta.example"] },
  ];
  const table = SelectorTable.parse({
    version: 1,
    logos: brands.slice(0, 5).map((b) => ({
      slug: slugOf(b.name),
      brand: b.name,
      url: `https://www.${b.domains[0]}/`,
      kind: "header",
      selector: "a.logo",
    })),
  });
  const fictional = FICTIONAL.map((f) => ({ ...f, path: join(ROOT, f.path) }));
  let aborted = false;
  let alphaTries = 0;
  let epsilonTries = 0;
  const grab: Grab = (entry, signal) => {
    const page = entry.url;
    switch (entry.brand) {
      case "Alpha":
        alphaTries++;
        return Promise.reject(new Error("the selector matched nothing"));
      case "Beta":
        // Never answers: the deadline must give up on it, and the grab is told to stop.
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      case "Gamma":
        return Promise.resolve({ bytes: text("<svg></svg>"), pageUrl: page, sourceUrl: page });
      case "Delta":
        return Promise.resolve({ bytes: png(600, 120), pageUrl: "https://login.elsewhere.example/", sourceUrl: page });
      default:
        // Epsilon fails its first try (a bot check) and answers the second.
        epsilonTries++;
        if (epsilonTries === 1) return Promise.reject(new Error("a bot check"));
        return Promise.resolve({ bytes: png(600, 120, 7), pageUrl: page, sourceUrl: page });
    }
  };

  it("retries a failed brand once, records each that still fails with its reason, and goes on", async () => {
    const store = temp("capture");
    const { dir, index: made } = await capture({
      table,
      brands,
      grab,
      store,
      grabMs: 50,
      fictional,
      now: new Date("2026-10-31T10:00:00Z"),
    });
    expect(dir).toBe(join(store, GEN));
    const reasons = Object.fromEntries(made.missing.map((m) => [m.brand, m.reason]));
    expect(reasons.Alpha).toMatch(/selector matched nothing/);
    expect(alphaTries).toBe(2);
    expect(epsilonTries).toBe(2);
    expect(reasons.Beta).toMatch(/no logo within 0.05 s/);
    expect(aborted).toBe(true);
    expect(reasons.Gamma).toMatch(/not a PNG, JPEG or WebP/);
    expect(reasons.Delta).toMatch(/not one of the brand's domains/);
    expect(reasons.Zeta).toMatch(/no entry/);
    expect(made.logos.map((l) => l.brand)).toEqual(["Epsilon", "Protea Bank", "NimbusMail"]);
    // What is on disk is what the index says.
    const stored = LogoIndex.parse(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
    expect(stored).toEqual(made);
    for (const l of stored.logos) {
      const bytes = new Uint8Array(readFileSync(join(dir, l.key.slice(l.key.lastIndexOf("/") + 1))));
      expect(sha256(bytes)).toBe(l.sha256);
    }
    expect(stored.logos.filter((l) => l.fictional).map((l) => l.slug)).toEqual(["protea-bank", "nimbusmail"]);
    expect(
      coverage(
        stored,
        brands.map((b) => b.name),
      ),
    ).toEqual({ real: 1, fictional: 2, missing: 5 });
  });
});

// --- Load, restore and check against a stubbed Wrangler ----------------------------------------------------------------

type Fault = { failPut?: (key: string) => boolean; corruptGet?: (key: string) => boolean };
function fakeR2(fault: Fault = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const run: Run = (args) => {
    const [, , verb, path] = args;
    const key = (path ?? "").slice(`${BUCKET}/`.length);
    const file = args[args.indexOf("--file") + 1] ?? "";
    calls.push(`${verb} ${key}`);
    if (verb === "put") {
      if (fault.failPut?.(key)) return { status: 1, stdout: "", stderr: "upload failed" };
      objects.set(key, new Uint8Array(readFileSync(file)));
      return { status: 0, stdout: "Upload complete.", stderr: "" };
    }
    const object = objects.get(key);
    if (!object) return { status: 1, stdout: "", stderr: "The specified key does not exist." };
    const bytes = fault.corruptGet?.(key) ? new Uint8Array([...object, 0]) : object;
    writeFileSync(file, bytes);
    return { status: 0, stdout: "Download complete.", stderr: "" };
  };
  return { objects, calls, run };
}

// A store with one generation of `n` real logos (Brand 1..n) plus the fictional pair.
function makeStore(n: number, generation = GEN) {
  const store = temp("store");
  const dir = join(store, generation);
  mkdirSync(dir);
  const names = Array.from({ length: n }, (_, i) => `Brand ${i + 1}`);
  const entries = [
    ...names.map((name, i) => ({ name, bytes: png(600, 120, i), fictional: false })),
    { name: "Protea Bank", bytes: png(512, 160, 200), fictional: true },
    { name: "NimbusMail", bytes: png(512, 160, 201), fictional: true },
  ].map(({ name, bytes, fictional }) => {
    const slug = slugOf(name);
    writeFileSync(join(dir, `${slug}.png`), bytes);
    const size = imageInfo(bytes);
    return logo(slug, name, {
      key: `ref/logos/${generation}/${slug}.png`,
      sha256: sha256(bytes),
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      fictional,
    });
  });
  const made = { ...index(entries), generation };
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(made, null, 2)}\n`);
  return { store, dir, names };
}

describe("load", () => {
  it("puts every logo, then the index last, and reads the index back", () => {
    const { store } = makeStore(20);
    const r2 = fakeR2();
    const { keys } = load({ target: "local", store, run: r2.run });
    const puts = r2.calls.filter((c) => c.startsWith("put "));
    expect(puts).toHaveLength(23);
    expect(puts.at(-1)).toBe(`put ${INDEX_KEY}`);
    expect(r2.calls.at(-1)).toBe(`get ${INDEX_KEY}`);
    expect(keys).toHaveLength(23);
    expect(r2.objects.has(PREVIOUS_KEY)).toBe(false);
  });

  it("writes nothing under --dry-run and lists every object", () => {
    const { store } = makeStore(20);
    const r2 = fakeR2();
    const lines: string[] = [];
    load({ target: "remote", store, run: r2.run, dryRun: true, log: (l) => lines.push(l) });
    expect(r2.calls).toEqual([]);
    expect(lines.filter((l) => l.startsWith("would put ref/logos/"))).toHaveLength(22);
  });

  it("refuses an image changed after capture before writing anything", () => {
    const { store, dir } = makeStore(20);
    writeFileSync(join(dir, "brand-3.png"), png(600, 120, 99));
    const r2 = fakeR2();
    expect(() => load({ target: "local", store, run: r2.run })).toThrow(/brand-3.png does not match the index/);
    expect(r2.calls).toEqual([]);
  });

  it("refuses an index naming a key outside ref/logos/", () => {
    const { store, dir } = makeStore(20);
    const bad = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    bad.logos[0].key = "raw/brand-1.png";
    writeFileSync(join(dir, "index.json"), JSON.stringify(bad));
    expect(() => load({ target: "local", store, run: fakeR2().run })).toThrow(LoadRefused);
  });

  it("fails when a put fails or the index reads back different, before or without replacing the live index", () => {
    const { store } = makeStore(20);
    const failing = fakeR2({ failPut: (key) => key.endsWith("brand-7.png") });
    expect(() => load({ target: "local", store, run: failing.run })).toThrow(/writing .*brand-7.png failed/);
    expect(failing.objects.has(INDEX_KEY)).toBe(false);
    const corrupt = fakeR2({ corruptGet: (key) => key === INDEX_KEY });
    expect(() => load({ target: "local", store, run: corrupt.run })).toThrow(/did not read back as written/);
  });

  it("keeps the index it replaces, never overwrites the older generation, and restores it", () => {
    const first = makeStore(20, "20261030T100000Z");
    const second = makeStore(21, GEN);
    const r2 = fakeR2();
    load({ target: "local", store: first.store, run: r2.run });
    const firstIndex = r2.objects.get(INDEX_KEY);
    const olderObjects = [...r2.objects.keys()].filter((k) => k.includes("20261030T100000Z"));
    load({ target: "local", store: second.store, run: r2.run });
    expect(r2.objects.get(PREVIOUS_KEY)).toEqual(firstIndex);
    for (const key of olderObjects) expect(r2.objects.has(key)).toBe(true);
    // A retried load of the same generation keeps the previous index as it was.
    load({ target: "local", store: second.store, run: r2.run });
    expect(r2.objects.get(PREVIOUS_KEY)).toEqual(firstIndex);
    load({ target: "local", run: r2.run, restore: true });
    expect(r2.objects.get(INDEX_KEY)).toEqual(firstIndex);
    // A retried restore answers the same.
    load({ target: "local", run: r2.run, restore: true });
    expect(r2.objects.get(INDEX_KEY)).toEqual(firstIndex);
    expect(check({ target: "local", brands: first.names, run: r2.run }).generation).toBe("20261030T100000Z");
  });

  it("refuses a restore with no previous index", () => {
    expect(() => load({ target: "local", run: fakeR2().run, restore: true })).toThrow(
      /no ref\/logos\/index.previous.json/,
    );
  });
});

describe("check", () => {
  it("passes 20 real brands whose objects match the index", () => {
    const { store, names } = makeStore(20);
    const r2 = fakeR2();
    load({ target: "local", store, run: r2.run });
    expect(check({ target: "local", brands: names, run: r2.run })).toEqual({
      real: 20,
      fictional: 2,
      missing: 0,
      generation: GEN,
    });
  });

  it("fails 19 real brands, and 18 real plus the two fictional", () => {
    for (const n of [19, 18]) {
      const { store, names } = makeStore(n);
      const r2 = fakeR2();
      load({ target: "local", store, run: r2.run });
      expect(() => check({ target: "local", brands: names, run: r2.run })).toThrow(/only \d+ real brands/);
    }
  });

  it("fails a listed object that is absent or whose bytes differ", () => {
    const { store, names } = makeStore(20);
    const r2 = fakeR2();
    load({ target: "local", store, run: r2.run });
    r2.objects.delete(`ref/logos/${GEN}/brand-4.png`);
    expect(() => check({ target: "local", brands: names, run: r2.run })).toThrow(/brand-4.png is listed but not in R2/);
    const again = fakeR2({ corruptGet: (key) => key.endsWith("brand-5.png") });
    load({ target: "local", store, run: again.run });
    expect(() => check({ target: "local", brands: names, run: again.run })).toThrow(/brand-5.png in R2 does not match/);
  });

  it("fails when there is no index", () => {
    expect(() => check({ target: "local", brands: [], run: fakeR2().run })).toThrow(
      /there is no ref\/logos\/index.json/,
    );
  });
});
