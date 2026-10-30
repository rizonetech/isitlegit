import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CaseFilters, type CasePage, filtersFrom, type ListedCase, PAGE_SIZE } from "../../src/db/case-filters";
import { CasesPage } from "../../src/web/pages/cases-view";
import { errorPage } from "../../src/web/pages/errors";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The Cases list in Chromium (D07 T04 §1), served over HTTP by this process with the shipped htmx and app script: the
// filters redraw the results and push the address; Back reloads through the server, never a snapshot; the newest
// change wins; a failing results request becomes the whole page it should be; the list works by keyboard alone and,
// without JavaScript, through Apply; and every state passes the accessibility gate's rules at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date("2026-10-30T12:00:00Z");
const VERDICTS = ["malicious", "suspicious", "safe"] as const;
const cases = (prefix: string, count: number): ListedCase[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i).padStart(26 - prefix.length, "0")}`,
    channel: i % 4 === 3 ? "upload" : "email",
    sourceKind: i % 4 === 3 ? "document" : "mail",
    status: "done",
    verdict: VERDICTS[i % 3] ?? "safe",
    createdAt: new Date(NOW.getTime() - i * 3_600_000).toISOString(),
    checkedBy: i % 4 === 3 ? null : "Thandi Nkosi",
  }));
const ORGS = {
  A: { name: "Karoo Couriers", cases: cases("A", 30) },
  B: { name: "Bravo Couriers", cases: cases("B", 3) },
  E: { name: "Empty Freight", cases: [] as ListedCase[] },
};

// What the server answers, changed by each test.
type State = {
  org: keyof typeof ORGS;
  removed: boolean;
  fail: null | "session" | "removed" | "outage" | "network";
  delay: (f: CaseFilters) => number;
  seen: { path: string; htmx: boolean }[];
};
const state: State = { org: "A", removed: false, fail: null, delay: () => 0, seen: [] };

function listFor(all: ListedCase[], f: CaseFilters): CasePage {
  const since = f.period === "all" ? 0 : NOW.getTime() - Number(f.period) * 86_400_000;
  const matched = all.filter(
    (c) =>
      (f.verdict === "all" || c.verdict === f.verdict) &&
      (f.channel === "all" || c.channel === f.channel) &&
      Date.parse(c.createdAt) >= since,
  );
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  return {
    cases: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    pages,
    matching: matched.length,
    total: all.length,
  };
}

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const htmx = req.headers["hx-request"] === "true";
  if (url.pathname === "/cases") {
    state.seen.push({ path: `${url.pathname}${url.search}`, htmx });
    const filters = filtersFrom(url.searchParams);
    await new Promise((done) => setTimeout(done, state.delay(filters)));
    // As src/auth/gate.ts answers: a browser page to sign in, anything else 401.
    if (state.fail === "session")
      return (req.headers.accept ?? "").includes("text/html")
        ? new Response(null, {
            status: 303,
            headers: { location: `/signin?next=${encodeURIComponent(url.pathname + url.search)}` },
          })
        : Response.json({ error: "sign in first" }, { status: 401 });
    if (state.fail === "removed" || state.removed) return errorPage(403, "", { email: "thandi@karoo.example" });
    if (state.fail === "outage") return errorPage(500, "", { retry: `${url.pathname}${url.search}` });
    const org = ORGS[state.org];
    const { children: _, ...shell } = member({ organization: { id: state.org, name: org.name } });
    return new Response(
      String(
        <CasesPage
          shell={shell}
          list={listFor(org.cases, filters)}
          filters={filters}
          senders={{ domains: ["karoocouriers.example"], addresses: [] }}
          now={NOW}
        />,
      ),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } },
    );
  }
  if (url.pathname === "/signin")
    return new Response("<!doctype html><title>Sign in</title><h1>Sign in</h1>", {
      headers: { "content-type": "text/html" },
    });
  if (url.pathname.startsWith("/r/"))
    return new Response(`<!doctype html><title>Report</title><h1>Report ${url.pathname.slice(3)}</h1>`, {
      headers: { "content-type": "text/html" },
    });
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
    if (state.fail === "network" && req.headers["hx-request"] === "true") return req.socket.destroy();
    const out = await answer(req);
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
  Object.assign(state, { org: "A", removed: false, fail: null, delay: () => 0, seen: [] });
});

async function open(path = "/cases", options: { width?: number; js?: boolean } = {}) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const p: Page = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
}
// A verdict filter's label (the rows carry the same words in their pills).
const segment = (p: Page, name: string) => p.locator("fieldset label").filter({ hasText: new RegExp(`^${name}$`) });
const ids = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll("table a[href^='/r/']")].map((a) => a.getAttribute("href")?.slice(3) ?? ""),
  );
const expected = (org: keyof typeof ORGS, f: Partial<CaseFilters>) =>
  listFor(ORGS[org].cases, { verdict: "all", channel: "all", period: "30", page: 1, ...f }).cases.map((c) => c.id);

describe.skipIf(!chromiumPath() && !process.env.CI)("the cases list in Chromium", { timeout: 120_000 }, () => {
  it("redraws the results on a filter change, pushes the address, and Back reloads the earlier list", async () => {
    const { p, context } = await open();
    expect(await ids(p)).toEqual(expected("A", {}));
    await segment(p, "Malicious").click();
    await expect.poll(() => p.url()).toContain("verdict=malicious");
    await expect.poll(() => ids(p)).toEqual(expected("A", { verdict: "malicious" }));
    // Only the results were fetched, and focus stayed on the control.
    expect(state.seen.at(-1)?.htmx).toBe(true);
    expect(await p.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value)).toBe("malicious");
    await p.goBack();
    await expect.poll(() => ids(p)).toEqual(expected("A", {}));
    // Back went to the server as a whole page, not a snapshot.
    expect(state.seen.at(-1)).toEqual({ path: "/cases", htmx: false });
    await context.close();
  });

  it("shows Loading cases while it waits, and the newest change wins", async () => {
    state.delay = (f) => (f.verdict === "malicious" ? 1500 : f.verdict === "safe" ? 300 : 0);
    const { p, context } = await open();
    await segment(p, "Malicious").click();
    await expect.poll(() => p.locator("#case-loading").isVisible()).toBe(true);
    await segment(p, "Safe").click();
    await expect.poll(() => p.url()).toContain("verdict=safe");
    await expect.poll(() => p.locator("#case-loading").isVisible()).toBe(false);
    await p.waitForTimeout(1600);
    expect(await ids(p)).toEqual(expected("A", { verdict: "safe" }));
    expect(p.url()).toContain("verdict=safe");
    await context.close();
  });

  it("filters, pages and opens a report by keyboard alone", async () => {
    const { p, context } = await open();
    await p.locator('input[name="verdict"][value="all"]').focus();
    await p.keyboard.press("ArrowRight");
    await expect.poll(() => p.url()).toContain("verdict=malicious");
    await expect.poll(() => ids(p)).toEqual(expected("A", { verdict: "malicious" }));
    await segment(p, "All").click();
    await expect.poll(() => ids(p)).toEqual(expected("A", {}));
    const next = p.getByRole("link", { name: "Next" });
    await next.focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => p.url()).toContain("page=2");
    await expect.poll(() => ids(p)).toEqual(expected("A", { page: 2 }));
    const row = p.locator("table a[href^='/r/']").first();
    await row.focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => p.locator("h1").textContent()).toContain("Report");
    await context.close();
  });

  it("filters without JavaScript through Apply", async () => {
    const { p, context } = await open("/cases", { js: false });
    await p.locator("#case-channel").selectOption("upload");
    await p.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => p.url()).toContain("channel=upload");
    expect(await ids(p)).toEqual(expected("A", { channel: "upload" }));
    await context.close();
  });

  it("after an organisation switch or a removal, Back shows the active organisation's cases or the 403 page", async () => {
    const { p, context } = await open();
    await segment(p, "Malicious").click();
    await expect.poll(() => p.url()).toContain("verdict=malicious");
    state.org = "B";
    await p.goBack();
    await expect.poll(() => p.getByText("Everything Bravo Couriers has checked").isVisible()).toBe(true);
    expect(await ids(p)).toEqual(expected("B", {}));
    await p.goForward();
    await expect.poll(() => ids(p)).toEqual(expected("B", { verdict: "malicious" }));
    state.removed = true;
    await p.goBack();
    await expect.poll(() => p.getByText("You're not a member of this organisation.").isVisible()).toBe(true);
    expect(await p.content()).not.toContain("Karoo Couriers has checked");
    await context.close();
  });

  for (const [fail, sees] of [
    ["session", "Sign in"],
    ["removed", "You're not a member of this organisation."],
    ["outage", "Sorry, something broke on our side."],
  ] as const)
    it(`turns a filter request that fails (${fail}) into the whole page it should be`, async () => {
      const { p, context } = await open();
      state.fail = fail;
      await segment(p, "Suspicious").click();
      await expect.poll(() => p.getByText(sees, { exact: true }).isVisible()).toBe(true);
      if (fail === "session") expect(decodeURIComponent(p.url())).toContain("next=/cases?verdict=suspicious");
      if (fail === "outage") {
        const retry = await p.getByRole("link", { name: "Try again" }).getAttribute("href");
        expect(retry).toContain("verdict=suspicious");
        state.fail = null;
        await p.getByRole("link", { name: "Try again" }).click();
        await expect.poll(() => ids(p)).toEqual(expected("A", { verdict: "suspicious" }));
      }
      await context.close();
    });

  it("loads the page whole when a filter request cannot be sent", async () => {
    const { p, context } = await open();
    state.fail = "network";
    await segment(p, "Safe").click();
    await expect.poll(() => state.seen.some((s) => s.path.includes("verdict=safe") && !s.htmx)).toBe(true);
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules on the list, the filtered-empty and the first-run states (${theme}, ${width} px)`, async () => {
        for (const [org, path] of [
          ["A", "/cases"],
          ["A", "/cases?verdict=malicious&channel=upload&period=7"],
          ["E", "/cases"],
        ] as const) {
          state.org = org;
          const { p, context } = await open(path, { width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), `${org} ${path}`).toEqual([]);
          await context.close();
        }
      });
});
