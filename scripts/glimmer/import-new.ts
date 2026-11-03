// The Loupe 1.1 sources into the store (D03 T04 §44), from the rows `new_rows.py` writes in PhreshPhish's shape.
//
//   python3 -I scripts/glimmer/new_rows.py <ows|phishingeval-ji|phishdecloaker>
//   node scripts/glimmer/import-new.ts <ows|phishingeval-ji|phishdecloaker>
//
// Brand (`target` in a row) is stored with label source `grouping-only`: it groups and caps pages, and is never
// a trusted label, taught truth or score (D03 T04 §45). The lure label is the source's own, ground truth.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { indexRows, type PhreshIndex, readHtml, readShot } from "./import-phreshphish.ts";
import {
  checkFreeSpace,
  concurrencyArg,
  exportBinding,
  type ImportResult,
  importSource,
  type SourceItem,
} from "./import-source.ts";
import { normaliseScreenshot, openTextReader } from "./source-pages.ts";
import { checkNewSourceCoverage, type ExportReceipt, NEW_SOURCE_FLOORS, scanRowsLineage } from "./sources.ts";
import { openStore, storeDir } from "./store.ts";

export { checkFreeSpace, checkNewSourceCoverage, NEW_SOURCE_FLOORS };

export const MIN_FREE_BYTES = 300 * 1000 * 1000 * 1000;

export const NEW_SOURCES: Record<string, string> = {
  ows: "CC BY 4.0",
  "phishingeval-ji": "CC BY 4.0",
  phishdecloaker: "CC BY 4.0",
  putra: "CC BY 4.0",
  "van-dooremaal-ares-2021": "CC BY 4.0",
};

export function newItem(
  row: PhreshIndex,
  html: () => string,
  reader: Awaited<ReturnType<typeof openTextReader>>,
  shot?: () => Uint8Array,
): SourceItem {
  if (row.oversized) {
    return {
      id: row.sha256,
      url: null,
      labels: {},
      label_source: {},
      load: async () => Promise.reject(new Error("the row is over the size limit")),
    };
  }
  if (row.label !== "phish" && row.label !== "benign") {
    return {
      id: row.sha256,
      url: row.url,
      labels: {},
      label_source: {},
      load: async () =>
        Promise.reject(new Error(`label "${String(row.label).slice(0, 40)}" is neither phish nor benign`)),
    };
  }
  const lure = row.label === "phish";
  const brand = row.target && row.target.toLowerCase() !== "other" ? row.target.slice(0, 200) : null;
  return {
    ...(row.input ? { input: row.input } : {}),
    id: row.sha256,
    url: row.url,
    labels: lure
      ? { lure: true, ...(brand ? { brand } : {}) }
      : { lure: false, lure_type: "none" as const, ...(brand ? { brand } : {}) },
    label_source: lure
      ? { lure: "ground-truth", ...(brand ? { brand: "grouping-only" } : {}) }
      : { lure: "ground-truth", lure_type: "ground-truth", ...(brand ? { brand: "grouping-only" } : {}) },
    ...(shot ? { inertFlags: true } : {}),
    load: async () => {
      const page = await reader.renderHtml(html());
      return shot ? { ...page, screenshot: await normaliseScreenshot(shot()) } : page;
    },
  };
}

export async function importNewSource(options: {
  source: string;
  dir: string;
  reader: Awaited<ReturnType<typeof openTextReader>>;
  concurrency?: number;
  minFreeBytes?: number;
  freeBytes?: (dir: string) => number;
  enforceCoverage?: boolean;
  log?: (line: string) => void;
}): Promise<ImportResult> {
  const { source, dir, reader } = options;
  const licence = NEW_SOURCES[source];
  if (!licence) throw new Error(`unknown 1.1 source "${source}"`);
  const rowsFile = join(dir, "raw", source, "rows.jsonl");
  if (!existsSync(rowsFile)) {
    throw new Error(`import-new: ${rowsFile} is missing; run scripts/glimmer/new_rows.py ${source} first`);
  }
  const minFreeBytes = options.minFreeBytes ?? MIN_FREE_BYTES;
  if (minFreeBytes > 0) checkFreeSpace(dir, minFreeBytes, options.freeBytes, 16_384);
  const store = openStore(dir);
  const indexed = await indexRows(rowsFile);
  return await importSource({
    source,
    licence,
    items: indexed.map((entry) =>
      newItem(entry, () => readHtml(rowsFile, entry), reader, entry.shot ? () => readShot(rowsFile, entry) : undefined),
    ),
    store,
    binding: exportBinding(rowsFile),
    ...(options.log ? { log: options.log } : {}),
    concurrency: options.concurrency ?? 4,
    minFreeBytes,
    ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}),
    ...(options.enforceCoverage !== false
      ? {
          beforePublish: (stored) => {
            const exportFile = join(dirname(rowsFile), "EXPORT.json");
            const exportReceipt = existsSync(exportFile)
              ? (JSON.parse(readFileSync(exportFile, "utf-8")) as ExportReceipt)
              : undefined;
            return checkNewSourceCoverage(source, {
              exportReceipt,
              rowItems: scanRowsLineage(rowsFile),
              stored,
            })[0];
          },
        }
      : {}),
  });
}

if (import.meta.filename === process.argv[1]) {
  const source = process.argv[2] ?? "";
  const licence = NEW_SOURCES[source];
  if (!licence) {
    console.error(`usage: node scripts/glimmer/import-new.ts <${Object.keys(NEW_SOURCES).join("|")}>`);
    process.exit(2);
  }
  const dir = storeDir();
  const rowsFile = join(dir, "raw", source, "rows.jsonl");
  if (!existsSync(rowsFile)) {
    console.error(`import-new: ${rowsFile} is missing; run scripts/glimmer/new_rows.py ${source} first`);
    process.exit(2);
  }
  const reader = await openTextReader();
  try {
    const result = await importNewSource({
      source,
      dir,
      reader,
      concurrency: concurrencyArg(),
      log: (line) => console.log(line),
    });
    console.log(
      `${source}: ${JSON.stringify({ ...result, excluded: result.excluded.length, filtered: result.filtered.length })}`,
    );
    process.exitCode = result.status === "complete" ? 0 : 1;
  } finally {
    await reader.close();
  }
}
