import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportDocument, type ReportEvidence } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, focused, launch } from "./browser";
import { member } from "./shell-fixtures";

// The report as a member and a link holder meet it (D07 T03 §1), in Chromium with the shipped stylesheet: the phone
// back link a member reaches by keyboard and a link holder never sees, long findings wrapping, the page passing the
// accessibility gate's rules at 360 and 1280 px in both themes, and print keeping the report and dropping the shell.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
const LONG = "accountverificationnimbusmai1securelogin.portal.example";
const levels = ["critical", "high", "medium", "low", "info"] as const;
const evidence = (count: number): ReportEvidence[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `E${i + 1}`,
    severity: levels[i % levels.length] as ReportEvidence["severity"],
    summary: `Finding ${i + 1}: the link points at ${LONG} and asks for the mailbox password`,
  }));
const STORED = {
  status: "done" as const,
  verdict: "malicious" as const,
  sourceKind: "mail" as const,
  createdAt: "2026-10-27T08:12:00Z",
};

function html(view: "member" | "public", count = 3) {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={STORED}
      evidence={evidence(count)}
      shell={view === "member" ? shell : null}
      {...(view === "public" ? { linkExpires: Date.UTC(2026, 10, 3) / 1000 } : {})}
    />,
  );
}

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function open(body: string, width: number, theme: "light" | "dark") {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  await p.route(`${APP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/r/case") return route.fulfill({ status: 200, contentType: "text/html", body });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/r/case`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the report in Chromium", { timeout: 120_000 }, () => {
  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules for a member and a link holder (${theme}, ${width} px)`, async () => {
        for (const view of ["member", "public"] as const) {
          const { p, context } = await open(html(view), width, theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), view).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), view).toEqual([]);
          await context.close();
        }
      });

  it("gives a member on a phone a back link to Cases, reached by keyboard, and a link holder none", async () => {
    const { p, context } = await open(html("member"), 360, "light");
    const back = p.getByRole("link", { name: "← Cases" });
    expect(await back.isVisible()).toBe(true);
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await p.keyboard.press("Tab");
      reached = (await focused(p))?.key === "← Cases";
    }
    expect(reached).toBe(true);
    await context.close();
    const desktop = await open(html("member"), 1280, "light");
    expect(await desktop.p.getByRole("link", { name: "← Cases" }).isVisible()).toBe(false);
    await desktop.context.close();
    const pub = await open(html("public"), 360, "light");
    expect(await pub.p.getByRole("link", { name: "← Cases" }).count()).toBe(0);
    await pub.context.close();
  });

  for (const theme of ["light", "dark"] as const)
    it(`prints the whole report and none of the shell (${theme})`, async () => {
      const { p, context } = await open(html("member", 40), 1280, theme);
      await p.emulateMedia({ media: "print" });
      expect(await p.locator("#nav").isVisible()).toBe(false);
      expect(await p.locator("h1").first().isVisible()).toBe(true);
      expect(await p.getByText("Checked", { exact: true }).isVisible()).toBe(true);
      const page = await p.evaluate(() => document.documentElement.clientWidth);
      const cut = await p.evaluate(
        (w) =>
          [...document.querySelectorAll("article li")].filter((li) => {
            const r = li.getBoundingClientRect();
            return r.width === 0 || r.right > w + 1 || li.scrollWidth > li.clientWidth + 1;
          }).length,
        page,
      );
      expect(cut).toBe(0);
      for (let i = 1; i <= 40; i += 13) expect(await p.getByText(`Finding ${i}:`).isVisible(), `E${i}`).toBe(true);
      // Many pages long: the content runs past one A4 page.
      expect(await p.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(1200);
      await context.close();
    });
  it("prints without the sidebar even with the phone Menu left open", async () => {
    const { p, context } = await open(html("member", 5), 360, "light");
    await p.getByRole("button", { name: "Menu" }).click();
    expect(await p.locator("#nav").isVisible()).toBe(true);
    await p.emulateMedia({ media: "print" });
    expect(await p.locator("#nav").isVisible()).toBe(false);
    expect(await p.getByText("Finding 1:").isVisible()).toBe(true);
    await context.close();
  });

  // How fast a member's phone shows the report, its largest kind included (D07 T03 §1, completion review): the page as
  // served, on a throttled mid-range phone profile (4x CPU, fast 3G: 150 ms, 1.6 Mbit/s down), cold and warm, with the
  // Largest Contentful Paint the browser reports. This measures the page's own weight and rendering, the Worker's
  // reads being test/web's; the target is the Web Vitals "good" line, 2.5 s.
  it("paints the largest report within 2.5 s on a throttled phone, cold and warm", async () => {
    // Served over HTTP from this process with the Worker's cache rules (the fingerprinted files a year, immutable;
    // the page no-store), not through request interception, which turns the browser's cache off.
    const body = html("member", 100);
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/r/case") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
        return res.end(body);
      }
      const file = join(PUBLIC, path);
      if (path.startsWith("/static/") && existsSync(file)) {
        const type = path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".svg")
              ? "image/svg+xml"
              : "font/woff2";
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
        return res.end(readFileSync(file));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const p = await context.newPage();
    const cdp = await context.newCDPSession(p);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    // The browser's own word for a file served from its cache (memory or disk), not an inference from sizes.
    const fromCache: string[] = [];
    cdp.on("Network.responseReceived", (event) => {
      const { url, fromDiskCache, fromServiceWorker } = event.response as {
        url: string;
        fromDiskCache?: boolean;
        fromServiceWorker?: boolean;
      };
      if (url.includes("/static/") && (fromDiskCache || fromServiceWorker)) fromCache.push(url);
    });
    cdp.on("Network.requestServedFromCache", () => fromCache.push("memory"));
    const lcp = () =>
      p.evaluate(
        () =>
          new Promise<number>((resolve) => {
            new PerformanceObserver((list) => {
              const entries = list.getEntries();
              resolve(entries[entries.length - 1]?.startTime ?? Number.NaN);
            }).observe({ type: "largest-contentful-paint", buffered: true });
          }),
      );
    try {
      await p.goto(`${origin}/r/case`, { waitUntil: "load" });
      const cold = await lcp();
      fromCache.length = 0;
      // A second visit, as a member opening the next report: a new navigation, the files from the cache.
      await p.goto(`${origin}/r/case?again`, { waitUntil: "load" });
      const warm = await lcp();
      console.log(
        JSON.stringify({
          event: "report-lcp",
          coldMs: Math.round(cold),
          warmMs: Math.round(warm),
          cachedFiles: fromCache.length,
        }),
      );
      expect(fromCache.length, "the second visit's files come from the cache").toBeGreaterThan(0);
      expect(cold).toBeLessThan(2500);
      expect(warm).toBeLessThan(2500);
    } finally {
      await context.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
