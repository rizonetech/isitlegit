// Renders the fictional brands' reference logos (D03 T03 §2) from their SVG sources in test/fixtures/brands/ to PNG,
// 512 px wide on a transparent background, in the headless Chromium the browser tests use. The PNGs are committed: the
// reference logo store copies them into each generation with `fictional: true`.
//
//   node scripts/fixtures/make-brand-logos.ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../lib/chromium.ts";

const DIR = join(import.meta.dirname, "../../test/fixtures/brands");
const executablePath = chromiumPath();
if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
const browser = await chromium.launch({ executablePath, args: ["--proxy-server=127.0.0.1:9"] });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 160 }, deviceScaleFactor: 1 });
  for (const slug of ["protea-bank", "nimbusmail"]) {
    const svg = readFileSync(join(DIR, `${slug}.svg`), "utf8");
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const png = await page.locator("svg").screenshot({ type: "png", omitBackground: true });
    const out = join(DIR, `${slug}.png`);
    writeFileSync(`${out}.tmp`, png);
    renameSync(`${out}.tmp`, out);
    console.log(`make-brand-logos: ${out} (${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
