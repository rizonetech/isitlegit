// Turning a public dataset's page into what the Loupe store keeps (D03 T04 §5): a screenshot the store accepts and the
// page's visible text. Each is done by the tool that owns the format: sharp decodes and re-encodes the image, and
// Chromium (inert: no JavaScript, no network) lays the HTML out and reads `innerText`, which already leaves out
// scripts, styles, comments and everything CSS or `hidden` keeps off the screen.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

// A dataset's HTML bytes as text, in the encoding the page declares, as a browser reads it: a byte order mark first,
// then the charset its transport declared (a mail part's `Content-Type`), then a `<meta charset>` or `http-equiv`
// content type in the first 1,024 bytes, else UTF-8 when the bytes are UTF-8, else Windows-1252. A Shift_JIS or
// windows-1251 page decoded as UTF-8 would train Loupe on mojibake.
export function decodeHtml(bytes: Uint8Array, declaredByTransport?: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  if (declaredByTransport) {
    try {
      return new TextDecoder(declaredByTransport).decode(bytes);
    } catch {
      // a label the decoder does not know: the page's own declaration or the bytes decide
    }
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const declared = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // a label the decoder does not know: the page is read as UTF-8, the web's default
    }
  }
  // Undeclared: UTF-8 when the bytes are UTF-8, else Windows-1252, the single-byte charset undeclared mail and pages
  // most often are (an accented name in it would otherwise read as replacement characters, out of every rule's reach).
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export class PageTimeout extends Error {}

