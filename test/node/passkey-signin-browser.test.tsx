import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { LinkRequestPage, pageResponse, retryIn } from "../../src/auth/confirm-page.tsx";
import { Document } from "../../src/web/components/Document.tsx";
import { InvitePage } from "../../src/web/pages/invite.tsx";
import { SigninPage } from "../../src/web/pages/signin.tsx";
import { AXE, problems, scan } from "./axe";
import { launch } from "./browser";

// D07 T02 §16: the passkey sign-in end to end against the real verifier. The Worker runs from wrangler.jsonc on a local
// D1 with the migrations applied, at an origin APP_URL names (the verifier checks the signed client data against it);
// a member with a fresh session registers a passkey in Chromium through Better Auth's own endpoints, with Chromium's
// virtual authenticator, signs out, then presses "Sign in with a passkey" on the sign-in page and lands signed in.
const ROOT = join(import.meta.dirname, "../..");
const PUBLIC = join(ROOT, "public");
const SECRET = "test-passkey-better-auth-secret-0123456789abcdef";
const EMAIL = "lindiwe@karoocouriers.example";
// Better Auth's session cookie with `useSecureCookies` (src/auth/auth.ts), signed as better-call signs it.
const SESSION_COOKIE = "__Secure-better-auth.session_token";
const signed = (token: string) =>
  encodeURIComponent(`${token}.${createHmac("sha256", SECRET).update(token).digest("base64")}`);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

const sql = (persist: string, command: string) =>
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to", persist, "--command", command],
    { cwd: ROOT, stdio: "pipe" },
  );

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let browser: Browser;
let origin: string;
let persist: string;
const token = randomBytes(24).toString("base64url");
// Two invitations from another organisation: one to the member, one to an address whose passkey is on another device.
const INVITED = randomUUID();
const OTHERS = randomUUID();
const OTHER = "sipho@karoocouriers.example";

beforeAll(async () => {
  persist = mkdtempSync(join(tmpdir(), "isitlegit-passkey-"));
  execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: ROOT,
    stdio: "pipe",
  });
  // The member, their organisation and a session made now (fresh, so registration is allowed).
  const now = new Date().toISOString();
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const [user, org] = [randomUUID(), randomUUID()];
  sql(
    persist,
    [
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('${user}', 'Lindiwe', '${EMAIL}', 1, '${now}', '${now}')`,
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('${org}', 'Karoo Couriers', 'karoo-couriers', '${now}')`,
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('${randomUUID()}', '${org}', '${user}', 'owner', '${now}')`,
      `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "activeOrganizationId") VALUES ('${randomUUID()}', '${week}', '${token}', '${now}', '${now}', '${user}', '${org}')`,
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('inviter', 'Anele', 'anele@gardenroute.example', 1, '${now}', '${now}')`,
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('freight', 'Garden Route Freight', 'garden-route-freight', '${now}')`,
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('${randomUUID()}', 'freight', 'inviter', 'owner', '${now}')`,
      `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES ('${INVITED}', 'freight', '${EMAIL}', 'member', 'pending', '${week}', '${now}', 'inviter')`,
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('other', 'Sipho', '${OTHER}', 1, '${now}', '${now}')`,
      `INSERT INTO "passkey" (id, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp") VALUES ('${randomUUID()}', 'k', 'other', 'elsewhere', 0, 'singleDevice', 0)`,
      `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES ('${OTHERS}', 'freight', '${OTHER}', 'member', 'pending', '${week}', '${now}', 'inviter')`,
    ].join("; "),
  );
  const port = await freePort();
  origin = `http://localhost:${port}`;
  worker = await unstable_startWorker({
    config: join(ROOT, "wrangler.jsonc"),
    bindings: {
      APP_URL: { type: "plain_text", value: origin },
      BETTER_AUTH_SECRET: { type: "secret_text", value: SECRET },
    },
    // The browser's own origin, not the custom domain wrangler.jsonc routes (which local dev would otherwise rewrite
    // requests to, so Better Auth would see an origin APP_URL does not name).
    dev: {
      server: { hostname: "localhost", port },
      inferOriginFromRoutes: false,
      inspector: false,
      logLevel: "error",
      persist,
      remote: false,
    },
  });
  await worker.ready;
  browser = await launch();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (persist) rmSync(persist, { recursive: true, force: true });
}, 120_000);

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

// A passkey registered for the member through Better Auth's registration endpoints, made by the virtual authenticator.
async function registerPasskey(page: Page) {
  return page.evaluate(async () => {
    const options = await fetch("/api/auth/passkey/generate-register-options", { credentials: "same-origin" });
    if (!options.ok) return `options ${options.status}`;
    const parse = (PublicKeyCredential as unknown as { parseCreationOptionsFromJSON: (j: unknown) => unknown })
      .parseCreationOptionsFromJSON;
    const created = (await navigator.credentials.create({
      publicKey: parse(await options.json()) as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential & { toJSON: () => unknown };
    const answer = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: created.toJSON(), name: "Laptop" }),
    });
    return answer.status === 200 ? 200 : `${answer.status} ${await answer.text()}`;
  });
}

const sessionEmail = (page: Page) =>
  page.evaluate(async () => {
    const answer = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    return ((await answer.json()) as { user?: { email?: string } } | null)?.user?.email ?? null;
  });

