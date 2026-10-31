import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll } from "vitest";
import { LinkRequestPage, pageResponse, retryIn } from "../../src/auth/confirm-page.tsx";
import { Document } from "../../src/web/components/Document.tsx";
import { InvitePage } from "../../src/web/pages/invite.tsx";
import { SigninPage } from "../../src/web/pages/signin.tsx";

// The passkey sign-in pages served with the Worker's answers stubbed (their real shapes: the codes
// test/auth/passkey.test.ts pins), and a passkey made in Chromium's virtual authenticator for this origin, shared by
// the passkey browser files (D07 T02 §16, §23). Call it inside a describe: it registers the stub server's setup there.
const PUBLIC = join(import.meta.dirname, "../../public");

export async function withAuthenticator(context: BrowserContext, page: Page) {
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

export function passkeyHarness(browser: () => Browser) {
  const stub = {
    options: 0,
    verify: 0,
    links: 0,
    optionsDelayMs: 0,
    optionsHang: false,
    optionsStatus: 200,
    optionsDrop: false,
    verifyDelayMs: 0,
    verifyHang: false,
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
      verifyHang: false,
      answers: [],
      answered: 0,
    });
  let server: Server;
  let site = "";
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
        if (stub.verifyHang) return;
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
    const context = await browser().newContext({
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

  return {
    stub,
    reset,
    signinWith,
    message,
    focusedType,
    press,
    get site() {
      return site;
    },
  };
}
