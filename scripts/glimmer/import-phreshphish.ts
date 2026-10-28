// PhreshPhish (CC BY 4.0, https://huggingface.co/datasets/phreshphish/phreshphish) into the Loupe store (D03 T04 §5).
//
//   ~/.venvs/fireworks/bin/python scripts/glimmer/phreshphish_rows.py   # the downloaded shards as rows (JSONL)
//   node scripts/glimmer/import-phreshphish.ts
//
// Each row is a page's URL, HTML, label (`phish` or `benign`) and the brand a phishing page targets. The page is rendered
// from its HTML in inert Chromium (no script, no request: a phishing page is never live) for its screenshot and text.
// `lure` comes from the label and `brand` from the target (except `other`), both ground truth; `lure_type` is left for
// §9's adjudication, since the set does not say which kind of lure a page is.
import { closeSync, createReadStream, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { importSource, type SourceItem } from "./import-source.ts";
import { openTextReader } from "./source-pages.ts";
import { openStore, storeDir } from "./store.ts";

export const SOURCE = "phreshphish";
export const LICENCE = "CC BY 4.0 (PhreshPhish, train shards 000 and 001)";

export type PhreshRow = { sha256: string; url: string | null; html: string; label: string; target: string | null };
// A row without its HTML, and where its line sits in rows.jsonl, so thousands of pages never sit in memory at once.
export type PhreshIndex = Omit<PhreshRow, "html"> & { offset: number; length: number };

export function phreshItem(
  row: Omit<PhreshRow, "html">,
  html: () => string,
  reader: Awaited<ReturnType<typeof openTextReader>>,
): SourceItem {
  if (row.label !== "phish" && row.label !== "benign") throw new Error(`row ${row.sha256}: label "${row.label}"`);
  const lure = row.label === "phish";
  const brand = row.target && row.target.toLowerCase() !== "other" ? row.target.slice(0, 200) : null;
  return {
    id: row.sha256,
    url: row.url,
    labels: lure ? { lure: true, ...(brand ? { brand } : {}) } : { lure: false, lure_type: "none" },
    label_source: lure
      ? { lure: "ground-truth", ...(brand ? { brand: "ground-truth" } : {}) }
      : { lure: "ground-truth", lure_type: "ground-truth" },
    load: () => reader.renderHtml(html()),
  };
}

// Each row's small fields and its line's byte range; the HTML stays on disk until the page is rendered.
export async function indexRows(path: string): Promise<PhreshIndex[]> {
  const index: PhreshIndex[] = [];
  let offset = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const length = Buffer.byteLength(line, "utf-8");
    if (line.trim()) {
      const { html: _html, ...row } = JSON.parse(line) as PhreshRow;
      index.push({ ...row, offset, length });
    }
    offset += length + 1;
  }
  return index;
}

export function readHtml(path: string, entry: PhreshIndex): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(entry.length);
    readSync(fd, buffer, 0, entry.length, entry.offset);
    return (JSON.parse(buffer.toString("utf-8")) as PhreshRow).html;
  } finally {
    closeSync(fd);
  }
}

if (import.meta.filename === process.argv[1]) {
  const dir = storeDir();
  const rowsFile = join(dir, "raw", SOURCE, "rows.jsonl");
  if (!existsSync(rowsFile)) {
    console.error(`import-phreshphish: ${rowsFile} is missing; run scripts/glimmer/phreshphish_rows.py first`);
    process.exit(2);
  }
  const reader = await openTextReader();
  try {
    const result = await importSource({
      source: SOURCE,
      licence: LICENCE,
      items: (await indexRows(rowsFile)).map((entry) => phreshItem(entry, () => readHtml(rowsFile, entry), reader)),
      store: openStore(dir),
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify({ ...result, excluded: result.excluded.length }));
    process.exitCode = result.status === "complete" ? 0 : 1;
  } finally {
    await reader.close();
  }
}
