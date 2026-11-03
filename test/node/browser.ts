import { existsSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(import.meta.dirname, "../../public");

import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright-core";

// The Chromium every browser test uses, shared with the Loupe data scripts.
export { chromiumPath } from "../../scripts/lib/chromium.ts";

import { chromiumPath } from "../../scripts/lib/chromium.ts";

// Chromium driven by playwright-core (real keyboard and mouse input), sandboxed and offline: every request but loopback
// goes to a proxy nothing listens on.
export function launch(): Promise<Browser> {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  return chromium.launch({
    executablePath,
    chromiumSandbox: true,
    args: ["--proxy-server=127.0.0.1:9", "--no-first-run"],
  });
}

export type Focus = {
  key: string;
  tag: string;
  outline: string;
  border: string;
  borderColor: string;
  contrast: number;
  opaque: boolean;
};

// The focused element and its focus indicator (either its outline or, for a one-border field or combobox with
// `outline: none`, its border), or null when focus is on the document itself. `key` is its id, else its
// aria-label, else its rendered text, else the alt text of the image it holds. `contrast` is the WCAG ratio of the
// indicator composited over what is really beside it (every painted ancestor's background, page first, on a 1x1 canvas,
// so any colour syntax and any alpha count as a viewer sees them) against that background; `opaque` says the background
// behind it is fully painted.
export function focused(page: Page): Promise<Focus | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const pixel = (fill: string[]) => {
      const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
      if (!ctx) throw new Error("no canvas");
      for (const colour of fill) {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
      }
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const s = getComputedStyle(el);
    const behind: string[] = [];
    for (let node = el.parentElement; node; node = node.parentElement)
      behind.unshift(getComputedStyle(node).backgroundColor);
    const beside = pixel(behind);
    const indicator = s.outlineStyle !== "none" ? s.outlineColor : s.borderTopColor;
    const ring = luminance(pixel([...behind, indicator]));
    const page = luminance(beside);
    const [hi, lo] = ring > page ? [ring, page] : [page, ring];
    return {
      key:
        el.id ||
        el.getAttribute("aria-label") ||
        // biome-ignore lint/performance/useDomNodeTextContent: the rendered text, with the space layout puts between a badge and a name
        el.innerText.replace(/\s+/g, " ").trim() ||
        el.querySelector("img")?.getAttribute("alt") ||
        "",
      tag: el.tagName.toLowerCase(),
      outline: `${s.outlineStyle} ${s.outlineWidth}`,
      border: `${s.borderTopStyle} ${s.borderTopWidth}`,
      borderColor: s.borderTopColor,
      contrast: (hi + 0.05) / (lo + 0.05),
      opaque: beside[3] === 255,
    };
  });
}

// A rendered page at http://app.test/ with the files under public/ served as the Worker serves them, so the page loads
// the shipped stylesheet, fonts and logos with no network. Options set the viewport, colour scheme and scripts.
export async function openPage(browser: Browser, html: string, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.route("http://app.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
    const file = join(PUBLIC, path);
    if (!path.startsWith("/static/") || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto("http://app.test/");
  return page;
}
