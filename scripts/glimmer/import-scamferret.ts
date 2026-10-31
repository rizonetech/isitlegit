// ScamFerret (GPL-3.0, https://github.com/ScamFerret/artifact, commit 8cf8dc6) into the Loupe store (D03 T04 §5, §28).
//
//   python3 -I scripts/glimmer/scamferret_rows.py   # the archive's pages as rows (JSONL) and EXPORT.json
//   node scripts/glimmer/import-scamferret.ts
//
// Reads the rows `scamferret_rows.py` writes from the archive's `dataset/` (`<class>/<category>/toppage_html/<host>.html.gz`,
// 200 a category, and `sample_screenshot/<host>.png` for 20 of them), bound to the converter's receipt: rows without one,
// or changed since, are not imported. A page with a real screenshot keeps it (normalised); the rest are rendered from
// their HTML in inert Chromium. The class gives `lure` (ground truth); the category gives `lure_type` where it settles
// it: online shopping scams are fake shops and technical-support scams impersonate a vendor; investment and
// cryptocurrency scams are left for §9's adjudication.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { indexRows, MAX_ROW_BYTES, type PhreshIndex, readHtml, readShot } from "./import-phreshphish.ts";
import { concurrencyArg, exportBinding, importSource, type SourceItem } from "./import-source.ts";
import { normaliseScreenshot, openTextReader } from "./source-pages.ts";
import { openStore, storeDir } from "./store.ts";

export const SOURCE = "scamferret";
export const LICENCE = "GPL-3.0 (ScamFerret artifact, commit 8cf8dc631edafe584141e2f95f0c0f51855fb7bc)";

export function lureTypeOf(scam: boolean, category: string): "fake_shop" | "impersonation" | "none" | undefined {
  if (!scam) return "none";
  if (category.startsWith("online_shopping")) return "fake_shop";
  if (category === "technical_support") return "impersonation";
  return undefined;
}

// A row's `category` is the archive's own folder name; the item id is `<class folder>/<category>/<file>`.
export type ScamferretIndex = PhreshIndex & { category?: string };

export function scamferretItem(
  entry: ScamferretIndex,
  html: () => string,
  reader: Awaited<ReturnType<typeof openTextReader>>,
  shot?: () => Uint8Array,
): SourceItem {
  const id = entry.sha256;
  if (entry.oversized) {
    const reason = `the row is over ${MAX_ROW_BYTES / 1024 / 1024} MB`;
    return { id, url: null, labels: {}, label_source: {}, load: async () => Promise.reject(new Error(reason)) };
  }
  const scam = entry.label === "phish";
  const lureType = lureTypeOf(scam, entry.category ?? "");
  return {
    id,
    ...(entry.input ? { input: entry.input } : {}),
    url: entry.url,
    labels: { lure: scam, ...(lureType ? { lure_type: lureType } : {}) },
    // A scam tag whose category settles no lure type (cryptocurrency, investment) does not establish what the
    // page itself does: its lure is unverified, trained at 0.7 and never evaluated (§18, admission rule).
    label_source: {
      lure: scam && !lureType ? "unverified" : "ground-truth",
      ...(lureType ? { lure_type: "ground-truth" } : {}),
    },
    // The dataset's screenshot is a live capture; the text and form flags come from the inert HTML (§18 gap 8).
    ...(shot ? { inertFlags: true } : {}),
    load: async () => {
      const rendered = await reader.renderHtml(html());
      return shot ? { ...rendered, screenshot: await normaliseScreenshot(shot()) } : rendered;
    },
  };
}

export function scamferretItems(
  rowsFile: string,
  index: ScamferretIndex[],
  reader: Awaited<ReturnType<typeof openTextReader>>,
): SourceItem[] {
  return index.map((entry) =>
    scamferretItem(
      entry,
      () => readHtml(rowsFile, entry),
      reader,
      entry.shot ? () => readShot(rowsFile, entry) : undefined,
    ),
  );
}

// The import, bound to the converter's receipt: `exportBinding` throws for rows with none, or changed since, before
// anything is stored or IMPORT.json written (§28).
export async function importScamferret(
  dir: string,
  reader: Awaited<ReturnType<typeof openTextReader>>,
  concurrency = 4,
  log: (line: string) => void = (line) => console.log(line),
) {
  const rowsFile = join(dir, "raw", SOURCE, "rows.jsonl");
  if (!existsSync(rowsFile)) throw new Error(`${rowsFile} is missing; run scripts/glimmer/scamferret_rows.py first`);
  const binding = exportBinding(rowsFile);
  return importSource({
    source: SOURCE,
    licence: LICENCE,
    items: scamferretItems(rowsFile, await indexRows(rowsFile), reader),
    store: openStore(dir),
    binding,
    log,
    concurrency,
  });
}

if (import.meta.filename === process.argv[1]) {
  const reader = await openTextReader();
  try {
    const result = await importScamferret(storeDir(), reader, concurrencyArg()).catch((error: Error) => {
      console.error(`import-scamferret: ${error.message}`);
      return undefined;
    });
    if (result) console.log(JSON.stringify({ ...result, excluded: result.excluded.length }));
    process.exitCode = result?.status === "complete" ? 0 : 1;
  } finally {
    await reader.close();
  }
  // The import ends when its work ends: a handle nothing waits on must not keep the next queued import waiting.
  process.exit(process.exitCode ?? 0);
}
