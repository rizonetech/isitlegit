import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indexRows, phreshItem, readHtml } from "../../scripts/glimmer/import-phreshphish.ts";
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
    writeFileSync(join(shop, "toppage_html", "cheap-shoes.example.html.gz"), gzipSync("<h1>Shoes 90% off</h1>"));
    const big = await sharp({ create: { width: 2560, height: 5000, channels: 3, background: "#c33" } })
      .png()
      .toBuffer();
    writeFileSync(join(shop, "sample_screenshot", "cheap-shoes.example.png"), big);
    const legit = join(dataset, "legitimate_websites", "investment", "toppage_html");
    mkdirSync(legit, { recursive: true });
    writeFileSync(join(legit, "bank.example.html.gz"), gzipSync("<h1>Annual report</h1><input type=password>"));

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
    expect(shot.text).toBe("Shoes 90% off");
    expect(openStore(join(dir, "store")).readPage(benign?.id ?? "").text).toBe("Annual report");
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
          html: "<h1>Log in to Facebook</h1>",
          label: "phish",
          target: "facebook",
        },
        { sha256: "b2", url: "https://news.example/", html: "<h1>Today's news</h1>", label: "benign", target: null },
        { sha256: "c3", url: "http://198.51.100.7/", html: "<h1>Verify</h1>", label: "phish", target: "other" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const index = await indexRows(rows);
    expect(index.map((entry) => entry.sha256)).toEqual(["a1", "b2", "c3"]);
    expect(readHtml(rows, index[1] as (typeof index)[number])).toBe("<h1>Today's news</h1>");
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

describe("the import run", () => {
  const item = (id: string, colour: string, fail = false): SourceItem => ({
    id,
    url: `https://${id}.example/`,
    labels: { lure: false, lure_type: "none" },
    label_source: { lure: "ground-truth", lure_type: "ground-truth" },
    load: async () => {
      if (fail) throw new Error("image does not decode");
      return { screenshot: await jpeg(320, 200, colour), text: id };
    },
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
    const rerun = await importSource({ source: "set", licence: "CC0", items, store: openStore(storeDir) });
    expect(rerun).toMatchObject({ status: "complete", imported: 2, duplicates: 1, stored: 3 });
    expect(openStore(storeDir).counts().bySource).toEqual({ other: 1, set: 3 });
  });
});