// A browser call that may never answer, given 5 seconds: true when it finished, false when it failed or ran out.
// (The Kempf import hung for 30 minutes on 2026-10-29 with every worker waiting on such a call.)
export async function bounded(work: Promise<unknown>, ms = 5_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type FormFlags = { has_login_form: boolean; has_payment_form: boolean };

// The page's form flags from its DOM, as the screener's prompt defines them (`src/vision/page-screen.ts`): a login form
// asks for a username, email or password; a payment form for card details. Only visible fields count, in the page or
// in any frame the page can read; a payment provider's frame counts by its host. Run inside the page.
// `region`: the part of this document the screenshot shows, in its own coordinates (a frame's visible area, clipped by
// every frame around it); a field outside it is not seen. Without one, the document's width bounds it. `descend`: read
// the fields of same-origin frames inside too (the dataset reader, which reads one document); the render reads every
// frame on its own, each with its own region, so it does not.
export function readFormFlags(
  options: { region?: { left: number; top: number; right: number; bottom: number }; descend?: boolean } = {},
): FormFlags {
  const { region, descend = true } = options;
  const providers = /(stripe|braintree|adyen|checkout\.com|paypal|payfast|peach|paygate|yoco|ozow|square|klarna)/i;
  // The browser's own reading of an element, not a method the page left on it: a bot-detection script gives a hidden
  // frame its own `getBoundingClientRect` and `checkVisibility` that return nothing (Game, Makro, Nexstar, 2026-10-29).
  const rect = (el: Element) => Element.prototype.getBoundingClientRect.call(el);
  // What of an element's box its ancestors let show: each ancestor that clips its overflow (`height: 0; overflow:
  // hidden` hides a whole form) cuts the box to its own; `checkVisibility` does not see that clipping.
  const clipped = (el: Element) => {
    const box = rect(el);
    let { left, top, right, bottom } = box;
    // Up through every ancestor, across a shadow root to its host: a clipping host hides the fields drawn inside it.
    const up = (node: Element) =>
      node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
    for (let at = up(el); at && left < right && top < bottom; at = up(at)) {
      const style = getComputedStyle(at);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const outer = rect(at);
      if (style.overflowX !== "visible") {
        left = Math.max(left, outer.left);
        right = Math.min(right, outer.right);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, outer.top);
        bottom = Math.min(bottom, outer.bottom);
      }
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  // Seen by a viewer: a box, on the page, and not hidden by itself or an ancestor (display, visibility or opacity 0).
  const visible = (el: Element) => {
    const box = clipped(el);
    // Off the page to the left, above it, or to the right of the 1280-pixel viewport no viewer scrolls across.
    if (box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth) return false;
    if (
      region &&
      (box.right <= region.left || box.left >= region.right || box.bottom <= region.top || box.top >= region.bottom)
    )
      return false;
    if (!Element.prototype.checkVisibility.call(el, { opacityProperty: true, visibilityProperty: true })) return false;
    return onTop(el, box);
  };
  // Not painted over: at one of a few points of its visible box (its centre and four points inset from its corners),
  // the topmost element is the field itself or inside it. An opaque panel above a form hides it from the screenshot.
  // Points outside the viewport cannot be asked; a box wholly outside it counts as seen as before.
  const onTop = (el: Element, box: { left: number; top: number; right: number; bottom: number }) => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const xs = [box.left + 2, (box.left + box.right) / 2, box.right - 2];
    const ys = [box.top + 2, (box.top + box.bottom) / 2, box.bottom - 2];
    let asked = false;
    for (const x of xs)
      for (const y of ys) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        asked = true;
        const hit = root.elementFromPoint(x, y);
        if (hit && (hit === el || Node.prototype.contains.call(el, hit))) return true;
      }
    return !asked;
  };
  // A document's inputs, those inside open shadow roots included (a sign-in widget often draws its fields in one).
  const inputsOf = (root: Document | ShadowRoot): HTMLInputElement[] => {
    const found = [...root.querySelectorAll("input")];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...inputsOf(el.shadowRoot));
    return found;
  };
  const login = (doc: Document) =>
    inputsOf(doc).some((input) => {
      if (input.type === "hidden" || !visible(input)) return false;
      if (input.type === "password" || input.type === "email") return true;
      const hint = [input.autocomplete, input.name, input.id, input.placeholder, input.getAttribute("aria-label")]
        .concat(input.labels ? [...input.labels].map((label) => label.textContent ?? "") : [])
        .join(" ")
        .toLowerCase();
      return /\b(username|user ?name|user id|e-?mail|login|log in|sign ?in)\b/.test(hint);
    });
  // A card field by its autocomplete hint, or by what its name, id, placeholder, aria label or label says.
  const card =
    /\b(card ?(number|no\.?|num)|cardnumber|ccnum|cc-?number|credit ?card|debit ?card|cvv2?|cvc2?|csc|security code|expiry|expiration|exp(iry)? ?date|mm ?\/ ?yy)\b/i;
  const payment = (doc: Document) =>
    inputsOf(doc).some((input) => {
      if (input.type === "hidden" || !visible(input)) return false;
      if (/^cc-(number|exp|csc)/.test(input.autocomplete)) return true;
      const hint = [input.name, input.id, input.placeholder, input.getAttribute("aria-label")]
        .concat(input.labels ? [...input.labels].map((label) => label.textContent ?? "") : [])
        .join(" ")
        .replace(/[_-]/g, " ");
      return card.test(hint);
    }) || [...doc.querySelectorAll("iframe")].some((frame) => visible(frame) && providers.test(frame.src || ""));
  const docs: Document[] = [document];
  for (const frame of descend ? document.querySelectorAll("iframe") : []) {
    try {
      // A field's own visibility stops at its frame: a frame no one can see shows none of its fields.
      // Nor does one below the 2000 pixels the screenshot keeps (`MAX_HEIGHT`; this runs in the page, so the number is
      // written here).
      if (visible(frame) && rect(frame).top < 2000 && frame.contentDocument) docs.push(frame.contentDocument);
    } catch {
      // a cross-origin frame cannot be read; a payment provider's is still counted by its host above
    }
  }
  return { has_login_form: docs.some(login), has_payment_form: docs.some(payment) };
}

