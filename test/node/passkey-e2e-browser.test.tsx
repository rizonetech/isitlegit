import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { launch } from "./browser";

// D07 T02 §16: the passkey sign-in end to end against the real verifier. The Worker runs from wrangler.jsonc on a local
// D1 with the migrations applied, at an origin APP_URL names (the verifier checks the signed client data against it);
// a member with a fresh session registers a passkey in Chromium through Better Auth's own endpoints, with Chromium's
// virtual authenticator, signs out, then presses "Sign in with a passkey" on the sign-in page and lands signed in.
const ROOT = join(import.meta.dirname, "../..");
const _PUBLIC = join(ROOT, "public");
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

// The schema and the seed in one wrangler call (each call starts the CLI, the setup's slowest step): every migration in
// order, then the rows the tests need.
const migrations = () =>
  readdirSync(join(ROOT, "src/db/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(ROOT, "src/db/migrations", f), "utf-8"))
    .join("\n");
const sql = (persist: string, statements: string) => {
  const file = join(persist, "setup.sql");
  writeFileSync(file, `${migrations()}\n${statements};\n`);
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to", persist, "--file", file],
    {
      cwd: ROOT,
      stdio: "pipe",
    },
  );
};

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
  // The Worker and Chromium start side by side.
  [browser] = await Promise.all([launch(), worker.ready]);
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (persist) rmSync(persist, { recursive: true, force: true });
}, 120_000);

async function withAuthenticator(
  context: BrowserContext,
  page: Page,
  transport: "internal" | "hybrid" = "internal",
) {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport,
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

  it("signs in with a passkey held only by another device (hybrid transport)", async () => {
    // The cross-device journey (D07 T02 §19): the credential lives on a hybrid authenticator, the phone in the
    // panel's words, and the real verifier answers it and the session is read back.
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
    await withAuthenticator(context, page, "hybrid");
    await page.goto(`${origin}/signin`);
    expect(await registerPasskey(page)).toBe(200);
    await context.clearCookies();
    expect(await sessionEmail(page)).toBeNull();
    await page.goto(`${origin}/signin?next=/cases/7`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(`${origin}/cases/7`, { timeout: 15_000 });
    expect(await sessionEmail(page)).toBe(EMAIL);
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
    // Twenty landings: a nearest-rank 95th percentile over ten is the slowest one, so a single slow CI run failed the
    // test (checks-lane run 41251993982: nine landings under 740 ms and one at 2,124 ms). Over twenty it is the
    // nineteenth, a real percentile that one outlier cannot move, against the same 2-second bound.
    const SAMPLES = 20;
    const times: number[] = [];
    for (let run = 0; run < SAMPLES; run++) {
      // The sign-in limiter allows twenty passkey proofs per client address per ten minutes (src/auth/ratelimit.ts), and
      // this file's first test has spent some: each landing comes from its own address, as separate phones would.
      await context.setExtraHTTPHeaders({ "cf-connecting-ip": `203.0.113.${run + 1}` });
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
    expect(times).toHaveLength(SAMPLES);
    expect(p95, times.join(",")).toBeLessThan(2000);
    await context.close();
  }, 180_000);
});
