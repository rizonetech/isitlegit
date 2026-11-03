import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ConfirmPage,
  InboxPage,
  LinkCheckFailedPage,
  LinkRequestPage,
  MessagePage,
  pageResponse,
  retryIn,
} from "../../src/auth/confirm-page.tsx";
import { Document } from "../../src/web/components/Document.tsx";
import { SigninPage } from "../../src/web/pages/signin.tsx";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The sign-in page in Chromium (D07 T02 §7), served over HTTP by this process with the shipped stylesheet and app script;
// its posts and the session check are answered here with the Worker's shapes (the Worker's own answers are
// test/web/signin-page.test.ts and test/auth/'s). It proves A1's frame at both widths; the busy submit, said in a live
// region, sending once and usable again after Back; each rate-limited state's retry, held until its time and then
// repeating its own operation; the inbox state finishing in the tab that asked, for its own address only; the keyboard
// order; and every state passing the accessibility gate's rules, each check shown to fail on a planted defect.
const PUBLIC = join(import.meta.dirname, "../../public");
const EMAIL = "thandi@karoocouriers.example";

type Post = { path: string; body: Record<string, string> };
const state = {
  delayMs: 0,
  session: null as string | null,
  sessionFails: false,
  // Per session check, in the order they arrive: how long to hold its answer (the answer is the session as it was
  // when the check arrived).
  sessionDelays: [] as number[],
  gets: 0,
  posts: [] as Post[],
  linkAnswer: "inbox" as "inbox" | "limited",
  confirmAnswer: "limited" as "limited" | "signed-in",
  // How long the limited pages hold their retry; the retry tests use a short real one rather than a fake clock.
  retrySeconds: 600,
};
afterEach(() =>
  Object.assign(state, {
    delayMs: 0,
    session: null,
    sessionFails: false,
    sessionDelays: [],
    gets: 0,
    posts: [],
    linkAnswer: "inbox",
    confirmAnswer: "limited",
    retrySeconds: 600,
  }),
);

