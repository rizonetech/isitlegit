import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DomainClaimView } from "../../src/auth/domain-claim";
import { DomainPage, type Result } from "../../src/web/pages/domains-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The domain verification page in Chromium (D07 T02 §15), served over HTTP by this process with the shipped app script:
// each form sends what it shows, Check now, Send code and Verify go busy and send once, the whole page works by keyboard
// and without JavaScript, the record's name and value copy (and select when the clipboard refuses), and each state
// passes the accessibility gate's rules at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date("2026-10-30T12:05:00Z");
const DOMAIN = "kcexpress.example";
const pending = (over: Partial<DomainClaimView> = {}): DomainClaimView => ({
  domain: DOMAIN,
  state: "pending",
  method: null,
  verifiedAt: null,
  verifiedBy: null,
  txt: { name: `_isitlegit.${DOMAIN}`, value: "isitlegit-verify=7f3c9a1e52d84b06" },
  code: { expiresAt: null, expired: false, attempts: 0, lockedUntil: null, nextCodeAt: null },
  lastCheck: { at: "2026-10-30T12:05:00Z", outcome: "dns-not-visible" },
  ...over,
});
const STATES: Record<string, { view: DomainClaimView; result: Result | null }> = {
  pending: { view: pending(), result: null },
  coded: {
    view: pending({
      code: { expiresAt: "2026-10-30T12:35:00Z", expired: false, attempts: 1, lockedUntil: null, nextCodeAt: null },
    }),
    result: { r: "verify-wrong" },
  },
  failed: { view: pending(), result: { r: "check-different", seen: "isitlegit-verify=0b19" } },
  locked: {
    view: pending({
      code: {
        expiresAt: null,
        expired: false,
        attempts: 0,
        lockedUntil: "2026-10-30T13:14:00Z",
        nextCodeAt: "2026-10-30T13:14:00Z",
      },
    }),
    result: null,
  },
  verified: {
    view: pending({ state: "verified", method: "dns", verifiedAt: "2026-10-30T12:12:00Z", lastCheck: null }),
    result: null,
  },
};