// The text a viewer sees. `innerText` of an element that is not rendered is its whole `textContent`, so a page whose
// body (or root) is hidden would pass its hidden text off as visible: such a page shows nothing. Run inside the page.
export function shownText(): string {
  const body = document.body;
  if (!body) return "";
  // The browser's own methods and inline style, never ones the page left on an element (see `readFormFlags`).
  const seen = (el: Element) =>
    Element.prototype.checkVisibility.call(el, { opacityProperty: true, visibilityProperty: true });
  const inline = (el: Element): CSSStyleDeclaration | undefined => {
    for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
      const getter = Object.getOwnPropertyDescriptor(proto, "style")?.get;
      if (getter) return getter.call(el);
    }
    return undefined; // an element of no styled namespace cannot be hidden by its own style
  };
  // A body that display, visibility or opacity 0 hides (on itself or the root) shows nothing: `checkVisibility` reads
  // the element and its ancestors.
  if (!seen(body)) return "";
  // `innerText` leaves out what display and visibility hide, but not what opacity 0 or a position off the page hides.
  // Those elements (the outermost of each) leave the layout while the text is read, and are put back after, so the
  // screenshot that follows sees the page as it was.
  // Clipped away by an ancestor that hides its overflow (`height: 0; overflow: hidden`): drawn nowhere, so not seen,
  // as `readFormFlags` judges a field.
  const clippedAway = (el: Element) => {
    const box = Element.prototype.getBoundingClientRect.call(el);
    if (box.width <= 0 || box.height <= 0) return false; // an empty box is judged by its children
    let { left, top, right, bottom } = box;
    for (let at = el.parentElement; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const outer = Element.prototype.getBoundingClientRect.call(at);
      if (style.overflowX !== "visible") {
        left = Math.max(left, outer.left);
        right = Math.min(right, outer.right);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, outer.top);
        bottom = Math.min(bottom, outer.bottom);
      }
      if (left >= right || top >= bottom) return true;
    }
    return false;
  };
  const hidden: Element[] = [];
  for (const el of body.querySelectorAll("*")) {
    if (hidden.some((outer) => Node.prototype.contains.call(outer, el))) continue;
    const box = Element.prototype.getBoundingClientRect.call(el);
    const offPage = box.width > 0 && box.height > 0 && (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth);
    if (offPage || !seen(el) || clippedAway(el)) hidden.push(el);
  }
  const saved = hidden.flatMap((el) => {
    const style = inline(el);
    return style ? [[style, style.getPropertyValue("display"), style.getPropertyPriority("display")] as const] : [];
  });
  for (const [style] of saved) style.setProperty("display", "none", "important");
  try {
    // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point; textContent keeps what CSS hides
    const parts = [body.innerText];
    // `innerText` leaves out what open shadow roots draw: each shown host's root adds its own rendered text.
    const shadows = (root: ParentNode) => {
      for (const el of root.querySelectorAll("*")) {
        if (!el.shadowRoot || !seen(el)) continue;
        // A root's own text nodes ("Press & Hold" set as its text) and each shown element's rendered text.
        for (const node of el.shadowRoot.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()) parts.push(node.nodeValue);
          // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point
          else if (node instanceof HTMLElement && seen(node) && node.innerText.trim()) parts.push(node.innerText);
        }
        shadows(el.shadowRoot);
      }
    };
    shadows(body);
    return parts.join("\n");
  } finally {
    for (const [style, value, priority] of saved) {
      if (value) style.setProperty("display", value, priority);
      else style.removeProperty("display");
    }
  }
}

export type RenderedHtml = { screenshot: Uint8Array; text: string; drawn?: string } & FormFlags;

// The CSS properties that draw a picture, as the browser computes them.
const PICTURE_PROPERTIES = [
  "background-image",
  "border-image-source",
  "list-style-image",
  "mask-image",
  "-webkit-mask-image",
  "content",
];

// Every picture out of a page, by the browser's own reading of it (D03 T04 §7): picture elements removed, and every
// picture property of every element set to `none` with an inline `!important`, which outranks any stylesheet rule
// however it is written, escaped or not. Run inside the page.
export function removePictures(properties: string[]): void {
  for (const el of document.querySelectorAll(
    "img, picture, source, video, audio, svg, canvas, object, embed, iframe, frame, input[type=image]",
  ))
    el.remove();
  for (const el of document.querySelectorAll<HTMLElement | SVGElement>("*"))
    for (const property of properties) el.style.setProperty(property, "none", "important");
  // Pseudo-elements take no inline style: a last stylesheet covers them, and `picturesLeft` refuses any it misses.
  const sheet = document.createElement("style");
  sheet.textContent = `*::before, *::after, *::marker { ${properties.map((p) => `${p}: none !important;`).join(" ")} }`;
  document.head?.append(sheet) ?? document.documentElement.append(sheet);
}

