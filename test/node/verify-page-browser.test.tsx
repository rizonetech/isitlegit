import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VerifyPage, VerifyUnavailable, VerifyUnknown, type VerifyView } from "../../src/web/pages/verify-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The verify page in Chromium (D05 T02 §6, correction 16), drawn by its own view and served with the shipped app
// script: the copy control (copied, and refused with the address selected by hand), the keyboard order through the
// page's controls, its links, and every state at 1280 and 390 px with no sideways scroll and passing the accessibility
// rules. Its answers through the Worker are test/web/verify-page.test.ts.
const PUBLIC = join(import.meta.dirname, "../../public");
const PROTECTED: VerifyView = {
  kind: "protected",
  name: "Fynbos Freight (Pty) Ltd",
  domains: ["fynbosfreight.example", "fynbos-logistics.example"],
  verifiedOn: "2026-10-12T08:00:00.000Z",
  checkedAt: "2026-10-31T08:00:00.000Z",
};
const pages: Record<string, () => string> = {
  protected: () => String(<VerifyPage view={PROTECTED} />),
  "not-verified": () => String(<VerifyPage view={{ kind: "not-verified", name: "Outeniqua Paper" }} />),
  unknown: () => String(<VerifyUnknown reference="404-ABC123" now={new Date("2026-10-31T08:00:00Z")} />),
  unavailable: () =>
    String(
      <VerifyUnavailable reference="500-ABC123" now={new Date("2026-10-31T08:00:00Z")} retry="/v/fynbos-freight" />,
    ),
};

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const draw = pages[url.pathname.slice(1)];
    if (draw) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(draw());
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

async function open(page: string, width = 1280): Promise<{ p: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await context.newPage();
  await p.goto(`${origin}/${page}`, { waitUntil: "load" });
  return { p, context };
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the verify page in Chromium", { timeout: 120_000 }, () => {
  it("copies the check address, and when the clipboard refuses says so and selects it to copy by hand", async () => {
    const ok = await open("protected");
    await ok.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await ok.p.getByRole("button", { name: "Copy check@isitlegit.co.za" }).click();
    await expect.poll(() => ok.p.locator("[data-copy-status]").textContent()).toBe("Copied");
    expect(await ok.p.evaluate(() => navigator.clipboard.readText())).toBe("check@isitlegit.co.za");
    await ok.context.close();
    const refused = await open("protected");
    await refused.p.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
    });
    await refused.p.getByRole("button", { name: "Copy check@isitlegit.co.za" }).click();
    await expect
      .poll(() => refused.p.locator("[data-copy-status]").textContent())
      .toBe("Copy failed: select the address to copy it");
    expect(await refused.p.evaluate(() => window.getSelection()?.toString())).toBe("check@isitlegit.co.za");
    await refused.context.close();
  });

  it("reaches every control by keyboard in reading order, with its links where the boards send them", async () => {
    const { p, context } = await open("protected");
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await p.keyboard.press("Tab");
      seen.push(await p.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim() ?? ""));
    }
    const order = ["Copy check@isitlegit.co.za", "Protect your own business"].map((x) => seen.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1] as number);
    expect(await p.getByRole("link", { name: "Protect your own business" }).getAttribute("href")).toBe(
      "https://isitlegit.co.za/protect",
    );
    await context.close();
    const lapsed = await open("not-verified");
    expect(await lapsed.p.getByRole("link", { name: "Sign in to renew your protection" }).getAttribute("href")).toBe(
      "https://app.isitlegit.co.za/signin",
    );
    expect(await lapsed.p.getByRole("button", { name: /Copy/ }).count()).toBe(0);
    await lapsed.context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [390, 1280])
      it(`reads every state with no sideways scroll and passes the accessibility rules (${theme}, ${width} px)`, async () => {
        for (const page of Object.keys(pages)) {
          const { p, context } = await open(page, width);
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), page).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), page).toEqual([]);
          await context.close();
        }
      });
});