const pages: Record<string, () => unknown> = {
  "/signin": () => SigninPage({ next: "/cases/42" }),
  "/signin/failed": () => SigninPage({ next: "/cases/42", error: "INVALID_TOKEN" }),
  "/signin/inbox": () => InboxPage({ email: EMAIL, callbackURL: "/cases/42" }),
  "/signin/refused": () =>
    InboxPage({ email: EMAIL, callbackURL: "/cases/42", codeError: "That code is not right. 2 tries left." }),
  "/signin/code-limited": () =>
    InboxPage({
      email: EMAIL,
      callbackURL: "/cases/42",
      codeError: "Too many codes tried from here.",
      retry: retryIn(state.retrySeconds),
      code: "123 456",
    }),
  "/signin/link-limited": () =>
    LinkRequestPage({ callbackURL: "/cases/42", email: EMAIL, retry: retryIn(state.retrySeconds) }),
  "/signin/confirm": () => ConfirmPage({ token: "tok", callbackURL: "/cases/42" }),
  // A link another browser asked for (D07 T02 §12): where to finish, with signing in here as the secondary choice.
  "/signin/confirm-elsewhere": () => ConfirmPage({ token: "tok", callbackURL: "/cases/42", elsewhere: true }),
  // The check of where a link was asked for failed (D07 T02 §12): nothing spent, Try again keeps the link.
  "/signin/confirm-check-failed": () => LinkCheckFailedPage({ token: "tok", callbackURL: "/cases/42" }),
  "/signin/confirm-limited": () =>
    ConfirmPage({ token: "tok", callbackURL: "/cases/42", retry: retryIn(state.retrySeconds) }),
  "/signin/message": () =>
    MessagePage({
      title: "No account",
      heading: "This address has no IsItLegit account",
      text: "Ask for an invitation.",
    }),
};

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}
const send = async (res: import("node:http").ServerResponse, rendered: Response) => {
  res.writeHead(rendered.status, Object.fromEntries(rendered.headers));
  res.end(await rendered.text());
};

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") {
      const fields = await body(req);
      state.posts.push({ path: url.pathname, body: fields });
      await new Promise((done) => setTimeout(done, state.delayMs));
      if (url.pathname === "/signin/link")
        return send(
          res,
          await pageResponse(
            state.linkAnswer === "inbox"
              ? InboxPage({ email: fields.email ?? "", callbackURL: fields.callbackURL ?? "/cases" })
              : LinkRequestPage({
                  callbackURL: fields.callbackURL ?? "/cases",
                  email: fields.email ?? "",
                  retry: retryIn(600),
                }),
          ),
        );
      // As the Worker lands a sign-in (src/auth/confirm.tsx `signedIn`): the address as asked, and the signal cookie.
      res.writeHead(303, {
        location: fields.callbackURL ?? "/cases",
        "set-cookie": "isitlegit_signed_in=1; Path=/; Max-Age=60; SameSite=Lax; Secure",
      });
      return res.end();
    }
    if (url.pathname === "/api/auth/get-session") {
      if (state.sessionFails) return res.writeHead(500).end();
      const now = state.session;
      await new Promise((done) => setTimeout(done, state.sessionDelays.shift() ?? 0));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(now ? { user: { email: now } } : null));
    }
    const page = pages[url.pathname];
    state.gets++;
    if (page) return send(res, await pageResponse(page()));
    // A sign-in's landing in another tab: the page the link opened, with the signal cookie set.
    if (url.pathname === "/landed") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "isitlegit_signed_in=1; Path=/; Max-Age=60; SameSite=Lax; Secure",
      });
      return res.end(String(<Document title="Landed">{<h1>Landed</h1>}</Document>));
    }
    if (url.pathname.startsWith("/cases")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(String(<Document title="Cases">{<h1>Cases page</h1>}</Document>));
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

// The page's retry hold, taken over by the test (`captureRetry`): the page holds a rate-limited button with one timer
// (src/web/client/app.ts, `data-retry-at`) for each held button (a page can hold more than one), whose callback names
// `readyLabel`. The test keeps those callbacks and the delays they were given, and fires it on its own signal, so the held state is not a race against the page's load time
// under CI load, and the release is the page's own code running, not a wall-clock margin.
type Captured = { fire: () => void; ms: number };
// A call Playwright gives no timeout of its own (`evaluate`, `keyboard.press`) can wait out the whole test limit with
// nothing to say where, as the retry test did in CI (checks lane 41260977071, main's 41146401455 before it). Each such
// call in the retry test goes through here, so a hang fails in 20 seconds naming the step.
async function step<T>(name: string, work: Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step "${name}" did not finish in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

async function open(
  path: string,
  options: { width?: number; context?: BrowserContext; clock?: boolean; captureRetry?: boolean } = {},
) {
  const context =
    options.context ?? (await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 } }));
  const p: Page = await context.newPage();
  if (options.clock) await p.clock.install();
  if (options.captureRetry)
    await p.addInitScript(() => {
      const w = window as unknown as { __retry: Captured[] };
      w.__retry = [];
      const real = window.setTimeout.bind(window);
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof fn === "function" && String(fn).includes("readyLabel")) {
          w.__retry.push({ fire: () => fn(...args), ms: ms ?? 0 });
          return 0;
        }
        return real(fn, ms, ...args);
      }) as typeof window.setTimeout;
    });
  await p.goto(`${origin}${path}`, { waitUntil: "load", timeout: 30_000 });
  return { p, context };
}

// The page's controls in the order Tab reaches them, by name, starting from the one the page focused (a field with
// `autofocus`) when there is one.
// Presses Tab from the page's start until the control with this text has focus, within `max` presses: false when
// sequential navigation never reaches it.
async function tabsTo(p: Page, text: string, max = 8) {
  for (let i = 0; i < max; i++) {
    await p.keyboard.press("Tab");
    if ((await p.evaluate(() => document.activeElement?.textContent?.trim())) === text) return true;
  }
  return false;
}

