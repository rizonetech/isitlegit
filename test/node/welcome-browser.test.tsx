import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CasesPage } from "../../src/web/pages/cases-view";
import {
  type Access,
  doneCount,
  type Protection,
  type Steps,
  WelcomePage,
  type WelcomePlan,
} from "../../src/web/pages/welcome-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The onboarding checklist in Chromium (D07 T08 §2; board `Welcome`), served over HTTP by this process with the shipped
// app script: every action reached and activated by keyboard, the copy button, the progress after a step is done, the
// list hidden and shown with and without JavaScript with the way back from Cases, the judges' banner, a member's words,
// and the accessibility gate's rules in both themes at phone and desktop widths. The Worker's own reads (what ticks a
// step, the cookie, the plan words) are test/web/welcome.test.ts's.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date("2026-10-30T12:00:00Z");
const EMPTY: Steps = {
  domain: null,
  members: 1,
  emailed: false,
  reported: false,
  suppliers: 0,
  accounts: 0,
  protectedIdentity: false,
};
const FULL: Steps = {
  domain: "karoocouriers.example",
  members: 3,
  emailed: true,
  reported: true,
  suppliers: 2,
  accounts: 2,
  protectedIdentity: true,
};
type State = {
  steps: Steps;
  plan: WelcomePlan;
  protection: Protection;
  access: Access;
  canSetup: boolean;
  judge: boolean;
  hidden: boolean;
  visited: string[];
};
const fresh = (): State => ({
  steps: EMPTY,
  plan: { plan: "trial", daysLeft: 11, endsAt: new Date(NOW.getTime() + 11 * 86_400_000).toISOString() },
  protection: { on: true },
  access: { bankChange: true, identity: true },
  canSetup: true,
  judge: false,
  hidden: false,
  visited: [],
});
const state = fresh();