describe("passkey sign-in against the real verifier", () => {
  it("registers a passkey, signs out, and signs in with it on the sign-in page, landing on its return path", async () => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: signed(token),
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const { cdp, authenticatorId } = await withAuthenticator(context, page);
    await page.goto(`${origin}/signin`);
    expect(await sessionEmail(page)).toBe(EMAIL);
    expect(await registerPasskey(page)).toBe(200);
    await context.clearCookies();
    expect(await sessionEmail(page)).toBeNull();

    // With user verification off the device cannot answer options that require it, so the browser refuses before the
    // Worker is asked: no session, the email field focused and the reason said (the Worker's own refusal of an answer
    // without verification, which a compliant browser never sends, is test/auth/passkey.test.ts's).
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    await page.goto(`${origin}/signin?next=/cases/7`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect.poll(() => page.locator("[data-passkey-message]").textContent()).toContain("No passkey was used");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("type"))).toBe("email");
    expect(await sessionEmail(page)).toBeNull();

    // Unlocked: one press, the device's answer, and the page it asked for, signed in.
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
    const started = Date.now();
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(`${origin}/cases/7`, { timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await sessionEmail(page)).toBe(EMAIL);

    // From an invitation to this address: the passkey is offered, signs in back to the invitation, and accepting
    // takes one press.
    await context.clearCookies();
    await page.goto(`${origin}/invite/${INVITED}`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByRole("button", { name: "Accept and join" }).waitFor();
    expect(new URL(page.url()).pathname).toBe(`/invite/${INVITED}`);
    await page.getByRole("button", { name: "Accept and join" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/cases"));

    // An invitation to another address whose passkey is not on this device: this device's passkey signs in as the
    // member, and the invitation says it was sent to someone else.
    await context.clearCookies();
    await page.goto(`${origin}/invite/${OTHERS}`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect.poll(() => page.textContent("main")).toContain(`You are signed in as ${EMAIL}`);
    await context.close();
  }, 90_000);

  it("lands within 2 seconds of the device's answer at the 95th percentile on a throttled mid-range phone", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const { cdp } = await withAuthenticator(context, page);
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: signed(token),
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto(`${origin}/signin`);
    expect(await registerPasskey(page)).toBe(200);
    // Lighthouse's mid-range mobile profile: 4x CPU slowdown, 150 ms latency, 1.6 Mbit/s down, 750 kbit/s up.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    const times: number[] = [];
    for (let run = 0; run < 10; run++) {
      await context.clearCookies();
      await page.goto(`${origin}/signin?next=/cases/7`);
      // From the answer to the landing: the device answers at once here, so the clock starts at verification.
      const answered = page.waitForRequest((r) => r.url().endsWith("/api/auth/passkey/verify-authentication"));
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await answered;
      const started = Date.now();
      await page.waitForURL(`${origin}/cases/7`, { waitUntil: "load" });
      times.push(Date.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95, times.join(",")).toBeLessThan(2000);
    await context.close();
  }, 180_000);
});

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
    verifyDelayMs: 0,
    answers: [] as { status: number; code?: string }[],
  };
  const reset = () =>
    Object.assign(stub, {
      options: 0,
      verify: 0,
      links: 0,
      optionsDelayMs: 0,
      optionsHang: false,
      optionsStatus: 200,
      verifyDelayMs: 0,
      answers: [],
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
        if (stub.optionsStatus !== 200) return res.writeHead(stub.optionsStatus).end();
        await new Promise((done) => setTimeout(done, stub.optionsDelayMs));
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
    opts: { none?: boolean; script?: boolean; width?: number; noWebAuthn?: boolean } = {},
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
    await before.p.waitForTimeout(1500);
    expect([stub.options, stub.verify]).toEqual([1, 0]);
    expect(new URL(before.p.url()).pathname).toBe("/signin");
    await before.context.close();

    const late = await signinWith("/signin");
    stub.verifyDelayMs = 1000;
    await press(late.p);
    await expect.poll(() => stub.verify).toBe(1);
    await late.p.getByRole("button", { name: "Email me a link instead" }).focus();
    await late.p.keyboard.press("Enter");
    await late.p.waitForTimeout(1500);
    expect(new URL(late.p.url()).pathname).toBe("/signin");
    expect(await message(late.p)).toBe("");
    await late.context.close();
  });

  it("ends a request that never answers in the retry state, within its bound", async () => {
    const { p, context } = await signinWith("/signin");
    stub.optionsHang = true;
    await press(p);
    await expect.poll(() => message(p), { timeout: 20_000 }).toContain("took too long");
    expect(await focusedType(p)).toBe("email");
    await context.close();
  }, 30_000);

  // Every passkey state through the accessibility gate's own rules (test/node/axe.ts, as §7's states are scanned), at
  // a phone's 375 px and at desktop width, in both themes, with no sideways scroll: the option on each page that offers
  // it, the prompt open, and a recovery's message shown.
  for (const theme of ["light", "dark"] as const)
    for (const width of [375, 1280])
      it(`passes the accessibility gate in every passkey state (${theme}, ${width} px)`, async () => {
        const states: [string, (p: Page) => Promise<unknown>][] = [
          ["/signin", async () => {}],
          ["/signin/limited", async () => {}],
          ["/invite/demo", async () => {}],
          [
            "/signin prompt",
            async (p) => {
              stub.optionsHang = true;
              await press(p);
              await p.getByRole("heading", { name: "Confirm it is you" }).waitFor();
            },
          ],
          [
            "/signin refused",
            async (p) => {
              stub.answers = [{ status: 401, code: "PASSKEY_NOT_FOUND" }];
              await press(p);
              await expect.poll(() => message(p)).toContain("no longer on your account");
            },
          ],
        ];
        for (const [name, act] of states) {
          const { p, context } = await signinWith(name.split(" ")[0] as string, { width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.locator("[data-passkey]").isVisible(), name).toBe(true);
          await act(p);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), name).toEqual([]);
          await context.close();
        }
      }, 60_000);

  it("offers the passkey on the rate-limited state too, signing in from there", async () => {
    const { p, context } = await signinWith("/signin/limited");
    await press(p);
    await p.waitForURL(`${site}/cases/42`);
    await context.close();
  });
});
