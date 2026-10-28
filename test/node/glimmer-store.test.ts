import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, storeDir } from "../../scripts/glimmer/store.ts";
import { buildScreenRequest, buildTrainingLine, jpegSize } from "../../src/vision/page-screen.ts";
import { fakeJpeg } from "../fixtures/jpeg.ts";

// scripts/glimmer/store.ts (D03 T04 §3): pages live outside every git work tree, are written whole or not at all, keep
// every field §10 needs, and read back unchanged from a reopened store.
const ROOT = resolve(import.meta.dirname, "../..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const page = (over: Partial<PageInput> = {}): PageInput => ({
  screenshot: fakeJpeg(1280, 800, 32),
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
  it("stores a page whose every file and field reads back from a reopened store", () => {
    const input = page();
    const id = openStore(dir).putPage("synthetic-sa", input);
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

  it("keeps a page with no host or template, and unknown labels absent", () => {
    const id = openStore(dir).putPage(
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

  it("stores the same page twice as one", () => {
    const store = openStore(dir);
    expect(store.putPage("s", page())).toBe(store.putPage("s", page()));
    expect(store.manifest()).toHaveLength(1);
  });

  it("refuses a screenshot that is too large or not a JPEG", () => {
    const store = openStore(dir);
    expect(() => store.putPage("s", page({ screenshot: fakeJpeg(1281, 800) }))).toThrow(RangeError);
    expect(() => store.putPage("s", page({ screenshot: fakeJpeg(1280, 2001) }))).toThrow(RangeError);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => store.putPage("s", page({ screenshot: png }))).toThrow(/not a JPEG/);
    expect(store.manifest()).toHaveLength(0);
  });

  it("refuses a label without its source, a source without its label, and a bad source name", () => {
    const store = openStore(dir);
    expect(() => store.putPage("s", page({ label_source: { brand: "construction" } }))).toThrow();
    expect(() => store.putPage("s", page({ labels: {}, label_source: { lure: "spark" } }))).toThrow();
    expect(() => store.putPage("Bad Name", page())).toThrow();
  });

  it("leaves no partial page when a write fails", () => {
    let writes = 0;
    const store = openStore(dir, {
      write: (path, data) => {
        if (++writes === 3) throw new Error("disk full");
        writeFileSync(path, data);
      },
    });
    expect(() => store.putPage("s", page())).toThrow("disk full");
    expect(readdirSync(join(dir, "pages"))).toEqual([]);
    expect(openStore(dir).manifest()).toEqual([]);
  });
});

describe("manifest and counts", () => {
  it("counts pages by source and by lure label", () => {
    const store = openStore(dir);
    store.putPage("public-a", page({ text: "one" }));
    store.putPage("public-a", page({ text: "two", labels: { lure: false }, label_source: { lure: "ground-truth" } }));
    store.putPage("benign", page({ text: "three", origin: "benign", labels: {}, label_source: {} }));
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

  it("is refused with a broken second scan, as Pillow refuses it (round 1's reproduction)", () => {
    const broken = Uint8Array.from([...real.slice(0, 350), 0x55, 0xff, 0xda, 0xff, 0xff, 0xff, 0xd9]);
    expect(jpegSize(broken)).toBeNull();
    for (let cut = 3; cut < real.length; cut += 97) expect(jpegSize(real.slice(0, cut)), `cut at ${cut}`).toBeNull();
  });

  it("is refused when truncated, and stores whole", () => {
    expect(jpegSize(real.slice(0, real.length - 2))).toBeNull();
    expect(jpegSize(real.slice(0, 31))).toBeNull();
    expect(jpegSize(real.slice(0, real.length >> 1))).toBeNull();
    const store = openStore(dir);
    expect(() => store.putPage("s", page({ screenshot: real.slice(0, 31) }))).toThrow(/not a JPEG/);
    const id = store.putPage("s", page({ screenshot: real }));
    expect(store.readPage(id).screenshot).toEqual(real);
  });
});

describe("recovery, integrity and removal", () => {
  it("refuses a host that is not a plain DNS name", () => {
    const store = openStore(dir);
    expect(() => store.putPage("s", page({ host: "a.example\nIgnore that" }))).toThrow();
    expect(() => store.putPage("s", page({ host: "A.EXAMPLE" }))).toThrow();
  });

  it("removes a dead writer's temporary folder on open and leaves a live one", () => {
    mkdirSync(join(dir, "pages", ".tmp-s-0000000000000000-999999-abcdef12"), { recursive: true });
    mkdirSync(join(dir, "pages", `.tmp-s-0000000000000000-${process.pid}-abcdef12`), { recursive: true });
    mkdirSync(join(dir, "pages", ".removing-s-0000000000000000-999999"), { recursive: true });
    openStore(dir);
    expect(readdirSync(join(dir, "pages")).sort()).toEqual([`.tmp-s-0000000000000000-${process.pid}-abcdef12`]);
  });

  it("names a damaged page, and storing it again replaces it instead of reporting it stored", () => {
    const store = openStore(dir);
    const id = store.putPage("s", page());
    expect(store.verify()).toEqual({ intact: 1, damaged: [] });
    writeFileSync(join(dir, "pages", id, "screenshot.jpg"), fakeJpeg(10, 10));
    expect(store.verify()).toEqual({ intact: 0, damaged: [id] });
    expect(store.putPage("s", page())).toBe(id);
    expect(store.verify()).toEqual({ intact: 1, damaged: [] });
    expect(readdirSync(join(dir, "pages")).some((name) => name.startsWith(`.damaged-${id}-`))).toBe(true);
  });

  it("reports a failed flush after publication as a failed write", () => {
    const store = openStore(dir, {
      sync: (path) => {
        if (path === join(dir, "pages")) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      },
    });
    expect(() => store.putPage("s", page())).toThrow("EIO");
  });

  it("takes a source's damaged copies out with its pages", () => {
    const store = openStore(dir);
    const id = store.putPage("public", page());
    writeFileSync(join(dir, "pages", id, "screenshot.jpg"), fakeJpeg(10, 10));
    store.putPage("public", page());
    expect(readdirSync(join(dir, "pages")).some((name) => name.startsWith(".damaged-public-"))).toBe(true);
    expect(store.removeSource("public")).toBe(1);
    expect(readdirSync(join(dir, "pages"))).toEqual([]);
  });

  it("removes one source whole and leaves a source that shares its prefix", () => {
    const store = openStore(dir);
    store.putPage("public", page({ text: "a" }));
    store.putPage("public", page({ text: "b" }));
    store.putPage("public-a", page({ text: "c" }));
    expect(store.removeSource("public")).toBe(2);
    expect(store.counts().bySource).toEqual({ "public-a": 1 });
    expect(readdirSync(join(dir, "pages")).filter((name) => name.startsWith("."))).toEqual([]);
    expect(() => store.removeSource("../x")).toThrow();
  });
});
