import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  indexRows,
  type PhreshIndex,
  phreshItem,
  readHtml,
  readShot,
} from "../../scripts/glimmer/import-phreshphish.ts";
import { lureTypeOf, scamferretItems } from "../../scripts/glimmer/import-scamferret.ts";
import { hostOf, importSource, type SourceItem } from "../../scripts/glimmer/import-source.ts";
import { openTextReader } from "../../scripts/glimmer/source-pages.ts";
import { openStore } from "../../scripts/glimmer/store.ts";
import { jpegSize } from "../../src/vision/page-screen.ts";

// The public-dataset converters (D03 T04 §5): each item becomes one page with its screenshot and text paired, its host,
// labels and provenance read back from a reopened store; IMPORT.json accounts for every item; a stopped import is
// incomplete and a rerun finishes it with no duplicate and no other source touched.
let dir: string;
let reader: Awaited<ReturnType<typeof openTextReader>>;
beforeAll(async () => {
  reader = await openTextReader();
  // The browser starts lazily on the first page; it starts here, inside the hook's 60 seconds, so no test pays
  // Chromium's start-up on a slow CI runner (three runs on 2026-10-28 timed out at 15 seconds that way).
  await reader.renderHtml("<p>start the browser before the tests</p>");
}, 60_000);
afterAll(async () => {
  await reader?.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-import-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const jpeg = async (width: number, height: number, colour = "#2a6") =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: colour } })
      .jpeg()
      .toBuffer(),
  );

