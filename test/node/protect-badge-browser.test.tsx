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
import { BADGES } from "../../src/web/badges";
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
    // Only the linked badge is selected, the same as Copy puts on the clipboard: no name or company to duplicate.
    expect(selected).not.toContain(SHELL.user.name);
    expect(selected).not.toContain(SHELL.organization.name);
    const payload = await p.evaluate(() => {
      const range = window.getSelection()?.getRangeAt(0);
      const holder = document.createElement("div");
      if (range) holder.append(range.cloneContents());
      return holder.innerHTML;
    });
    expect(payload).toContain('href="https://isitlegit.co.za/v/karoo-couriers"');
    expect(payload).toContain('src="https://isitlegit.co.za/b/karoo-couriers.png"');
    expect(payload).not.toContain(SHELL.user.name);
    expect(payload).not.toContain(SHELL.organization.name);
    // The status line is announced politely.
    expect(await status(p).getAttribute("role")).toBe("status");
    expect(await status(p).getAttribute("aria-live")).toBe("polite");
    await context.close();
  });

  it("falls back the same way when the browser has no Clipboard API at all", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    await p.route("https://isitlegit.co.za/**", (route) => route.abort());
    await p.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
    await p.goto(`${origin}/protect`, { waitUntil: "load" });
    await p.getByRole("button", { name: "Copy signature HTML" }).click();
    await expect
      .poll(async () => status(p).textContent())
      .toContain("Copy failed: the badge in the preview is selected");
    const selected = await p.evaluate(() => {
      const holder = document.createElement("div");
      const range = window.getSelection()?.getRangeAt(0);
      if (range) holder.append(range.cloneContents());
      return { html: holder.innerHTML, text: window.getSelection()?.toString() ?? "" };
    });
    expect(selected.html).toContain('src="https://isitlegit.co.za/b/karoo-couriers.png"');
    expect(selected.text).not.toContain(SHELL.user.name);
    await context.close();
  });

  it("opens and closes each client's steps by keyboard", async () => {
    const { p, context } = await open({ clipboard: true });
    for (const client of ["classic Outlook on Windows", "new Outlook and Outlook on the web", "Gmail"]) {
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

// Completion review gap 12: the served images are real images. Chromium decodes each PNG variant and parses and renders
// each SVG variant, and a truncated PNG and a malformed SVG fail to, so the check can fail.
describe("the badge images decode", () => {
  async function decodes(
    p: Page,
    kind: "png" | "svg",
    data: string,
  ): Promise<{ ok: boolean; width: number; height: number }> {
    return p.evaluate(
      async ([type, payload]) => {
        const mime = type === "png" ? "image/png" : "image/svg+xml";
        const bytes =
          type === "png"
            ? Uint8Array.from(atob(payload as string), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(payload as string);
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const img = new Image();
        const loaded = await new Promise<boolean>((done) => {
          img.onload = () => done(true);
          img.onerror = () => done(false);
          img.src = url;
        });
        return { ok: loaded && img.naturalWidth > 0, width: img.naturalWidth, height: img.naturalHeight };
      },
      [kind, data] as const,
    );
  }

  it("decodes both PNGs at the one size and renders both SVGs, and fails on a truncated PNG and a broken SVG", async () => {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.goto(`${origin}/protect`);
    const sizes: string[] = [];
    for (const variant of ["protected", "notVerified"] as const) {
      const png = await decodes(p, "png", BADGES[variant].png);
      expect(png.ok, `${variant} png`).toBe(true);
      expect(png.height, `${variant} png`).toBe(104);
      sizes.push(`${png.width}x${png.height}`);
      const svg = await decodes(p, "svg", BADGES[variant].svg);
      expect(svg.ok, `${variant} svg`).toBe(true);
      const parsed = await p.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        return {
          error: doc.querySelector("parsererror") !== null,
          title: doc.querySelector("title")?.textContent ?? "",
        };
      }, BADGES[variant].svg);
      expect(parsed.error, `${variant} svg`).toBe(false);
      expect(parsed.title).toBe(variant === "protected" ? "Protected by IsItLegit" : "Not verified by IsItLegit");
    }
    expect(new Set(sizes).size).toBe(1);
    // Negative controls: the check fails on a damaged image.
    // Chromium shows a PNG cut off mid-image as far as it got, so it is the renderer here, not the validator (test/web/
    // badge.test.ts decodes every chunk strictly); a cut header it rejects.
    const truncated = Buffer.from(BADGES.protected.png, "base64").subarray(0, 20).toString("base64");
    expect((await decodes(p, "png", truncated)).ok).toBe(false);
    expect((await decodes(p, "svg", BADGES.protected.svg.replace("</svg>", ""))).ok).toBe(false);
    await context.close();
  });
});
