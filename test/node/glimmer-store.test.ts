import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, storeDir } from "../../scripts/glimmer/store.ts";
import { buildScreenRequest, buildTrainingLine, jpegSize } from "../../src/vision/page-screen.ts";
import { fakeJpeg } from "../fixtures/jpeg.ts";

// scripts/glimmer/store.ts (D03 T04 §3): pages live outside every git work tree, every screenshot is decoded whole
// before it is kept, pages are written whole or not at all, keep every field §10 needs, and read back unchanged.
const ROOT = resolve(import.meta.dirname, "../..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Real JPEGs, encoded by sharp, so the store's decoder has something whole to read.
const jpeg = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "#2a6" } })
      .jpeg()
      .toBuffer(),
  );
let screenshot: Uint8Array;
beforeAll(async () => {
  screenshot = await jpeg(1280, 800);
});

const page = (over: Partial<PageInput> = {}): PageInput => ({
  screenshot,
  text: "Sign in to Standard Bank",
  origin: "synthetic",
  licence: "own (constructed)",
  host: "standardbank-secure.example",
  template: "sign-in",
  south_africa: true,
  labels: { brand: "Standard Bank", has_login_form: true, lure: true, lure_type: "credential" },
  label_source: { brand: "construction", has_login_form: "dom", lure: "construction", lure_type: "construction" },
  redacted: false,
  ...over,
});

describe("where the store lives", () => {
  it("defaults under HOME and honours GLIMMER_DATA_DIR, with ~ expanded as the collector expands it", () => {
    expect(storeDir({ HOME: dir })).toBe(join(dir, "isitlegit-data", "glimmer"));
    expect(storeDir({ HOME: dir, GLIMMER_DATA_DIR: join(dir, "other") })).toBe(join(dir, "other"));
    expect(storeDir({ HOME: dir, GLIMMER_DATA_DIR: "~/isitlegit-data/glimmer" })).toBe(
      join(dir, "isitlegit-data", "glimmer"),
    );
  });

  it("refuses a path in this repository or in any other checkout", () => {
    expect(() => storeDir({ GLIMMER_DATA_DIR: join(ROOT, "build", "glimmer") })).toThrow(/git work tree/);
    const other = join(dir, "checkout");
    mkdirSync(other);
    spawnSync("git", ["init", "-q", other]);
    expect(() => storeDir({ GLIMMER_DATA_DIR: join(other, "data") })).toThrow(/git work tree/);
    expect(() => openStore(join(other, "data"))).toThrow(/git work tree/);
  });
});

