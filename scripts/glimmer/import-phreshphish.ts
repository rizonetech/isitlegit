// PhreshPhish (CC BY 4.0, https://huggingface.co/datasets/phreshphish/phreshphish) into the Loupe store (D03 T04 §5).
//
//   ~/.venvs/fireworks/bin/python scripts/glimmer/phreshphish_rows.py   # the downloaded shards as rows (JSONL)
//   node scripts/glimmer/import-phreshphish.ts
//
// Each row is a page's URL, HTML, label (`phish` or `benign`) and the brand a phishing page targets. The page is rendered
// from its HTML in inert Chromium (no script, no request: a phishing page is never live) for its screenshot and text.
// `lure` comes from the label and `brand` from the target (except `other`), both ground truth; `lure_type` is left for
// §9's adjudication, since the set does not say which kind of lure a page is.
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { importSource, type SourceItem } from "./import-source.ts";
import { normaliseScreenshot, openTextReader } from "./source-pages.ts";
import { openStore, storeDir } from "./store.ts";

export const SOURCE = "phreshphish";
export const LICENCE = "CC BY 4.0 (PhreshPhish train shards)";

// `screenshot` (base64 JPEG) is there when the dataset captured the live page itself (7 Days Later, §18).
export type PhreshRow = {
  sha256: string;
  url: string | null;
  html: string;
  label: string;
  target: string | null;
  screenshot?: string;
};
// A row without its HTML or screenshot, and where its line sits in rows.jsonl, so thousands of pages never sit in
// memory at once.
export type PhreshIndex = Omit<PhreshRow, "html" | "screenshot"> & { offset: number; length: number; shot: boolean };

export function phreshItem(
  row: Omit<PhreshRow, "html" | "screenshot">,
  html: () => string,
  reader: Awaited<ReturnType<typeof openTextReader>>,
  // The dataset's own capture of the live page, used instead of the inert render's picture; the HTML still gives the
  // text and the form flags.
  shot?: () => Uint8Array,
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
    load: async () => {
      const page = await reader.renderHtml(html());
      return shot ? { ...page, screenshot: await normaliseScreenshot(shot()) } : page;
    },
  };
}

// Each row's small fields and its line's byte range; the HTML stays on disk until the page is rendered. Lines end at a
// newline byte and nowhere else: JSONL allows U+2028 and U+2029 inside a string, and Node's readline would cut a row
// there (19 PhreshPhish pages hold one).
export async function indexRows(path: string): Promise<PhreshIndex[]> {
  const index: PhreshIndex[] = [];
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    let pending: Buffer[] = [];
    let lineStart = 0;
    let position = 0;
    const finish = (end: number) => {
      const line = Buffer.concat(pending).toString("utf-8");
      pending = [];
      if (line.trim()) {
        const { html: _html, screenshot, ...row } = JSON.parse(line) as PhreshRow;
        index.push({ ...row, offset: lineStart, length: end - lineStart, shot: Boolean(screenshot) });
      }
    };
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      let from = 0;
      for (let newline = chunk.indexOf(10, from); newline !== -1 && newline < read; newline = chunk.indexOf(10, from)) {
        pending.push(Buffer.from(chunk.subarray(from, newline)));
        finish(position + newline);
        from = newline + 1;
        lineStart = position + from;
      }
      pending.push(Buffer.from(chunk.subarray(from, read)));
      position += read;
    }
    finish(position);
  } finally {
    closeSync(fd);
  }
  return index;
}

export function readRow(path: string, entry: PhreshIndex): PhreshRow {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(entry.length);
    readSync(fd, buffer, 0, entry.length, entry.offset);
    return JSON.parse(buffer.toString("utf-8")) as PhreshRow;
  } finally {
    closeSync(fd);
  }
}

export function readHtml(path: string, entry: PhreshIndex): string {
  return readRow(path, entry).html;
}

// The row's own screenshot, when the dataset captured the live page.
export function readShot(path: string, entry: PhreshIndex): Uint8Array {
  const shot = readRow(path, entry).screenshot;
  if (!shot) throw new Error(`row ${entry.sha256} has no screenshot`);
  return new Uint8Array(Buffer.from(shot, "base64"));
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
