// The admin console in Chromium (D07 T05 §2), served by this process with the shipped stylesheet and app script: the
// overview reads its tiles, spend bars, searched table and incident panel at phone and desktop widths in both themes,
// the invites page reads its form, one-time code panel and statuses, and the accessibility gate's rules hold with no
// sideways scroll.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvitesPage, type OrgRow, OverviewPage } from "../../src/web/pages/admin-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

const PUBLIC = join(import.meta.dirname, "../../public");

const SHELL = { operator: "derick@rizonetech.com", feedbackOpen: 2 };
const ROWS: OrgRow[] = [
  {
    id: "org-karoo",
    name: "Karoo Couriers",
    created: "2026-10-26T00:00:00.000Z",
    plan: "Trial, 14 days",
    domainsVerified: 1,
    domainsPending: false,
    members: 2,
    casesWeek: 27,
    topCheck: "domain.lookalike",
    feedbackOpen: 1,
    capOverride: null,
    capEffective: 50,
  },
  {
    id: "org-plain",
    name: "Plain Org",
    created: "2026-10-26T00:00:00.000Z",
    plan: "Free",
    domainsVerified: 0,
    domainsPending: true,
    members: 1,
    casesWeek: 0,
    topCheck: null,
    feedbackOpen: 0,
    capOverride: 5,
    capEffective: 5,
  },
];
const SPEND = [
  { label: "Meta Model API today", amountUsd: 6.4, capUsd: 15 },
  { label: "Meta Model API total", amountUsd: 41.1, capUsd: 90, note: "US$30 reserve opens on 3 Nov" },
  { label: "Fireworks today", amountUsd: 4, capUsd: 5 },
  { label: "Fireworks total", amountUsd: 8, capUsd: 90 },
];
const overview = (query = "", empty = false) =>
  new Response(
    String(
      OverviewPage({
        shell: SHELL,
        generatedAt: "Mon 27 Oct 2026, 14:02 SAST",
        organisations: empty ? 0 : 14,
        orgsVerified: 11,
        casesToday: 63,
        casesTotal: 412,
        medianSeconds: 51,
        p95Seconds: 160,
        feedbackOpen: 2,
        spend: SPEND,
        rows: empty ? [] : ROWS.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
        query,
        incidents: [
          { at: "2026-10-27T10:00:00.000Z", kind: "sign-in-failed", org: null, outcome: "refused" },
          { at: "2026-10-27T09:00:00.000Z", kind: "rate-limited", org: "Karoo Couriers", outcome: "refused" },
        ],
        capDraft: null,
      }),
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
const invites = (created: boolean) =>
  new Response(
    String(
      InvitesPage({
        shell: SHELL,
        now: "2026-10-27T12:00:00.000Z",
        draft: created ? { label: "", uses: "", expires: "" } : { label: "Karoo pilot", uses: "2", expires: "" },
        errors: {},
        created: created ? { code: "ABCD-EFGH-JKLM-NPQR", label: "Karoo pilot" } : null,
        notice: null,
        creationKey: "f".repeat(32),
        items: [
          {
            id: "a1",
            tag: "a1b2c3d4",
            label: "Karoo pilot",
            uses: 1,
            max_uses: 2,
            expires_at: "2999-01-01T00:00:00.000Z",
            revoked_at: null,
            created: "2026-10-27T00:00:00.000Z",
          },
          {
            id: "a2",
            tag: "e5f6a7b8",
            label: "Spent",
            uses: 1,
            max_uses: 1,
            expires_at: "2999-01-01T00:00:00.000Z",
            revoked_at: null,
            created: "2026-10-27T00:00:00.000Z",
          },
          {
            id: "a3",
            tag: "c9d0e1f2",
            label: "Old",
            uses: 0,
            max_uses: 5,
            expires_at: "2020-01-01T00:00:00.000Z",
            revoked_at: null,
            created: "2026-10-27T00:00:00.000Z",
          },
          {
            id: "a4",
            tag: "1a2b3c4d",
            label: "Dead",
            uses: 0,
            max_uses: 5,
            expires_at: "2999-01-01T00:00:00.000Z",
            revoked_at: "2026-10-28T00:00:00.000Z",
            created: "2026-10-27T00:00:00.000Z",
          },
        ],
      }),
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const state = { posts: 0, delayMs: 0 };
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/admin") return overview(url.searchParams.get("q") ?? "");
  if (req.method === "POST" && url.pathname === "/admin/invites") {
    state.posts += 1;
    await sleep(state.delayMs);
    return invites(true);
  }
  if (url.pathname === "/admin-empty") return overview("", true);
  if (url.pathname === "/admin/invites") return invites(url.searchParams.get("created") === "1");
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

describe.skipIf(!chromiumPath() && !process.env.CI)("the admin console in Chromium", { timeout: 120_000 }, () => {
  it("reads the tiles, bars, a searched table and the panel at phone and desktop widths in both themes", async () => {
    for (const width of [360, 1280]) {
      const ctx = await context(width);
      const p = await ctx.newPage();
      await p.goto(`${origin}/admin`, { waitUntil: "load" });
      for (const theme of ["light", "dark"] as const) {
        await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(await p.getByRole("heading", { name: "Overview" }).count()).toBe(1);
        expect(await p.getByText("63", { exact: true }).count()).toBeGreaterThan(0);
        expect(await p.getByText("US$6.40 of 15.00").count()).toBe(1);
        expect(await p.getByText("Sign-in refused").count()).toBe(1);
        expect(await p.getByText("Lookalike domains").count()).toBeGreaterThan(0);
        expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${width}`).toBeLessThanOrEqual(
          width + 1,
        );
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p)), `${theme} ${width}`).toEqual([]);
      }
      // A search narrows the table; the empty service offers to clear it.
      await p.getByLabel("Search organisations").fill("Plain");
      await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
      expect(await p.getByText("Plain Org", { exact: true }).count()).toBeGreaterThan(0);
      await p.getByLabel("Search organisations").fill("Nope");
      await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
      expect(await p.getByText("No organisations match").count()).toBe(1);
      await ctx.close();
    }
  });

  it("reads the invite form, the one-time code and the four statuses at phone and desktop widths, with every control reachable by keyboard", async () => {
    for (const width of [360, 1280]) {
      const ctx = await context(width);
      const p = await ctx.newPage();
      await p.goto(`${origin}/admin/invites?created=1`, { waitUntil: "load" });
      expect(await p.getByText("Code created for Karoo pilot").count()).toBe(1);
      expect(await p.getByText("ABCD-EFGH-JKLM-NPQR").count()).toBe(1);
      for (const status of ["Active", "Used up", "Expired", "Revoked"]) {
        expect(await p.getByText(status, { exact: true }).count(), `${status} ${width}`).toBeGreaterThan(0);
      }
      // The one-time Copy is a real button with its status line; list rows carry no code to copy.
      expect(await p.getByRole("button", { name: "Copy" }).count()).toBe(1);
      // The one active row's Revoke stays reachable where the table gives way to the list.
      expect(await p.getByRole("button", { name: "Revoke the code for Karoo pilot" }).count(), `${width}`).toBe(1);
      for (const [role, name] of [
        ["textbox", "Label"],
        ["textbox", "Organisations"],
        ["textbox", "Expires"],
        ["button", "Create code"],
        ["button", "Copy"],
      ] as const) {
        const target = p.getByRole(role, { name, exact: true }).first();
        let reached = false;
        for (let i = 0; i < 80 && !reached; i++) {
          await p.keyboard.press("Tab");
          reached = await target.evaluate((el) => el === document.activeElement);
        }
        expect(reached, `${name} ${width}`).toBe(true);
        const ring = await target.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            style: style.outlineStyle,
            width: Number.parseFloat(style.outlineWidth),
            shadow: style.boxShadow,
            borderStyle: style.borderTopStyle,
            borderWidth: Number.parseFloat(style.borderTopWidth),
          };
        });
        if (role === "textbox") {
          expect(
            ring.style === "none" && ring.borderStyle === "solid" && ring.borderWidth >= 1,
            `${name} ${width}`,
          ).toBe(true);
        } else {
          expect(ring.style !== "none" || ring.shadow !== "none", `${name} ${width}`).toBe(true);
        }
      }
      for (const theme of ["light", "dark"] as const) {
        await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${width}`).toBeLessThanOrEqual(
          width + 1,
        );
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p)), `${theme} ${width}`).toEqual([]);
      }
      await ctx.close();
    }
  });

  it("copies the shown code to the clipboard, and says when the clipboard refuses", async () => {
    const granted = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const p = await granted.newPage();
    await p.goto(`${origin}/admin/invites?created=1`, { waitUntil: "load" });
    await p.getByRole("button", { name: "Copy" }).click();
    await expect.poll(() => p.getByText("Copied").count()).toBe(1);
    expect(await p.evaluate(() => navigator.clipboard.readText())).toBe("ABCD-EFGH-JKLM-NPQR");
    await granted.close();
    // Without clipboard permission the code stays readable and the failure is said aloud.
    const denied = await context(1280);
    const q = await denied.newPage();
    // Headless Chromium may grant the clipboard without a permission prompt; remove the API so the refusal is sure.
    await q.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
    });
    await q.goto(`${origin}/admin/invites?created=1`, { waitUntil: "load" });
    await q.getByRole("button", { name: "Copy" }).click();
    await expect.poll(() => q.getByText("Copy failed: select the code to copy it").count()).toBe(1);
    expect(await q.getByText("ABCD-EFGH-JKLM-NPQR").count()).toBe(1);
    await denied.close();
  });

  it("sends one create for two presses, the button busy while it runs", async () => {
    state.delayMs = 1500;
    state.posts = 0;
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/admin/invites`, { waitUntil: "load" });
    await p.getByLabel("Label").fill("Double press");
    await p.getByLabel("Organisations").fill("2");
    await p.evaluate(() =>
      document.addEventListener("submit", (event) => {
        const form = event.target as HTMLFormElement;
        setTimeout(() => {
          const b = form.querySelector<HTMLButtonElement>("button[type=submit]");
          sessionStorage.setItem(
            "busy",
            JSON.stringify({ text: b?.textContent?.trim(), disabled: b?.disabled, busy: b?.getAttribute("aria-busy") }),
          );
          form.requestSubmit();
        }, 100);
      }),
    );
    await p.getByRole("button", { name: "Create code" }).click({ noWaitAfter: true });
    await p.waitForURL(`${origin}/admin/invites`, { waitUntil: "load" });
    await expect.poll(() => p.evaluate(() => sessionStorage.getItem("busy"))).not.toBeNull();
    expect(JSON.parse((await p.evaluate(() => sessionStorage.getItem("busy"))) ?? "{}")).toEqual({
      text: "Creating code…",
      disabled: true,
      busy: "true",
    });
    expect(state.posts).toBe(1);
    await ctx.close();
  });

  it("names the empty service with no organisations", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/admin-empty`, { waitUntil: "load" });
    expect(await p.getByText("No organisations yet.").count()).toBe(1);
    for (const theme of ["light", "dark"] as const) {
      await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await p.addScriptTag({ path: AXE });
      expect(problems(await scan(p)), theme).toEqual([]);
    }
    await ctx.close();
  });
});
