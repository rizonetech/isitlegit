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

// D07 T08 §14: adding and renaming a passkey from the Account page, end to end against the real verifier. The Worker
// runs from wrangler.jsonc on a local D1 with the migrations applied, at an origin APP_URL names (the verifier checks
// the signed client data against it); a member with a fresh session adds a passkey with Chromium's virtual
// authenticator by pressing "Add a passkey", names it, renames it, signs out and signs in with it. The refusals the
// real verifier cannot be made to give are answered by an intercepted route, each named as such.
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

const sessionEmail = (page: Page) =>
  page.evaluate(async () => {
    const answer = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    return ((await answer.json()) as { user?: { email?: string } } | null)?.user?.email ?? null;
  });
const signedIn = (context: BrowserContext) =>
  context.addCookies([
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
// Tab to a control and press Enter on it, as a keyboard user does.
async function pressByKeyboard(page: Page, role: "button" | "link", name: string) {
  const target = page.getByRole(role, { name, exact: true });
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await target.evaluate((el) => el === document.activeElement);
  }
  expect(reached, name).toBe(true);
  await page.keyboard.press("Enter");
}
const rows = (page: Page) => page.locator("[data-passkey-row]");
const rowIds = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-passkey-row")));

describe("adding and renaming a passkey against the real verifier", () => {
  it("adds a passkey by keyboard, names it, renames it, then signs out and signs in with it", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await signedIn(context);
    const page = await context.newPage();
    await withAuthenticator(context, page);
    await page.goto(`${origin}/settings/account`);
    expect(await rows(page).count()).toBe(0);
    // The control is there once the script finds WebAuthn, and its "needs a browser" line is gone.
    await page.getByRole("button", { name: "Add a passkey", exact: true }).waitFor();
    expect(await page.locator("[data-passkey-add-unavailable]").isHidden()).toBe(true);
    // Added by keyboard: the naming page opens, saying so, its heading focused.
    await pressByKeyboard(page, "button", "Add a passkey");
    await page.waitForURL(/\/settings\/account\/passkeys\/[^/]+\/rename\?added=1$/);
    expect(await page.locator("#rename-title").textContent()).toBe("Name your new passkey");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("rename-title");
    expect(await page.getByText("Passkey added.").count()).toBe(1);
    // Name it.
    await page.getByLabel("Passkey name").fill("Work laptop");
    await Promise.all([
      page.waitForURL(`${origin}/settings/account?**`),
      page.getByRole("button", { name: "Save name" }).click(),
    ]);
    expect(await page.locator("#account-outcome").textContent()).toContain("Passkey renamed.");
    expect(await rows(page).count()).toBe(1);
    // Rename it from its row, by keyboard.
    await pressByKeyboard(page, "link", "Rename passkey Work laptop");
    await page.waitForURL(/\/rename$/);
    expect(await page.locator("#rename-title").textContent()).toBe("Rename passkey");
    expect(await page.getByLabel("Passkey name").inputValue()).toBe("Work laptop");
    await page.getByLabel("Passkey name").fill("Home laptop");
    await Promise.all([page.waitForURL(`${origin}/settings/account?**`), page.keyboard.press("Enter")]);
    expect(await page.locator("#account-outcome").textContent()).toContain("Passkey renamed.");
    expect(await page.locator("[data-passkey-row]").first().textContent()).toContain("Home laptop");
    // A stored row is not a usable passkey: sign out and sign in with it.
    await context.clearCookies();
    expect(await sessionEmail(page)).toBeNull();
    await page.goto(`${origin}/signin?next=/cases/7`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL(`${origin}/cases/7`, { timeout: 10_000 });
    expect(await sessionEmail(page)).toBe(EMAIL);
    await context.close();
  }, 120_000);

  it("says a cancelled prompt in words, adds nothing, and starts no second ceremony while one is under way", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await signedIn(context);
    const page = await context.newPage();
    const { cdp, authenticatorId } = await withAuthenticator(context, page);
    let creates = 0;
    await page.exposeFunction("countCreate", () => {
      creates += 1;
    });
    await page.addInitScript(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = (options) => {
        (window as unknown as { countCreate: () => void }).countCreate();
        return create(options);
      };
    });
    await page.goto(`${origin}/settings/account`);
    const before = await rows(page).count();
    // A device that cannot verify the person: the browser refuses before the Worker is asked.
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await expect.poll(() => page.locator("[data-passkey-add-message]").textContent()).toContain("No passkey was added");
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-passkey-add-message"))).toBe(true);
    expect(await page.getByRole("button", { name: "Add a passkey", exact: true }).getAttribute("aria-busy")).toBeNull();
    expect(await rows(page).count()).toBe(before);
    // Two presses while the ceremony is held: one ceremony.
    creates = 0;
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
    const add = page.getByRole("button", { name: "Add a passkey", exact: true });
    await Promise.all([add.dispatchEvent("click"), add.dispatchEvent("click")]);
    await page.waitForURL(/\/rename\?added=1$/);
    expect(creates).toBe(1);
    await context.close();
  }, 120_000);

  it("answers each refusal with its sentence and the next step, leaving the list unchanged", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await signedIn(context);
    const page = await context.newPage();
    const { cdp, authenticatorId } = await withAuthenticator(context, page);
    await page.goto(`${origin}/settings/account`);
    const before = await rowIds(page);
    const add = page.getByRole("button", { name: "Add a passkey", exact: true });
    const message = page.locator("[data-passkey-add-message]");
    // INTERCEPTED: the verifier's own refusals that a real browser cannot be made to provoke.
    const refuse = async (status: number, body: object, expected: string) => {
      await page.route("**/api/auth/passkey/verify-registration", (route) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
      );
      await add.click();
      await expect.poll(() => message.textContent(), { message: `${status}` }).toContain(expected);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-passkey-add-message"))).toBe(true);
      await page.unroute("**/api/auth/passkey/verify-registration");
      expect(await rowIds(page)).toEqual(before);
      // The device keeps the credential it made for a response that was refused; the next try starts clean.
      await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    };
    await refuse(400, { code: "USER_VERIFICATION_REQUIRED", message: "x" }, "Your device was not unlocked");
    await refuse(500, {}, "could not be added and nothing was saved");
    await refuse(400, { message: "this passkey is already registered" }, "already has a passkey for your account");
    await refuse(
      400,
      { message: "the passkey response could not be verified" },
      "could not be added and nothing was saved",
    );
    // Options that could not be fetched.
    await page.route("**/api/auth/passkey/generate-register-options", (route) =>
      route.fulfill({ status: 500, body: "" }),
    );
    await add.click();
    await expect.poll(() => message.textContent()).toContain("could not start adding a passkey");
    // An expired session at the options or at the verifier goes to sign-in, returning here.
    await page.unroute("**/api/auth/passkey/generate-register-options");
    await page.route("**/api/auth/passkey/generate-register-options", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await Promise.all([page.waitForURL(`${origin}/signin?next=%2Fsettings%2Faccount`), add.click()]);
    await context.close();
  }, 120_000);

  it("reconciles an add whose answer was lost: one new passkey, no second ceremony, and its own naming page", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await signedIn(context);
    const page = await context.newPage();
    await withAuthenticator(context, page);
    let creates = 0;
    await page.exposeFunction("countCreate", () => {
      creates += 1;
    });
    await page.addInitScript(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = (options) => {
        (window as unknown as { countCreate: () => void }).countCreate();
        return create(options);
      };
    });
    await page.goto(`${origin}/settings/account`);
    const known = await rowIds(page);
    expect(known.length).toBeGreaterThan(0);
    // The Worker verifies and saves the passkey; the answer never reaches the page.
    await page.route("**/api/auth/passkey/verify-registration", async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await page.waitForURL(/\/settings\/account\?reconcile=add&known=/);
    await page.unroute("**/api/auth/passkey/verify-registration");
    expect(creates).toBe(1);
    expect(await page.locator("#account-outcome").textContent()).toContain(
      "Your passkey was saved, but we did not get the answer.",
    );
    const ids = await rowIds(page);
    expect(ids).toHaveLength(known.length + 1);
    const fresh = ids.filter((id) => !known.includes(id));
    expect(fresh).toHaveLength(1);
    // It names that credential, and pressing Add again is not what the page offers first.
    const link = page.getByRole("link", { name: "Name this passkey" });
    expect(await link.getAttribute("href")).toBe(`/settings/account/passkeys/${fresh[0]}/rename?added=1`);
    await link.click();
    await page.waitForURL(/rename\?added=1$/);
    expect(page.url()).toContain(`/passkeys/${fresh[0]}/rename`);
    expect(creates).toBe(1);
    // An add that saved nothing says so and offers the add again.
    await page.goto(
      `${origin}/settings/account?reconcile=add&known=${encodeURIComponent((await rowIds(page).catch(() => [])).join(","))}`,
    );
    const all = await rowIds(page);
    await page.goto(`${origin}/settings/account?reconcile=add&known=${encodeURIComponent(all.join(","))}`);
    expect(await page.locator("#account-outcome").textContent()).toContain("No passkey was added: nothing was saved.");
    await context.close();
  }, 120_000);

  it("names a passkey with JavaScript off", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
    await signedIn(context);
    const page = await context.newPage();
    await page.goto(`${origin}/settings/account`);
    // No script: no Add control, the reason is said, and the existing passkeys can still be renamed.
    expect(await page.locator("[data-passkey-add]").isVisible()).toBe(false);
    expect(await page.getByText("Adding a passkey needs a browser that supports passkeys").isVisible()).toBe(true);
    const first = page.locator("[data-passkey-row] a", { hasText: "Rename" }).first();
    await Promise.all([page.waitForNavigation(), first.click()]);
    await page.getByLabel("Passkey name").fill("Named without a script");
    await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Save name" }).click()]);
    expect(await page.locator("#account-outcome").textContent()).toContain("Passkey renamed.");
    expect(await page.getByText("Named without a script").count()).toBeGreaterThan(0);
    await context.close();
  }, 120_000);
});
