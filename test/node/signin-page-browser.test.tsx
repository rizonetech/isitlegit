import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ConfirmPage,
  InboxPage,
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
  posts: [] as Post[],
  linkAnswer: "inbox" as "inbox" | "limited",
  confirmAnswer: "limited" as "limited" | "signed-in",
};
afterEach(() =>
  Object.assign(state, { delayMs: 0, session: null, posts: [], linkAnswer: "inbox", confirmAnswer: "limited" }),
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
      retry: retryIn(600),
    }),
  "/signin/link-limited": () => LinkRequestPage({ callbackURL: "/cases/42", email: EMAIL, retry: retryIn(600) }),
  "/signin/confirm": () => ConfirmPage({ token: "tok", callbackURL: "/cases/42" }),
  "/signin/confirm-limited": () => ConfirmPage({ token: "tok", callbackURL: "/cases/42", retry: retryIn(600) }),
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
      res.writeHead(303, { location: `${fields.callbackURL ?? "/cases"}#signed-in` });
      return res.end();
    }
    if (url.pathname === "/api/auth/get-session") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.session ? { user: { email: state.session } } : null));
    }
    const page = pages[url.pathname];
    if (page) return send(res, await pageResponse(page()));
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

async function open(path: string, options: { width?: number; context?: BrowserContext; clock?: boolean } = {}) {
  const context =
    options.context ?? (await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 } }));
  const p: Page = await context.newPage();
  if (options.clock) await p.clock.install();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
}

// The page's controls in the order Tab reaches them, by name, starting from the one the page focused (a field with
// `autofocus`) when there is one.
async function tabOrder(p: Page, count: number) {
  const name = () =>
    p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "";
      const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null;
      return (label ?? el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
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
      const { p, context } = await open(path, { clock: true });
      const button = p.getByRole("button", { name: new RegExp(`^${held} \\d\\d:\\d\\d$`) });
      expect(await button.isDisabled()).toBe(true);
      await p.clock.fastForward(601_000);
      const go = p.getByRole("button", { name: ready, exact: true });
      await expect.poll(() => go.isEnabled()).toBe(true);
      if (operation === "/signin/code") await p.getByLabel("Code from the email").fill("123 456");
      await go.click();
      await expect.poll(() => state.posts.length).toBe(1);
      const sent = state.posts[0];
      expect(sent?.path).toBe(operation);
      expect(sent?.body.callbackURL).toBe("/cases/42");
      if (operation === "/signin/link") expect(sent?.body.email).toBe(EMAIL);
      if (operation === "/signin/confirm") expect(sent?.body.token).toBe("tok");
      await context.close();
    });

  it("finishes in the tab that asked when the link signs in elsewhere in this browser, for its own address only", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const asked = await open("/signin/inbox", { context });
    // Another address signed in, and told: the inbox stays.
    state.session = "someone-else@example.org";
    const other = await open("/cases#signed-in", { context });
    await asked.p.waitForTimeout(1500);
    expect(new URL(asked.p.url()).pathname).toBe("/signin/inbox");
    await other.p.close();
    // Its own address: within 2 seconds of the word.
    state.session = EMAIL;
    const started = Date.now();
    const redeemed = await open("/cases#signed-in", { context });
    expect(redeemed.p.url()).not.toContain("#signed-in");
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

  it("reaches each field and button by Tab in the order drawn", async () => {
    const { p, context } = await open("/signin");
    expect(await tabOrder(p, 3)).toEqual(["Work email", "Email me a sign-in link", "Create an account"]);
    await context.close();
    const inbox = await open("/signin/inbox");
    expect(await tabOrder(inbox.p, 4)).toEqual([
      "Code from the email",
      "Sign in",
      "Send another link",
      "Use a different email",
    ]);
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
    expect(await tabOrder(p, 3)).not.toEqual(["Work email", "Email me a sign-in link", "Create an account"]);
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
