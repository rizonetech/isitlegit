import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WeeklyStats } from "../../src/db/case-filters";
import { type CaseFilters, type CasePage, filtersFrom, type ListedCase, PAGE_SIZE } from "../../src/db/case-filters";
import { fold, searchText } from "../../src/db/search-fold";
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
    // Named as D07 T04 §7 names them: an email's subject over its sender, an upload's file name over its type.
    subject: i % 4 === 3 ? null : `${i % 2 ? "Statement" : "Remittance advice"} ${prefix}${i}`,
    senderName: null,
    senderAddress: i % 4 === 3 ? null : `accounts${i}@outeniqua.example`,
    uploadName: i % 4 === 3 ? `Proof of payment ${prefix}${i}.pdf` : null,
    uploadMediaType: i % 4 === 3 ? "application/pdf" : null,
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
  delay: (f: CaseFilters & { pageAsked?: boolean }) => number;
  seen: { path: string; htmx: boolean }[];
  // The week's numbers the server answers with (D07 T04 §2), changed by a test to prove the panel redraws.
  stats: WeeklyStats;
};
const STATS: WeeklyStats = {
  thisWeek: {
    weekStart: "2026-10-25T22:00:00.000Z",
    checked: 27,
    malicious: 6,
    suspicious: 3,
    safe: 15,
    unfinished: 3,
    medianSecondsToVerdict: 48,
  },
  lastWeekChecked: 19,
};
const state: State = { org: "A", removed: false, fail: null, delay: () => 0, seen: [], stats: STATS };