const shell = () => {
  const { children: _, ...rest } = shellOf();
  return rest;
};
const html = (body: unknown, status = 200) =>
  new Response(String(body), { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/welcome" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const action = new URLSearchParams(Buffer.concat(chunks).toString()).get("action");
    state.hidden = action === "hide";
    return new Response(null, { status: 303, headers: { location: action === "hide" ? "/cases" : "/welcome" } });
  }
  if (url.pathname === "/welcome")
    return html(
      <WelcomePage
        shell={shell()}
        firstName="Thandi"
        steps={state.steps}
        plan={state.plan}
        protection={state.protection}
        access={state.access}
        now={NOW}
        canSetup={state.canSetup}
        judge={state.judge}
        hidden={state.hidden}
      />,
    );
  if (url.pathname === "/cases")
    return html(
      <CasesPage
        shell={shell()}
        list={{ cases: [], page: 1, pages: 1, matching: 0, total: 0 }}
        filters={{ q: "", verdict: "all", period: "all", type: "all", sender: "", page: 1 } as never}
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
        now={NOW}
        setup={{ done: doneCount(state.steps), hidden: state.hidden }}
      />,
    );
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
  // Any other page the checklist links to: a page that says where it is.
  state.visited.push(url.pathname + url.hash);
  return html(
    <main id="content">
      <h1>Opened {url.pathname}</h1>
    </main>,
  );
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
afterEach(() => Object.assign(state, fresh()));

const open = async (path: string, width = 1280, js = true) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width, height: 900 },
    javaScriptEnabled: js,
  });
  const p: Page = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
};
// Tab to a control by its accessible name and activate it with the key a keyboard user presses.
async function activate(p: Page, role: "link" | "button", name: string, key = "Enter") {
  const target = p.getByRole(role, { name, exact: true });
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await p.keyboard.press("Tab");
    reached = await target.evaluate((el) => el === document.activeElement);
  }
  expect(reached, name).toBe(true);
  await p.keyboard.press(key);
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the welcome list in Chromium", { timeout: 120_000 }, () => {
  it("reaches and activates each step's action by keyboard, to its own page", async () => {
    for (const [role, name, path] of [
      ["link", "Verify a domain", "/settings/domains"],
      ["link", "Invite people", "/team"],
      ["link", "Show me how", "/settings/domains"],
      ["link", "Add suppliers", "/suppliers"],
      ["link", "Protect Karoo Couriers", "/protect"],
    ] as const) {
      const { p, context } = await open("/welcome");
      await activate(p, role, name);
      await p.waitForURL(`${origin}${path}**`);
      expect(await p.locator("h1").textContent()).toContain(`Opened ${path}`);
      await context.close();
    }
    expect(state.visited).toContain("/settings/domains");
  });

  it("names the progress, and moves it when a step is done", async () => {
    const { p, context } = await open("/welcome");
    const bar = p.getByRole("progressbar", { name: "Setup progress" });
    expect(await bar.getAttribute("aria-valuenow")).toBe("0");
    expect(await bar.getAttribute("aria-valuetext")).toBe("0 of 5 steps done");
    expect(await p.getByText("0 of 5 done").count()).toBe(1);
    state.steps = { ...EMPTY, domain: "karoocouriers.example", members: 3 };
    await p.reload({ waitUntil: "load" });
    expect(await bar.getAttribute("aria-valuenow")).toBe("2");
    expect(await p.getByText("2 of 5 done").count()).toBe(1);
    // A done step has its pill and no action.
    expect(await p.getByText("Done", { exact: true }).count()).toBe(2);
    expect(await p.getByRole("link", { name: "Verify a domain" }).count()).toBe(0);
    await context.close();
  });

  it("copies the check address from its button, and says so", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const p = await context.newPage();
    await p.goto(`${origin}/welcome`, { waitUntil: "load" });
    const group = p.locator("[data-copy-group]", { hasText: "Your check address" });
    await activate(p, "button", "Copy address");
    await expect.poll(() => group.locator("[data-copy-status]").textContent()).toContain("Copied");
    expect(await p.evaluate(() => navigator.clipboard.readText())).toBe("check@isitlegit.co.za");
    await context.close();
  });

  for (const js of [true, false])
    it(`hides and shows the list ${js ? "with" : "without"} JavaScript, with the way back from Cases`, async () => {
      const { p, context } = await open("/welcome", 1280, js);
      // Hide: Cases is where it lands, offering the list back.
      await Promise.all([p.waitForURL(`${origin}/cases`), p.getByRole("button", { name: "Hide this list" }).click()]);
      expect(await p.getByRole("link", { name: "Show setup list" }).count()).toBe(1);
      expect(await p.getByRole("link", { name: /Finish setting up/ }).count()).toBe(0);
      // Navigate away and back to the list by the link, no address typed.
      await Promise.all([p.waitForURL(`${origin}/welcome`), p.getByRole("link", { name: "Show setup list" }).click()]);
      expect(await p.getByRole("button", { name: "Show this list again" }).count()).toBe(1);
      expect(await p.getByRole("button", { name: "Hide this list" }).count()).toBe(0);
      // Restore: back on the list, Cases offers Finish setting up with the count.
      await Promise.all([
        p.waitForURL(`${origin}/welcome`),
        p.getByRole("button", { name: "Show this list again" }).click(),
      ]);
      expect(await p.getByRole("button", { name: "Hide this list" }).count()).toBe(1);
      await p.goto(`${origin}/cases`, { waitUntil: "load" });
      expect(await p.getByRole("link", { name: "Finish setting up (0 of 5 done)" }).count()).toBe(1);
      await context.close();
    });

  it("hides and shows the list by keyboard", async () => {
    const { p, context } = await open("/welcome");
    await Promise.all([p.waitForURL(`${origin}/cases`), activate(p, "button", "Hide this list")]);
    await Promise.all([p.waitForURL(`${origin}/welcome`), activate(p, "link", "Show setup list")]);
    await activate(p, "button", "Show this list again", "Space");
    await expect.poll(() => p.getByRole("button", { name: "Hide this list" }).count()).toBe(1);
    await context.close();
  });

  it("shows the judges' banner above the list, and gives a member the owner words in place of the setup buttons", async () => {
    state.judge = true;
    state.canSetup = false;
    const { p, context } = await open("/welcome");
    const banner = p.getByRole("region", { name: "Welcome, judges. This organisation is ready to explore." });
    expect(await banner.count()).toBe(1);
    expect(
      await banner
        .getByText("a phishing email, an invoice with changed bank details, a voice note and a safe statement")
        .count(),
    ).toBe(1);
    expect(await banner.getByText("Sample data on a fictional company.").count()).toBe(1);
    await Promise.all([p.waitForURL(`${origin}/cases`), activate(p, "link", "Open the sample cases")]);
    await p.goBack();
    // Four steps are an owner's or admin's: the domain, the team, the suppliers and the protection.
    expect(await p.getByText("An owner or admin does this").count()).toBe(4);
    expect(await p.getByRole("link", { name: "Add suppliers" }).count()).toBe(0);
    expect(await p.getByRole("link", { name: "Protect Karoo Couriers" }).count()).toBe(0);
    expect(await p.getByRole("link", { name: "Verify a domain" }).count()).toBe(0);
    expect(await p.getByRole("link", { name: "Invite people" }).count()).toBe(0);
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280] as const)
      it(`passes the accessibility gate's rules for every state (${theme}, ${width} px)`, async () => {
        const states: [string, Partial<State>, string][] = [
          ["empty", {}, "/welcome"],
          ["half", { steps: { ...EMPTY, domain: "karoocouriers.example", members: 3 } }, "/welcome"],
          ["finished", { steps: FULL }, "/welcome"],
          ["judge", { judge: true }, "/welcome"],
          ["member", { canSetup: false }, "/welcome"],
          ["hidden", { hidden: true }, "/welcome"],
          [
            "lapsed",
            { plan: { plan: "free", trialEnded: true }, access: { bankChange: false, identity: false } },
            "/welcome",
          ],
          ["received only", { steps: { ...EMPTY, emailed: true, suppliers: 1, protectedIdentity: true } }, "/welcome"],
          [
            "ineffective protection",
            { steps: FULL, protection: { on: false, reason: "no finance contact is set" } },
            "/welcome",
          ],
          ["protect", { plan: { plan: "protect" } }, "/welcome"],
          ["cases link", {}, "/cases"],
          ["cases link hidden", { hidden: true }, "/cases"],
        ];
        for (const [label, changes, path] of states) {
          Object.assign(state, fresh(), changes);
          const { p, context } = await open(path, width);
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), label).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), label).toEqual([]);
          await context.close();
        }
      });
});
