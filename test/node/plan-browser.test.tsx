import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppShell } from "../../src/web/components/AppShell";
import { Document } from "../../src/web/components/Document";
import { errorPage } from "../../src/web/pages/errors";
import { PlanPage, type Usage } from "../../src/web/pages/settings-plan-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The Plan page in Chromium (D07 T08 §4), served by this process with the shipped stylesheet: reached from the
// navigation by keyboard, "Tell us" a focusable link to the support address, a retry from the outage page recovering,
// and the accessibility gate's rules at 360 and 1280 px in both themes for a trial, a capped organisation and a paused one.
const PUBLIC = join(import.meta.dirname, "../../public");
const ORG = { id: "org-karoo", name: "Karoo Couriers" };
const NOW = Date.now();
type Case = "trial" | "free" | "capped" | "paused";
const state = { now: "trial" as Case, down: false };
const shell = () => {
  const { children: _, ...rest } = shellOf({ organization: ORG, active: "cases" });
  return rest;
};

function answer(req: IncomingMessage): Response {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/cases")
    return new Response(
      String(
        <Document title="Cases">
          <AppShell {...shell()}>
            <h1 id="cases-title">Cases</h1>
          </AppShell>
        </Document>,
      ),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  if (url.pathname === "/settings/plan") {
    const usage: Usage =
      state.now === "paused"
        ? { used: 0, limit: 0 }
        : state.now === "capped"
          ? { used: 60, limit: 50 }
          : { used: 27, limit: 50 };
    const plan =
      state.now === "free"
        ? ({ plan: "free", trialEndedAt: new Date(NOW - 86_400_000).toISOString() } as const)
        : ({ plan: "trial", trialEndsAt: new Date(NOW + 11 * 86_400_000).toISOString(), daysLeft: 11 } as const);
    return new Response(
      String(
        <PlanPage shell={shell()} plan={plan} usage={usage} startedAt={new Date(NOW - 3 * 86_400_000).toISOString()} />,
      ),
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
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
    return new Response(readFileSync(file), { headers: { "content-type": type } });
  }
  return new Response("not found", { status: 404 });
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    // The outage page is drawn by the real error page, read once from the module.
    if (state.down && req.url === "/settings/plan") {
      const out = errorPage(500, "", { retry: "/settings/plan" });
      res.writeHead(503, Object.fromEntries(out.headers));
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
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
afterEach(() => {
  state.now = "trial";
  state.down = false;
});

async function context(width: number): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width, height: 900 } });
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the plan page in Chromium", { timeout: 120_000 }, () => {
  for (const width of [360, 1280]) {
    it(`passes the accessibility rules in both themes with no sideways scroll at ${width} px`, async () => {
      const ctx = await context(width);
      for (const kind of ["trial", "free", "capped", "paused"] as const) {
        state.now = kind;
        const p = await ctx.newPage();
        await p.goto(`${origin}/settings/plan`, { waitUntil: "load" });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${kind}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${theme} ${kind}`).toEqual([]);
        }
        await p.close();
      }
      await ctx.close();
    });
  }

  it("reaches Plan from another member page's navigation by keyboard, and Tell us is a link to the support address", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/cases`, { waitUntil: "load" });
    expect(await p.locator("#cases-title").count()).toBe(1);
    const nav = p.getByRole("link", { name: /^Plan\b/ }).first();
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await p.keyboard.press("Tab");
      reached = await nav.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
    expect(new URL(p.url()).pathname).toBe("/settings/plan");
    expect(await p.getByRole("heading", { name: "Plan", exact: true }).count()).toBe(1);
    const tell = p.getByRole("link", { name: "Tell us" });
    expect(await tell.getAttribute("href")).toBe("mailto:support@isitlegit.co.za");
    await tell.focus();
    expect(await tell.evaluate((el) => el === document.activeElement)).toBe(true);
    // The trial card runs full width above the usage card, with its trial progress bar.
    const status = await p
      .locator("#status-heading")
      .evaluate((el) => el.closest("section")?.getBoundingClientRect().width ?? 0);
    const usage = await p
      .locator("#usage-heading")
      .evaluate((el) => el.closest("section")?.getBoundingClientRect().width ?? 0);
    expect(Math.abs(status - usage)).toBeLessThan(2);
    expect(await p.getByRole("progressbar", { name: "Trial used" }).count()).toBe(1);
    await ctx.close();
  });

  it("recovers from the outage page through Try again once the read works", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    state.down = true;
    const first = await p.goto(`${origin}/settings/plan`, { waitUntil: "load" });
    expect(first?.status()).toBe(503);
    const retry = p.getByRole("link", { name: "Try again" });
    await retry.focus();
    state.down = false;
    await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
    expect(new URL(p.url()).pathname).toBe("/settings/plan");
    expect(await p.getByRole("heading", { name: "Plan", exact: true }).count()).toBe(1);
    await ctx.close();
  });
});
