import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IdentityPage, type IdentityView, type Result } from "../../src/web/pages/identity-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The protected identity page in Chromium (D05 T01 §3), served over HTTP by this process with the shipped app script;
// its posts answered here with the redirect the Worker gives (their own answers are test/web/identity-page.test.ts).
// It proves every form shown busy and sent once, each form given back after a stopped request, the outcome announced
// after the redirect, every control and refusal reached by keyboard with an accessible name and a visible focus ring,
// and every state passing the accessibility gate's rules at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const { children: _children, ...SHELL } = member({ active: "protect" });
const CONTACT = "accounts@karoocouriers.example";
const IDENTITY: NonNullable<IdentityView["identity"]> = {
  displayNames: ["Karoo Couriers", "KC Express"],
  financeContact: CONTACT,
  logo: { key: "ident/org-karoo/logo-01J9ABC.png" },
  protected: true,
  effective: { on: true },
  version: 3,
};
const ACCOUNTS = [
  { id: "acc-1", bankName: "Kestrel Bank", branchCode: "250655", holder: "Customer payments", masked: "***512" },
  { id: "acc-2", bankName: "Protea Mutual", branchCode: "470010", holder: "Cash on delivery", masked: "***934" },
];
const BASE: IdentityView = {
  shell: SHELL,
  canEdit: true,
  identity: IDENTITY,
  domains: [
    { domain: "karoocouriers.example", state: "verified" },
    { domain: "kcexpress.example", state: "pending" },
  ],
  addresses: [CONTACT, "finance@karoocouriers.example"],
  since: "2026-10-12T08:00:00.000Z",
  accounts: ACCOUNTS,
  bankAvailable: true,
  slug: { slug: "karoo-couriers", changed: false },
};
const states: Record<string, IdentityView> = {
  registered: BASE,
  first: { ...BASE, identity: null, since: null, accounts: [], addresses: [CONTACT] },
  "no-address": { ...BASE, identity: null, since: null, accounts: [], addresses: [] },
  paused: {
    ...BASE,
    identity: { ...IDENTITY, effective: { on: false, reason: "no domain is verified" } },
    domains: [{ domain: "kcexpress.example", state: "pending" }],
    since: null,
  },
  "paused-contact": {
    ...BASE,
    identity: { ...IDENTITY, effective: { on: false, reason: "the finance contact is no longer a verified address" } },
    addresses: ["finance@karoocouriers.example"],
    since: null,
  },
  off: { ...BASE, identity: { ...IDENTITY, protected: false, effective: { on: false, reason: "off" } }, since: null },
  member: { ...BASE, canEdit: false },
  "bank-unavailable": { ...BASE, bankAvailable: false },
  confirm: { ...BASE, confirm: ACCOUNTS[0] ?? null },
  saved: { ...BASE, result: "saved" },
  unavailable: { ...BASE, result: "unavailable" },
  switched: { ...BASE, result: "switched" },
  refused: {
    ...BASE,
    typed: { tradingNames: "!!!", contact: "late@karoocouriers.example", protected: true },
    account: { bankName: "Kestrel Bank", branchCode: "25", holder: "Customer payments" },
    errors: {
      names: "Each name needs letters or digits.",
      contact: "Choose one of your verified sending addresses.",
      protection: "Protection needs a verified domain and a finance contact. Fix it, then switch protection on.",
      general: "Your identity was changed while you were editing, so nothing was saved. Check the page and save again.",
      logo: "The logo must be a PNG or SVG image.",
      account: {
        bankName: "Enter the bank.",
        branchCode: "A branch code is 6 digits.",
        number: "An account number is 7 to 11 digits.",
        holder: "Enter the account holder.",
        general: "Fill in every field.",
      },
    },
  },
};

const state = {
  page: "registered",
  delayMs: 0,
  logoFails: false,
  posts: [] as { path: string; fields: Record<string, string> }[],
};
afterEach(() => Object.assign(state, { page: "registered", delayMs: 0, logoFails: false, posts: [] }));

