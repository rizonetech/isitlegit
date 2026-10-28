// ScamFerret (GPL-3.0, https://github.com/ScamFerret/artifact, commit 8cf8dc6) into the Loupe store (D03 T04 §5).
//
//   node scripts/glimmer/import-scamferret.ts
//
// Reads the archive's `dataset/` (unpacked by scripts/glimmer/extract_archive.py into `<store>/raw/scamferret/extracted`):
// `<class>/<category>/toppage_html/<host>.html.gz`, 200 a category, and `sample_screenshot/<host>.png` for 20 of
// them. A page with a real screenshot keeps it (normalised); the rest are rendered from their HTML in inert Chromium.
// The class gives `lure` (ground truth); the category gives `lure_type` where it settles it: online shopping scams are
// fake shops and technical-support scams impersonate a vendor; investment and cryptocurrency scams are left for §9's
// adjudication.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { importSource, type SourceItem } from "./import-source.ts";
import { decodeHtml, normaliseScreenshot, openTextReader } from "./source-pages.ts";
import { openStore, storeDir } from "./store.ts";

export const SOURCE = "scamferret";
export const LICENCE = "GPL-3.0 (ScamFerret artifact, commit 8cf8dc631edafe584141e2f95f0c0f51855fb7bc)";

export function lureTypeOf(scam: boolean, category: string): "fake_shop" | "impersonation" | "none" | undefined {
  if (!scam) return "none";
  if (category.startsWith("online_shopping")) return "fake_shop";
  if (category === "technical_support") return "impersonation";
  return undefined;
}

export function scamferretItems(datasetDir: string, reader: Awaited<ReturnType<typeof openTextReader>>): SourceItem[] {
  const items: SourceItem[] = [];
  for (const [folder, scam] of [
    ["scam_websites", true],
    ["legitimate_websites", false],
  ] as const) {
    const classDir = join(datasetDir, folder);
    if (!existsSync(classDir)) continue;
    for (const category of readdirSync(classDir).sort()) {
      const htmlDir = join(classDir, category, "toppage_html");
      if (!existsSync(htmlDir)) continue;
      for (const file of readdirSync(htmlDir)
        .filter((name) => name.endsWith(".html.gz"))
        .sort()) {
        const host = file.replace(/\.html\.gz$/, "");
        const png = join(classDir, category, "sample_screenshot", `${host}.png`);
        const lureType = lureTypeOf(scam, category);
        items.push({
          id: `${folder}/${category}/${file}`,
          url: `https://${host}/`,
          labels: { lure: scam, ...(lureType ? { lure_type: lureType } : {}) },
          label_source: { lure: "ground-truth", ...(lureType ? { lure_type: "ground-truth" } : {}) },
          load: async () => {
            const html = decodeHtml(gunzipSync(readFileSync(join(htmlDir, file))));
            const rendered = await reader.renderHtml(html);
            if (!existsSync(png)) return rendered;
            return { ...rendered, screenshot: await normaliseScreenshot(new Uint8Array(readFileSync(png))) };
          },
        });
      }
    }
  }
  return items;
}

if (import.meta.filename === process.argv[1]) {
  const dir = storeDir();
  const dataset = join(dir, "raw", SOURCE, "extracted", "artifact-8cf8dc631edafe584141e2f95f0c0f51855fb7bc", "dataset");
  if (!existsSync(dataset)) {
    console.error(`import-scamferret: ${dataset} is missing; unpack the archive with extract_archive.py --only`);
    process.exit(2);
  }
  const reader = await openTextReader();
  try {
    const result = await importSource({
      source: SOURCE,
      licence: LICENCE,
      items: scamferretItems(dataset, reader),
      store: openStore(dir),
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify({ ...result, excluded: result.excluded.length }));
    process.exitCode = result.status === "complete" ? 0 : 1;
  } finally {
    await reader.close();
  }
}
