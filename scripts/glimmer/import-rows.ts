// The second sweep's HTML datasets into the Loupe store (D03 T04 §18), from the rows `dataset_rows.py` writes in
// PhreshPhish's row shape, so each goes through the same tested item and import run as PhreshPhish (§5).
//
//   ~/.venvs/fireworks/bin/python -I scripts/glimmer/dataset_rows.py <source>
//   node scripts/glimmer/import-rows.ts <source>
import { existsSync } from "node:fs";
import { join } from "node:path";
import { indexRows, phreshItem, readHtml, readShot } from "./import-phreshphish.ts";
import { importSource } from "./import-source.ts";
import { openTextReader } from "./source-pages.ts";
import { openStore, storeDir } from "./store.ts";

// Each source's licence, as Claude re-read it at the dataset's own page (2026-10-28).
export const ROW_SOURCES: Record<string, string> = {
  compphish: "CC BY 4.0",
  "ariyadasa-2021": "CC BY 4.0",
  "kempf-html": "CC BY-SA 3.0",
  "look-for-mallory": "Apache 2.0",
  "7-days-later": "CC BY 4.0",
};

if (import.meta.filename === process.argv[1]) {
  const source = process.argv[2] ?? "";
  const licence = ROW_SOURCES[source];
  if (!licence) {
    console.error(`usage: node scripts/glimmer/import-rows.ts <${Object.keys(ROW_SOURCES).join("|")}>`);
    process.exit(2);
  }
  const dir = storeDir();
  const rowsFile = join(dir, "raw", source, "rows.jsonl");
  if (!existsSync(rowsFile)) {
    console.error(`import-rows: ${rowsFile} is missing; run scripts/glimmer/dataset_rows.py ${source} first`);
    process.exit(2);
  }
  const reader = await openTextReader();
  try {
    const result = await importSource({
      source,
      licence,
      items: (await indexRows(rowsFile)).map((entry) =>
        phreshItem(
          entry,
          () => readHtml(rowsFile, entry),
          reader,
          entry.shot ? () => readShot(rowsFile, entry) : undefined,
        ),
      ),
      store: openStore(dir),
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
