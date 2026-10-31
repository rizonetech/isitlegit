import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkRequestPage, pageResponse, retryIn } from "../../src/auth/confirm-page.tsx";
import { Document } from "../../src/web/components/Document.tsx";
import { InvitePage } from "../../src/web/pages/invite.tsx";
import { SigninPage } from "../../src/web/pages/signin.tsx";
import { AXE, problems, scan } from "./axe";
import { launch } from "./browser";

// D07 T02 §16: the passkey sign-in page's own behaviour around the ceremony, every recovery, the one-at-a-time rule,
// the stall bound and the accessibility gate, with the Worker's answers stubbed (their real shapes: the codes
// test/auth/passkey.test.ts pins). The ceremony against the real verifier is test/node/passkey-e2e-browser.test.tsx.
const PUBLIC = join(import.meta.dirname, "../../public");

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function withAuthenticator(context: BrowserContext, page: Page) {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

// The page's own behaviour around the ceremony, with the Worker's answers stubbed here (their real shapes: the codes
// test/auth/passkey.test.ts pins) and a passkey made in Chromium's virtual authenticator for this origin.
describe("the passkey prompt and its recoveries", () => {
  const stub = {
    options: 0,
    verify: 0,
    links: 0,
    optionsDelayMs: 0,
    optionsHang: false,
    optionsStatus: 200,
    optionsDrop: false,
    verifyDelayMs: 0,
    answers: [] as { status: number; code?: string }[],
    // Answers the stub has finished sending, so a test waits on a late answer arriving rather than on a timer.
    answered: 0,
  };
  const reset = () =>
    Object.assign(stub, {
      options: 0,
      verify: 0,
      links: 0,
      optionsDelayMs: 0,
      optionsHang: false,
      optionsStatus: 200,
      optionsDrop: false,
      verifyDelayMs: 0,
      answers: [],
      answered: 0,
    });
  let server: Server;
  let site: string;
  const pages: Record<string, () => unknown> = {
    "/signin": () => SigninPage({ next: "/cases/42" }),
    "/signin/limited": () => LinkRequestPage({ callbackURL: "/cases/42", email: "a@b.example", retry: retryIn(600) }),
    "/invite/demo": () =>
      InvitePage({
        state: {
          kind: "signed-out",
          passkey: true,
          invitation: {
            id: "demo",
            organizationId: "freight",
            organization: "Garden Route Freight",
            inviter: "Anele",
            email: "lindiwe@karoocouriers.example",
            role: "member",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      }),
  };
  beforeAll(async () => {
    server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/auth/passkey/generate-authenticate-options") {
        stub.options++;
        if (stub.optionsHang) return;
        if (stub.optionsDrop) return req.socket.destroy();
        if (stub.optionsStatus !== 200) return res.writeHead(stub.optionsStatus).end();
        await new Promise((done) => setTimeout(done, stub.optionsDelayMs));
        // The answer goes out now, late or not; the test waits on this, not on a timer.
        stub.answered++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            challenge: randomBytes(32).toString("base64url"),
            rpId: "localhost",
            timeout: 60_000,
            userVerification: "required",
            allowCredentials: [],
          }),
        );
      }
      if (url.pathname === "/api/auth/passkey/verify-authentication") {
        stub.verify++;
        for await (const _ of req);
        await new Promise((done) => setTimeout(done, stub.verifyDelayMs));
        stub.answered++;
        const answer = stub.answers.shift() ?? { status: 200 };
        res.writeHead(answer.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(answer.code ? { code: answer.code, message: "refused" } : { ok: true }));
      }
      if (req.method === "POST" && url.pathname === "/signin/link") {
        stub.links++;
        for await (const _ of req);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(String(<Document title="Inbox">{<h1>Check your inbox</h1>}</Document>));
      }
      const page = pages[url.pathname];
      if (page) {
        const rendered = await pageResponse(page());
        res.writeHead(rendered.status, Object.fromEntries(rendered.headers));
        return res.end(await rendered.text());
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
    await new Promise<void>((done) => server.listen(0, "localhost", done));
    site = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((done) => server?.close(() => done()));
  });

  // A page with a virtual authenticator, holding a passkey for this origin unless `none`.
  async function signinWith(
    path: string,
    opts: { none?: boolean; script?: boolean; width?: number; noWebAuthn?: boolean; clock?: boolean } = {},
  ) {
    reset();
    const context = await browser.newContext({
      viewport: { width: opts.width ?? 1280, height: 900 },
      javaScriptEnabled: opts.script ?? true,
    });
    const p = await context.newPage();
    // A browser without WebAuthn: the script finds no PublicKeyCredential.
    if (opts.noWebAuthn) await context.addInitScript(() => Reflect.deleteProperty(window, "PublicKeyCredential"));
    if (opts.script !== false && !opts.noWebAuthn) {
      await withAuthenticator(context, p);
      await p.goto(`${site}/cases`);
      if (!opts.none)
        await p.evaluate(async () => {
          await navigator.credentials.create({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rp: { id: "localhost", name: "IsItLegit" },
              user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "m@k.example", displayName: "M" },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              authenticatorSelection: { residentKey: "required", userVerification: "required" },
            },
          });
        });
    }
    // The page's own clock, for the stall bound: installed after the passkey is made, before the page loads.
    if (opts.clock) await p.clock.install();
    await p.goto(`${site}${path}`, { waitUntil: "load" });
    return { p, context };
  }
  const message = (p: Page) => p.locator("[data-passkey-message]").textContent();
  const focusedType = (p: Page) =>
    p.evaluate(() => document.activeElement?.getAttribute("type") ?? document.activeElement?.tagName);
  // By keyboard, as a member reaching it with Tab would: focus, then Enter.
  const press = async (p: Page) => {
    await p.getByRole("button", { name: "Sign in with a passkey" }).focus();
    await p.keyboard.press("Enter");
  };

  it("offers no passkey where the browser has no WebAuthn", async () => {
    const { p, context } = await signinWith("/signin", { noWebAuthn: true });
    expect(await p.evaluate(() => typeof window.PublicKeyCredential)).toBe("undefined");
    expect(await p.locator("[data-passkey]").isHidden()).toBe(true);
    expect(await p.getByRole("button", { name: "Email me a sign-in link" }).isVisible()).toBe(true);
    await context.close();
  });

  it("keeps the address typed, and says the service's failure, when the options cannot be had", async () => {
    const { p, context } = await signinWith("/signin");
    await p.getByLabel("Work email").fill("lindiwe@karoocouriers.example");
    stub.optionsStatus = 500;
    await press(p);
    await expect.poll(() => message(p)).toContain("Passkey sign-in did not finish");
    expect(await p.getByLabel("Work email").inputValue()).toBe("lindiwe@karoocouriers.example");
    expect(await focusedType(p)).toBe("email");
    expect(stub.verify).toBe(0);
    // Try again from the page, by keyboard, once the service answers.
    stub.optionsStatus = 200;
    await press(p);
    await p.waitForURL(`${site}/cases/42`);
    await context.close();
  });

  it("offers no passkey without the script, and the email route still works", async () => {
    const { p, context } = await signinWith("/signin", { script: false });
    expect(await p.getByRole("button", { name: "Sign in with a passkey" }).isVisible()).toBe(false);
    expect(await p.locator("[data-passkey]").isHidden()).toBe(true);
    await p.getByLabel("Work email").fill("m@k.example");
    await p.getByRole("button", { name: "Email me a sign-in link" }).click();
    await p.waitForURL(`${site}/signin/link`);
    expect(stub.links).toBe(1);
    await context.close();
  });

  it("shows the prompt with focus on its heading and the button busy, then lands on the return path", async () => {
    const { p, context } = await signinWith("/signin");
    stub.optionsDelayMs = 600;
    await press(p);
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent)).toBe("Confirm it is you");
    expect(await p.getByRole("button", { name: "Try the passkey again" }).getAttribute("aria-busy")).toBe("true");
    expect(await p.getByLabel("Work email").isVisible()).toBe(false);
    await p.waitForURL(`${site}/cases/42`);
    expect([stub.options, stub.verify]).toEqual([1, 1]);
    await context.close();
  });

  for (const [code, words] of [
    ["USER_VERIFICATION_REQUIRED", "Your device was not unlocked"],
    ["PASSKEY_NOT_FOUND", "This passkey is no longer on your account; sign in with an email link."],
    ["AUTHENTICATION_FAILED", "That passkey could not be checked"],
    ["SOMETHING_ELSE", "Passkey sign-in did not finish"],
  ] as const)
    it(`ends a ${code} refusal on the email field, the reason announced`, async () => {
      const { p, context } = await signinWith("/signin");
      stub.answers = [{ status: code === "SOMETHING_ELSE" ? 500 : 401, code }];
      await press(p);
      await expect.poll(() => message(p)).toContain(words);
      expect(await p.locator("[data-passkey-message]").getAttribute("role")).toBe("alert");
      expect(await focusedType(p)).toBe("email");
      expect(await p.locator("[data-passkey-prompt]").isHidden()).toBe(true);
      expect(await p.getByRole("button", { name: "Sign in with a passkey" }).getAttribute("aria-busy")).toBeNull();
      expect(new URL(p.url()).pathname).toBe("/signin");
      await context.close();
    });

  it("says so when this device has no passkey, at once", async () => {
    const { p, context } = await signinWith("/signin", { none: true });
    const started = Date.now();
    await press(p);
    await expect.poll(() => message(p), { timeout: 10_000 }).toContain("No passkey was used");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await focusedType(p)).toBe("email");
    expect(stub.verify).toBe(0);
    await context.close();
  });

  it("asks for new options once when the challenge has run out, then stops", async () => {
    const renewed = await signinWith("/signin");
    stub.answers = [{ status: 400, code: "CHALLENGE_NOT_FOUND" }];
    await press(renewed.p);
    await renewed.p.waitForURL(`${site}/cases/42`);
    expect([stub.options, stub.verify]).toEqual([2, 2]);
    await renewed.context.close();
    const twice = await signinWith("/signin");
    stub.answers = [
      { status: 400, code: "CHALLENGE_NOT_FOUND" },
      { status: 400, code: "CHALLENGE_NOT_FOUND" },
    ];
    await press(twice.p);
    await expect.poll(() => message(twice.p)).toContain("Passkey sign-in did not finish");
    expect([stub.options, stub.verify]).toEqual([2, 2]);
    await twice.context.close();
  });

  it("runs one ceremony at a time: a second press replaces the first, and only the live one signs in", async () => {
    const { p, context } = await signinWith("/signin");
    stub.optionsDelayMs = 800;
    await press(p);
    await p.getByRole("button", { name: "Try the passkey again" }).focus();
    await p.keyboard.press("Enter");
    await p.waitForURL(`${site}/cases/42`);
    expect(stub.options).toBe(2);
    expect(stub.verify).toBe(1);
    await context.close();
  });

  it("drops the ceremony for Email me a link instead, even when its answer comes after", async () => {
    const before = await signinWith("/signin");
    stub.optionsDelayMs = 800;
    await press(before.p);
    await before.p.getByRole("button", { name: "Email me a link instead" }).focus();
    await before.p.keyboard.press("Enter");
    expect(await focusedType(before.p)).toBe("email");
    expect(await before.p.locator("[data-passkey-prompt]").isHidden()).toBe(true);
    // The late answer has come and gone (the stub has sent it), and the page made nothing of it.
    await expect.poll(() => stub.answered, { timeout: 5_000 }).toBe(1);
    await before.p.evaluate(() => new Promise((done) => setTimeout(done, 0)));
    expect([stub.options, stub.verify]).toEqual([1, 0]);
    expect(new URL(before.p.url()).pathname).toBe("/signin");
    await before.context.close();

    const late = await signinWith("/signin");
    stub.verifyDelayMs = 1000;
    await press(late.p);
    await expect.poll(() => stub.verify).toBe(1);
    await late.p.getByRole("button", { name: "Email me a link instead" }).focus();
    await late.p.keyboard.press("Enter");
    // Options and the late verification both answered, and the page stayed.
    await expect.poll(() => stub.answered, { timeout: 5_000 }).toBe(2);
    await late.p.evaluate(() => new Promise((done) => setTimeout(done, 0)));
    expect(new URL(late.p.url()).pathname).toBe("/signin");
    expect(await message(late.p)).toBe("");
    await late.context.close();
  });

  // The page's clock measures the 15-second bound, so the test moves it rather than waiting it out: nothing ends the
  // request before the bound, and the retry state follows right after it.
  it("ends a request that never answers in the retry state, within its bound", async () => {
    const { p, context } = await signinWith("/signin", { clock: true });
    stub.optionsHang = true;
    await press(p);
    await expect.poll(() => stub.options).toBe(1);
    await p.clock.fastForward(14_000);
    expect(await message(p)).toBe("");
    await p.clock.fastForward(1_100);
    await expect.poll(() => message(p)).toContain("took too long");
    expect(await focusedType(p)).toBe("email");
    await context.close();
  });

  // Every passkey state through the accessibility gate's own rules (test/node/axe.ts, as §7's states are scanned), at
  // a phone's 375 px and at desktop width, in both themes, with no sideways scroll: the option on each page that offers
  // it, the prompt open, and a recovery's message shown.
  for (const width of [375, 1280])
    it(`passes the accessibility gate in every passkey state, in both themes (${width} px)`, async () => {
      // Each page as drawn, its prompt open, and every recovery's message shown (the stall's words are drawn in the
      // same line as these, and its 15-second bound is the timing test's).
      const refusal = (status: number, code: string, words: string) => async (p: Page) => {
        stub.answers = [{ status, code }];
        await press(p);
        await expect.poll(() => message(p)).toContain(words);
      };
      const states: [string, (p: Page) => Promise<unknown>][] = [];
      for (const path of ["/signin", "/signin/limited", "/invite/demo"]) {
        states.push([path, async () => {}]);
        states.push([
          `${path} prompt`,
          async (p) => {
            stub.optionsHang = true;
            await press(p);
            await p.getByRole("heading", { name: "Confirm it is you" }).waitFor();
          },
        ]);
        states.push([`${path} unlocked`, refusal(401, "USER_VERIFICATION_REQUIRED", "not unlocked")]);
        states.push([`${path} removed`, refusal(401, "PASSKEY_NOT_FOUND", "no longer on your account")]);
        states.push([`${path} failed`, refusal(401, "AUTHENTICATION_FAILED", "could not be checked")]);
        states.push([`${path} service`, refusal(500, "SERVER", "did not finish")]);
      }
      // The browser's own refusals, on every page: no passkey or cancelled, and a device prompt that timed out (both
      // as the browser rejects them); and the connection lost before the options came.
      const rejected = (name: string, words: string) => async (p: Page) => {
        await p.evaluate(
          (n) =>
            Object.defineProperty(navigator.credentials, "get", {
              value: () => Promise.reject(new DOMException("refused", n)),
            }),
          name,
        );
        await press(p);
        await expect.poll(() => message(p)).toContain(words);
      };
      for (const path of ["/signin", "/signin/limited", "/invite/demo"]) {
        states.push([`${path} none`, rejected("NotAllowedError", "No passkey was used")]);
        states.push([`${path} timeout`, rejected("TimeoutError", "took too long")]);
        states.push([
          `${path} network`,
          async (p) => {
            stub.optionsDrop = true;
            await press(p);
            await expect.poll(() => message(p)).toContain("did not reach us");
          },
        ]);
      }
      // One browser context, its virtual authenticator and passkey, for every state at this width; each state starts
      // from its page loaded afresh, the stub's answers reset.
      const { p, context } = await signinWith("/signin", { width });
      for (const [name, act] of states) {
        reset();
        await p.goto(`${site}${name.split(" ")[0]}`, { waitUntil: "load" });
        expect(await p.locator("[data-passkey]").isVisible(), name).toBe(true);
        await act(p);
        // Focus is somewhere a keyboard can go on from, never left on the page, and a recovery's reason is in the
        // alert line.
        if (name.includes(" "))
          expect(await p.evaluate(() => document.activeElement !== document.body), name).toBe(true);
        if (/ (unlocked|removed|failed|service|none|timeout|network)$/.test(name))
          expect(await p.locator("[data-passkey-message][role=alert]").textContent(), name).not.toBe("");
        // Each theme is the page's own attribute, so one state is scanned in both without being reached twice.
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${name} ${theme}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${name} ${theme}`).toEqual([]);
        }
      }
      await context.close();
    }, 60_000);

  // A page with no email field to return to: the invitation's link request takes focus, and on the rate-limited state,
  // whose request is held until the time it names, the state's heading, which says when links can be sent again. Both
  // a refusal and "Email me a link instead" end there.
  for (const [path, landed] of [
    ["/signin/limited", "Too many sign-in links from here"],
    ["/invite/demo", "Email me a sign-in link"],
  ] as const)
    it(`ends on the page's own email route where there is no email field (${path})`, async () => {
      const { p, context } = await signinWith(path);
      const focusedText = () => p.evaluate(() => document.activeElement?.textContent?.trim());
      stub.answers = [{ status: 401, code: "AUTHENTICATION_FAILED" }];
      await press(p);
      await expect.poll(() => message(p)).toContain("could not be checked");
      expect(await focusedText()).toBe(landed);
      stub.optionsDelayMs = 800;
      await press(p);
      await p.getByRole("button", { name: "Email me a link instead" }).focus();
      await p.keyboard.press("Enter");
      expect(await focusedText()).toBe(landed);
      expect(await p.locator("[data-passkey-prompt]").isHidden()).toBe(true);
      if (path === "/signin/limited")
        expect(await p.getByRole("button", { name: /^Send another link at \d\d:\d\d$/ }).isDisabled()).toBe(true);
      await context.close();
    });

  it("offers the passkey on the rate-limited state too, signing in from there", async () => {
    const { p, context } = await signinWith("/signin/limited");
    await press(p);
    await p.waitForURL(`${site}/cases/42`);
    await context.close();
  });
});
