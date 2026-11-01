// The signature badge card on the Protect page in Chromium (D05 T02 §7, correction 12): Copy puts the badge on the
// clipboard as rich content and as its markup, a refused clipboard selects the preview and says how to finish by hand,
// each outcome is announced, the steps open and close by keyboard, and the badge's link keeps its neutral name when
// images do not load.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BADGE_ALT, badgeSnippet, IdentityPage, type IdentityView } from "../../src/web/pages/identity-view";
import { launch } from "./browser";
import { member } from "./shell-fixtures";

const PUBLIC = join(import.meta.dirname, "../../public");
const { children: _children, ...SHELL } = member({ active: "protect" });
const CONTACT = "accounts@karoocouriers.example";
const VIEW: IdentityView = {
  shell: SHELL,
  canEdit: true,
  identity: {
    displayNames: ["Karoo Couriers"],
    financeContact: CONTACT,
    logo: null,
    protected: true,
    effective: { on: true },
    version: 1,
  },
  domains: [{ domain: "karoocouriers.example", state: "verified" }],
  addresses: [CONTACT],
  since: "2026-10-12T08:00:00.000Z",
  accounts: [],
  bankAvailable: true,
  slug: { slug: "karoo-couriers", changed: false },
};
const SNIPPET = badgeSnippet("karoo-couriers");

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/protect") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(String(<IdentityPage {...VIEW} result={null} />));
    }
    const file = join(PUBLIC, url.pathname);
    if (url.pathname.startsWith("/static/") && existsSync(file)) {
      const type = url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".svg")
            ? "image/svg+xml"
            : "font/woff2";
      res.writeHead(200, { "content-type": type });
      return res.end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

// The page on localhost, a secure context, with the badge images stopped (the live badge is on isitlegit.co.za).
async function open(options: { clipboard: boolean }): Promise<{ p: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (options.clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const p = await context.newPage();
  await p.route("https://isitlegit.co.za/**", (route) => route.abort());
  if (!options.clipboard)
    await p.addInitScript(() => {
      // A clipboard that refuses, as a browser without permission does.
      Object.defineProperty(navigator, "clipboard", {
        value: {
          write: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
          writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        },
      });
    });
  await p.goto(`${origin}/protect`, { waitUntil: "load" });
  return { p, context };
}
const status = (p: Page) =>
  p.locator("#badge-heading").locator("xpath=ancestor::section").locator("[data-copy-status]");

describe("the signature badge card in Chromium", () => {
  it("copies the badge as rich content and its markup, and says so", async () => {
    const { p, context } = await open({ clipboard: true });
    await p.getByRole("button", { name: "Copy signature HTML" }).click();
    await expect.poll(async () => status(p).textContent()).toBe("Copied");
    const copied = await p.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      if (!item) return null;
      return {
        types: [...item.types].sort(),
        html: await (await item.getType("text/html")).text(),
        text: await (await item.getType("text/plain")).text(),
      };
    });
    expect(copied?.types).toEqual(["text/html", "text/plain"]);
    expect(copied?.html).toContain(SNIPPET);
    expect(copied?.text).toBe(SNIPPET);
    await context.close();
  });

  it("selects the preview and says how to copy it by hand when the clipboard refuses", async () => {
    const { p, context } = await open({ clipboard: false });
    await p.getByRole("button", { name: "Copy signature HTML" }).click();
    await expect
      .poll(async () => status(p).textContent())
      .toBe("Copy failed: the badge in the preview is selected. Press Ctrl+C (Cmd+C on a Mac) to copy it.");
    const selected = await p.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected).toContain(SHELL.user.name);
    expect(selected).toContain(SHELL.organization.name);
    // The status line is announced politely.
    expect(await status(p).getAttribute("role")).toBe("status");
    expect(await status(p).getAttribute("aria-live")).toBe("polite");
    await context.close();
  });

  it("opens and closes each client's steps by keyboard", async () => {
    const { p, context } = await open({ clipboard: true });
    for (const client of ["Outlook desktop", "Outlook on the web", "Gmail"]) {
      const summary = p.locator("summary", { hasText: `Steps for ${client}` });
      await summary.focus();
      expect(await summary.evaluate((el) => el === document.activeElement), client).toBe(true);
      await p.keyboard.press("Enter");
      expect(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open), client).toBe(true);
      await p.keyboard.press("Enter");
      expect(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open), client).toBe(false);
    }
    await context.close();
  });

  it("keeps the badge link's neutral name when its image does not load", async () => {
    const { p, context } = await open({ clipboard: true });
    const link = p.getByRole("link", { name: BADGE_ALT });
    expect(await link.count()).toBe(1);
    expect(await link.getAttribute("href")).toBe("https://isitlegit.co.za/v/karoo-couriers");
    // The image was stopped, so the name comes from its alternative text alone.
    expect(await link.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(0);
    await context.close();
  });
});