// A post's fields, whether the form sent them urlencoded or as multipart (the logo form's file is left out).
async function fieldsOf(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("latin1");
  if (!(req.headers["content-type"] ?? "").startsWith("multipart/"))
    return Object.fromEntries(new URLSearchParams(text));
  return Object.fromEntries(
    [...text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n--/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") {
      state.posts.push({ path: url.pathname, fields: await fieldsOf(req) });
      await new Promise((done) => setTimeout(done, state.delayMs));
      res.writeHead(303, { location: "/protect?r=saved" });
      return res.end();
    }
    if (url.pathname === "/protect") {
      const base = states[state.page] ?? BASE;
      const r = url.searchParams.get("r");
      const result = r && r !== "none" ? (r as Result) : null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
      return res.end(String(<IdentityPage {...base} result={result ?? base.result ?? null} />));
    }
    if (url.pathname === "/protect/logo") {
      // R2 unavailable: the route answers an error page, which an <img> cannot draw (completion review C7).
      if (state.logoFails) return res.writeHead(503, { "content-type": "text/html" }).end("<p>unavailable</p>");
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 24"><rect width="60" height="24" fill="#808080"/></svg>',
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
  state.page = page;
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await context.newPage();
  await p.goto(`${origin}/protect?r=none`, { waitUntil: "load" });
  return { p, context };
}

// The forms and the control that sends each, as a reader names it. Add account is filled first (its fields are required).
const FILL_ACCOUNT = async (p: Page) => {
  await p.locator("#account-bank").fill("Kestrel Bank");
  await p.locator("#account-branch").fill("250655");
  await p.locator("#account-number").fill("0620 0441 773");
  await p.locator("#account-holder").fill("Customer payments");
};
const ACTIONS: {
  page: string;
  name: string;
  busy: string;
  action: string;
  prepare?: (p: Page) => Promise<void>;
}[] = [
  { page: "registered", name: "Save identity", busy: "Saving", action: "save" },
  { page: "registered", name: "Replace logo", busy: "Uploading", action: "logo" },
  { page: "registered", name: "Remove logo", busy: "Removing", action: "remove-logo" },
  { page: "registered", name: "Add account", busy: "Adding", action: "add-account", prepare: FILL_ACCOUNT },
  {
    page: "registered",
    name: "Remove the Kestrel Bank account ending 512",
    busy: "Opening",
    action: "remove-account",
  },
  { page: "confirm", name: "Confirm removal", busy: "Removing", action: "confirm-remove-account" },
];

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "the protected identity page in Chromium",
  { timeout: 120_000 },
  () => {
    for (const a of ACTIONS)
      it(`shows ${a.name} busy, says so, and sends it once for two presses`, async () => {
        state.delayMs = 1200;
        const { p, context } = await open(a.page);
        await a.prepare?.(p);
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
        await p.getByRole("button", { name: a.name }).click({ noWaitAfter: true });
        await p.waitForURL(`${origin}/protect?r=saved`, { waitUntil: "load" });
        const busy = JSON.parse((await p.evaluate(() => sessionStorage.getItem("busy"))) ?? "{}");
        expect(busy).toMatchObject({ text: a.busy, disabled: true });
        expect(busy.live).toContain(a.busy);
        expect(state.posts.map((x) => x.path)).toEqual(["/protect"]);
        expect(state.posts[0]?.fields.action).toBe(a.action);
        expect(state.posts[0]?.fields.org).toBe("org-karoo");
        await context.close();
      });

    for (const a of ACTIONS)
      it(`gives the form back when ${a.name} is stopped, and sends again`, async () => {
        state.delayMs = 5000;
        const { p, context } = await open(a.page);
        await a.prepare?.(p);
        await p.evaluate(() => {
          for (const form of document.querySelectorAll<HTMLFormElement>("form[data-busy]")) form.dataset.busyMs = "800";
        });
        await p.getByRole("button", { name: a.name }).click({ noWaitAfter: true });
        await p.waitForTimeout(200);
        await (await context.newCDPSession(p)).send("Page.stopLoading");
        await expect.poll(() => p.getByRole("button", { name: a.name }).isEnabled(), { timeout: 5000 }).toBe(true);
        expect((await p.getByRole("button", { name: a.name }).textContent())?.trim()).not.toBe(a.busy);
        state.delayMs = 0;
        await p.getByRole("button", { name: a.name }).click({ noWaitAfter: true });
        await expect.poll(() => state.posts.length).toBe(2);
        await context.close();
      });

    it("announces the outcome after the redirect in a status region", async () => {
      const { p, context } = await open("registered");
      await p.getByRole("button", { name: "Save identity" }).click({ noWaitAfter: true });
      await p.waitForURL(`${origin}/protect?r=saved`, { waitUntil: "load" });
      const status = p.locator("[role=status]", { hasText: "Your identity is saved." });
      await expect.poll(() => status.count()).toBe(1);
      await context.close();
    });

    it("reaches every control and refusal by keyboard, each with an accessible name and a visible focus ring", async () => {
      for (const page of ["registered", "first", "refused", "confirm", "bank-unavailable"]) {
        const { p, context } = await open(page);
        const seen: { name: string; outline: string }[] = [];
        let entered = false;
        for (let i = 0; i < 80; i++) {
          await p.keyboard.press("Tab");
          const here = await p.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el || el === document.body) return null;
            const labelled = (el.getAttribute("aria-labelledby") ?? "")
              .split(" ")
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ");
            const labels = [...((el as HTMLInputElement).labels ?? [])].map((l) => l.textContent).join(" ");
            // An image's alternative text names the link it sits in (the signature badge's preview, D05 T02 §7).
            const images = [...el.querySelectorAll("img[alt]")].map((img) => img.getAttribute("alt")).join(" ");
            const name = (
              el.getAttribute("aria-label") ||
              labelled ||
              labels ||
              el.textContent?.trim() ||
              images ||
              el.getAttribute("title") ||
              ""
            ).trim();
            const s = getComputedStyle(el);
            const isField =
              el.tagName === "TEXTAREA" ||
              el.tagName === "SELECT" ||
              (el.tagName === "INPUT" &&
                !["checkbox", "radio", "file", "button", "submit"].includes((el as HTMLInputElement).type));
            return {
              name,
              inMain: !!el.closest("main"),
              outline: isField ? `${s.borderTopStyle} ${s.borderTopColor}` : s.outlineStyle,
            };
          });
          if (!here) continue;
          if (here.inMain) {
            entered = true;
            seen.push({ name: here.name, outline: here.outline });
          } else if (entered) break;
        }
        expect(seen.length, page).toBeGreaterThan(3);
        for (const s of seen) {
          expect(s.name, `${page}: a control with no name`).not.toBe("");
          expect(s.outline, `${page}: ${s.name} focus ring`).not.toBe("none");
        }
        const names = seen.map((s) => s.name);
        if (page === "registered")
          for (const wanted of [
            "Protected",
            "Trading names",
            "kcexpress.example",
            "Manage domains",
            "Logo file",
            "Replace logo",
            "Remove logo",
            CONTACT,
            "Save identity",
            "Bank",
            "Account number",
            "Add account",
            "Remove the Kestrel Bank account ending 512",
          ])
            expect(names, wanted).toContain(wanted);
        if (page === "confirm") expect(names).toEqual(expect.arrayContaining(["Confirm removal", "Cancel"]));
        await context.close();
      }
    });

    it("announces every refusal on its field: invalid, described by the refusal, and an alert", async () => {
      const { p, context } = await open("refused");
      for (const [id, error] of [
        ["trading-names", "Each name needs letters or digits."],
        ["account-bank", "Enter the bank."],
        ["account-branch", "A branch code is 6 digits."],
        ["account-number", "An account number is 7 to 11 digits."],
        ["account-holder", "Enter the account holder."],
      ] as const) {
        const field = p.locator(`#${id}`);
        expect(await field.getAttribute("aria-invalid"), id).toBe("true");
        const described = ((await field.getAttribute("aria-describedby")) ?? "").split(" ");
        expect(described, id).toContain(`${id}-error`);
        expect(await p.locator(`#${id}-error`).textContent()).toBe(error);
        expect(await p.locator(`#${id}-error`).getAttribute("role")).toBe("alert");
      }
      for (const words of [
        "Choose one of your verified sending addresses.",
        "so nothing was saved",
        "The logo must be a PNG or SVG image.",
        "Fill in every field.",
        "Protection needs a verified domain",
      ])
        expect(await p.locator("[role=alert]", { hasText: words }).count(), words).toBe(1);
      // The typed values come back, the account number never.
      expect(await p.locator("#trading-names").inputValue()).toBe("!!!");
      expect(await p.locator("#account-bank").inputValue()).toBe("Kestrel Bank");
      expect(await p.locator("#account-number").inputValue()).toBe("");
      await context.close();
    });

    it("asks before another form's send discards unsaved names, and sends nothing when declined (completion review C3)", async () => {
      const { p, context } = await open("registered");
      await p.locator("#trading-names").fill("KC Express\nKaroo Rush");
      await FILL_ACCOUNT(p);
      const asked: string[] = [];
      p.once("dialog", (dialog) => {
        asked.push(dialog.message());
        void dialog.dismiss();
      });
      await p.getByRole("button", { name: "Add account" }).click();
      await p.waitForTimeout(300);
      expect(asked).toEqual(["You have unsaved changes in the identity details. Discard them?"]);
      expect(state.posts).toEqual([]);
      expect(await p.locator("#trading-names").inputValue()).toBe("KC Express\nKaroo Rush");
      // Accepted, the send goes ahead.
      p.once("dialog", (dialog) => void dialog.accept());
      await Promise.all([p.waitForURL(/r=saved/), p.getByRole("button", { name: "Add account" }).click()]);
      expect(state.posts.map((x) => x.fields.action)).toEqual(["add-account"]);
      // A form sent with nothing changed elsewhere asks nothing.
      let quiet = true;
      p.once("dialog", (dialog) => {
        quiet = false;
        void dialog.dismiss();
      });
      await Promise.all([p.waitForURL(/r=saved/), p.getByRole("button", { name: "Save identity" }).click()]);
      expect(quiet).toBe(true);
      await context.close();
    });

    it("still asks after a refusal drew the unsaved values back as the form's own (round 1)", async () => {
      const { p, context } = await open("refused");
      const asked: string[] = [];
      p.once("dialog", (dialog) => {
        asked.push(dialog.message());
        void dialog.dismiss();
      });
      await p.getByRole("button", { name: "Remove logo" }).click();
      await p.waitForTimeout(300);
      expect(asked).toEqual(["You have unsaved changes in the identity details. Discard them?"]);
      expect(state.posts).toEqual([]);
      await context.close();
    });

    it("says the logo could not be shown, with a reload, when its image fails (completion review C7)", async () => {
      state.logoFails = true;
      const { p, context } = await open("registered");
      const message = p.getByText("Your logo could not be shown just now.");
      await message.waitFor({ state: "visible" });
      expect(await p.locator("img[data-fallback]").isHidden()).toBe(true);
      expect(await p.getByRole("link", { name: "Reload" }).count()).toBe(1);
      await context.close();
      state.logoFails = false;
      const ok = await open("registered");
      await ok.p.locator("img[data-fallback]").waitFor({ state: "visible" });
      expect(await ok.p.getByText("Your logo could not be shown just now.").isHidden()).toBe(true);
      await ok.context.close();
    });

    it("moves focus to what just happened: the outcome after a redirect, the refusal, the confirmation (completion review E5)", async () => {
      for (const [page, where] of [
        ["saved", "[role=status]"],
        // The first refusal on the page, read out as an alert, before the fields it is about.
        ["refused", "[role=alert]"],
        ["confirm", "#confirm-heading"],
      ] as const) {
        state.page = page;
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const p = await context.newPage();
        await p.goto(`${origin}/protect${page === "saved" ? "?r=saved" : "?r=none"}`, { waitUntil: "load" });
        await p.waitForFunction(() => document.activeElement && document.activeElement !== document.body);
        const focused = await p.evaluate(
          (sel) => document.activeElement === document.querySelector(sel) || !!document.activeElement?.closest(sel),
          where,
        );
        expect(focused, page).toBe(true);
        await context.close();
      }
    });

    it("registers in three actions from a page with a verified domain and address ready (completion review E2)", async () => {
      const { p, context } = await open("first");
      let actions = 0;
      await p.getByRole("radio", { name: CONTACT }).check();
      actions++;
      await p.getByRole("checkbox", { name: "Protected" }).check();
      actions++;
      await Promise.all([p.waitForURL(/r=saved/), p.getByRole("button", { name: "Save identity" }).click()]);
      actions++;
      expect(actions).toBeLessThanOrEqual(3);
      expect(state.posts.map((x) => [x.fields.action, x.fields.contact, x.fields.protected])).toEqual([
        ["save", CONTACT, "on"],
      ]);
      await context.close();
    });

    it("gives a member the page with nothing that changes it, and the badge to copy for their own signature", async () => {
      const { p, context } = await open("member");
      expect(await p.locator("main form, main input").count()).toBe(0);
      // Copying the signature badge changes nothing (D05 T02 §7): staff are the ones who paste it into their signatures.
      expect(await p.locator("main button").allTextContents()).toEqual(["Copy signature HTML"]);
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
  },
);
