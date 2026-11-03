import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  indexRows,
  type PhreshIndex,
  phreshItem,
  readHtml,
  readShot,
} from "../../scripts/glimmer/import-phreshphish.ts";
import { importScamferret, lureTypeOf, scamferretItems } from "../../scripts/glimmer/import-scamferret.ts";
import {
  exportBinding,
  fileSha256,
  hostOf,
  importSource,
  type SourceItem,
} from "../../scripts/glimmer/import-source.ts";
import { applyRules, itemConflict, readExcluded } from "../../scripts/glimmer/label-rules.ts";
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
    const big = await sharp({ create: { width: 2560, height: 5000, channels: 3, background: "#c33" } })
      .png()
      .toBuffer();
    // The rows scripts/glimmer/scamferret_rows.py writes from the archive: the item id is `<class>/<category>/<file>`.
    const rowsFile = join(dir, "rows.jsonl");
    writeFileSync(
      rowsFile,
      `${[
        {
          sha256: "scam_websites/online_shopping_english/cheap-shoes.example.html.gz",
          url: "https://cheap-shoes.example/",
          html: "<h1>Designer shoes 90% off today only</h1>",
          label: "phish",
          target: null,
          category: "online_shopping_english",
          screenshot: big.toString("base64"),
        },
        {
          sha256: "scam_websites/cryptocurrency/coin-yield.example.html.gz",
          url: "https://coin-yield.example/",
          html: "<h1>Guaranteed daily returns on your coins</h1>",
          label: "phish",
          target: null,
          category: "cryptocurrency",
        },
        {
          sha256: "legitimate_websites/investment/bank.example.html.gz",
          url: "https://bank.example/",
          html: "<h1>Annual report for shareholders</h1><input type=password>",
          label: "benign",
          target: null,
          category: "investment",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const itemsOf = async () => scamferretItems(rowsFile, await indexRows(rowsFile), reader);

    const store = openStore(join(dir, "store"));
    const result = await importSource({
      source: "scamferret",
      licence: "GPL-3.0",
      items: await itemsOf(),
      store,
    });
    expect(result).toMatchObject({ status: "complete", expected: 3, imported: 3, duplicates: 0, stored: 3 });
    const pages = openStore(join(dir, "store")).manifest();
    const scam = pages.find((p) => p.host === "cheap-shoes.example");
    const benign = pages.find((p) => p.host === "bank.example");
    expect(scam).toMatchObject({
      origin: "public",
      labels: { lure: true, lure_type: "fake_shop", has_login_form: false, has_payment_form: false },
      // Its screenshot is the dataset's live capture, its flags the inert HTML's: a false flag is untrusted (§18 G8).
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "unverified" },
    });
    // A scam tag that settles no lure type does not establish the page's lure (§18 G7); its own render's flags stand.
    expect(pages.find((p) => p.host === "coin-yield.example")).toMatchObject({
      labels: { lure: true },
      label_source: { lure: "unverified", has_login_form: "dom" },
    });
    expect(benign).toMatchObject({ labels: { lure: false, lure_type: "none", has_login_form: true } });
    // A page stored before the mapping changed takes it on resume, without rendering again: its false flag untrusted.
    const old = (await itemsOf()).map(({ inertFlags: _, ...item }) => item);
    const fresh = openStore(join(dir, "store2"));
    await importSource({ source: "scamferret", licence: "GPL-3.0", items: old, store: fresh });
    const before = fresh.manifest().find((p) => p.host === "cheap-shoes.example");
    expect(before?.label_source.has_login_form).toBe("dom");
    let rendered = 0;
    const again = (await itemsOf()).map((item) => ({
      ...item,
      load: async () => {
        rendered++;
        return item.load();
      },
    }));
    const resumed = await importSource({ source: "scamferret", licence: "GPL-3.0", items: again, store: fresh });
    expect(rendered).toBe(0);
    expect(resumed.relabelled).toBeGreaterThan(0);
    const after = openStore(join(dir, "store2"))
      .manifest()
      .find((p) => p.host === "cheap-shoes.example");
    expect(after?.label_source.has_login_form).toBe("unverified");
    // A mapping that no longer gives a field it once set withdraws it on resume; what the DOM set stays.
    const withBrand = (await itemsOf()).map((item) =>
      item.labels.lure_type === "fake_shop"
        ? {
            ...item,
            labels: { ...item.labels, brand: "Shoes" },
            label_source: { ...item.label_source, brand: "ground-truth" as const },
          }
        : item,
    );
    const branded = openStore(join(dir, "store3"));
    await importSource({ source: "scamferret", licence: "GPL-3.0", items: withBrand, store: branded });
    expect(branded.manifest().find((p) => p.host === "cheap-shoes.example")?.labels.brand).toBe("Shoes");
    const corrected = await importSource({
      source: "scamferret",
      licence: "GPL-3.0",
      items: await itemsOf(),
      store: branded,
    });
    expect(corrected.relabelled).toBeGreaterThan(0);
    const withdrawn = openStore(join(dir, "store3"))
      .manifest()
      .find((p) => p.host === "cheap-shoes.example");
    expect(withdrawn?.labels).not.toHaveProperty("brand");
    expect(withdrawn?.label_source).not.toHaveProperty("brand");
    expect(withdrawn?.labels.has_login_form).toBe(false);
    const shot = openStore(join(dir, "store")).readPage(scam?.id ?? "");
    expect(jpegSize(shot.screenshot)).toEqual({ width: 1280, height: 2000 });
    expect(shot.text).toBe("Designer shoes 90% off today only");
    expect(openStore(join(dir, "store")).readPage(benign?.id ?? "").text).toBe("Annual report for shareholders");
  });

  describe("bound to its converter's export (D03 T04 §28)", () => {
    const row = {
      sha256: "scam_websites/technical_support/help.example.html.gz",
      url: "https://help.example/",
      html: "<h1>Call our support line to unlock your computer</h1>",
      label: "phish",
      target: null,
      category: "technical_support",
    };
    // A store with the converter's rows and, when asked, the receipt that names them.
    const withRows = (receipt: boolean | { inputs: string; rows_sha256: string }) => {
      const folder = join(dir, "raw", "scamferret");
      mkdirSync(folder, { recursive: true });
      const rowsFile = join(folder, "rows.jsonl");
      writeFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      if (receipt)
        writeFileSync(
          join(folder, "EXPORT.json"),
          JSON.stringify(receipt === true ? { inputs: "m1", rows_sha256: fileSha256(rowsFile) } : receipt),
        );
      return { folder, rowsFile };
    };

    it("imports rows whose export receipt names them, and records the binding in IMPORT.json", async () => {
      const { folder, rowsFile } = withRows(true);
      expect(exportBinding(rowsFile)).toEqual({ inputs: "m1", rows: fileSha256(rowsFile) });
      const result = await importScamferret(dir, reader, 1, () => {});
      expect(result).toMatchObject({ status: "complete", expected: 1, stored: 1, inputs: "m1" });
      const record = JSON.parse(readFileSync(join(folder, "IMPORT.json"), "utf-8"));
      expect(record).toMatchObject({ status: "complete", inputs: "m1", rows: fileSha256(rowsFile) });
      expect(openStore(dir).manifest()[0]).toMatchObject({
        labels: { lure: true, lure_type: "impersonation" },
        label_source: { lure: "ground-truth", lure_type: "ground-truth" },
      });
    });

    it("refuses rows with no receipt, stores nothing and writes no IMPORT.json", async () => {
      const { folder } = withRows(false);
      await expect(importScamferret(dir, reader, 1, () => {})).rejects.toThrow(/EXPORT.json is missing/);
      expect(existsSync(join(folder, "IMPORT.json"))).toBe(false);
      expect(openStore(dir).manifest()).toEqual([]);
    });

    it("refuses rows changed since the receipt was written", async () => {
      const { folder, rowsFile } = withRows(true);
      writeFileSync(rowsFile, `${JSON.stringify({ ...row, label: "benign" })}\n`);
      await expect(importScamferret(dir, reader, 1, () => {})).rejects.toThrow(/changed since its export receipt/);
      expect(existsSync(join(folder, "IMPORT.json"))).toBe(false);
      expect(openStore(dir).manifest()).toEqual([]);
    });

    it("refuses a receipt that names no inputs, and rows that were never converted", async () => {
      withRows({ inputs: "", rows_sha256: "" });
      await expect(importScamferret(dir, reader, 1, () => {})).rejects.toThrow(/does not name its inputs and rows/);
      rmSync(join(dir, "raw"), { recursive: true });
      await expect(importScamferret(dir, reader, 1, () => {})).rejects.toThrow(/scamferret_rows.py first/);
    });
  });
});

describe("PhreshPhish", () => {
  it("reads rows by offset and keeps the brand a phishing page targets", async () => {
    const rows = join(dir, "rows.jsonl");
    writeFileSync(
      rows,
      `${[
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
        .join("\n")}\n`,
    );
    const index = await indexRows(rows);
    expect(index.map((entry) => entry.sha256)).toEqual(["a1", "b2", "c3"]);
    expect(readHtml(rows, index[1] as (typeof index)[number])).toBe("<h1>Today's news from the city</h1>");
    // Each row's own SHA-256 is its item's input digest, carried to the item and the page it makes (§28 G4).
    const lines = readFileSync(rows, "utf-8").split("\n").filter(Boolean);
    expect(index.map((entry) => entry.input)).toEqual(
      lines.map((line) => createHash("sha256").update(line).digest("hex")),
    );
    expect(phreshItem(index[0] as (typeof index)[number], () => "", reader).input).toBe(index[0]?.input);
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
    expect(page?.labels).toMatchObject({ lure: true, has_login_form: true, has_payment_form: false });
    // The inert copy found the sign-in form, so that flag stands; it found no card form, which a script could build in
    // the live page the screenshot shows, so that flag is untrusted (§18).
    expect(page?.label_source).toMatchObject({ has_login_form: "dom", has_payment_form: "unverified" });
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

  // §28, G3: items with one content keep their own labels on the page, and contradictory ones exclude it.
  it("keeps every item a content stands for, and excludes the page when their labels contradict, in either order", async () => {
    const same = (id: string, lure: boolean): SourceItem => ({
      ...item(id, "#606"),
      labels: lure ? { lure: true, lure_type: "credential" } : { lure: false, lure_type: "none" },
      // One content for every item here: the same screenshot and text.
      load: async () => ({ screenshot: await jpeg(320, 200, "#606"), text: "the visible text of one shared page" }),
    });
    for (const [order, items] of [
      ["lure first", [same("a-lure", true), same("b-benign", false)]],
      ["benign first", [same("b-benign", false), same("a-lure", true)]],
    ] as const) {
      const storeDir = join(dir, `store-${order.replace(" ", "-")}`);
      const store = openStore(storeDir);
      const result = await importSource({ source: "set", licence: "CC0", items: [...items], store, concurrency: 1 });
      expect(result, order).toMatchObject({ imported: 1, duplicates: 1 });
      const [page] = store.manifest();
      expect(
        page?.items?.map((i) => i.id),
        order,
      ).toEqual(items.map((i) => i.id));
      expect(itemConflict(page as never), order).toMatch(/share this content with contradictory labels/);
      applyRules(store);
      expect(readExcluded(storeDir).get(page?.id as string), order).toMatch(/items .* and .* share this content/);
    }
    // Found on a resumed import too: the second item arrives in a later run.
    const storeDir = join(dir, "store-resumed");
    await importSource({ source: "set", licence: "CC0", items: [same("a-lure", true)], store: openStore(storeDir) });
    expect(openStore(storeDir).manifest()[0]?.items).toBeUndefined();
    await importSource({
      source: "set",
      licence: "CC0",
      items: [same("a-lure", true), same("b-benign", false)],
      store: openStore(storeDir),
    });
    const [resumed] = openStore(storeDir).manifest();
    expect(resumed?.items?.map((i) => i.id)).toEqual(["a-lure", "b-benign"]);
    // Agreeing items are kept together and the page stays eligible.
    const agree = join(dir, "store-agree");
    await importSource({
      source: "set",
      licence: "CC0",
      items: [same("c-benign", false), same("d-benign", false)],
      store: openStore(agree),
      concurrency: 1,
    });
    expect(itemConflict(openStore(agree).manifest()[0] as never)).toBeNull();
  });

  // §28, G4: a bound import settles the pages its changed items left.
  it("moves a changed item to its new render, keeps unchanged and shared pages, and leaves a failed one on no page", async () => {
    const storeDir = join(dir, "store-g4");
    const binding = { inputs: "i".repeat(64), rows: "r".repeat(64) };
    const content = (id: string, text: string, colour: string, fail = false): SourceItem => ({
      ...item(id, colour, fail),
      load: async () => {
        if (fail) throw new Error("the render failed");
        return { screenshot: await jpeg(320, 200, colour), text };
      },
    });
    // Export 1: rows a (its own content), b, and c and d sharing one content.
    const first = [
      content("row-a1", "page a as first exported", "#111"),
      content("row-b", "page b, which never changes", "#222"),
      content("row-c", "one content for rows c and d", "#333"),
      content("row-d", "one content for rows c and d", "#333"),
    ];
    await importSource({
      source: "set",
      licence: "CC0",
      items: first,
      store: openStore(storeDir),
      binding,
      concurrency: 1,
    });
    const byItem = () =>
      new Map(
        openStore(storeDir)
          .manifest()
          .map((p) => [p.item as string, p]),
      );
    const before = byItem();
    expect(before.size).toBe(3);
    // Export 2: a's row changed (a new id, new content), b unchanged, d dropped from the shared page.
    const second = [
      first[1] as SourceItem,
      first[2] as SourceItem,
      content("row-a2", "page a as exported again", "#141"),
    ];
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: second,
      store: openStore(storeDir),
      binding,
      concurrency: 1,
    });
    expect(result).toMatchObject({ status: "complete", replaced: 2, skipped: 2, imported: 1 });
    const after = byItem();
    expect(after.has("row-a1")).toBe(false); // a's old page is gone
    expect(after.get("row-a2")).toBeDefined();
    expect(after.get("row-b")?.id).toBe(before.get("row-b")?.id); // unchanged, not rendered again
    const shared = after.get("row-c");
    expect(shared?.id).toBe(before.get("row-c")?.id);
    expect(shared?.items).toBeUndefined(); // only row c is left on it
    // Export 3: a's row changes again but its render fails: a is on no page, never on its old content.
    const third = [first[1] as SourceItem, first[2] as SourceItem, content("row-a3", "unused", "#151", true)];
    const failed = await importSource({
      source: "set",
      licence: "CC0",
      items: third,
      store: openStore(storeDir),
      binding,
      concurrency: 1,
    });
    expect(failed.excluded).toEqual([{ item: "row-a3", reason: "the render failed" }]);
    expect([...byItem().keys()].sort()).toEqual(["row-b", "row-c"]);
    // The import's half of the item ledger: every item it was given, once, with its outcome and where it is now.
    const ledger = readFileSync(join(storeDir, "raw", "set", "ITEMS.import.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledger[0]).toMatchObject(binding);
    expect(ledger[0].import).toMatch(/^[0-9a-f]{64}$/);
    const outcomeOf = new Map(ledger.slice(1).map((o) => [o.item, o]));
    expect(outcomeOf.get("row-a3")).toEqual({ item: "row-a3", outcome: "excluded", reason: "the render failed" });
    expect(outcomeOf.get("row-b")).toMatchObject({
      outcome: "stored",
      page: openStore(storeDir)
        .manifest()
        .find((p) => p.item === "row-b")?.id,
    });
    expect(ledger.length - 1).toBe(third.length);
    // An unbound import only reports a page whose item is gone.
    const loose = await importSource({
      source: "set",
      licence: "CC0",
      items: [first[1] as SourceItem],
      store: openStore(storeDir),
    });
    expect(loose).toMatchObject({ status: "incomplete", replaced: 0 });
    expect(byItem().has("row-c")).toBe(true);
  });

  // §28, G4, for an item whose id stays when its input changes (ScamFerret's file path, 7 Days Later's folder).
  it("renders an item again when its input changed, releases its old page, and leaves a failed one on no page", async () => {
    const storeDir = join(dir, "store-input");
    const digest = (n: number) => n.toString(16).padStart(64, "0");
    const row = (id: string, input: number, text: string, colour: string, fail = false): SourceItem => ({
      ...item(id, colour),
      input: digest(input),
      load: async () => {
        if (fail) throw new Error("the render failed");
        return { screenshot: await jpeg(320, 200, colour), text };
      },
    });
    const first = [
      row("folder/a", 1, "item a as first rendered", "#711"),
      row("folder/b", 2, "item b, which never changes", "#722"),
      row("folder/c", 3, "one content for items c and d", "#733"),
      row("folder/d", 4, "one content for items c and d", "#733"),
    ];
    await importSource({ source: "set", licence: "CC0", items: first, store: openStore(storeDir), concurrency: 1 });
    const pages = () => openStore(storeDir).manifest();
    const before = new Map(pages().map((p) => [p.item as string, p]));
    expect(before.get("folder/a")?.input).toBe(digest(1));
    expect(before.get("folder/c")?.items?.map((i) => i.input)).toEqual([digest(3), digest(4)]);
    // a's input changed (same id, new content); b unchanged; d's input changed, so it leaves the page it shared with c.
    const second = [
      row("folder/a", 11, "item a as rendered again", "#741"),
      first[1] as SourceItem,
      first[2] as SourceItem,
      row("folder/d", 14, "item d on its own now", "#744"),
    ];
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: second,
      store: openStore(storeDir),
      concurrency: 1,
    });
    expect(result).toMatchObject({ rerendered: 2, skipped: 2, imported: 2, status: "complete" });
    const after = new Map(pages().map((p) => [p.item as string, p]));
    expect(after.get("folder/a")?.input).toBe(digest(11));
    expect(after.get("folder/a")?.id).not.toBe(before.get("folder/a")?.id);
    expect(pages().some((p) => p.id === before.get("folder/a")?.id)).toBe(false); // the old content is gone
    expect(after.get("folder/b")?.id).toBe(before.get("folder/b")?.id); // unchanged, not rendered again
    expect(after.get("folder/c")?.id).toBe(before.get("folder/c")?.id); // kept for c
    expect(after.get("folder/c")?.items).toBeUndefined();
    expect(after.get("folder/d")?.input).toBe(digest(14));
    // a changes again and its render fails: a is on no page.
    const third = [row("folder/a", 21, "unused", "#751", true), ...second.slice(1)];
    const failed = await importSource({
      source: "set",
      licence: "CC0",
      items: third,
      store: openStore(storeDir),
      concurrency: 1,
    });
    expect(failed.excluded).toEqual([{ item: "folder/a", reason: "the render failed" }]);
    expect(pages().some((p) => p.item === "folder/a")).toBe(false);
    // A page stored before inputs were kept has none: taken as unchanged, not rendered again.
    const legacy = join(dir, "store-legacy");
    await importSource({ source: "set", licence: "CC0", items: [item("folder/x", "#761")], store: openStore(legacy) });
    const again = await importSource({
      source: "set",
      licence: "CC0",
      items: [row("folder/x", 99, "new", "#762")],
      store: openStore(legacy),
    });
    expect(again).toMatchObject({ rerendered: 0, skipped: 1 });
  });

  it("excludes an empty page with no text or form fields, while admitting a sparse logo-and-two-fields lure and filtering structural or title walls", async () => {
    const empty: SourceItem = {
      ...item("blank", "#333"),
      load: async () => ({ screenshot: await jpeg(64, 64), text: " " }),
    };
    const sparseLure: SourceItem = {
      ...item("sparse-lure", "#234"),
      load: async () =>
        reader.renderHtml(
          '<!doctype html><html><head><title>Sign in</title></head><body><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="40"><form><input type="email" name="user"><input type="password" name="pass"></form></body></html>',
        ),
    };
    const title404: SourceItem = {
      ...item("title-404", "#345"),
      load: async () =>
        reader.renderHtml(
          "<!doctype html><html><head><title>404 Not Found</title></head><body><p>Welcome to our portal with plenty of navigation words.</p></body></html>",
        ),
    };
    const structuralWall: SourceItem = {
      ...item("captcha-wall", "#456"),
      load: async () => ({
        screenshot: await jpeg(64, 64, "#456"),
        text: "Sign in to continue to your account",
        has_login_form: true,
        has_payment_form: false,
        evidence: {
          title: "Security Check",
          overlays: "",
          captcha: true,
          consentWall: false,
          challengeCover: false,
          wall: false,
        },
      }),
    };
    const storePath = join(dir, "store");
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [
        empty,
        sparseLure,
        title404,
        structuralWall,
        ...Array.from({ length: 20 }, (_, i) => item(`page-${i}`, `#${(i * 7 + 16).toString(16).padStart(3, "0")}`)),
      ],
      store: openStore(storePath),
      concurrency: 1,
    });
    expect(result.filtered).toEqual([
      { item: "blank", reason: "an empty page" },
      { item: "title-404", reason: "an error page" },
      { item: "captcha-wall", reason: "a CAPTCHA frame" },
    ]);
    expect(result.excluded).toEqual([]);
    expect(result.status).toBe("complete");
    const storedSparse = openStore(storePath)
      .manifest()
      .find((p) => p.item === "sparse-lure");
    expect(storedSparse).toBeDefined();
    expect(storedSparse?.labels.has_login_form).toBe(true);
    expect(storedSparse?.evidence?.title).toBe("Sign in");
  });

  it("leaves IMPORT.json incomplete when ITEMS.import.jsonl fails to write, and recovers on rerun", async () => {
    const storePath = join(dir, "store-ledger-fail");
    const binding = { inputs: "in-1", rows: "rw-1" };
    const failed = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("p1", "#123"), item("p2", "#456")],
      store: openStore(storePath),
      binding,
      writeLedger: () => {
        throw new Error("ENOSPC writing ITEMS.import.jsonl");
      },
    });
    expect(failed.status).toBe("incomplete");
    expect(failed.reason).toContain("ENOSPC writing ITEMS.import.jsonl");
    const onDisk = JSON.parse(readFileSync(join(storePath, "raw", "set", "IMPORT.json"), "utf-8"));
    expect(onDisk.status).toBe("incomplete");
    const recovered = await importSource({
      source: "set",
      licence: "CC0",
      items: [item("p1", "#123"), item("p2", "#456")],
      store: openStore(storePath),
      binding,
    });
    expect(recovered.status).toBe("complete");
    const ledger = readFileSync(join(storePath, "raw", "set", "ITEMS.import.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(3);
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
    const again = {
      ...item("fixme", "#303"),
      load: () => {
        loads++;
        return item("fixme", "#303").load();
      },
    };
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
      load: () => {
        loads++;
        return item("m1", "#121").load();
      },
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
    // Each normal item's page is made before the run, so its load resolves at once and only the stuck one can meet the
    // deadline: a busy runner encoding a picture inside the load once lost that race (D00 T01 §14).
    const ready = await Promise.all(
      Array.from({ length: 25 }, async (_, i) => {
        const normal = item(`ok${i}`, `#${(i * 13 + 32).toString(16).padStart(3, "0")}`);
        const page = await normal.load();
        return { ...normal, load: async () => page };
      }),
    );
    const result = await importSource({
      source: "set",
      licence: "CC0",
      items: [stuck, ...ready],
      store: openStore(join(dir, "store")),
      itemMs: 300,
      concurrency: 2,
    });
    expect(result.excluded).toEqual([{ item: "stuck", reason: "the item did not load within 0.3 seconds" }]);
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
    const counted = items.map((it) => ({
      ...it,
      load: () => {
        loads++;
        return it.load();
      },
    }));
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