// Text the page draws that `innerText` leaves out: form controls' values and placeholders, and option labels, decoded by
// the browser (character references and all) as the screenshot shows them. Run inside the page.
export function controlText(): string {
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
    "input, textarea, button",
  )) {
    if ((el as HTMLInputElement).type === "hidden" || (el as HTMLInputElement).type === "password") continue;
    if (el.value) out.push(el.value);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) out.push(placeholder);
  }
  for (const option of document.querySelectorAll("option")) if (option.label) out.push(option.label);
  return out.join("\n");
}

// How many elements or pseudo-elements still draw a picture, as the browser computes them. Run inside the page.
export function picturesLeft(properties: string[]): number {
  let left = document.querySelectorAll(
    "img, picture, video, svg, canvas, object, embed, iframe, frame, input[type=image]",
  ).length;
  for (const el of document.querySelectorAll("*"))
    for (const pseudo of [null, "::before", "::after", "::marker"]) {
      const style = getComputedStyle(el, pseudo);
      if (properties.some((property) => /url\(|image-set\(|image\(/i.test(style.getPropertyValue(property)))) left++;
    }
  return left;
}

// One inert browser for many pages: open it once, read every page through it, close it. Nothing runs and nothing is
// fetched (no JavaScript; every request refused), so a dataset's phishing HTML is laid out as a picture, never live.
// A page gets 30 seconds in all. Playwright's `evaluate` has no time limit of its own, and one page that never answers
// held all four import workers for good (CompPhish, 2026-10-28): a page past its deadline fails, and its browser is
// closed and replaced, since a renderer that stopped answering may not close a page either.
export const PAGE_DEADLINE_MS = 30_000;

// A render fault that belongs to the attempt, not the page: Chromium's "Unable to capture screenshot".
export function passingRenderFault(error: unknown): boolean {
  return /Unable to capture screenshot/i.test(String((error as Error)?.message));
}

// The processes carrying a marker, as pids; none when nothing matches (pgrep exits 1).
function marked(marker: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", "--", marker]).toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Ends every process carrying `marker` and returns only once none is left. One `pkill` is not enough on a loaded host: the
// browser forks helpers (zygote, GPU, renderer) while it is being killed, and one forked after the signal was sent
// outlives it. The kill is repeated until a look finds none, for at most `limitMs`; it reports what is still alive.
export async function endMarked(marker: string, limitMs = 10_000): Promise<string[]> {
  const until = Date.now() + limitMs;
  for (;;) {
    try {
      execFileSync("pkill", ["-KILL", "-f", "--", marker]);
    } catch {
      // pkill exits 1 when no process matched
    }
    await new Promise((done) => setTimeout(done, 50));
    const left = marked(marker);
    if (!left.length || Date.now() >= until) return left;
  }
}

export async function openTextReader(
  options: {
    pageMs?: number;
    closeBrowser?: (browser: Browser) => Promise<void>;
    // A fault to raise when a page is captured (tests make Chromium's capture fail); none otherwise.
    captureFault?: () => Error | null;
  } = {},
): Promise<{
  visibleText: (html: string) => Promise<string>;
  renderHtml: (html: string, options?: { pictures?: boolean }) => Promise<RenderedHtml>;
  launches: () => number;
  dropBrowser: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const captureFault = options.captureFault;
  const found = chromiumPath();
  if (!found) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const executablePath: string = found;
  // A crashed browser (a huge page can take Chromium down) is replaced, not left to fail every page after it.
  type Session = { browser: Browser; context: BrowserContext; marker: string };
  let session: Promise<Session> | null = null;
  let launched = 0;
  async function launch(): Promise<Session> {
    launched++;
    // A switch Chromium ignores, naming this one browser, so a browser that will not close can still be ended.
    const marker = `--glimmer-reader=${randomUUID()}`;
    const browser = await chromium.launch({
      executablePath,
      chromiumSandbox: true,
      args: ["--proxy-server=127.0.0.1:9", "--no-first-run", marker],
    });
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: { width: 1280, height: MAX_HEIGHT },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    // Nothing a dataset page names is fetched: its own scripts, images and fonts are refused.
    // Refused as `aborted` (net::ERR_ABORTED), which Chromium never replaces the page with an error page for: a page's
    // `<meta http-equiv=refresh>` then stays the page it is, instead of navigating away mid-read.
    await context.route("**/*", (route) => route.abort("aborted"));
    browser.on("disconnected", () => {
      session = null;
    });
    return { browser, context, marker };
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
  // A browser closed within 5 seconds, or ended by its marker: one that will not close must not hold the process open
  // (an import finished its work and then waited on such a browser for four hours, 2026-10-29).
  async function end(entry: Session): Promise<void> {
    if (await bounded((options.closeBrowser ?? ((browser) => browser.close()))(entry.browser))) return;
    await endMarked(entry.marker);
  }
  async function withPage<T>(html: string, read: (page: Page) => Promise<T>, retried = false): Promise<T> {
    const mine = current();
    const entry = await mine;
    const { browser, context } = entry;
    // A browser that died under several workers is replaced once: each clears the shared session only while it still
    // holds the session that died, so a later worker never drops a replacement an earlier one already launched.
    const forget = () => {
      if (session === mine) session = null;
    };
    let page: Page | undefined;
    let timer: NodeJS.Timeout | undefined;
    const deadline = options.pageMs ?? PAGE_DEADLINE_MS;
    try {
      const work = (async () => {
        page = await context.newPage();
        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
        return await read(page);
      })();
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PageTimeout(`the page did not render within ${deadline / 1000} seconds`)),
          deadline,
        );
      });
      return await Promise.race([work, late]);
    } catch (error) {
      if (error instanceof PageTimeout) {
        // The renderer stopped answering: this browser is dropped (its pages with it) and the next page gets a new one.
        forget();
        page = undefined;
        await end(entry);
        throw error;
      }
      // The browser went away under this page: start a fresh one and try the page once more. A page can fail with the
      // closure before Playwright marks the browser disconnected, so the error itself counts too.
      const gone =
        !browser.isConnected() ||
        /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(
          String((error as Error)?.message),
        );
      if (gone && !retried) {
        forget();
        return withPage(html, read, true);
      }
      // A capture the compositor failed to take (a loaded host, 2026-10-29) is a passing fault of that one page: it is
      // tried once more in a fresh page of the same browser.
      if (passingRenderFault(error) && !retried) return withPage(html, read, true);
      throw error;
    } finally {
      clearTimeout(timer);
      // Bounded: a renderer that stopped answering may never close its page; then its browser is dropped instead.
      if (page && !(await bounded(page.close()))) {
        forget();
        void end(entry);
      }
    }
  }
  async function visibleText(html: string): Promise<string> {
    return withPage(html, async (page) => tidy(await page.evaluate(shownText)));
  }
  // `pictures: false` (the pilot client's samples): the browser removes every picture before anything is read or
  // captured, and a page it still finds one on is refused.
  async function renderHtml(html: string, options: { pictures?: boolean } = {}): Promise<RenderedHtml> {
    return withPage(html, async (page) => {
      let drawn: string | undefined;
      if (options.pictures === false) {
        await page.evaluate(removePictures, PICTURE_PROPERTIES);
        if ((await page.evaluate(picturesLeft, PICTURE_PROPERTIES)) > 0)
          throw new Error("refused: a picture survived the browser's own reading of the page");
        drawn = await page.evaluate(controlText);
      }
      const text = tidy(await page.evaluate(shownText));
      // Only the fields in the 1280 by 2000 pixels the screenshot keeps (§26).
      const flags = await page.evaluate(readFormFlags, {
        region: { left: 0, top: 0, right: 1280, bottom: MAX_HEIGHT },
      });
      // Only the top 1280 by 2000 pixels are kept, so only they are captured: a full page tens of thousands of pixels
      // tall would outgrow the decoder's pixel limit and the browser's memory.
      const fault = captureFault?.();
      if (fault) throw fault;
      const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: 1280, height: MAX_HEIGHT },
        timeout: 10_000,
      });
      return {
        screenshot: await normaliseScreenshot(new Uint8Array(shot)),
        text,
        ...flags,
        ...(drawn !== undefined ? { drawn } : {}),
      };
    });
  }
  return {
    visibleText,
    renderHtml,
    // How many browsers this reader has launched: one, plus one for each that died.
    launches: () => launched,
    // Closes the current browser as a crash would, under whatever pages it is rendering (the tests' crash).
    dropBrowser: async () => {
      if (session) await (await session).browser.close();
    },
    close: async () => {
      const open = session;
      session = null;
      if (open) await end(await open);
    },
  };
}
