import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maintenancePage, slowDownPage } from "../../src/web/pages/errors";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The 429 and maintenance pages in Chromium (D07 T08 §1), served by this process with the shipped stylesheet: the
// accessibility gate's rules at 360 and 1280 px in both themes, no sideways scroll, and Reload opened by keyboard
// returning to the same address with its query.
const PUBLIC = join(import.meta.dirname, "../../public");
const now = new Date("2026-10-27T16:48:00.000Z");
const window = { from: new Date("2026-10-28T00:00:00Z"), to: new Date("2026-10-28T00:30:00Z") };

function answer(req: IncomingMessage): Response {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/slow")
    return slowDownPage({
      kind: "daily",
      orgName: "Karoo Couriers",
      limit: 50,
      resetsAt: new Date("2026-10-27T22:00:00Z"),
      now,
    });
  if (url.pathname === "/paused")
    return slowDownPage({ kind: "daily", orgName: "Karoo Couriers", limit: 0, resetsAt: now, now });
  if (url.pathname === "/burst") return slowDownPage({ kind: "burst", retryInSeconds: 30, now });
  if (url.pathname.startsWith("/static/")) {
    const file = join(PUBLIC, url.pathname);
    if (existsSync(file)) {
      const type = url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".svg")
            ? "image/svg+xml"
            : "font/woff2";
      return new Response(readFileSync(file), { headers: { "content-type": type } });
    }
    return new Response("not found", { status: 404 });
  }
  return maintenancePage({ window, reload: `${url.pathname}${url.search}`, now: new Date("2026-10-27T23:50:00Z") });
}

let browser: Browser;
let server: Server;
let origin: string;
const pool = new Map<number, BrowserContext>();
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const out = answer(req);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "the 429 and maintenance pages in Chromium",
  { timeout: 120_000 },
  () => {
    for (const width of [360, 1280]) {
      it(`pass the accessibility rules in both themes with no sideways scroll at ${width} px`, async () => {
        let context = pool.get(width);
        if (!context) {
          context = await browser.newContext({ viewport: { width, height: 900 } });
          pool.set(width, context);
        }
        for (const path of ["/slow", "/paused", "/burst", "/maintenance"]) {
          const p = await context.newPage();
          await p.goto(`${origin}${path}`, { waitUntil: "load" });
          await p.addScriptTag({ path: AXE });
          for (const theme of ["light", "dark"] as const) {
            await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
            expect(
              await p.evaluate(() => document.documentElement.scrollWidth),
              `${theme} ${path}`,
            ).toBeLessThanOrEqual(width);
            expect(problems(await scan(p)), `${theme} ${path}`).toEqual([]);
          }
          await p.close();
        }
      });
    }

    it("opens Reload by keyboard onto the same address with its query, and the 429 links by keyboard", async () => {
      const context = pool.get(1280) ?? (await browser.newContext({ viewport: { width: 1280, height: 900 } }));
      const p = await context.newPage();
      await p.goto(`${origin}/cases?q=remittance&sig=abc`, { waitUntil: "load" });
      await p.getByRole("link", { name: "Reload" }).focus();
      await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
      expect(new URL(p.url()).pathname + new URL(p.url()).search).toBe("/cases?q=remittance&sig=abc");
      await p.goto(`${origin}/slow`, { waitUntil: "load" });
      expect(await p.getByRole("link", { name: "See your plan" }).getAttribute("href")).toBe("/settings/plan");
      expect(await p.getByRole("link", { name: "Back to cases" }).getAttribute("href")).toBe("/cases");
      await p.close();
    });
  },
);