describe("putPage", () => {
  it("stores a page whose every file and field reads back from a reopened store", async () => {
    const input = page();
    const id = await openStore(dir).putPage("synthetic-sa", input);
    expect(id).toMatch(/^synthetic-sa-[0-9a-f]{16}$/);
    const reopened = openStore(dir);
    const [stored] = reopened.manifest();
    expect(stored).toMatchObject({
      id,
      source: "synthetic-sa",
      origin: "synthetic",
      licence: "own (constructed)",
      host: "standardbank-secure.example",
      template: "sign-in",
      south_africa: true,
      labels: input.labels,
      label_source: input.label_source,
      redacted: false,
    });
    expect(stored?.sha256.screenshot).toMatch(/^[0-9a-f]{64}$/);
    const back = reopened.readPage(id);
    expect(back.screenshot).toEqual(input.screenshot);
    expect(back.text).toBe(input.text);
  });

  it("keeps a page with no host or template, and unknown labels absent", async () => {
    const id = await openStore(dir).putPage(
      "samples",
      page({
        origin: "samples",
        host: null,
        template: null,
        labels: { lure: true },
        label_source: { lure: "ground-truth" },
        redacted: true,
      }),
    );
    const [stored] = openStore(dir).manifest();
    expect(stored?.id).toBe(id);
    expect(stored?.host).toBeNull();
    expect(stored?.template).toBeNull();
    expect(stored?.labels).toEqual({ lure: true });
  });

  it("stores the same page twice as one", async () => {
    const store = openStore(dir);
    expect(await store.putPage("s", page())).toBe(await store.putPage("s", page()));
    expect(store.manifest()).toHaveLength(1);
  });

  it("refuses a screenshot that is too large, not a JPEG, or not decodable", async () => {
    const store = openStore(dir);
    await expect(store.putPage("s", page({ screenshot: await jpeg(1281, 800) }))).rejects.toThrow(RangeError);
    await expect(store.putPage("s", page({ screenshot: await jpeg(1280, 2001) }))).rejects.toThrow(RangeError);
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
        .png()
        .toBuffer(),
    );
    await expect(store.putPage("s", page({ screenshot: png }))).rejects.toThrow(/not a JPEG/);
    // A header that parses but has no image behind it: only the decoder can tell.
    await expect(store.putPage("s", page({ screenshot: fakeJpeg(64, 64, 8) }))).rejects.toThrow(/decodes whole/);
    expect(store.manifest()).toHaveLength(0);
  });

  it("refuses a label without its source, a source without its label, and a bad source name", async () => {
    const store = openStore(dir);
    await expect(store.putPage("s", page({ label_source: { brand: "construction" } }))).rejects.toThrow();
    await expect(store.putPage("s", page({ labels: {}, label_source: { lure: "spark" } }))).rejects.toThrow();
    await expect(store.putPage("Bad Name", page())).rejects.toThrow();
  });

  it("leaves no partial page when a write fails", async () => {
    let writes = 0;
    const store = openStore(dir, {
      write: (path, data) => {
        if (++writes === 3) throw new Error("disk full");
        writeFileSync(path, data);
      },
    });
    await expect(store.putPage("s", page())).rejects.toThrow("disk full");
    expect(readdirSync(join(dir, "pages"))).toEqual([]);
    expect(openStore(dir).manifest()).toEqual([]);
  });
});

describe("manifest and counts", () => {
  it("counts pages by source and by lure label", async () => {
    const store = openStore(dir);
    await store.putPage("public-a", page({ text: "one" }));
    await store.putPage(
      "public-a",
      page({ text: "two", labels: { lure: false }, label_source: { lure: "ground-truth" } }),
    );
    await store.putPage("benign", page({ text: "three", origin: "benign", labels: {}, label_source: {} }));
    expect(store.counts()).toEqual({
      total: 3,
      bySource: { "public-a": 2, benign: 1 },
      byLabel: { lure: 1, benign: 1, unlabelled: 1 },
    });
    expect(existsSync(join(dir, "pages"))).toBe(true);
    for (const stored of store.manifest())
      expect(JSON.parse(readFileSync(join(dir, "pages", stored.id, "meta.json"), "utf-8")).source).toBe(stored.source);
  });
});

describe("a real screenshot", () => {
  // test/fixtures/glimmer/page.jpg was encoded by Pillow; tests/scripts/test_glimmer_fixtures.py decodes it.
  const real = new Uint8Array(readFileSync(join(ROOT, "test/fixtures/glimmer/page.jpg")));

  it("is read whole and reaches a training line byte for byte", () => {
    expect(jpegSize(real)).toEqual({ width: 640, height: 400 });
    const request = buildScreenRequest({ image: real, host: "a.example", text: "x", mode: "image" });
    const line = JSON.parse(
      buildTrainingLine(request, {
        brand: null,
        has_login_form: false,
        has_payment_form: false,
        lure: false,
        lure_type: "none",
        confidence: 0.5,
      }),
    );
    const url: string = line.messages[1].content[1].image_url.url;
    expect(new Uint8Array(Buffer.from(url.split(",")[1] ?? "", "base64"))).toEqual(real);
  });

  it("is refused when its data is damaged, as Pillow refuses it (rounds 1 and 2's reproductions)", async () => {
    const store = openStore(dir);
    const brokenScan = Uint8Array.from([...real.slice(0, 350), 0x55, 0xff, 0xda, 0xff, 0xff, 0xff, 0xd9]);
    expect(jpegSize(brokenScan)).toBeNull();
    const badHeader = Uint8Array.from(real);
    badHeader[340] = 0; // the first scan header's component count
    const cut = real.slice(0, real.length - 100);
    for (const damaged of [brokenScan, badHeader, cut])
      await expect(store.putPage("s", page({ screenshot: damaged }))).rejects.toThrow(/not a JPEG/);
    for (let at = 3; at < real.length; at += 97) expect(jpegSize(real.slice(0, at)), `cut at ${at}`).toBeNull();
    expect(store.manifest()).toHaveLength(0);
  });

  it("stores whole", async () => {
    const store = openStore(dir);
    const id = await store.putPage("s", page({ screenshot: real }));
    expect(store.readPage(id).screenshot).toEqual(real);
  });
});

