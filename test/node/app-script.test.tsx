import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filtersFrom } from "../../src/db/case-filters";
import { AppShell, CHECK_ADDRESS } from "../../src/web/components/AppShell.tsx";
import { Document } from "../../src/web/components/Document.tsx";
import { CasesPage } from "../../src/web/pages/cases-view";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// htmx and the app script in a real browser (D07 T01 §9), loaded by `Document`'s own tags from the fingerprinted files
// the Worker serves: an `hx-get` swaps its answer in, and the member shell's copy button copies the check address,
// says so on its status line (visible and announced), resets, and when the clipboard refuses says how to copy by hand
// and selects the address. At desktop width and at 360 px (behind the phone Menu), in both themes, by mouse and keys.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");

function page(theme: "light" | "dark"): string {
  const body = String(
    <Document title="Cases">
      <AppShell {...member()}>
        <h1>Cases</h1>
        <button type="button" hx-get="/fragment" hx-target="#target" hx-swap="innerHTML">
          Load
        </button>
        <div id="target">
          <p id="old">Not loaded yet</p>
        </div>
      </AppShell>
    </Document>,
  );
  return body.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
}

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

type Clipboard = "granted" | "denied" | "absent";

// The page on the app's own origin (localhost is a secure context): the document, the built files from public/static/
// and the htmx fragment. `clipboard` decides what the browser's clipboard does.
async function open(options: { theme?: "light" | "dark"; width?: number; clipboard?: Clipboard } = {}) {
  const { theme = "light", width = 1280, clipboard = "granted" } = options;
  const context: BrowserContext = await browser.newContext({ viewport: { width, height: 900 } });
  if (clipboard === "granted") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  const p: Page = await context.newPage();
  if (clipboard === "denied")
    await p.addInitScript(() => {
      navigator.clipboard.writeText = () =>
        Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    });
  if (clipboard === "absent")
    await p.addInitScript(() => Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined }));
  await p.clock.install();
  await p.route(`${APP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/cases") return route.fulfill({ status: 200, contentType: "text/html", body: page(theme) });
    if (path === "/fragment")
      return route.fulfill({ status: 200, contentType: "text/html", body: '<p id="swapped">Loaded by htmx</p>' });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/cases`);
  // The scripts run once the page is parsed: htmx sets `window.htmx`, and the app script is a deferred module.
  await p.waitForFunction(() => "htmx" in window);
  if (width < 768) await p.getByRole("button", { name: "Menu" }).click();
  return { p, context };
}

// The Cases first-run page (D07 T01 §14): the copy group on the page itself, so a phone copies with one press
// without opening Menu. Rendered as the route renders it, with no cases yet.
function firstRunPage(theme: "light" | "dark"): string {
  const body = String(
    <CasesPage
      shell={member()}
      list={{ cases: [], page: 1, pages: 1, matching: 0, total: 0 }}
      filters={filtersFrom(new URLSearchParams())}
      senders={{ domains: [], addresses: [] }}
      stats={{
        thisWeek: {
          weekStart: "2026-10-25T22:00:00.000Z",
          checked: 0,
          malicious: 0,
          suspicious: 0,
          safe: 0,
          unfinished: 0,
          kinds: { phishing: 0, invoice: 0, impersonation: 0 },
          medianSecondsToVerdict: null,
        },
        lastWeekChecked: 0,
      }}
      now={new Date("2026-10-30T12:00:00Z")}
    />,
  );
  return body.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
}

async function openFirstRun(options: { theme?: "light" | "dark"; clipboard?: Clipboard } = {}) {
  const { theme = "light", clipboard = "granted" } = options;
  const context: BrowserContext = await browser.newContext({ viewport: { width: 360, height: 900 } });
  if (clipboard !== "absent") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  const p: Page = await context.newPage();
  if (clipboard === "denied")
    await p.addInitScript(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      let refused = false;
      navigator.clipboard.writeText = (text: string) => {
        if (!refused) {
          refused = true;
          return Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
        }
        return original(text);
      };
    });
  if (clipboard === "absent")
    await p.addInitScript(() => Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined }));
  await p.clock.install();
  await p.route(`${APP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/cases") return route.fulfill({ status: 200, contentType: "text/html", body: firstRunPage(theme) });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/cases`);
  await p.waitForFunction(() => "htmx" in window);
  return { p, context };
}

const copyButton = (p: Page) => p.getByRole("button", { name: "Copy the check address" });
const status = (p: Page) => p.locator("[data-copy-status]");
// The status line's text once a press has had its moment: the outcome is written 100 ms after the line is emptied, on
// the page's installed clock, which the poll moves on.
const settled = (p: Page) => async () => {
  await p.clock.runFor(50);
  return status(p).textContent();
};

// The WCAG ratio of the status line's text against what is painted behind it.
function contrast(p: Page): Promise<number> {
  return p.evaluate(() => {
    const el = document.querySelector("[data-copy-status]") as HTMLElement;
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
    const behind: string[] = [];
    for (let node: HTMLElement | null = el; node; node = node.parentElement)
      behind.unshift(getComputedStyle(node).backgroundColor);
    const back = luminance(pixel(behind));
    const fore = luminance(pixel([...behind, getComputedStyle(el).color]));
    const [hi, lo] = fore > back ? [fore, back] : [back, fore];
    return (hi + 0.05) / (lo + 0.05);
  });
}

