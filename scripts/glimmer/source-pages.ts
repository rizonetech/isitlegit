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

export type FormFlags = { has_login_form: boolean; has_payment_form: boolean };

// The page's form flags from its DOM, as the screener's prompt defines them (`src/vision/page-screen.ts`): a login form
// asks for a username, email or password; a payment form for card details. Only visible fields count, in the page or
// in any frame the page can read; a payment provider's frame counts by its host. Run inside the page.
export function readFormFlags(): FormFlags {
  const providers = /(stripe|braintree|adyen|checkout\.com|paypal|payfast|peach|paygate|yoco|ozow|square|klarna)/i;
  const visible = (el: Element) => {
    const box = (el as HTMLElement).getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const login = (doc: Document) =>
    [...doc.querySelectorAll("input")].some((input) => {
      if (input.type === "hidden" || !visible(input)) return false;
      if (input.type === "password" || input.type === "email") return true;
      const hint = [input.autocomplete, input.name, input.id, input.placeholder, input.getAttribute("aria-label")]
        .concat(input.labels ? [...input.labels].map((label) => label.textContent ?? "") : [])
        .join(" ")
        .toLowerCase();
      return /\b(username|user ?name|user id|e-?mail|login|log in|sign ?in)\b/.test(hint);
    });
  const payment = (doc: Document) =>
    [...doc.querySelectorAll("input")].some(
      (input) => visible(input) && /^cc-(number|exp|csc)/.test(input.autocomplete),
    ) || [...doc.querySelectorAll("iframe")].some((frame) => visible(frame) && providers.test(frame.src || ""));
  const docs: Document[] = [document];
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      if (frame.contentDocument) docs.push(frame.contentDocument);
    } catch {
      // a cross-origin frame cannot be read; a payment provider's is still counted by its host above
    }
  }
  return { has_login_form: docs.some(login), has_payment_form: docs.some(payment) };
}

export type RenderedHtml = { screenshot: Uint8Array; text: string } & FormFlags;

// One inert browser for many pages: open it once, read every page through it, close it. Nothing runs and nothing is
// fetched (no JavaScript; every request refused), so a dataset's phishing HTML is laid out as a picture, never live.
export async function openTextReader(): Promise<{
  visibleText: (html: string) => Promise<string>;
  renderHtml: (html: string) => Promise<RenderedHtml>;
  close: () => Promise<void>;
}> {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const browser: Browser = await chromium.launch({
    executablePath,
    chromiumSandbox: true,
    args: ["--proxy-server=127.0.0.1:9", "--no-first-run"],
  });
  const context = await browser.newContext({
    javaScriptEnabled: false,
    offline: true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  // Nothing a dataset page names is fetched: its own scripts, images and fonts are refused.
  await context.route("**/*", (route) => route.abort());
  const tidy = (text: string) =>
    text
      .replace(/[ \t\f\v\r]+/g, " ")
      .replace(/ *\n[\n ]*/g, "\n")
      .trim();
  async function withPage<T>(html: string, read: (page: import("playwright-core").Page) => Promise<T>): Promise<T> {
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
      return await read(page);
    } finally {
      await page.close();
    }
  }
  async function visibleText(html: string): Promise<string> {
    // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point; textContent keeps what CSS hides
    return withPage(html, async (page) => tidy(await page.evaluate(() => document.body?.innerText ?? "")));
  }
  async function renderHtml(html: string): Promise<RenderedHtml> {
    return withPage(html, async (page) => {
      // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point; textContent keeps what CSS hides
      const text = tidy(await page.evaluate(() => document.body?.innerText ?? ""));
      const flags = await page.evaluate(readFormFlags);
      const shot = await page.screenshot({ type: "png", fullPage: true, timeout: 10_000 });
      return { screenshot: await normaliseScreenshot(new Uint8Array(shot)), text, ...flags };
    });
  }
  return { visibleText, renderHtml, close: () => browser.close() };
}
