// Turning a public dataset's page into what the Loupe store keeps (D03 T04 §5): a screenshot the store accepts and the
// page's visible text. Each is done by the tool that owns the format: sharp decodes and re-encodes the image, and
// Chromium (inert: no JavaScript, no network) lays the HTML out and reads `innerText`, which already leaves out
// scripts, styles, comments and everything CSS or `hidden` keeps off the screen.
import { type Browser, chromium } from "playwright-core";
import sharp, { type Sharp } from "sharp";
import { chromiumPath } from "../lib/chromium.ts";
import { MAX_HEIGHT, MAX_WIDTH } from "./store.ts";

// A source image as a JPEG the store accepts: at most 1280 px wide (scaled down, never up) and 2000 px tall (cropped
// from the top, where a page's identity sits), decoded at sharp's strictest so a damaged file is refused here.
export async function normaliseScreenshot(bytes: Uint8Array): Promise<Uint8Array> {
  let image: Sharp;
  let width: number;
  let height: number;
  try {
    const decoded = await sharp(bytes, { failOn: "warning", limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    image = sharp(decoded.data);
    ({ width, height } = decoded.info);
  } catch (error) {
    throw new TypeError(`the image does not decode (${(error as Error).message.split("\n")[0]})`);
  }
  if (height > MAX_HEIGHT) image = image.extract({ left: 0, top: 0, width, height: MAX_HEIGHT });
  return new Uint8Array(await image.flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer());
}

// One inert browser for many pages: open it once, read every page through it, close it.
export async function openTextReader(): Promise<{
  visibleText: (html: string) => Promise<string>;
  close: () => Promise<void>;
}> {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const browser: Browser = await chromium.launch({
    executablePath,
    chromiumSandbox: true,
    args: ["--proxy-server=127.0.0.1:9", "--no-first-run"],
  });
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
  // Nothing a dataset page names is fetched: its own scripts, images and fonts are refused.
  await context.route("**/*", (route) => route.abort());
  async function visibleText(html: string): Promise<string> {
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
      // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point; textContent keeps what CSS hides
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return text
        .replace(/[ \t\f\v\r]+/g, " ")
        .replace(/ *\n[\n ]*/g, "\n")
        .trim();
    } finally {
      await page.close();
    }
  }
  return { visibleText, close: () => browser.close() };
}