describe.skipIf(!chromiumPath() && !process.env.CI)("htmx and the app script in Chromium", { timeout: 60_000 }, () => {
  it("runs htmx from Document's own tag: a click swaps the answer into its target", async () => {
    const { p, context } = await open();
    await p.getByRole("button", { name: "Load" }).click();
    await expect.poll(() => p.locator("#swapped").count()).toBe(1);
    expect(await p.locator("#old").count()).toBe(0);
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 360])
      it(`copies the check address and says so, visibly and announced, by mouse and keys (${theme}, ${width} px)`, async () => {
        const { p, context } = await open({ theme, width });
        expect(await status(p).getAttribute("role")).toBe("status");
        expect(await status(p).getAttribute("aria-live")).toBe("polite");
        await copyButton(p).click();
        await expect.poll(settled(p)).toBe("Copied");
        expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(CHECK_ADDRESS);
        expect(await status(p).isVisible()).toBe(true);
        expect(await contrast(p)).toBeGreaterThanOrEqual(4.5);
        // It clears after 4 seconds.
        await p.clock.runFor(4_000);
        await expect.poll(settled(p)).toBe("");
        // From the keyboard: Enter, then Space.
        await p.evaluate(() => navigator.clipboard.writeText("something else"));
        await copyButton(p).focus();
        await p.keyboard.press("Enter");
        await expect.poll(settled(p)).toBe("Copied");
        expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(CHECK_ADDRESS);
        await p.keyboard.press("Space");
        await expect.poll(settled(p)).toBe("Copied");
        await context.close();
      });

  for (const clipboard of ["denied", "absent"] as const)
    it(`says how to copy by hand and selects the address when the clipboard is ${clipboard}`, async () => {
      const { p, context } = await open({ clipboard });
      await copyButton(p).click();
      await expect.poll(settled(p)).toBe("Copy failed: select the address to copy it");
      expect(await p.evaluate(() => window.getSelection()?.toString())).toBe(CHECK_ADDRESS);
      expect(await status(p).isVisible()).toBe(true);
      // The message stays until the next press, which starts again.
      await p.clock.runFor(10_000);
      expect(await status(p).textContent()).toBe("Copy failed: select the address to copy it");
      await p.evaluate(() => window.getSelection()?.removeAllRanges());
      await copyButton(p).click();
      await expect.poll(() => p.evaluate(() => window.getSelection()?.toString())).toBe(CHECK_ADDRESS);
      await context.close();
    });
  // The clearing and the outcome reach a screen reader as two changes, so the same message twice running is announced
  // twice: a MutationObserver's batches stand in for what assistive technology is told. A screen reader itself is not run.
  it("announces a repeated outcome afresh: each press empties the line, then writes it in a later batch", async () => {
    const { p, context } = await open({ clipboard: "absent" });
    await p.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      const line = document.querySelector("[data-copy-status]") as HTMLElement;
      new MutationObserver(() => seen.push(line.textContent ?? "")).observe(line, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    const failed = "Copy failed: select the address to copy it";
    for (let i = 0; i < 2; i++) {
      await copyButton(p).click();
      await expect.poll(settled(p)).toBe(failed);
    }
    // The first press finds the line empty already; the second empties it, and its words follow in a batch of their own.
    expect(await p.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([failed, "", failed]);
    await context.close();
  });

  // §14: one press on the Cases first-run page itself at 360 px, Menu closed, in both themes.
  for (const theme of ["light", "dark"] as const)
    it(`copies from the Cases first-run page with one press at 360 px (${theme})`, async () => {
      const { p, context } = await openFirstRun({ theme });
      const button = p.getByRole("button", { name: "Copy address", exact: true });
      expect(await button.isVisible()).toBe(true);
      await button.click();
      const group = p.locator("[data-copy-group]", { has: button });
      await expect
        .poll(async () => {
          await p.clock.runFor(50);
          return group.locator("[data-copy-status]").textContent();
        })
        .toBe("Copied");
      expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(CHECK_ADDRESS);
      const line = group.locator("[data-copy-status]");
      expect(await line.getAttribute("role")).toBe("status");
      expect(await line.getAttribute("aria-live")).toBe("polite");
      expect(await line.isVisible()).toBe(true);
      await context.close();
    });

  for (const theme of ["light", "dark"] as const)
    for (const clipboard of ["denied", "absent"] as const)
      it(`announces the refusal in its own group on the first-run page (${theme}, ${clipboard})`, async () => {
        const { p, context } = await openFirstRun({ theme, clipboard });
        const button = p.getByRole("button", { name: "Copy address", exact: true });
        await button.click();
        const group = p.locator("[data-copy-group]", { has: button });
        await expect
          .poll(async () => {
            await p.clock.runFor(50);
            return group.locator("[data-copy-status]").textContent();
          })
          .toBe("Copy failed: select the address to copy it");
        const selected = await p.evaluate(() => {
          const sel = window.getSelection();
          const source = document.querySelector("main [data-copy-source]");
          return { text: sel?.toString() ?? "", own: !!source && !!sel?.anchorNode && source.contains(sel.anchorNode) };
        });
        expect(selected).toEqual({ text: CHECK_ADDRESS, own: true });
        const line = group.locator("[data-copy-status]");
        expect(await line.getAttribute("role")).toBe("status");
        expect(await line.getAttribute("aria-live")).toBe("polite");
        expect(await line.isVisible()).toBe(true);
        await context.close();
      });

  it("copies on retry after a clipboard refusal on the first-run page", async () => {
    const { p, context } = await openFirstRun({ clipboard: "denied" });
    const button = p.getByRole("button", { name: "Copy address", exact: true });
    const group = p.locator("[data-copy-group]", { has: button });
    const line = async () => {
      await p.clock.runFor(50);
      return group.locator("[data-copy-status]").textContent();
    };
    await button.click();
    await expect.poll(line).toBe("Copy failed: select the address to copy it");
    await button.click();
    await expect.poll(line).toBe("Copied");
    expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(CHECK_ADDRESS);
    await context.close();
  });
});