async function tabOrder(p: Page, count: number) {
  const name = () =>
    p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "";
      const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null;
      // A link whose name is its image's text (the logo's "IsItLegit home") is named by that.
      const named = label ?? el.getAttribute("aria-label") ?? el.textContent?.trim();
      return (named || el.querySelector("img")?.getAttribute("alt") || "").trim();
    });
  const seen: string[] = [];
  const first = await name();
  if (first) seen.push(first);
  while (seen.length < count) {
    await p.keyboard.press("Tab");
    seen.push(await name());
  }
  return seen;
}
// Whether pressing a form's button says its busy words in a live region, read from inside the page while the request
// is out (the page cannot be read from outside then).
async function busySaid(p: Page, button: string) {
  await p.evaluate(() =>
    document.addEventListener("submit", (event) => {
      const form = event.target as HTMLFormElement;
      setTimeout(() => {
        const live = [...form.querySelectorAll<HTMLElement>("[role=status],[aria-live]")].map(
          (n) => n.textContent ?? "",
        );
        const b = form.querySelector<HTMLButtonElement>("button[type=submit]");
        sessionStorage.setItem(
          "busy",
          JSON.stringify({ live, text: b?.textContent, disabled: b?.disabled, busy: b?.getAttribute("aria-busy") }),
        );
        form.requestSubmit();
      }, 100);
    }),
  );
  await p.getByRole("button", { name: button }).click({ noWaitAfter: true });
  await p.waitForURL((u) => u.pathname !== "/signin", { waitUntil: "load" });
  return JSON.parse((await p.evaluate(() => sessionStorage.getItem("busy"))) ?? "{}") as {
    live: string[];
    text: string;
    disabled: boolean;
    busy: string;
  };
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the sign-in page in Chromium", { timeout: 120_000 }, () => {
  it("draws A1's frame: the brand panel beside the form at 1280 px, the form alone at 360 px", async () => {
    const wide = await open("/signin");
    expect(await wide.p.getByRole("complementary", { name: "IsItLegit" }).isVisible()).toBe(true);
    expect(await wide.p.getByRole("main").isVisible()).toBe(true);
    // The column keeps the board's 440 px measure (a class that styles nothing would let it run the half's width).
    const column = await wide.p.evaluate(
      () => document.querySelector("main > div")?.getBoundingClientRect().width ?? 0,
    );
    expect(column).toBeGreaterThan(300);
    expect(column).toBeLessThanOrEqual(440);
    await wide.context.close();
    const phone = await open("/signin", { width: 360 });
    expect(await phone.p.getByRole("complementary", { name: "IsItLegit" }).isVisible()).toBe(false);
    expect(await phone.p.getByLabel("Work email").isVisible()).toBe(true);
    expect(await phone.p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await phone.context.close();
  });

  it("shows the request busy, says so, sends it once, and gives a usable form back after Back", async () => {
    state.delayMs = 1200;
    const { p, context } = await open("/signin");
    await p.getByLabel("Work email").fill(EMAIL);
    const busy = await busySaid(p, "Email me a sign-in link");
    expect(busy).toMatchObject({ text: "Sending…", disabled: true, busy: "true" });
    expect(busy.live).toContain("Sending…");
    expect(state.posts.filter((x) => x.path === "/signin/link")).toHaveLength(1);
    await p.goBack({ waitUntil: "load" });
    const again = p.getByRole("button", { name: "Email me a sign-in link" });
    expect(await again.isEnabled()).toBe(true);
    await context.close();
  });

  for (const [path, held, ready, operation] of [
    ["/signin/link-limited", "Send another link at", "Send another link", "/signin/link"],
    ["/signin/confirm-limited", "Sign in to IsItLegit at", "Sign in to IsItLegit", "/signin/confirm"],
    ["/signin/code-limited", "Sign in at", "Sign in", "/signin/code"],
  ] as const)
    it(`holds the retry until its time, then repeats its own operation (${path})`, async () => {
      // No fake clock (an installed one held the click's animation-frame checks still and hung the test under CI load,
      // main's 41146401455; media's 41218719121), and no short real retry either (a three-second one raced the page's
      // load, gate run 41247301325). The retry is a minute away and the page's own timer is taken over (`captureRetry`):
      // the test sees the button held, checks the delay the page worked out from the server's time, then lets the
      // page's own release run, waiting on the button turning usable and pressing it by keyboard.
      state.retrySeconds = 60;
      const { p, context } = await open(path, { captureRetry: true });
      const button = p.getByRole("button", { name: new RegExp(`^${held} \\d\\d:\\d\\d$`) });
      expect(await button.isDisabled()).toBe(true);
      // The longest hold is this retry's minute (a page may also hold a shorter one, the code page's resend).
      const delays = await step(
        "read the page's captured retry delays",
        p.evaluate(() => (window as unknown as { __retry: Captured[] }).__retry.map((c) => c.ms)),
      );
      expect(delays.length).toBeGreaterThan(0);
      expect(Math.max(...delays)).toBeGreaterThan(20_000);
      expect(Math.max(...delays)).toBeLessThanOrEqual(62_000);
      const go = p.getByRole("button", { name: ready, exact: true });
      expect(await go.count()).toBe(0);
      await step(
        "fire the page's own retry release",
        p.evaluate(() => {
          for (const held of (window as unknown as { __retry: Captured[] }).__retry) held.fire();
        }),
      );
      await expect.poll(() => go.isEnabled(), { timeout: 10_000 }).toBe(true);
      // The code the limit stopped is kept: nothing is typed again.
      if (operation === "/signin/code") expect(await p.getByLabel("Code from the email").inputValue()).toBe("123 456");
      await go.focus({ timeout: 10_000 });
      // The press starts a navigation (the form's POST, then its answer or its redirect): the test waits for it to land
      // before it closes the context, so the close never races a request still in flight (main's 41295139191, where
      // `context.close()` did not finish in 20 s after every assertion had passed).
      const landed = p.waitForEvent("framenavigated", { timeout: 15_000 });
      await step("press Enter on the released button", p.keyboard.press("Enter"));
      await expect.poll(() => state.posts.length, { timeout: 10_000 }).toBe(1);
      const sent = state.posts[0];
      expect(sent?.path).toBe(operation);
      expect(sent?.body.callbackURL).toBe("/cases/42");
      if (operation === "/signin/link") expect(sent?.body.email).toBe(EMAIL);
      if (operation === "/signin/confirm") expect(sent?.body.token).toBe("tok");
      if (operation === "/signin/code") expect(sent?.body.code).toBe("123 456");
      await step("wait for the page the press led to", landed);
      await step("wait for that page to load", p.waitForLoadState("load"));
      await step("close the context", context.close());
    });

  it("fails a hung call in its own step, naming it, long before the test limit", async () => {
    const started = Date.now();
    await expect(step("a call that never answers", new Promise(() => undefined), 200)).rejects.toThrow(
      'step "a call that never answers" did not finish in 200 ms',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(step("a call that answers", Promise.resolve(7), 200)).resolves.toBe(7);
  });

  it("finishes in the tab that asked when the link signs in elsewhere in this browser, for its own address only", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    // Another address signed in, and told: the inbox stays.
    state.session = "someone-else@example.org";
    const other = await open("/landed", { context });
    await asked.p.waitForTimeout(1500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    await other.p.close();
    // Its own address: within 2 seconds of the word.
    state.session = EMAIL;
    const started = Date.now();
    const redeemed = await open("/landed", { context });
    // The signal is read once and cleared.
    expect(await redeemed.p.evaluate(() => document.cookie)).not.toContain("isitlegit_signed_in");
    await asked.p.waitForURL(`${origin}/cases/42`, { timeout: 2000 });
    expect(Date.now() - started).toBeLessThan(2500);
    await context.close();
  });

  it("finishes by asking for the session when no word comes, at once on showing again and every 5 seconds", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    // No session, or a failed check: it stays and asks again.
    await asked.p.waitForTimeout(5500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    // Signed in by the link in a tab closed before it could say so: the next check finds it.
    state.session = EMAIL;
    await asked.p.waitForURL(`${origin}/cases/42`, { timeout: 6000 });
    await context.close();
  });

  it("holds Send another link for 30 seconds while the code can be typed at once, and keeps a padded paste whole", async () => {
    const { p, context } = await open("/signin/inbox", { clock: true });
    const resend = p.getByRole("button", { name: "Send another link in 30 seconds" });
    expect(await resend.isDisabled()).toBe(true);
    const field = p.getByLabel("Code from the email");
    expect(await field.isEditable()).toBe(true);
    await field.fill(" 012 345 ");
    expect(await field.inputValue()).toBe(" 012 345 ");
    await p.clock.fastForward(31_000);
    await p.clock.resume();
    await expect.poll(() => p.getByRole("button", { name: "Send another link", exact: true }).isEnabled()).toBe(true);
    await context.close();
  });

  it("goes on only for the session as it is now, whatever a late word from another tab says", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    const other = await open("/signin", { context });
    // Another address is signed in now; a late word for this page's address arrives.
    state.session = "someone-else@example.org";
    await other.p.evaluate((email) => new BroadcastChannel("isitlegit-auth").postMessage({ signedIn: email }), EMAIL);
    await asked.p.waitForTimeout(1500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    // The word again, with this address signed in: it goes on.
    state.session = EMAIL;
    await other.p.evaluate((email) => new BroadcastChannel("isitlegit-auth").postMessage({ signedIn: email }), EMAIL);
    await asked.p.waitForURL(`${origin}/cases/42`, { timeout: 2000 });
    await context.close();
  });

  it("drops a slow answer for its address that arrives after a newer one for another", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    const show = () =>
      asked.p.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    // The first check finds this address but answers slowly; the second, after another address signed in, answers at once.
    state.session = EMAIL;
    state.sessionDelays = [2500, 0];
    await show();
    await asked.p.waitForTimeout(200);
    state.session = "someone-else@example.org";
    await show();
    await asked.p.waitForTimeout(3500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    await context.close();
  });

  it("finishes by asking for the session in a browser without BroadcastChannel", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      // Safari before 15.4.
      delete (window as { BroadcastChannel?: unknown }).BroadcastChannel;
    });
    const asked = await open("/signin/inbox", { context });
    state.session = EMAIL;
    await asked.p.waitForURL(`${origin}/cases/42`, { timeout: 6000 });
    await context.close();
  });

  it("keeps asking after a failed check, and checks nothing while hidden", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    await asked.p.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    state.session = EMAIL;
    await asked.p.waitForTimeout(5500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    // Shown again while the session store fails: it stays, and finds the session at a later check.
    state.sessionFails = true;
    await asked.p.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await asked.p.waitForTimeout(500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    state.sessionFails = false;
    await asked.p.waitForURL(`${origin}/cases/42`, { timeout: 6000 });
    await context.close();
  });

  it("asks at once on being shown again, not at the next interval", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    await asked.p.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    state.session = EMAIL;
    await asked.p.waitForTimeout(2000);
    const shown = Date.now();
    await asked.p.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await asked.p.waitForURL(`${origin}/cases/42`, { timeout: 4000 });
    expect(Date.now() - shown).toBeLessThan(1500);
    await context.close();
  });

  it("loads a busy page restored from the back/forward cache again, its form usable", async () => {
    const { p, context } = await open("/signin");
    const before = state.gets;
    // The page as the cache keeps it after its form went: busy, its button disabled. (Chromium under automation keeps no
    // back/forward cache, so the restore is the event the browser fires for one.)
    await p.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("form[data-busy]");
      const button = form?.querySelector<HTMLButtonElement>("button[type=submit]");
      if (form) form.dataset.sent = "true";
      if (button) {
        button.disabled = true;
        button.textContent = "Sending…";
      }
    });
    expect(await p.getByRole("button", { name: "Sending…" }).isDisabled()).toBe(true);
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => state.gets).toBeGreaterThan(before);
    await p.waitForLoadState("load");
    expect(await p.getByRole("button", { name: "Email me a sign-in link" }).isEnabled()).toBe(true);
    await context.close();
  });

  it("gives the form back when its request is stopped", async () => {
    state.delayMs = 5000;
    const { p, context } = await open("/signin");
    await p.getByLabel("Work email").fill(EMAIL);
    await p.evaluate(() => {
      for (const form of document.querySelectorAll<HTMLFormElement>("form[data-busy]")) form.dataset.busyMs = "800";
    });
    await p.getByRole("button", { name: "Email me a sign-in link" }).click({ noWaitAfter: true });
    await p.waitForTimeout(200);
    await (await context.newCDPSession(p)).send("Page.stopLoading");
    await expect
      .poll(() =>
        p.evaluate(() => {
          const b = document.querySelector<HTMLButtonElement>("form[data-busy] button[type=submit]");
          return { text: b?.textContent?.trim(), disabled: b?.disabled };
        }),
      )
      .toEqual({ text: "Email me a sign-in link", disabled: false });
    await context.close();
  });

  it("reaches each field and button by Tab in the order drawn", async () => {
    const { p, context } = await open("/signin");
    // The passkey button follows the link request, under A1's "or" divider (D07 T02 §16), once the script finds WebAuthn.
    expect(await tabOrder(p, 5)).toEqual([
      "IsItLegit home",
      "Work email",
      "Email me a sign-in link",
      "Sign in with a passkey",
      "Create an account",
    ]);
    expect(await p.getByRole("link", { name: "IsItLegit home" }).getAttribute("href")).toBe("https://isitlegit.co.za");
    await context.close();
    const inbox = await open("/signin/inbox");
    // The inbox focuses its code field itself (autofocus); the order is read from there once it has.
    await expect.poll(() => inbox.p.evaluate(() => document.activeElement?.id)).toBe("signin-code");
    // Send another link is held for its first 30 seconds, so Tab passes it until then.
    expect(await tabOrder(inbox.p, 3)).toEqual(["Code from the email", "Sign in", "Use a different email"]);
    await inbox.context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules in every state (${theme}, ${width} px)`, async () => {
        for (const path of Object.keys(pages)) {
          const { p, context } = await open(path, { width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), path).toEqual([]);
          await context.close();
        }
      });

  // D07 T02 §12: the other-device state is read in order, the guidance first and signing in here reached second, by keyboard.
  it("puts the finish-elsewhere guidance first and reaches Sign in in this browser instead by keyboard, posting once", async () => {
    const { p, context } = await open("/signin/confirm-elsewhere", { width: 360 });
    expect(await p.getByRole("heading", { name: "Finish in the browser where you asked" }).isVisible()).toBe(true);
    expect(await p.getByText("6-digit code from the same email").isVisible()).toBe(true);
    const here = p.getByRole("button", { name: "Sign in in this browser instead" });
    await expect.poll(() => here.isVisible()).toBe(true);
    // The heading comes before the button, and the button is the page's only control.
    const order = await p.evaluate(() => [
      document.querySelector("h1,h2")?.getBoundingClientRect().top ?? -1,
      document.querySelector("button")?.getBoundingClientRect().top ?? -1,
    ]);
    expect((order[0] ?? 0) < (order[1] ?? 0)).toBe(true);
    // Reached by sequential Tab from the page's start, not by a direct focus.
    expect(await tabsTo(p, "Sign in in this browser instead")).toBe(true);
    await p.keyboard.press("Enter");
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]?.path).toBe("/signin/confirm");
    expect(state.posts[0]?.body).toMatchObject({ token: "tok", callbackURL: "/cases/42" });
    await context.close();
  });

  // D07 T02 §12 (completion review G2): the failed-check page keeps the link, is reached by Tab and fits the viewport.
  it("draws the check-failed page with Try again reached by Tab, naming the same link, at both widths", async () => {
    for (const width of [360, 1280]) {
      const { p, context } = await open("/signin/confirm-check-failed", { width });
      expect(await p.getByRole("heading", { name: "We could not check this link just now" }).isVisible()).toBe(true);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const again = p.getByRole("link", { name: "Try again" });
      expect(await again.getAttribute("href")).toBe("/signin/confirm?token=tok&callbackURL=%2Fcases%2F42");
      expect(await tabsTo(p, "Try again")).toBe(true);
      await context.close();
    }
  });

  // Each check above, shown to catch the defect it is for.
  it("catches a planted unlabelled control, a planted tab order, and a busy state that is not said", async () => {
    const { p, context } = await open("/signin");
    await p.evaluate(() => {
      const planted = document.createElement("input");
      planted.className = "planted";
      document.querySelector("form")?.prepend(planted);
    });
    await p.addScriptTag({ path: AXE });
    expect(problems(await scan(p)).some((x) => x.includes("planted"))).toBe(true);
    await p.evaluate(() => document.querySelector("a[href='/signup']")?.setAttribute("tabindex", "1"));
    expect(await tabOrder(p, 4)).not.toEqual([
      "IsItLegit home",
      "Work email",
      "Email me a sign-in link",
      "Create an account",
    ]);
    await context.close();
    state.delayMs = 1200;
    const quiet = await open("/signin");
    await quiet.p.getByLabel("Work email").fill(EMAIL);
    // The status region removed as it is made: the check sees no busy words.
    await quiet.p.evaluate(() =>
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if ((n as HTMLElement).dataset?.busyStatus !== undefined) (n as HTMLElement).remove();
      }).observe(document.body, { childList: true, subtree: true }),
    );
    expect((await busySaid(quiet.p, "Email me a sign-in link")).live).not.toContain("Sending…");
    await quiet.context.close();
  });
});
