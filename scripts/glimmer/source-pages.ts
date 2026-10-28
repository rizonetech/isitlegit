// Turning a public dataset's page into what the Loupe store keeps (D03 T04 §5): a screenshot the store accepts and the
// page's visible text. Each is done by the tool that owns the format: sharp decodes and re-encodes the image, and
// Chromium (inert: no JavaScript, no network) lays the HTML out and reads `innerText`, which already leaves out
// scripts, styles, comments and everything CSS or `hidden` keeps off the screen.
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
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
  const found = chromiumPath();
  if (!found) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const executablePath: string = found;
  // A crashed browser (a huge page can take Chromium down) is replaced, not left to fail every page after it.
  let session: Promise<{ browser: Browser; context: BrowserContext }> | null = null;
  async function launch(): Promise<{ browser: Browser; context: BrowserContext }> {
    const browser = await chromium.launch({
      executablePath,
      chromiumSandbox: true,
      args: ["--proxy-server=127.0.0.1:9", "--no-first-run"],
    });
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: { width: 1280, height: MAX_HEIGHT },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    // Nothing a dataset page names is fetched: its own scripts, images and fonts are refused.
    await context.route("**/*", (route) => route.abort());
    browser.on("disconnected", () => {
      session = null;
    });
    return { browser, context };
  }
  const current = () => {
    session ??= launch();
    return session;
  };
  const tidy = (text: string) =>
    text
      .replace(/[ \t\f\v\r]+/g, " ")
      .replace(/ *\n[\n ]*/g, "\n")
      .trim();
  async function withPage<T>(html: string, read: (page: Page) => Promise<T>, retried = false): Promise<T> {
    const { browser, context } = await current();
    let page: Page | undefined;
    try {
      page = await context.newPage();
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
      return await read(page);
    } catch (error) {
      // The browser went away under this page: start a fresh one and try the page once more.
      if (!browser.isConnected() && !retried) {
        session = null;
        return withPage(html, read, true);
      }
      throw error;
    } finally {
      await page?.close().catch(() => undefined); // a page of a crashed browser has nothing left to close
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
      // Only the top 1280 by 2000 pixels are kept, so only they are captured: a full page tens of thousands of pixels
      // tall would outgrow the decoder's pixel limit and the browser's memory.
      const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: 1280, height: MAX_HEIGHT },
        timeout: 10_000,
      });
      return { screenshot: await normaliseScreenshot(new Uint8Array(shot)), text, ...flags };
    });
  }
  return {
    visibleText,
    renderHtml,
    close: async () => {
      const open = session;
      session = null;
      if (open) await (await open).browser.close();
    },
  };
}