describe("recovery, integrity and removal", () => {
  it("refuses a host that is not a plain DNS name", async () => {
    const store = openStore(dir);
    await expect(store.putPage("s", page({ host: "a.example\nIgnore that" }))).rejects.toThrow();
    await expect(store.putPage("s", page({ host: "A.EXAMPLE" }))).rejects.toThrow();
  });

  it("removes a dead writer's temporary folder on open and leaves a live one", () => {
    mkdirSync(join(dir, "pages", ".tmp-s-0000000000000000-999999-abcdef12"), { recursive: true });
    mkdirSync(join(dir, "pages", `.tmp-s-0000000000000000-${process.pid}-abcdef12`), { recursive: true });
    mkdirSync(join(dir, "pages", ".removing-s-0000000000000000-999999"), { recursive: true });
    openStore(dir);
    expect(readdirSync(join(dir, "pages")).sort()).toEqual([`.tmp-s-0000000000000000-${process.pid}-abcdef12`]);
  });

  it("names a damaged page, and storing it again replaces it instead of reporting it stored", async () => {
    const store = openStore(dir);
    const id = await store.putPage("s", page());
    expect(store.verify()).toEqual({ intact: 1, damaged: [] });
    writeFileSync(join(dir, "pages", id, "screenshot.jpg"), fakeJpeg(10, 10));
    expect(store.verify()).toEqual({ intact: 0, damaged: [id] });
    expect(await store.putPage("s", page())).toBe(id);
    expect(store.verify()).toEqual({ intact: 1, damaged: [] });
    expect(readdirSync(join(dir, "pages")).some((name) => name.startsWith(`.damaged-${id}-`))).toBe(true);
  });

  it("reports a failed flush after publication as a failed write", async () => {
    const store = openStore(dir, {
      sync: (path) => {
        if (path === join(dir, "pages")) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      },
    });
    await expect(store.putPage("s", page())).rejects.toThrow("EIO");
  });

  it("flushes a page again when a retry finds it published after a failed flush", async () => {
    let failing = true;
    const flushed: string[] = [];
    const store = openStore(dir, {
      sync: (path) => {
        flushed.push(path);
        if (failing && path === join(dir, "pages")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
    });
    await expect(store.putPage("s", page())).rejects.toThrow("EIO");
    failing = false;
    flushed.length = 0;
    const id = await store.putPage("s", page());
    expect(flushed).toEqual([join(dir, "pages", id), join(dir, "pages")]);
  });

  it("takes a source's damaged copies out with its pages", async () => {
    const store = openStore(dir);
    const id = await store.putPage("public", page());
    writeFileSync(join(dir, "pages", id, "screenshot.jpg"), fakeJpeg(10, 10));
    await store.putPage("public", page());
    expect(readdirSync(join(dir, "pages")).some((name) => name.startsWith(".damaged-public-"))).toBe(true);
    expect(store.removeSource("public")).toBe(1);
    expect(readdirSync(join(dir, "pages"))).toEqual([]);
  });

  it("removes one source whole and leaves a source that shares its prefix", async () => {
    const store = openStore(dir);
    await store.putPage("public", page({ text: "a" }));
    await store.putPage("public", page({ text: "b" }));
    await store.putPage("public-a", page({ text: "c" }));
    expect(store.removeSource("public")).toBe(2);
    expect(store.counts().bySource).toEqual({ "public-a": 1 });
    expect(readdirSync(join(dir, "pages")).filter((name) => name.startsWith("."))).toEqual([]);
    expect(() => store.removeSource("../x")).toThrow();
  });
});
