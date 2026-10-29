import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openStore, type PageInput, type StoredPage, storeDir } from "../../scripts/glimmer/store.ts";
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

  it("keeps an unverified label as unverified", async () => {
    const store = openStore(dir);
    await store.putPage(
      "public-x",
      page({
        labels: { lure: true, lure_type: "credential" },
        label_source: { lure: "unverified", lure_type: "unverified" },
      }),
    );
    expect(openStore(dir).manifest()[0]?.label_source).toEqual({ lure: "unverified", lure_type: "unverified" });
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
    expect(store.verify()).toEqual({ intact: 1, damaged: [], setAside: [] });
    writeFileSync(join(dir, "pages", id, "screenshot.jpg"), fakeJpeg(10, 10));
    expect(store.verify()).toEqual({ intact: 0, damaged: [id], setAside: [] });
    expect(await store.putPage("s", page())).toBe(id);
    // The damaged copy is set aside, and counted, so repairs never pile copies up unseen.
    const after = store.verify();
    expect(after).toMatchObject({ intact: 1, damaged: [] });
    expect(after.setAside).toHaveLength(1);
    expect(after.setAside[0]?.startsWith(`.damaged-${id}-`)).toBe(true);
    expect(store.verify("s").setAside).toHaveLength(1);
    expect(store.verify("other").setAside).toHaveLength(0);
  });

  it("refuses a huge screenshot from its header, before decoding a pixel", async () => {
    // A 16000 by 16000 image would need 768 MB to decode (round 3); the header says so first.
    const store = openStore(dir);
    await expect(store.putPage("s", page({ screenshot: fakeJpeg(16000, 16000, 8) }))).rejects.toThrow(
      "the screenshot is 16000 by 16000",
    );
  });

  it("flushes the parent of every folder the first page creates", async () => {
    const root = join(dir, "new", "store");
    const flushed: string[] = [];
    const store = openStore(root, { sync: (path) => flushed.push(path) });
    const id = await store.putPage("s", page());
    for (const parent of [dir, join(dir, "new"), root]) expect(flushed, parent).toContain(parent);
    // The folders are on disk before the page's publication is flushed.
    expect(flushed.indexOf(root)).toBeLessThan(flushed.lastIndexOf(join(root, "pages")));
    expect(openStore(root).readPage(id).text).toBe(page().text);
  });

  it("flushes again on a retry the parent of a folder whose first flush failed", async () => {
    // Round 4: the store folder was created, its parent's flush failed, and a retry saw the folder and moved on.
    const root = join(dir, "data", "glimmer");
    let failing = true;
    const flushed: string[] = [];
    const store = openStore(root, {
      sync: (path) => {
        flushed.push(path);
        if (failing && path === join(dir, "data")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
    });
    await expect(store.putPage("s", page())).rejects.toThrow("EIO");
    expect(existsSync(root)).toBe(true);
    failing = false;
    flushed.length = 0;
    await store.putPage("s", page());
    expect(flushed).toContain(join(dir, "data"));
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

  it("reads a page only when both its files match their hashes", async () => {
    const store = openStore(dir);
    const whole = await store.putPage("public", page({ text: "whole" }));
    const altered = await store.putPage("public", page({ text: "to alter" }));
    const swapped = await store.putPage("public", page({ text: "to swap" }));
    const malformed = await store.putPage("public", page({ text: "to break" }));
    expect(store.readVerifiedPage(whole)?.text).toBe("whole");
    writeFileSync(join(dir, "pages", altered, "text.txt"), "altered");
    // A valid JPEG, but not the one recorded.
    writeFileSync(join(dir, "pages", swapped, "screenshot.jpg"), fakeJpeg(12, 12));
    writeFileSync(join(dir, "pages", malformed, "meta.json"), "{ not json");
    for (const id of [altered, swapped, malformed, "public-0000000000000000"])
      expect(store.readVerifiedPage(id), id).toBeNull();
  });

  it("removes one page and leaves the rest", async () => {
    const store = openStore(dir);
    const gone = await store.putPage("public", page({ text: "a" }));
    await store.putPage("public", page({ text: "b" }));
    expect(store.removePage(gone)).toBe(true);
    expect(store.removePage(gone)).toBe(false);
    expect(store.counts().bySource).toEqual({ public: 1 });
    expect(readdirSync(join(dir, "pages")).filter((name) => name.startsWith("."))).toEqual([]);
    for (const bad of ["../x", "public", ".removing-public-0123456789abcdef"])
      expect(() => store.removePage(bad)).toThrow();
  });

  it("makes a page's removal durable before deleting it, and finishes a stopped removal on the next open", async () => {
    let failing = false;
    const seen: boolean[] = [];
    const store = openStore(dir, {
      sync: (path) => {
        if (path !== join(dir, "pages")) return;
        // At the parent's flush the renamed folder is still there: the delete comes after it.
        seen.push(readdirSync(path).some((name) => name.startsWith(".removing-")));
        if (failing) throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
    });
    const kept = await store.putPage("public", page({ text: "kept" }));
    const first = await store.putPage("public", page({ text: "first" }));
    seen.length = 0;
    expect(store.removePage(first)).toBe(true);
    expect(seen).toEqual([true]);
    // A failed flush: the page is out of view, renamed, never half deleted; the other page is whole.
    const second = await store.putPage("public", page({ text: "second" }));
    failing = true;
    expect(() => store.removePage(second)).toThrow("EIO");
    failing = false;
    expect(store.manifest().map((p) => p.id)).toEqual([kept]);
    const left = readdirSync(join(dir, "pages")).filter((name) => name.startsWith(".removing-"));
    expect(left).toEqual([`.removing-${second}-${process.pid}`]);
    // Its process gone (a stop), the next open finishes the removal.
    renameSync(join(dir, "pages", left[0] as string), join(dir, "pages", `.removing-${second}-999999999`));
    const reopened = openStore(dir);
    expect(readdirSync(join(dir, "pages"))).toEqual([kept]);
    expect(reopened.verify().damaged).toEqual([]);
  });

  it("makes a stopped removal's rename durable before an open deletes it", async () => {
    const id = await openStore(dir).putPage("public", page({ text: "going" }));
    renameSync(join(dir, "pages", id), join(dir, "pages", `.removing-${id}-999999999`));
    const order: string[] = [];
    openStore(dir, {
      sync: (path) => {
        order.push(`sync ${path}`);
        order.push(`present ${readdirSync(join(dir, "pages")).some((name) => name.startsWith(".removing-"))}`);
      },
    });
    expect(order.slice(0, 2)).toEqual([`sync ${join(dir, "pages")}`, "present true"]);
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

describe("setLabels and the lure-type rule (D03 T04 §9)", () => {
  it("replaces one page's labels whole, refuses an invalid record, and derives a lure's type from its forms", async () => {
    const { applyRules, derivedLureType } = await import("../../scripts/glimmer/label-rules.ts");
    const dir = mkdtempSync(join(tmpdir(), "glimmer-labels-"));
    try {
      const store = openStore(dir);
      const shot = new Uint8Array(
        await sharp({ create: { width: 32, height: 32, channels: 3, background: "#fff" } })
          .jpeg()
          .toBuffer(),
      );
      const base = {
        origin: "public" as const,
        licence: "CC0",
        host: null,
        template: null,
        south_africa: false,
        redacted: false,
      };
      const put = (text: string, labels: Record<string, unknown>) =>
        store.putPage("set", {
          ...base,
          screenshot: shot,
          text,
          labels,
          label_source: Object.fromEntries(
            Object.keys(labels).map((k) => [k, k.startsWith("has_") ? "dom" : "ground-truth"]),
          ),
        } as Parameters<typeof store.putPage>[1]);
      const login = await put("login lure", { lure: true, has_login_form: true, has_payment_form: false });
      const card = await put("card lure", { lure: true, has_login_form: true, has_payment_form: true });
      const plain = await put("lookalike", { lure: true, has_login_form: false, has_payment_form: false });
      const shop = await put("shop", {
        lure: true,
        lure_type: "fake_shop",
        has_login_form: false,
        has_payment_form: false,
      });
      const benign = await put("benign", {
        lure: false,
        lure_type: "none",
        has_login_form: false,
        has_payment_form: false,
      });
      const counts = applyRules(store);
      expect(counts).toMatchObject({ credential: 1, payment: 1, impersonation: 1 });
      const byId = new Map(
        openStore(dir)
          .manifest()
          .map((p) => [p.id, p]),
      );
      expect(byId.get(login)?.labels.lure_type).toBe("credential");
      expect(byId.get(login)?.label_source.lure_type).toBe("rule");
      expect(byId.get(card)?.labels.lure_type).toBe("payment");
      expect(byId.get(plain)?.labels.lure_type).toBe("impersonation");
      expect(byId.get(shop)?.label_source.lure_type).toBe("ground-truth");
      expect(derivedLureType(byId.get(benign) as never)).toBeNull();
      // A benign page without a type is completed as none.
      expect(derivedLureType({ labels: { lure: false } } as never)).toBe("none");
      expect(() => store.setLabels(login, { lure: true }, { lure: "ground-truth", lure_type: "rule" })).toThrow();
      expect(openStore(dir).verify().damaged).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the brand rule (D03 T04 §9)", () => {
  it("names a lure's brand from its text, a real page's from its host, and none otherwise", async () => {
    const { derivedBrand } = await import("../../scripts/glimmer/label-rules.ts");
    const page = (labels: Record<string, unknown>, host: string | null = null) =>
      ({ id: "x", host, labels, label_source: {} }) as never;
    expect(derivedBrand(page({ lure: true }), "Sign in to your Microsoft 365 account")).toBe("Microsoft 365");
    expect(derivedBrand(page({ lure: true }), "Verify your FNB online banking")).toBe("FNB");
    expect(derivedBrand(page({ lure: true }), "Designer shoes 90% off today")).toBeNull();
    expect(derivedBrand(page({ lure: true }), "Welcome to Metamorphosis")).toBeNull();
    expect(derivedBrand(page({ lure: false }, "en.wikipedia.org"), "")).toBe("wikipedia");
    expect(derivedBrand(page({ lure: true, brand: "PayPal" }), "Amazon")).toBeUndefined();
  });

  it("gives one brand one name across spellings and hosts, and skips sign-in buttons and everyday words", async () => {
    const { canonicalBrand, derivedBrand } = await import("../../scripts/glimmer/label-rules.ts");
    const page = (labels: Record<string, unknown>, host: string | null = null) =>
      ({ id: "x", host, labels, label_source: {} }) as never;
    // A real page's host and a lure's text meet on one name.
    expect(derivedBrand(page({ lure: false }, "www.standardbank.co.za"), "")).toBe("Standard Bank");
    expect(derivedBrand(page({ lure: true }), "Standard Bank Internet Banking: verify now")).toBe("Standard Bank");
    for (const alias of ["standardbank", "Standard Bank Group", "STANDARD BANK"])
      expect(canonicalBrand(alias)).toBe("Standard Bank");
    expect(canonicalBrand("First National Bank")).toBe("FNB");
    // A South African brand our list names, outside KNOWN_BRANDS, is found in a lure's text.
    expect(derivedBrand(page({ lure: true }), "Your Capitec app needs updating")).toBe("Capitec");
    // Another service's sign-in button is not the page's brand; the brand beside it is.
    expect(derivedBrand(page({ lure: true }), "Sign in with Google to view the invoice")).toBeNull();
    expect(derivedBrand(page({ lure: true }), "Continue with Apple. Takealot order 4411 on hold")).toBe("Takealot");
    // An everyday word that is also a listed brand does not make a brand.
    expect(derivedBrand(page({ lure: true }), "Game over: Clicks and Rain")).toBeNull();
    // A brand named by its domain meets its host's stem.
    expect(derivedBrand(page({ lure: false }, "www.booking.com"), "")).toBe("Booking.com");
    expect(canonicalBrand("booking")).toBe(canonicalBrand("Booking.com"));
    // An unknown name stays as given.
    expect(canonicalBrand("  Metamorphosis ")).toBe("Metamorphosis");
    // Any case of a several-word name or long form, and a one-word name in capitals.
    for (const text of ["STANDARD BANK online", "your standard bank card", "Standard Bank Group plc"])
      expect(derivedBrand(page({ lure: true }), text), text).toBe("Standard Bank");
    expect(derivedBrand(page({ lure: true }), "First National Bank: verify")).toBe("FNB");
    expect(derivedBrand(page({ lure: true }), "ABSA secure login")).toBe("Absa");
    // A one-word brand in lower case is a word ("a travel visa").
    expect(derivedBrand(page({ lure: true }), "apply for a travel visa today")).toBeNull();
    // A brand a rule set earlier is set again as the rule now reads it; a source's own brand is never touched.
    const ruled = {
      id: "x",
      host: null,
      labels: { lure: true, brand: null },
      label_source: { brand: "rule" },
    } as never;
    expect(derivedBrand(ruled, "STANDARD BANK")).toBe("Standard Bank");
    const sourced = {
      id: "x",
      host: null,
      labels: { lure: true, brand: "Std" },
      label_source: { brand: "ground-truth" },
    };
    expect(derivedBrand(sourced as never, "STANDARD BANK")).toBeUndefined();
    const same = {
      id: "x",
      host: null,
      labels: { lure: true, brand: "Absa" },
      label_source: { brand: "rule" },
    } as never;
    expect(derivedBrand(same, "ABSA login")).toBeUndefined();
  });
});

describe("every page's terminal outcome (D03 T04 §9)", () => {
  it("leaves every page complete or excluded with its reason, damaged and malformed pages included", async () => {
    const { applyRules, readExcluded } = await import("../../scripts/glimmer/label-rules.ts");
    const dir = mkdtempSync(join(tmpdir(), "glimmer-outcome-"));
    try {
      const store = openStore(dir);
      const shot = (n: number) =>
        sharp({ create: { width: 16 + n, height: 16, channels: 3, background: "#fff" } })
          .jpeg()
          .toBuffer()
          .then((b) => new Uint8Array(b));
      const put = async (n: number, labels: Record<string, unknown>) =>
        store.putPage("set", {
          origin: "public",
          licence: "CC0",
          host: null,
          template: null,
          south_africa: false,
          redacted: false,
          screenshot: await shot(n),
          text: `page ${n}`,
          labels,
          label_source: Object.fromEntries(Object.keys(labels).map((k) => [k, "ground-truth"])),
        } as Parameters<typeof store.putPage>[1]);
      const benign = await put(1, { lure: false, has_login_form: false, has_payment_form: false });
      const nolure = await put(2, { has_login_form: false, has_payment_form: false });
      const contradict = await put(3, {
        lure: true,
        lure_type: "none",
        has_login_form: false,
        has_payment_form: false,
      });
      const noforms = await put(4, { lure: true });
      const damaged = await put(5, { lure: false, has_login_form: false, has_payment_form: false });
      const malformed = await put(6, { lure: false, has_login_form: false, has_payment_form: false });
      writeFileSync(join(dir, "pages", damaged, "text.txt"), "altered");
      writeFileSync(join(dir, "pages", malformed, "meta.json"), "{");
      applyRules(store);
      const excluded = readExcluded(dir);
      expect([...excluded.keys()].sort()).toEqual([nolure, contradict, noforms, damaged, malformed].sort());
      expect(excluded.get(contradict)).toMatch(/contradict/);
      expect(excluded.get(noforms)).toMatch(/missing has_login_form, has_payment_form/);
      const after = openStore(dir).readVerifiedPage(benign)?.page;
      expect(after?.labels).toMatchObject({ lure: false, lure_type: "none", brand: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a publisher's label on its capture (D03 T04 §18)", () => {
  it("excludes a capture of something else, a text two sources label oppositely, and distrusts an inert copy's false flags", async () => {
    const { applyRules, readExcluded } = await import("../../scripts/glimmer/label-rules.ts");
    const dir = mkdtempSync(join(tmpdir(), "glimmer-capture-"));
    try {
      const store = openStore(dir);
      let n = 0;
      const put = async (source: string, text: string, labels: Record<string, unknown>) =>
        store.putPage(source, {
          origin: "public",
          licence: "CC0",
          host: null,
          template: null,
          south_africa: false,
          redacted: false,
          screenshot: new Uint8Array(
            await sharp({ create: { width: 16 + n++, height: 16, channels: 3, background: "#fff" } })
              .jpeg()
              .toBuffer(),
          ),
          text,
          labels,
          label_source: Object.fromEntries(
            Object.keys(labels).map((k) => [k, k.startsWith("has_") ? "dom" : "ground-truth"]),
          ),
        } as Parameters<typeof store.putPage>[1]);
      const lure = { lure: true, has_login_form: true, has_payment_form: false };
      const parked = await put("set", "This domain is for sale. Buy this domain today.", lure);
      const takedown = await put("set", "This phishing site has been taken down by the host.", lure);
      const missing = await put("set", "404 Not Found: the page you were looking for", lure);
      const wall = await put("set", "Are you a human? Press & Hold", lure);
      const fine = await put("set", "Sign in to your bank", lure);
      // One text, two sources, opposite labels.
      const a = await put("set-a", "Welcome back to Example", lure);
      const b = await put("set-b", "Welcome back to Example", {
        lure: false,
        has_login_form: true,
        has_payment_form: false,
      });
      // An inert copy beside a live screenshot: a false flag is untrusted, a true one stands.
      const live = await put("7-days-later", "Verify your account", {
        lure: true,
        has_login_form: false,
        has_payment_form: true,
      });
      applyRules(store);
      const excluded = readExcluded(dir);
      expect(excluded.get(parked)).toMatch(/parked, suspended or taken-down/);
      expect(excluded.get(takedown)).toMatch(/parked, suspended or taken-down/);
      expect(excluded.get(missing)).toMatch(/an error page/);
      expect(excluded.get(wall)).toMatch(/a bot challenge/);
      // A wall named only in the render's title is a wall too, as the renderer reads it.
      const { captureProblem } = await import("../../scripts/glimmer/label-rules.ts");
      expect(captureProblem("Welcome", { title: "Just a moment...", overlays: "" })).toBe("a bot challenge");
      expect(excluded.has(fine)).toBe(false);
      for (const id of [a, b]) expect(excluded.get(id)).toMatch(/labelled a lure by one source and not by another/);
      const sources = openStore(dir).readVerifiedPage(live)?.page.label_source;
      expect(sources).toMatchObject({ has_login_form: "unverified", has_payment_form: "dom" });
      // Both flags false off the inert copy: the derived type rests on them, so it is no better than unverified, and
      // a type an earlier run derived as `rule` is marked so too (§9 final review).
      const bare = await put("7-days-later", "Account notice", {
        lure: true,
        has_login_form: false,
        has_payment_form: false,
      });
      const earlier = await put("7-days-later", "Older notice", {
        lure: true,
        lure_type: "impersonation",
        has_login_form: false,
        has_payment_form: false,
      });
      store.setLabels(
        earlier,
        { lure: true, lure_type: "impersonation", has_login_form: false, has_payment_form: false },
        {
          lure: "ground-truth",
          lure_type: "rule",
          has_login_form: "dom",
          has_payment_form: "dom",
        },
      );
      applyRules(store);
      for (const id of [bare, earlier])
        expect(openStore(dir).readVerifiedPage(id)?.page).toMatchObject({
          labels: { lure_type: "impersonation" },
          label_source: { lure_type: "unverified" },
        });
      const { answerOf } = await import("../../scripts/glimmer/build-dataset.ts");
      const page = openStore(dir).readVerifiedPage(bare)?.page as StoredPage;
      expect(answerOf({ ...page, labels: { ...page.labels, brand: null } })?.confidence).toBe(0.7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
