// The feedback queue and organisation detail in Chromium (D07 T08 §5), served by this process with the shipped
// stylesheet and app script: the queue reads its tabs, rows, detail panel, note editing and actions at phone and
// desktop widths in both themes, the detail reads its cards, charts and plan controls, and the accessibility gate's
// rules hold with no sideways scroll.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeedbackQueuePage, type QueueItem } from "../../src/web/pages/admin-feedback-view";
import { OrgDetailPage } from "../../src/web/pages/admin-org-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

const PUBLIC = join(import.meta.dirname, "../../public");
const SHELL = { operator: "derick@rizonetech.com", feedbackOpen: 3 };

const ITEMS: QueueItem[] = [
  {
    id: "f1",
    caseTitle: "October statement",
    caseHref: "/r/case1?o=org1&e=1&s=2",
    orgName: "Karoo Couriers",
    verdict: "Safe",
    theySay: "Unsafe",
    decidedBy: "Google Web Risk",
    when: "10:41",
  },
  {
    id: "f2",
    caseTitle: "Invoice 0042",
    caseHref: "/r/case2?o=org2&e=1&s=2",
    orgName: "Outeniqua Paper",
    verdict: "Suspicious",
    theySay: "Safe",
    decidedBy: "Supplier ledger: new account",
    when: "Yesterday",
  },
];
const queue = (selected: string | null) =>
  new Response(
    String(
      FeedbackQueuePage({
        shell: SHELL,
        generatedAt: "",
        tabs: { new: 3, triaged: 5, closed: 12 },
        tab: "new",
        items: ITEMS,
        page: 0,
        pages: 1,
        detail:
          selected === null
            ? null
            : {
                id: "f1",
                title: "October statement",
                caseHref: "/r/case1?o=org1&e=1&s=2",
                status: "new" as const,
                quoteName: "Thandi Nkosi",
                quote: "The statement is real but the bank account is not ours.",
                drivers: ["Muse Spark weighed 6 findings, none above low"],
                note: "",
                updatedAt: "2026-11-02T10:00:00.000Z",
                withdrawn: false,
                notice: null,
                error: null,
              },
      }),
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
const org = () =>
  new Response(
    String(
      OrgDetailPage({
        shell: SHELL,
        orgId: "org1",
        header: {
          name: "Karoo Couriers",
          planPill: "Trial, 11 days left",
          meta: "Joined 27 Oct with invite KAROO-7Q4M · 4 members · daily cap 50 cases",
        },
        extendTrial: { enabled: true, reason: null, min: "", value: "", notice: null, error: null },
        cap: { value: "", error: null, notice: null },
        plan: { current: "trial" as const, error: null, notice: null },
        onboarding: {
          done: 4,
          steps: [
            { title: "Verify your domain", done: true, detail: "karoo.example is verified." },
            { title: "Invite your team", done: true, detail: "4 people joined." },
            { title: "Forward your first email", done: true, detail: "A forwarded email's report is ready." },
            { title: "Add suppliers", done: true, detail: "2 suppliers added." },
            { title: "Protect your business", done: false, detail: "Protected identity is not set up." },
          ],
        },
        domains: [{ domain: "karoo.example", state: "Verified", detail: "TXT record, verified 27 Oct." }],
        members: [
          { name: "Thandi Nkosi", role: "Owner" },
          { name: "pending@demo.isitlegit.co.za", role: "Invited" },
        ],
        weeks: [
          { label: "13 Oct", total: 12, bad: 3 },
          { label: "20 Oct", total: 19, bad: 5 },
          { label: "27 Oct", total: 27, bad: 7 },
        ],
        threats: [
          { name: "A page that collects what you type", count: 9, top: 9 },
          { name: "Invoice bank change", count: 5, top: 9 },
        ],
        feedback: [
          {
            caseTitle: "October statement",
            caseHref: "/r/case1?o=org1&e=1&s=2",
            verdict: "Safe",
            theySay: "Unsafe",
            status: "New",
          },
        ],
        feedbackHref: "/admin/feedback",
        planLines: ["Trial, ends Mon 10 Nov 2026", "Today 21 of 50 cases", "Protected identity: not set up"],
      }),
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/admin/feedback") return queue(url.searchParams.get("selected"));
  if (url.pathname === "/admin/orgs/org1") return org();
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
const context = (width: number): Promise<BrowserContext> => browser.newContext({ viewport: { width, height: 900 } });

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "the feedback queue and org detail in Chromium",
  { timeout: 120_000 },
  () => {
    it("reads tabs, rows, the detail panel and note editing at phone and desktop widths in both themes", async () => {
      for (const width of [360, 1280]) {
        const ctx = await context(width);
        const p = await ctx.newPage();
        await p.goto(`${origin}/admin/feedback?selected=f1`, { waitUntil: "load" });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.getByRole("heading", { name: "Feedback" }).count()).toBe(1);
          expect(await p.getByRole("navigation", { name: "Status" }).count()).toBe(1);
          expect(await p.getByText("October statement").count()).toBeGreaterThan(0);
          expect(await p.getByRole("button", { name: "Close: verdict was right" }).count()).toBe(1);
          // The signed report is one activation from the selected complaint, and the note travels with Close.
          const report = p.getByRole("link", { name: "Open the case report" });
          expect(await report.count()).toBe(1);
          expect(await report.getAttribute("href")).toBe("/r/case1?o=org1&e=1&s=2");
          expect(
            await p.evaluate(() => {
              const form = document.querySelector('form[action="/admin/feedback/action"]');
              return (
                form !== null &&
                form.querySelector('textarea[name="note"]') !== null &&
                form.querySelector('button[value="close"]') !== null
              );
            }),
          ).toBe(true);
          const note = p.getByLabel("Triage note");
          await note.fill("Ledger was empty on arrival");
          expect(await note.inputValue()).toBe("Ledger was empty on arrival");
          await p.keyboard.press("Tab");
          expect(await p.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${width}`).toBeLessThanOrEqual(
            width + 1,
          );
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), `${theme} ${width}`).toEqual([]);
        }
        await ctx.close();
      }
    });

    it("reads the org cards, charts and plan controls at phone and desktop widths in both themes", async () => {
      for (const width of [360, 1280]) {
        const ctx = await context(width);
        const p = await ctx.newPage();
        await p.goto(`${origin}/admin/orgs/org1`, { waitUntil: "load" });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.getByRole("heading", { name: "Karoo Couriers" }).count()).toBe(1);
          expect(await p.getByText("Cases by week").count()).toBe(1);
          expect(await p.getByText("A page that collects what you type").count()).toBe(1);
          expect(await p.getByRole("button", { name: "Extend trial" }).count()).toBe(1);
          expect(await p.getByRole("button", { name: "Change daily cap" }).count()).toBe(1);
          expect(await p.getByRole("button", { name: "Change plan" }).count()).toBe(1);
          expect(await p.getByLabel("Change plan", { exact: true }).count()).toBe(1);
          expect(await p.getByLabel("Trial until").count()).toBe(1);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${width}`).toBeLessThanOrEqual(
            width + 1,
          );
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), `${theme} ${width}`).toEqual([]);
        }
        await ctx.close();
      }
    });
  },
);