const state = { page: "pending", delayMs: 0, posts: [] as Record<string, string>[] };

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
      state.posts.push(await body(req));
      await new Promise((done) => setTimeout(done, state.delayMs));
      res.writeHead(303, { location: url.pathname });
      return res.end();
    }
    if (url.pathname === `/settings/domains/${DOMAIN}`) {
      const { view, result } = STATES[state.page] ?? STATES.pending ?? { view: pending(), result: null };
      const { children: _, ...shell } = member({ active: "domains" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
      return res.end(String(<DomainPage shell={shell} view={view} result={result} now={NOW} />));
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
afterEach(() => Object.assign(state, { page: "pending", delayMs: 0, posts: [] }));

async function open(options: { width?: number; js?: boolean; clipboard?: boolean } = {}) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  if (options.clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const p: Page = await context.newPage();
  await p.goto(`${origin}/settings/domains/${DOMAIN}`, { waitUntil: "load" });
  return { p, context };
}
const tabTo = async (p: Page, test: () => Promise<boolean>, limit = 80) => {
  for (let i = 0; i < limit && !(await test()); i++) await p.keyboard.press("Tab");
  expect(await test()).toBe(true);
};
const focusedText = (p: Page) => p.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

// The form only comes back once its request can no longer be running: the app script's wait must outlast the slowest
// action on the server, a mail send's deadline (round 1: at 20 seconds a second Send code could replace a code still
// being mailed).
describe("provider DNS help (D07 T04 §11)", () => {
  it("opens each provider's steps by keyboard, focus kept, and without JavaScript", async () => {
    const { p, context } = await open();
    const summary = (name: string) => p.locator("summary", { hasText: name });
    for (const name of ["Cloudflare", "Hetzner", "xneelo", "Afrihost", "Another provider"]) {
      await summary(name).focus();
      await p.keyboard.press("Enter");
      const details = summary(name).locator("..");
      expect(await details.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
      await p.keyboard.press("Enter");
      expect(await details.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
      expect(await focusedText(p)).toContain(name);
    }
    expect(await p.locator("body").textContent()).toContain("Record: _isitlegit.kcexpress.example");
    await context.close();
    const plain = await open({ js: false });
    await plain.p.locator("summary", { hasText: "Afrihost" }).click();
    expect(await plain.p.locator("text=Open ClientZone, then Hosting").isVisible()).toBe(true);
    await plain.context.close();
  });

  it("passes the accessibility gate with every recipe open, at both widths and themes", async () => {
    for (const width of [360, 1280]) {
      const { p, context } = await open({ width });
      for (const name of ["Cloudflare", "Hetzner", "xneelo", "Afrihost", "Another provider"])
        await p.locator("summary", { hasText: name }).click();
      await p.addScriptTag({ path: AXE });
      for (const theme of ["light", "dark"] as const) {
        await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const result = await scan(p);

        expect(problems(result), `${theme} ${width}`).toEqual([]);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      await context.close();
    }
  });
});

describe("the busy form's wait", () => {
  it("outlasts the mail send's deadline", () => {
    const number = (file: string, pattern: RegExp) =>
      Number(
        (pattern.exec(readFileSync(join(import.meta.dirname, "../..", file), "utf8"))?.[1] ?? "").replace(/_/g, ""),
      );
    const wait = number("src/web/client/app.ts", /const BUSY_MS = ([\d_]+);/);
    const mail = number("src/mail/smtp2go.ts", /deps\.timeoutMs \?\? ([\d_]+)/);
    expect(mail).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(mail + 10_000);
  });

  // The server holds a new code while the last is being mailed (src/auth/domains.ts CODE_SEND_WINDOW_MS); the window
  // must outlast a send's whole life: every attempt's deadline and the backoff between them (round 2).
  it("holds a new code for longer than a mail send's whole retry life", () => {
    const source = (file: string) => readFileSync(join(import.meta.dirname, "../..", file), "utf8");
    const mail = source("src/mail/smtp2go.ts");
    const attempts = Number(/export const MAX_ATTEMPTS = (\d+);/.exec(mail)?.[1]);
    const deadline = Number((/deps\.timeoutMs \?\? ([\d_]+)/.exec(mail)?.[1] ?? "").replace(/_/g, ""));
    expect(mail).toContain("await pause(1000 * 2 ** (attempts - 1));");
    const backoff = Array.from({ length: attempts - 1 }, (_, i) => 1000 * 2 ** i).reduce((a, b) => a + b, 0);
    const window = /export const CODE_SEND_WINDOW_MS = (\d+) \* 60_000;/.exec(source("src/auth/domains.ts"))?.[1];
    expect(attempts).toBeGreaterThan(0);
    expect(Number(window) * 60_000).toBeGreaterThan(attempts * deadline + backoff);
  });
});

describe.skipIf(!chromiumPath() && !process.env.CI)("the domain page in Chromium", { timeout: 120_000 }, () => {
  it("shows Check now busy while it runs and sends it once for two presses", async () => {
    state.delayMs = 1500;
    const { p, context } = await open();
    // A page whose form has gone cannot be read from outside until the answer arrives, so the page records its own
    // button a moment after the press, presses again, and the record is read once the answer has loaded.
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
    await p.getByRole("button", { name: "Check now" }).click({ noWaitAfter: true });
    await p.waitForURL(`${origin}/settings/domains/${DOMAIN}`, { waitUntil: "load" });
    await expect.poll(() => p.evaluate(() => sessionStorage.getItem("busy"))).not.toBeNull();
    expect(JSON.parse((await p.evaluate(() => sessionStorage.getItem("busy"))) ?? "{}")).toEqual({
      text: "Checking",
      disabled: true,
      busy: "true",
    });
    expect(state.posts).toEqual([{ org: "org-karoo", action: "check", local: "admin" }]);
    await context.close();
  });

  it("chooses the recipient and sends by keyboard alone, the form sending what it shows", async () => {
    const { p, context } = await open();
    await tabTo(p, () => p.evaluate(() => (document.activeElement as HTMLInputElement)?.name === "local"));
    await p.keyboard.press("ArrowDown");
    expect(await p.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("postmaster");
    await tabTo(p, async () => (await focusedText(p)) === "Send code");
    await p.keyboard.press("Enter");
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]).toEqual({ org: "org-karoo", action: "send", local: "postmaster" });
    await context.close();
  });

  it("verifies by keyboard with Enter, after an announced wrong code", async () => {
    state.page = "coded";
    const { p, context } = await open();
    const field = p.getByLabel("Code from the email");
    expect(await field.getAttribute("aria-invalid")).toBe("true");
    const described = (await field.getAttribute("aria-describedby")) ?? "";
    const said = await p.evaluate(
      (ids) =>
        ids
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      described,
    );
    expect(said).toContain("That code is not right. 2 tries left before this is locked for an hour.");
    await tabTo(p, () => p.evaluate(() => document.activeElement?.id === "claim-code"));
    await p.keyboard.type("48 21 07");
    await p.keyboard.press("Enter");
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]).toEqual({ org: "org-karoo", action: "verify", local: "admin", code: "48 21 07" });
    await context.close();
  });

  it("keeps a whole pasted code, spaces and all, for the server to read", async () => {
    state.page = "coded";
    const { p, context } = await open({ clipboard: true });
    await p.evaluate(() => navigator.clipboard.writeText(" 07 21 07 "));
    await p.getByLabel("Code from the email").focus();
    await p.keyboard.press("ControlOrMeta+V");
    expect(await p.getByLabel("Code from the email").inputValue()).toBe(" 07 21 07 ");
    await p.keyboard.press("Enter");
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]?.code).toBe(" 07 21 07 ");
    await context.close();
  });

  it("gives the form back when its request is stopped", async () => {
    state.delayMs = 5000;
    const { p, context } = await open();
    // The wait before the form comes back, shortened for the test (20 seconds on the page).
    await p.evaluate(() => {
      for (const form of document.querySelectorAll<HTMLFormElement>("form[data-busy]")) form.dataset.busyMs = "800";
    });
    await p.getByRole("button", { name: "Check now" }).click({ noWaitAfter: true });
    await p.waitForTimeout(200);
    // The reader presses Stop (the page cannot be reached from outside while its form is out, so through DevTools).
    await (await context.newCDPSession(p)).send("Page.stopLoading");
    await expect
      .poll(() =>
        p.evaluate(() => {
          const b = document.querySelector<HTMLButtonElement>("form[data-busy] button[type=submit]");
          return { text: b?.textContent?.trim(), disabled: b?.disabled };
        }),
      )
      .toEqual({ text: "Check now", disabled: false });
    state.delayMs = 0;
    await p.getByRole("button", { name: "Check now" }).click();
    await expect.poll(() => state.posts.length).toBe(2);
    await context.close();
  });

  it("copies the record's name and value, and selects them when the clipboard refuses", async () => {
    const { p, context } = await open({ clipboard: true });
    await p.getByRole("button", { name: "Copy the record name" }).click();
    await expect.poll(() => p.evaluate(() => navigator.clipboard.readText())).toBe(`_isitlegit.${DOMAIN}`);
    await p.getByRole("button", { name: "Copy the record value" }).click();
    await expect.poll(() => p.evaluate(() => navigator.clipboard.readText())).toBe("isitlegit-verify=7f3c9a1e52d84b06");
    await p.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
    await p.getByRole("button", { name: "Copy the record value" }).click();
    await expect.poll(() => p.evaluate(() => String(window.getSelection()))).toBe("isitlegit-verify=7f3c9a1e52d84b06");
    await context.close();
  });

  it("works without JavaScript: each form posts what it shows", async () => {
    const { p, context } = await open({ js: false });
    await p.getByLabel(`postmaster@${DOMAIN}`).check();
    await p.getByRole("button", { name: "Send code" }).click();
    await p.waitForLoadState("load");
    await p.getByRole("button", { name: "Check now" }).click();
    await p.waitForLoadState("load");
    expect(state.posts).toEqual([
      { org: "org-karoo", action: "send", local: "postmaster" },
      { org: "org-karoo", action: "check", local: "admin" },
    ]);
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules in each state (${theme}, ${width} px)`, async () => {
        for (const page of Object.keys(STATES)) {
          state.page = page;
          const { p, context } = await open({ width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), page).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), page).toEqual([]);
          await context.close();
        }
      });
});
