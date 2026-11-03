// The 20-sample logo recall set (D03 T03 §4): synthetic branded email pages with fictional
// brands, each rendered in headless Chromium at the desktop render size, with the logo's box
// labelled in the exact pixels of the saved image. Synthetic data only: invented brand names,
// no real marks, nothing from client mail.
//
//   node scripts/fixtures/make-branded.ts
//
// Writes test/vision/fixtures/logo-recall/sample-NN.png and labels.json (brand, image size, logo box).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../lib/chromium.ts";

const OUT = join(import.meta.dirname, "../../test/vision/fixtures/logo-recall");
const WIDTH = 1024;
const HEIGHT = 768;

// Twenty invented brands, varied wordmark colours and logo sizes and positions.
const BRANDS = [
  "Karoo Bank",
  "Protea Bank",
  "NimbusMail",
  "Baobab Insurance",
  "Fynbos Freight",
  "Karoo Solar",
  "Protea Health",
  "Savanna Air",
  "Kalahari Hotels",
  "Baobab Bank",
  "Fynbos Foods",
  "Karoo Mobile",
  "Protea Pay",
  "Savanna Bank",
  "Kalahari Mail",
  "Baobab Freight",
  "Fynbos Bank",
  "Karoo Health",
  "Protea Solar",
  "Savanna Pay",
] as const;

const COLOURS = ["#0b5394", "#7a1f1f", "#14532d", "#5b21b6", "#9a3412", "#0f766e"];

type Sample = {
  file: string;
  brand: string;
  width: number;
  height: number;
  logo: { left: number; top: number; right: number; bottom: number };
};

const executablePath = chromiumPath();
if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath, args: ["--proxy-server=127.0.0.1:9"] });
try {
  const samples: Sample[] = [];
  for (const [index, brand] of BRANDS.entries()) {
    const logoWidth = 140 + (index % 5) * 40;
    const logoHeight = 36 + (index % 3) * 12;
    const left = 24 + (index % 4) * 60;
    const top = 20 + (index % 3) * 18;
    const colour = COLOURS[index % COLOURS.length];
    const initials = brand
      .split(" ")
      .map((word) => word[0])
      .join("");
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif;background:#ffffff">
<div style="position:absolute;left:${left}px;top:${top}px;width:${logoWidth}px;height:${logoHeight}px;background:${colour};color:#fff;display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box">
<span style="font-weight:bold;font-size:${Math.round(logoHeight * 0.5)}px">${initials}</span>
<span style="font-size:${Math.round(logoHeight * 0.38)}px;white-space:nowrap">${brand}</span></div>
<div style="position:absolute;left:24px;top:${top + logoHeight + 40}px;width:700px;color:#222;font-size:16px;line-height:1.5">
<p>Dear customer,</p><p>Your monthly statement from ${brand} is ready. Sign in to view your balance and recent transactions.</p>
<p>This is a synthetic sample for logo detection measurement. No action is needed.</p></div>
</body></html>`);
    const file = `sample-${String(index + 1).padStart(2, "0")}.png`;
    const png = await page.screenshot({ type: "png" });
    writeFileSync(join(OUT, `${file}.tmp`), png);
    renameSync(join(OUT, `${file}.tmp`), join(OUT, file));
    await page.close();
    samples.push({
      file,
      brand,
      width: WIDTH,
      height: HEIGHT,
      logo: { left, top, right: left + logoWidth, bottom: top + logoHeight },
    });
    console.log(`make-branded: ${file} (${brand})`);
  }
  const labels = `${JSON.stringify({ version: 1, samples }, null, 1)}\n`;
  writeFileSync(join(OUT, "labels.json.tmp"), labels);
  renameSync(join(OUT, "labels.json.tmp"), join(OUT, "labels.json"));
  console.log(`make-branded: ${samples.length} samples in ${OUT}`);
} finally {
  await browser.close();
}
