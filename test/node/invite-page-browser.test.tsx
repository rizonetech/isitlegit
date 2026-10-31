import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Document } from "../../src/web/components/Document.tsx";
import { type InvitationView, InvitePage, type InviteState } from "../../src/web/pages/invite.tsx";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The invitation page in Chromium (D07 T02 §14), served over HTTP by this process with the shipped app script; its
// posts answered here with the shapes the Worker's routes give (their own answers are test/web/invite-page.test.ts).
// It proves every action shown busy and sent once, the form given back after a stopped request, each action driven by
// keyboard with the focus ring visible, and every state passing the accessibility gate's rules at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const INV: InvitationView = {
  id: "inv-1",
  organizationId: "org-karoo",
  organization: "Karoo Couriers",
  inviter: "Thandi Nkosi",
  email: "sipho@karoocouriers.example",
  role: "member",
  expiresAt: "2026-11-01T07:02:00Z",
};
const states: Record<string, InviteState> = {
  "signed-out": { kind: "signed-out", invitation: INV },
  invitee: { kind: "invitee", invitation: INV, signedInAs: INV.email },
  "invitee-unsure": {
    kind: "invitee",
    invitation: INV,
    signedInAs: INV.email,
    problem: "We could not tell whether that finished. Open the invitation again to see where it stands.",
    recheck: true,
  },
  "someone-else": { kind: "someone-else", invitation: INV, signedInAs: "thandi@karoocouriers.example" },
  expired: { kind: "expired", invitation: INV },
  revoked: { kind: "revoked", invitation: INV },
  declined: { kind: "declined", invitation: INV },
  accepted: { kind: "accepted", invitation: INV },
  "accepted-member": { kind: "accepted", invitation: INV, member: true },
  unfinished: { kind: "unfinished", invitation: INV },
  unknown: { kind: "unknown" },
};
const state = { page: "invitee", delayMs: 0, posts: [] as { path: string; body: Record<string, string> }[] };
afterEach(() => Object.assign(state, { page: "invitee", delayMs: 0, posts: [] }));

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") {
      state.posts.push({ path: url.pathname, body: await body(req) });
      await new Promise((done) => setTimeout(done, state.delayMs));
      res.writeHead(303, { location: "/done" });
      return res.end();
    }
    if (url.pathname === "/invite/inv-1") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
      return res.end(String(<InvitePage state={states[state.page] ?? { kind: "unknown" }} />));
    }
    if (url.pathname === "/done") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(String(<Document title="Done">{<h1>Done</h1>}</Document>));
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

async function open(page: string, width = 1280) {
  state.page = page;
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  await p.goto(`${origin}/invite/inv-1`, { waitUntil: "load" });
  return { p, context };
}
// Tab until the named control has focus, and check its focus ring shows.
async function tabTo(p: Page, name: string) {
  for (let i = 0; i < 20; i++) {
    await p.keyboard.press("Tab");
    const here = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { text: el?.textContent?.trim() ?? "", outline: el ? getComputedStyle(el).outlineStyle : "none" };
    });
    if (here.text === name) {
      expect(here.outline, `${name} focus ring`).not.toBe("none");
      return;
    }
  }
  throw new Error(`never reached ${name}`);
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the invitation page in Chromium", { timeout: 120_000 }, () => {
  const ACTIONS = [
    ["signed-out", "Email me a sign-in link", "Sending…", "/signin/link"],
    ["invitee", "Accept and join", "Joining…", "/invite/inv-1"],
    ["invitee", "Not you? Decline", "Declining…", "/invite/inv-1"],
    ["someone-else", "Sign out", "Signing out…", "/auth/sign-out"],
  ] as const;

  for (const [page, name, busyWords, path] of ACTIONS)
    it(`shows ${name} busy, says so, and sends it once for two presses`, async () => {
      state.delayMs = 1200;
      const { p, context } = await open(page);
      await p.evaluate(() =>
        document.addEventListener("submit", (event) => {
          const form = event.target as HTMLFormElement;
          setTimeout(() => {
            const b = form.querySelector<HTMLButtonElement>("button[type=submit]");
            const live = [...form.querySelectorAll("[role=status]")].map((n) => n.textContent);
            sessionStorage.setItem("busy", JSON.stringify({ text: b?.textContent, disabled: b?.disabled, live }));
            form.requestSubmit();
          }, 100);
        }),
      );
      await p.getByRole("button", { name }).click({ noWaitAfter: true });
      await p.waitForURL(`${origin}/done`, { waitUntil: "load" });
      const busy = JSON.parse((await p.evaluate(() => sessionStorage.getItem("busy"))) ?? "{}");
      expect(busy).toMatchObject({ text: busyWords, disabled: true });
      expect(busy.live).toContain(busyWords);
      expect(state.posts.map((x) => x.path)).toEqual([path]);
      await context.close();
    });

  for (const [page, name] of ACTIONS)
    it(`offers to see where ${name} stands within two seconds, and gives the form back when stopped`, async () => {
      state.delayMs = 6000;
      const { p, context } = await open(page);
      await p.evaluate(() => {
        for (const form of document.querySelectorAll<HTMLFormElement>("form[data-busy]")) form.dataset.busyMs = "3000";
      });
      await p.getByRole("button", { name }).click({ noWaitAfter: true });
      await p.waitForTimeout(200);
      await (await context.newCDPSession(p)).send("Page.stopLoading");
      const started = Date.now();
      const check = p.getByRole("link", { name: "Taking a while? See where it stands" });
      await expect.poll(() => check.isVisible(), { timeout: 3000 }).toBe(true);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(await check.getAttribute("href")).toBe("/invite/inv-1");
      await expect.poll(() => p.getByRole("button", { name }).isEnabled(), { timeout: 5000 }).toBe(true);
      expect(await check.count()).toBe(0);
      await context.close();
    });

  for (const [page, name, path, fields] of [
    ["signed-out", "Email me a sign-in link", "/signin/link", { email: INV.email, callbackURL: "/invite/inv-1" }],
    ["invitee", "Accept and join", "/invite/inv-1", { action: "accept" }],
    ["invitee", "Not you? Decline", "/invite/inv-1", { action: "decline" }],
    ["someone-else", "Sign out", "/auth/sign-out", { next: "/invite/inv-1" }],
  ] as const)
    it(`${name} by keyboard alone, its focus ring showing`, async () => {
      const { p, context } = await open(page);
      await tabTo(p, name);
      await p.keyboard.press("Enter");
      await p.waitForURL(`${origin}/done`, { waitUntil: "load" });
      expect(state.posts).toEqual([{ path, body: fields }]);
      await context.close();
    });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules in every state (${theme}, ${width} px)`, async () => {
        for (const page of Object.keys(states)) {
          const { p, context } = await open(page, width);
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), page).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), page).toEqual([]);
          await context.close();
        }
      });
});