function listFor(all: ListedCase[], f: CaseFilters): CasePage {
  const since = f.period === "all" ? 0 : NOW.getTime() - Number(f.period) * 86_400_000;
  const matched = all.filter(
    (c) =>
      (!fold(f.q) ||
        (
          searchText({
            subject: c.subject,
            fromName: c.senderName,
            fromAddress: c.senderAddress,
            uploadName: c.uploadName,
          }) ?? ""
        ).includes(fold(f.q))) &&
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
    await new Promise((done) => setTimeout(done, state.delay({ ...filters, pageAsked: url.searchParams.has("page") })));
    // As src/auth/gate.ts answers: a browser page to sign in, anything else 401.
    if (state.fail === "session")
      return (req.headers.accept ?? "").includes("text/html")
        ? new Response(null, {
            status: 303,
            headers: { location: `/signin?next=${encodeURIComponent(url.pathname + url.search)}` },
          })
        : Response.json({ error: "sign in first" }, { status: 401 });
    if (state.fail === "removed" || state.removed) return errorPage(403, "", { email: "thandi@karoo.example" });
    // As the route answers a results request once the organisation has no cases left.
    if (htmx && ORGS[state.org].cases.length === 0)
      return new Response(null, { status: 204, headers: { "hx-redirect": `${url.pathname}${url.search}` } });
    // As the route answers a results request drawn for another organisation than the active one.
    const drawnFor = req.headers["x-cases-org"];
    if (htmx && drawnFor && drawnFor !== state.org)
      return new Response(null, { status: 204, headers: { "hx-redirect": `${url.pathname}${url.search}` } });
    if (state.fail === "outage") return errorPage(500, "", { retry: `${url.pathname}${url.search}` });
    const org = ORGS[state.org];
    // The no-verdict panel for the accessibility scans.
    const asked = url.searchParams.get("stats");
    const stats =
      asked === "none" || asked === "minutes"
        ? {
            ...state.stats,
            thisWeek: { ...state.stats.thisWeek, medianSecondsToVerdict: asked === "none" ? null : 125 },
          }
        : state.stats;
    const { children: _, ...shell } = member({ organization: { id: state.org, name: org.name } });
    return new Response(
      String(
        <CasesPage
          shell={shell}
          list={listFor(org.cases, filters)}
          filters={filters}
          senders={{ domains: ["karoocouriers.example"], addresses: [] }}
          stats={stats}
          now={NOW}
        />,
      ),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } },
    );
  }
  // The export as src/web/pages/cases.tsx answers it: the gate's sign-in, the 403 page, the 503 page, the active
  // organisation's Cases for a page drawn for another, else the CSV as an attachment.
  if (url.pathname === "/cases/stats.csv" && state.fail === "session")
    return new Response(null, {
      status: 303,
      headers: { location: `/signin?next=${encodeURIComponent(url.pathname + url.search)}` },
    });
  if (url.pathname === "/cases/stats.csv" && (state.fail === "removed" || state.removed))
    return errorPage(403, "", { email: "thandi@karoo.example" });
  if (url.pathname === "/cases/stats.csv" && state.fail === "outage")
    return errorPage(500, "", { retry: `${url.pathname}${url.search}` });
  if (url.pathname === "/cases/stats.csv" && url.searchParams.get("org") !== state.org)
    return new Response(null, { status: 303, headers: { location: "/cases" } });
  if (url.pathname === "/cases/stats.csv")
    return new Response("week_start,checked\r\n2026-10-26,27\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="isitlegit-weekly-counts.csv"',
      },
    });
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
  Object.assign(state, { org: "A", removed: false, fail: null, delay: () => 0, seen: [], stats: STATS });
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
  listFor(ORGS[org].cases, { verdict: "all", channel: "all", period: "30", page: 1, q: "", ...f }).cases.map(
    (c) => c.id,
  );

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

  it("filters, pages and opens a report by keyboard alone, focus kept through each redraw", async () => {
    const { p, context } = await open();
    const focusedId = () => p.evaluate(() => document.activeElement?.id ?? "");
    const focusedText = () => p.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    // Tab from the top of the page to the verdict filter, then choose with the arrows.
    for (
      let i = 0;
      i < 40 && (await p.evaluate(() => (document.activeElement as HTMLInputElement)?.name)) !== "verdict";
      i++
    )
      await p.keyboard.press("Tab");
    await p.keyboard.press("ArrowRight");
    await expect.poll(() => p.url()).toContain("verdict=malicious");
    await expect.poll(() => ids(p)).toEqual(expected("A", { verdict: "malicious" }));
    await p.keyboard.press("ArrowLeft");
    await expect.poll(() => ids(p)).toEqual(expected("A", {}));
    // On to Next by Tab alone; Enter pages, and focus stays on a pager end through the redraw.
    for (let i = 0; i < 80 && (await focusedId()) !== "case-next"; i++) await p.keyboard.press("Tab");
    expect(await focusedId()).toBe("case-next");
    await p.keyboard.press("Enter");
    await expect.poll(() => ids(p)).toEqual(expected("A", { page: 2 }));
    // The last page: Next is disabled, so focus is on Previous, and Enter goes back.
    await expect.poll(focusedId).toBe("case-previous");
    await p.keyboard.press("Enter");
    await expect.poll(() => ids(p)).toEqual(expected("A", {}));
    await expect.poll(focusedId).toBe("case-next");
    // Back up to the first case by Shift+Tab, and open it.
    const first = expected("A", {})[0] ?? "";
    for (
      let i = 0;
      i < 200 && !(await p.evaluate(() => document.activeElement?.getAttribute("href") ?? "")).endsWith(first);
      i++
    )
      await p.keyboard.press("Shift+Tab");
    expect(await focusedText()).toBe(ORGS.A.cases.find((c) => c.id === first)?.subject);
    await p.keyboard.press("Enter");
    await expect.poll(() => p.locator("h1").textContent()).toContain(`Report ${first}`);
    await context.close();
  });

  it("loads a page restored from the back/forward cache again, so a removed member sees the 403 page", async () => {
    const { p, context } = await open();
    const before = state.seen.length;
    state.removed = true;
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => p.getByText("You're not a member of this organisation.").isVisible()).toBe(true);
    expect(state.seen.slice(before)).toContainEqual({ path: "/cases", htmx: false });
    await context.close();
  });

  it("shows the first-run state, controls and all, when the last case goes while the list is open", async () => {
    const { p, context } = await open();
    const kept = ORGS.A.cases;
    ORGS.A.cases = [];
    try {
      await segment(p, "Malicious").click();
      await expect.poll(() => p.getByText("Check your first suspicious email.").isVisible()).toBe(true);
      expect(p.url()).toContain("verdict=malicious");
      expect(state.seen.at(-1)?.htmx).toBe(false);
    } finally {
      ORGS.A.cases = kept;
    }
    await context.close();
  });

  it("lets the newest results request win, from the pager or the filters, in either order", async () => {
    // A slow Next, then a quick verdict: the verdict's rows and address stay.
    state.delay = (f) => (f.page === 2 ? 1500 : 0);
    const one = await open();
    await one.p.getByRole("link", { name: "Next" }).click();
    await segment(one.p, "Safe").click();
    await expect.poll(() => ids(one.p)).toEqual(expected("A", { verdict: "safe" }));
    await one.p.waitForTimeout(1700);
    expect(await ids(one.p)).toEqual(expected("A", { verdict: "safe" }));
    expect(one.p.url()).toContain("verdict=safe");
    expect(one.p.url()).not.toContain("page=2");
    expect(await one.p.locator('input[name="verdict"]:checked').getAttribute("value")).toBe("safe");
    await one.context.close();
    // A slow verdict, then a quick Next: Next pages the verdict now chosen (one page of it, so the first), and the
    // chosen radio, the address and the rows agree.
    state.delay = (f) => (f.verdict === "malicious" && f.page === 1 && !f.pageAsked ? 1500 : 0);
    const two = await open();
    await segment(two.p, "Malicious").click();
    await two.p.getByRole("link", { name: "Next" }).click();
    await expect.poll(() => two.p.url()).toContain("page=2");
    await expect.poll(() => ids(two.p)).toEqual(expected("A", { verdict: "malicious" }));
    await two.p.waitForTimeout(1700);
    expect(await ids(two.p)).toEqual(expected("A", { verdict: "malicious" }));
    expect(two.p.url()).toContain("verdict=malicious");
    expect(await two.p.locator('input[name="verdict"]:checked').getAttribute("value")).toBe("malicious");
    await two.context.close();
  });

  it("reloads the whole page when the organisation was switched in another tab, so the heading never mislabels the rows", async () => {
    const { p, context } = await open();
    expect(await p.getByText("Everything Karoo Couriers has checked").isVisible()).toBe(true);
    state.org = "B";
    await segment(p, "Malicious").click();
    await expect.poll(() => p.getByText("Everything Bravo Couriers has checked").isVisible()).toBe(true);
    expect(await ids(p)).toEqual(expected("B", { verdict: "malicious" }));
    expect(p.url()).toContain("verdict=malicious");
    await context.close();
  });

  it("searches as the member types, once after the pause, focus kept in the box, the address pushed", async () => {
    const { p, context } = await open();
    const before = state.seen.length;
    const box = p.locator("#case-search");
    await box.click();
    await box.pressSequentially("statement", { delay: 40 });
    await expect.poll(() => p.url()).toContain("q=statement");
    await expect.poll(() => ids(p)).toEqual(expected("A", { q: "statement" }));
    // One results request for the whole word, never one a keystroke.
    await p.waitForTimeout(500);
    const asked = state.seen.slice(before);
    expect(asked.filter((s) => s.path.includes("q=")).length).toBe(1);
    expect(asked.every((s) => s.htmx)).toBe(true);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("case-search");
    // A filter change keeps the search; clearing the box shows every case again.
    await segment(p, "Safe").click();
    await expect.poll(() => ids(p)).toEqual(expected("A", { q: "statement", verdict: "safe" }));
    expect(p.url()).toContain("q=statement");
    await box.fill("");
    await expect.poll(() => ids(p)).toEqual(expected("A", { verdict: "safe" }));
    // The form's fields go as they stand (defaults too), so the address carries an empty search, read as none.
    await expect.poll(() => new URL(p.url()).searchParams.get("q")).toBe("");
    await context.close();
  });

  it("searches at once on Enter, and Back and a reload show the search and its results", async () => {
    const { p, context } = await open();
    const box = p.locator("#case-search");
    // The words set with no input event, so the typing pause never fires: only Enter can search.
    await box.evaluate((el) => {
      (el as HTMLInputElement).value = "remittance";
    });
    await box.press("Enter");
    await expect.poll(() => ids(p)).toEqual(expected("A", { q: "remittance" }));
    expect(p.url()).toContain("q=remittance");
    expect(state.seen.at(-1)?.htmx).toBe(true);
    await segment(p, "Malicious").click();
    await expect.poll(() => p.url()).toContain("verdict=malicious");
    await p.goBack();
    await expect.poll(() => ids(p)).toEqual(expected("A", { q: "remittance" }));
    expect(await box.inputValue()).toBe("remittance");
    await p.reload();
    expect(await p.locator("#case-search").inputValue()).toBe("remittance");
    expect(await ids(p)).toEqual(expected("A", { q: "remittance" }));
    await context.close();
  });

  it("lets the newest search win over a slower earlier one", async () => {
    state.delay = (f) => (f.q === "remittance" ? 1500 : 0);
    const { p, context } = await open();
    const box = p.locator("#case-search");
    await box.fill("remittance");
    await expect.poll(() => state.seen.some((s) => s.path.includes("q=remittance"))).toBe(true);
    await box.fill("statement");
    await expect.poll(() => ids(p)).toEqual(expected("A", { q: "statement" }));
    await p.waitForTimeout(1700);
    expect(await ids(p)).toEqual(expected("A", { q: "statement" }));
    expect(p.url()).toContain("q=statement");
    await context.close();
  });

  it("searches without JavaScript when Enter submits the form", async () => {
    const { p, context } = await open("/cases", { js: false });
    await p.locator("#case-search").fill("statement");
    await p.locator("#case-search").press("Enter");
    await expect.poll(() => p.url()).toContain("q=statement");
    expect(await ids(p)).toEqual(expected("A", { q: "statement" }));
    await context.close();
  });

  it("redraws the week's stats with a results request, whatever the filters", async () => {
    const { p, context } = await open();
    const tile = (label: string) =>
      p.locator("#case-stats dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
    expect(await tile("Checked this week").textContent()).toBe("27");
    expect(await tile("Median time to verdict").textContent()).toBe("48 s");
    state.stats = {
      ...STATS,
      thisWeek: { ...STATS.thisWeek, checked: 28, malicious: 7, medianSecondsToVerdict: 95 },
    };
    await segment(p, "Safe").click();
    await expect.poll(() => tile("Checked this week").textContent()).toBe("28");
    expect(await tile("Malicious or suspicious").textContent()).toBe("10");
    expect(await tile("Median time to verdict").textContent()).toBe("1 min 35 s");
    await context.close();
  });

  for (const [fail, sees] of [
    ["session", "Sign in"],
    ["removed", "You're not a member of this organisation."],
    ["outage", "Sorry, something broke on our side."],
  ] as const)
    it(`shows the export's refusal (${fail}) as the page it is, never a downloaded file`, async () => {
      const { p, context } = await open();
      state.fail = fail;
      const downloads: string[] = [];
      p.on("download", (d) => downloads.push(d.suggestedFilename()));
      await p.getByRole("link", { name: "Export counts as CSV" }).click();
      await expect.poll(() => p.getByText(sees, { exact: true }).isVisible()).toBe(true);
      expect(downloads).toEqual([]);
      if (fail === "outage") {
        state.fail = null;
        const download = p.waitForEvent("download");
        await p.getByRole("link", { name: "Try again" }).click();
        expect((await download).suggestedFilename()).toBe("isitlegit-weekly-counts.csv");
      }
      await context.close();
    });

  it("sends an export pressed on a page drawn for another organisation to the active one's Cases", async () => {
    const { p, context } = await open();
    state.org = "B";
    await p.getByRole("link", { name: "Export counts as CSV" }).click();
    await expect.poll(() => p.getByText("Everything Bravo Couriers has checked").isVisible()).toBe(true);
    await context.close();
  });

  it("downloads the counts as CSV from the keyboard", async () => {
    const { p, context } = await open();
    const link = p.getByRole("link", { name: "Export counts as CSV" });
    for (let i = 0; i < 60 && !(await link.evaluate((el) => el === document.activeElement)); i++)
      await p.keyboard.press("Tab");
    expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
    const download = p.waitForEvent("download");
    await p.keyboard.press("Enter");
    expect((await download).suggestedFilename()).toBe("isitlegit-weekly-counts.csv");
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
    // Back and Forward each make htmx load the page again (no snapshots), a second navigation after the history step
    // returns: each step waits for that page's own document answer and its load, not a poll on a timer, so a loaded
    // machine is only slower (the flake the coordinator found under the full suite, 2026-10-31).
    const step = async (move: () => Promise<unknown>) => {
      // The new document's own load event (the old one reports "load" already, so its state cannot say when).
      const reloaded = p.waitForResponse(
        (r) => new URL(r.url()).pathname === "/cases" && r.request().resourceType() === "document",
      );
      const loaded = p.waitForEvent("load");
      await move();
      await reloaded;
      await loaded;
    };
    state.org = "B";
    await step(() => p.goBack());
    expect(await p.getByText("Everything Bravo Couriers has checked").isVisible()).toBe(true);
    expect(await ids(p)).toEqual(expected("B", {}));
    await step(() => p.goForward());
    expect(await ids(p)).toEqual(expected("B", { verdict: "malicious" }));
    state.removed = true;
    await step(() => p.goBack());
    expect(await p.getByText("You're not a member of this organisation.").isVisible()).toBe(true);
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
      if (fail === "session") {
        const next = new URL(new URL(p.url()).searchParams.get("next") ?? "", "http://x");
        expect(`${next.pathname} ${next.searchParams.get("verdict")}`).toBe("/cases suspicious");
      }
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
          ["A", "/cases?q=statement"],
          ["A", "/cases?q=nothing-like-this"],
          ["A", "/cases?stats=none"],
          ["A", "/cases?stats=minutes"],
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