describe("hostOf", () => {
  it("keeps a DNS name and drops what the request could not state", () => {
    expect(hostOf("https://Login.Example.CO.ZA/path")).toBe("login.example.co.za");
    expect(hostOf("http://192.0.2.1/x")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("ScamFerret", () => {
  it("maps categories to lure types only where the category settles it", () => {
    expect(lureTypeOf(true, "online_shopping_german")).toBe("fake_shop");
    expect(lureTypeOf(true, "technical_support")).toBe("impersonation");
    expect(lureTypeOf(true, "investment")).toBeUndefined();
    expect(lureTypeOf(false, "investment")).toBe("none");
  });

  it("imports a real screenshot and a rendered page, each read back whole", async () => {
    const dataset = join(dir, "dataset");
    const shop = join(dataset, "scam_websites", "online_shopping_english");
    mkdirSync(join(shop, "toppage_html"), { recursive: true });
    mkdirSync(join(shop, "sample_screenshot"), { recursive: true });
    writeFileSync(
      join(shop, "toppage_html", "cheap-shoes.example.html.gz"),
      gzipSync("<h1>Designer shoes 90% off today only</h1>"),
    );
    const big = await sharp({ create: { width: 2560, height: 5000, channels: 3, background: "#c33" } })
      .png()
      .toBuffer();
    writeFileSync(join(shop, "sample_screenshot", "cheap-shoes.example.png"), big);
    const legit = join(dataset, "legitimate_websites", "investment", "toppage_html");
    mkdirSync(legit, { recursive: true });
    writeFileSync(
      join(legit, "bank.example.html.gz"),
      gzipSync("<h1>Annual report for shareholders</h1><input type=password>"),
    );

    const store = openStore(join(dir, "store"));
    const result = await importSource({
      source: "scamferret",
      licence: "GPL-3.0",
      items: scamferretItems(dataset, reader),
      store,
    });
    expect(result).toMatchObject({ status: "complete", expected: 2, imported: 2, duplicates: 0, stored: 2 });
    const pages = openStore(join(dir, "store")).manifest();
    const scam = pages.find((p) => p.host === "cheap-shoes.example");
    const benign = pages.find((p) => p.host === "bank.example");
    expect(scam).toMatchObject({
      origin: "public",
      labels: { lure: true, lure_type: "fake_shop", has_login_form: false, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom" },
    });
    expect(benign).toMatchObject({ labels: { lure: false, lure_type: "none", has_login_form: true } });
    const shot = openStore(join(dir, "store")).readPage(scam?.id ?? "");
    expect(jpegSize(shot.screenshot)).toEqual({ width: 1280, height: 2000 });
    expect(shot.text).toBe("Designer shoes 90% off today only");
    expect(openStore(join(dir, "store")).readPage(benign?.id ?? "").text).toBe("Annual report for shareholders");
  });
});

describe("PhreshPhish", () => {
  it("reads rows by offset and keeps the brand a phishing page targets", async () => {
    const rows = join(dir, "rows.jsonl");
    writeFileSync(
      rows,
      [
        {
          sha256: "a1",
          url: "https://faceb00k-login.example/",
          html: "<h1>Log in to Facebook to continue</h1>",
          label: "phish",
          target: "facebook",
        },
        {
          sha256: "b2",
          url: "https://news.example/",
          html: "<h1>Today's news from the city</h1>",
          label: "benign",
          target: null,
        },
        {
          sha256: "c3",
          url: "http://198.51.100.7/",
          html: "<h1>Verify your account details now</h1>",
          label: "phish",
          target: "other",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const index = await indexRows(rows);
    expect(index.map((entry) => entry.sha256)).toEqual(["a1", "b2", "c3"]);
    expect(readHtml(rows, index[1] as (typeof index)[number])).toBe("<h1>Today's news from the city</h1>");
    const store = openStore(join(dir, "store"));
    const result = await importSource({
      source: "phreshphish",
      licence: "CC BY 4.0",
      items: index.map((entry) => phreshItem(entry, () => readHtml(rows, entry), reader)),
      store,
    });
    expect(result).toMatchObject({ status: "complete", imported: 3, stored: 3 });
    const pages = openStore(join(dir, "store")).manifest();
    expect(pages.find((p) => p.host === "faceb00k-login.example")).toMatchObject({
      labels: { lure: true, brand: "facebook" },
      label_source: { lure: "ground-truth", brand: "ground-truth" },
    });
    const ip = pages.find((p) => p.host === null);
    expect(ip?.labels.brand).toBeUndefined();
    expect(ip?.labels.lure_type).toBeUndefined();
  });
});

describe("rows with the dataset's own screenshot", () => {
  it("store the real capture, while the HTML still gives the text and form flags", async () => {
    const rows = join(dir, "rows.jsonl");
    const capture = await sharp({ create: { width: 1366, height: 3000, channels: 3, background: "#1877f2" } })
      .jpeg()
      .toBuffer();
    writeFileSync(
      rows,
      `${JSON.stringify({ sha256: "7dl-1", url: "https://fb-verify.example/", html: "<p>Log in to Facebook to keep your page</p><input type=password>", label: "phish", target: null, screenshot: capture.toString("base64") })}\n`,
    );
    const [entry] = await indexRows(rows);
    expect(entry).toMatchObject({ sha256: "7dl-1", shot: true });
    expect(entry).not.toHaveProperty("screenshot");
    const store = openStore(join(dir, "store"));
    const result = await importSource({
      source: "7-days-later",
      licence: "CC BY 4.0",
      items: [
        phreshItem(
          entry as PhreshIndex,
          () => readHtml(rows, entry as PhreshIndex),
          reader,
          () => readShot(rows, entry as PhreshIndex),
        ),
      ],
      store,
    });
    expect(result).toMatchObject({ status: "complete", imported: 1 });
    const [page] = store.manifest();
    expect(page?.labels).toMatchObject({ lure: true, has_login_form: true });
    const stored = store.readPage(page?.id ?? "");
    // The capture, scaled to 1280 wide and cut to 2000 tall: not the inert render's 1280 by 2000 white page.
    expect(jpegSize(stored.screenshot)).toEqual({ width: 1280, height: 2000 });
    const { dominant } = await sharp(stored.screenshot).stats();
    expect(dominant.b).toBeGreaterThan(200);
    expect(stored.text).toBe("Log in to Facebook to keep your page");
  });
});

describe("PhreshPhish rows", () => {
  it("ends a row only at a newline byte, never at U+2028 or U+2029 inside its HTML", async () => {
    const rows = join(dir, "rows.jsonl");
    const html = "<p>first\u2028second\u2029third</p>";
    writeFileSync(
      rows,
      `${JSON.stringify({ sha256: "x1", url: null, html, label: "benign", target: null })}\n${JSON.stringify({ sha256: "x2", url: null, html: "<p>é</p>", label: "phish", target: "bank" })}\n`,
    );
    const index = await indexRows(rows);
    expect(index.map((entry) => entry.sha256)).toEqual(["x1", "x2"]);
    expect(readHtml(rows, index[0] as (typeof index)[number])).toBe(html);
    expect(readHtml(rows, index[1] as (typeof index)[number])).toBe("<p>é</p>");
  });
});

describe("PhreshPhish rows, bounded and pinned", () => {
  it("excludes a row over 25 MB without parsing it, and imports the rest", async () => {
    const rows = join(dir, "rows.jsonl");
    const small = JSON.stringify({
      sha256: "s1",
      url: null,
      html: "<p>An ordinary benign page with words</p>",
      label: "benign",
      target: null,
    });
    const huge = JSON.stringify({
      sha256: "h1",
      url: null,
      html: `<p>${"x".repeat(26 * 1024 * 1024)}</p>`,
      label: "phish",
      target: null,
    });
    writeFileSync(rows, `${small}\n${huge}\n`);
    const index = await indexRows(rows);
    expect(index.map((e) => [e.sha256, Boolean(e.oversized)])).toEqual([
      ["s1", false],
      ["row-2", true],
    ]);
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: index.map((entry) => phreshItem(entry, () => readHtml(rows, entry), reader)),
      store: openStore(join(dir, "store")),
    });
    expect(result.excluded).toEqual([{ item: "row-2", reason: "the row is over 25 MB" }]);
    expect(result.imported).toBe(1);
  }, 60_000);

  it("refuses to read a rows file swapped in after it was indexed", async () => {
    const rows = join(dir, "rows.jsonl");
    const line = (id: string, label: string) =>
      JSON.stringify({ sha256: id, url: null, html: `<p>${id} page text</p>`, label, target: null });
    writeFileSync(rows, `${line("a", "phish")}\n`);
    const [entry] = await indexRows(rows);
    writeFileSync(`${rows}.new`, `${line("b", "benign")}\n`);
    renameSync(`${rows}.new`, rows);
    expect(() => readHtml(rows, entry as PhreshIndex)).toThrow(/changed since it was indexed/);
  });
});

describe("the import run", () => {
  const item = (id: string, colour: string, fail = false): SourceItem => ({
    id,
    url: `https://${id}.example/`,
    labels: { lure: false, lure_type: "none" },
    label_source: { lure: "ground-truth", lure_type: "ground-truth" },
    load: async () => {
      if (fail) throw new Error("image does not decode");
      return { screenshot: await jpeg(320, 200, colour), text: `the visible text of page ${id}` };
    },
  });

  it("excludes a page that renders almost no text", async () => {
    const empty: SourceItem = {
      ...item("blank", "#333"),
      load: async () => ({ screenshot: await jpeg(64, 64), text: " " }),
    };
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [
        empty,
        ...Array.from({ length: 20 }, (_, i) => item(`page-${i}`, `#${(i * 7 + 16).toString(16).padStart(3, "0")}`)),
      ],
      store: openStore(join(dir, "store")),
    });
    expect(result.filtered).toEqual([{ item: "blank", reason: "renders under 20 characters of text" }]);
    expect(result.excluded).toEqual([]);
    expect(result.status).toBe("complete");
  });

  it("keeps a source complete when only filtered pages pass 5 percent", async () => {
    const blank = (id: string): SourceItem => ({
      ...item(id, "#444"),
      load: async () => ({ screenshot: await jpeg(64, 64), text: "" }),
    });
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("kept", "#555"), blank("x"), blank("y")],
      store: openStore(join(dir, "store")),
    });
    expect(result).toMatchObject({ status: "complete", imported: 1 });
    expect(result.filtered).toHaveLength(2);
  });

  it("renders a damaged stored page again on resume, and the store repairs it", async () => {
    const storeDir = join(dir, "store");
    await importSource({ source: "set", licence: "CC0", items: [item("fixme", "#303")], store: openStore(storeDir) });
    const [stored] = openStore(storeDir).manifest();
    writeFileSync(join(storeDir, "pages", stored?.id ?? "", "screenshot.jpg"), "truncated");
    let loads = 0;
    const again = { ...item("fixme", "#303"), load: () => (loads++, item("fixme", "#303").load()) };
    const rerun = await importSource({ source: "set", licence: "CC0", items: [again], store: openStore(storeDir) });
    expect(loads).toBe(1);
    expect(rerun).toMatchObject({ status: "complete", skipped: 0 });
    expect(openStore(storeDir).verify().damaged).toEqual([]);
  });

  it("stays incomplete while a damaged page could not be repaired", async () => {
    const storeDir = join(dir, "store");
    const many = Array.from({ length: 20 }, (_, i) => item(`p${i}`, `#${(i * 11 + 16).toString(16).padStart(3, "0")}`));
    await importSource({ source: "set", licence: "CC0", items: many, store: openStore(storeDir) });
    const [first] = openStore(storeDir).manifest();
    writeFileSync(join(storeDir, "pages", first?.id ?? "", "screenshot.jpg"), "truncated");
    // The damaged page's item now fails to render: one exclusion, under 5 percent, yet the import must not read complete.
    const failing = many.map((it) =>
      it.id === first?.item ? { ...it, load: async () => Promise.reject(new Error("render failed")) } : it,
    );
    const rerun = await importSource({ source: "set", licence: "CC0", items: failing, store: openStore(storeDir) });
    expect(rerun.status).toBe("incomplete");
    expect(rerun.reason).toBe("1 damaged pages remain in the store");
  });

  it("repairs a page whose meta.json no longer reads, instead of failing on it", async () => {
    const storeDir = join(dir, "store");
    await importSource({ source: "set", licence: "CC0", items: [item("meta", "#404")], store: openStore(storeDir) });
    const [stored] = openStore(storeDir).manifest();
    writeFileSync(join(storeDir, "pages", stored?.id ?? "", "meta.json"), "{ truncated");
    const rerun = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("meta", "#404")],
      store: openStore(storeDir),
    });
    expect(rerun).toMatchObject({ status: "complete", imported: 1 });
    expect(openStore(storeDir).verify().damaged).toEqual([]);
    expect(openStore(storeDir).manifest()).toHaveLength(1);
  });

  it("finishes its own accounting when another source has a page whose meta.json no longer reads", async () => {
    const storeDir = join(dir, "store");
    await importSource({ source: "other", licence: "CC0", items: [item("o1", "#505")], store: openStore(storeDir) });
    const [other] = openStore(storeDir).manifest();
    writeFileSync(join(storeDir, "pages", other?.id ?? "", "meta.json"), "{ broken");
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("s1", "#606")],
      store: openStore(storeDir),
    });
    expect(result).toMatchObject({ status: "complete", imported: 1, stored: 1 });
  });

  it("stays incomplete while the store holds a page whose item the dataset dropped", async () => {
    const storeDir = join(dir, "store");
    await importSource({
      source: "set",
      licence: "CC0",
      items: [item("a1", "#111"), item("b2", "#222")],
      store: openStore(storeDir),
    });
    const again = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("a1", "#111")],
      store: openStore(storeDir),
    });
    expect(again).toMatchObject({
      status: "incomplete",
      reason: "1 stored pages are not in the dataset any more; remove them",
    });
  });

  it("gives a stored page a changed label or licence mapping on resume, without rendering it again", async () => {
    const storeDir = join(dir, "store");
    await importSource({ source: "set", licence: "CC0", items: [item("m1", "#121")], store: openStore(storeDir) });
    let loads = 0;
    const remapped: SourceItem = {
      ...item("m1", "#121"),
      labels: { lure: true, lure_type: "fake_shop" },
      load: () => (loads++, item("m1", "#121").load()),
    };
    const rerun = await importSource({
      source: "set",
      licence: "CC BY 4.0",
      items: [remapped],
      store: openStore(storeDir),
    });
    expect(loads).toBe(0);
    expect(rerun).toMatchObject({ status: "complete", skipped: 1, relabelled: 1 });
    const [stored] = openStore(storeDir).manifest();
    expect(stored).toMatchObject({ licence: "CC BY 4.0", labels: { lure: true, lure_type: "fake_shop" } });
  });

  it("turns a load that never settles into an exclusion, and the other items still import", async () => {
    const stuck: SourceItem = { ...item("stuck", "#707"), load: () => new Promise(() => undefined) };
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [
        stuck,
        ...Array.from({ length: 25 }, (_, i) => item(`ok${i}`, `#${(i * 13 + 32).toString(16).padStart(3, "0")}`)),
      ],
      store: openStore(join(dir, "store")),
      // Room for a normal item's load on a busy runner (0.3 seconds excluded one in CI, 2026-10-29); the stuck one
      // still meets the deadline, since it never settles at all.
      itemMs: 3000,
      concurrency: 2,
    });
    expect(result.excluded).toEqual([{ item: "stuck", reason: "the item did not load within 3 seconds" }]);
    expect(result).toMatchObject({ status: "complete", imported: 25 });
  }, 20_000);

  it("says running before the first page, so a killed run never leaves an earlier complete standing", async () => {
    const storeDir = join(dir, "store");
    const record = join(storeDir, "raw", "set", "IMPORT.json");
    await importSource({ source: "set", licence: "CC0", items: [item("first", "#101")], store: openStore(storeDir) });
    expect(JSON.parse(readFileSync(record, "utf-8")).status).toBe("complete");
    let seen = "";
    const watching: SourceItem = {
      ...item("second", "#202"),
      load: async () => {
        seen = JSON.parse(readFileSync(record, "utf-8")).status;
        throw new Error("killed");
      },
    };
    await importSource({ source: "set", licence: "CC0", items: [watching], store: openStore(storeDir) });
    expect(seen).toBe("running");
  });

  it("excludes a row whose label is neither phish nor benign, and imports the rest", async () => {
    const odd = phreshItem({ sha256: "z9", url: null, label: "maybe", target: null }, () => "<p>x</p>", reader);
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [
        odd,
        ...Array.from({ length: 20 }, (_, i) => item(`ok-${i}`, `#${(i * 9 + 16).toString(16).padStart(3, "0")}`)),
      ],
      store: openStore(join(dir, "store")),
    });
    expect(result.excluded).toEqual([{ item: "z9", reason: 'label "maybe" is neither phish nor benign' }]);
    expect(result.imported).toBe(20);
  });

  it("records exclusions and goes incomplete past 5 percent", async () => {
    const store = openStore(join(dir, "store"));
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("a", "#111"), item("b", "#222", true)],
      store,
    });
    expect(result.status).toBe("incomplete");
    expect(result.excluded).toEqual([{ item: "b", reason: "image does not decode" }]);
    const saved = JSON.parse(readFileSync(join(dir, "store", "raw", "set", "IMPORT.json"), "utf-8"));
    expect(saved.excluded).toHaveLength(1);
  });

  it("stops on a store write failure, and a rerun finishes it with no duplicate and another source untouched", async () => {
    const storeDir = join(dir, "store");
    const other = openStore(storeDir);
    await other.putPage("other", {
      screenshot: await jpeg(100, 100, "#999"),
      text: "other",
      origin: "public",
      licence: "CC0",
      host: null,
      template: null,
      south_africa: false,
      labels: {},
      label_source: {},
      redacted: false,
    });
    let writes = 0;
    const failing = openStore(storeDir, {
      write: (path, data) => {
        if (++writes > 3) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        writeFileSync(path, data);
      },
    });
    const items = [item("one", "#123"), item("two", "#456"), item("three", "#789")];
    const stopped = await importSource({ source: "set", licence: "CC0", items, store: failing, concurrency: 1 });
    expect(stopped.status).toBe("incomplete");
    expect(stopped.reason).toContain("ENOSPC");
    expect(stopped.imported).toBe(1);
    let loads = 0;
    const counted = items.map((it) => ({ ...it, load: () => (loads++, it.load()) }));
    const rerun = await importSource({ source: "set", licence: "CC0", items: counted, store: openStore(storeDir) });
    // The page already stored is skipped by its item id, never rendered again.
    expect(rerun).toMatchObject({ status: "complete", imported: 2, duplicates: 0, skipped: 1, stored: 3 });
    expect(loads).toBe(2);
    expect(
      openStore(storeDir)
        .manifest()
        .filter((p) => p.source === "set")
        .map((p) => p.item)
        .sort(),
    ).toEqual(["one", "three", "two"]);
    expect(openStore(storeDir).counts().bySource).toEqual({ other: 1, set: 3 });
  });
});
