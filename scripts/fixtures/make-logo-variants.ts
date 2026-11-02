// The expanded logo-variant set (D03 T03 §5, from §4's completion review): paired fictional
// references and labelled samples that can actually decide whether a second reference helps.
// For each fictional brand: a wordmark reference (the committed fixture), an icon reference
// (initials badge), and samples showing the wordmark, the icon alone, a dark variant, the other
// brand's wordmark (expected different) and no logo at all (expected different), each twice at
// different sizes. Synthetic data only.
//
//   node scripts/fixtures/make-logo-variants.ts
//
// Writes eval/sets/logo-variants/{refs,samples} and labels.json.
import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../lib/chromium.ts";

const OUT = join(import.meta.dirname, "../../eval/sets/logo-variants");
const FIXTURES = join(import.meta.dirname, "../../test/fixtures/brands");
const WIDTH = 1024;
const HEIGHT = 768;

const BRANDS = [
  { slug: "protea-bank", brand: "Protea Bank", initials: "PB", colour: "#0b5394" },
  { slug: "nimbusmail", brand: "NimbusMail", initials: "N", colour: "#5b21b6" },
] as const;

type Sample = {
  file: string;
  brand: string;
  shown: "wordmark" | "icon" | "dark" | "other" | "none";
  expected_same: boolean;
  width: number;
  height: number;
  logo: { left: number; top: number; right: number; bottom: number } | null;
};

const executablePath = chromiumPath();
if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
mkdirSync(join(OUT, "refs"), { recursive: true });
mkdirSync(join(OUT, "samples"), { recursive: true });
const browser = await chromium.launch({ executablePath });
try {
  // References: the committed wordmark, plus an icon badge rendered for each brand.
  for (const brand of BRANDS) {
    copyFileSync(join(FIXTURES, `${brand.slug}.png`), join(OUT, "refs", `${brand.slug}-wordmark.png`));
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    await page.setContent(
      `<div style="width:256px;height:256px;background:${brand.colour};color:#fff;display:flex;align-items:center;justify-content:center;font-family:Arial;font-weight:bold;font-size:96px">${brand.initials}</div>`,
    );
    const shot = await page.screenshot({ type: "png" });
    writeFileSync(join(OUT, "refs", `${brand.slug}-icon.png.tmp`), shot);
    renameSync(join(OUT, "refs", `${brand.slug}-icon.png.tmp`), join(OUT, "refs", `${brand.slug}-icon.png`));
    await page.close();
  }
  const samples: Sample[] = [];
  const shownKinds: Sample["shown"][] = ["wordmark", "icon", "dark", "other", "none"];
  for (const brand of BRANDS) {
    const other = BRANDS.find((b) => b.slug !== brand.slug) as (typeof BRANDS)[number];
    for (const shown of shownKinds) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const scale = repeat === 0 ? 1 : 0.6;
        const left = 24 + repeat * 80;
        const top = 20 + repeat * 14;
        let logoHtml = "";
        let logoBox: Sample["logo"] = null;
        if (shown === "wordmark" || shown === "other") {
          const shownBrand = shown === "wordmark" ? brand : other;
          const w = Math.round(360 * scale);
          const h = Math.round(112 * scale);
          logoHtml = `<div style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:${shownBrand.colour};color:#fff;display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;font-family:Arial"><b>${shownBrand.initials}</b><span>${shownBrand.brand}</span></div>`;
          logoBox = { left, top, right: left + w, bottom: top + h };
        } else if (shown === "icon") {
          const side = Math.round(96 * scale);
          logoHtml = `<div style="position:absolute;left:${left}px;top:${top}px;width:${side}px;height:${side}px;background:${brand.colour};color:#fff;display:flex;align-items:center;justify-content:center;font-family:Arial;font-weight:bold;font-size:${Math.round(34 * scale)}px">${brand.initials}</div>`;
          logoBox = { left, top, right: left + side, bottom: top + side };
        } else if (shown === "dark") {
          const w = Math.round(360 * scale);
          const h = Math.round(112 * scale);
          logoHtml = `<div style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:#111827;color:#fff;display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;font-family:Arial"><b>${brand.initials}</b><span>${brand.brand}</span></div>`;
          logoBox = { left, top, right: left + w, bottom: top + h };
        }
        const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
        await page.setContent(
          `<!doctype html><html><body style="margin:0;font-family:Arial;background:#fff">${logoHtml}<div style="position:absolute;left:24px;top:220px;width:700px;font-size:16px;line-height:1.5"><p>Dear customer,</p><p>Your statement from ${brand.brand} is ready.</p></div></body></html>`,
        );
        const file = `${brand.slug}-${shown}-${repeat + 1}.png`;
        const png = await page.screenshot({ type: "png" });
        writeFileSync(join(OUT, "samples", `${file}.tmp`), png);
        renameSync(join(OUT, "samples", `${file}.tmp`), join(OUT, "samples", file));
        await page.close();
        samples.push({
          file,
          brand: brand.brand,
          shown,
          expected_same: shown === "wordmark" || shown === "icon" || shown === "dark",
          width: WIDTH,
          height: HEIGHT,
          logo: logoBox,
        });
      }
    }
  }
  writeFileSync(join(OUT, "labels.json.tmp"), `${JSON.stringify({ version: 1, samples }, null, 1)}\n`);
  renameSync(join(OUT, "labels.json.tmp"), join(OUT, "labels.json"));
  console.log(`make-logo-variants: ${samples.length} samples`);
} finally {
  await browser.close();
}
