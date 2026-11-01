import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressClaimView } from "../../src/auth/domain-claim";
import { AddressNotFound, AddressPage, type Result } from "../../src/web/pages/addresses-view";
import { type AddressRow, DomainsListPage } from "../../src/web/pages/domains-list-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The single-address flow in Chromium (D07 T04 §27; SPEC M8a), served over HTTP by this process with the shipped app
// script: both entry points, Continue, Add, Verify and Send a new code reached and operated by keyboard with and without
// JavaScript, the typed address kept after a refusal, held and freed controls, every state of the page under the
// accessibility rules in both themes at phone and desktop widths. What the Worker decides (the limits, the verification,
// the audit) is test/web/addresses-page.test.ts's; this proves what a person sees and does.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date("2026-10-30T10:00:00Z");
const CODE = "482107";
type Claim = {
  // Real-clock deadlines for the tests that wait for one (the other states use fixed times).
  delivery?: "sent" | "uncertain" | "failed" | "sending";
  heldUntil?: number | undefined;
  lockedAt?: number | undefined;
  address: string;
  state: "pending" | "verified";
  attempts: number;
  locked: boolean;
  sent: boolean;
  expired: boolean;
  held: boolean;
};
const state: { claims: Claim[]; refuse: string | null; delay: number; posts: number; probes: string[] } = {
  claims: [],
  refuse: null,
  delay: 0,
  posts: 0,
  probes: [],
};
const fresh = () => {
  state.claims = [];
  state.refuse = null;
  state.delay = 0;
  state.posts = 0;
  state.probes = [];
};
const html = (body: unknown, status = 200) =>
  new Response(String(body), { status, headers: { "content-type": "text/html; charset=utf-8" } });
const shell = () => {
  const { children: _, ...rest } = shellOf({ active: "domains" });
  return rest;
};
const SOON = new Date(NOW.getTime() + 25 * 60_000).toISOString();
const LATER = new Date(NOW.getTime() + 55 * 60_000).toISOString();
const viewOf = (c: Claim): AddressClaimView => ({
  address: c.address,
  state: c.state,
  verifiedAt: c.state === "verified" ? NOW.toISOString() : null,
  code: {
    expiresAt: c.sent && !c.expired && !c.locked ? SOON : null,
    expired: c.expired,
    attempts: c.attempts,
    lockedUntil: c.lockedAt ? new Date(c.lockedAt).toISOString() : c.locked ? LATER : null,
    nextCodeAt: c.heldUntil ? new Date(c.heldUntil).toISOString() : c.held ? LATER : null,
    delivery: c.sent ? (c.delivery ?? "sent") : null,
  },
});
const rows = (): AddressRow[] =>
  state.claims.map((c) => ({
    kind: "single",
    label: c.address,
    state: c.state,
    verifiedAt: c.state === "verified" ? NOW.toISOString() : null,
    casesThisMonth: 0,
  }));
const here = (address: string) => `/settings/addresses/${encodeURIComponent(address)}`;
const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });

async function raw(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}
async function body(req: IncomingMessage) {
  return new URLSearchParams(await raw(req));
}
function listPage(status = 200, add?: { value: string; error: string | null }) {
  return html(
    <DomainsListPage
      shell={shell()}
      domains={[]}
      addresses={rows()}
      manage={true}
      outcome={null}
      {...(add ? { addAddress: add } : {})}
    />,
    status,
  );
}

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/probe") {
    state.probes.push(await raw(req));
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/settings/domains" && req.method === "POST") {
    state.posts += 1;
    const form = await body(req);
    await new Promise((done) => setTimeout(done, state.delay));
    const typed = (form.get("address") ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed))
      return listPage(400, { value: typed, error: "that is not an email address" });
    if (state.refuse === typed)
      return listPage(400, { value: typed, error: "that address is verified by another organisation" });
    state.claims.push({
      address: typed.toLowerCase(),
      state: "pending",
      attempts: 0,
      locked: false,
      sent: true,
      expired: false,
      held: false,
    });
    return redirect(`${here(typed.toLowerCase())}?r=add-sent`);
  }
  if (url.pathname === "/settings/domains") return listPage();
  const m = /^\/settings\/addresses\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const address = decodeURIComponent(m[1] as string);
    const claim = state.claims.find((c) => c.address === address);
    if (req.method === "POST") {
      state.posts += 1;
      const form = await body(req);
      await new Promise((done) => setTimeout(done, state.delay));
      if (!claim) return redirect(here(address));
      if (form.get("action") === "send") {
        claim.sent = true;
        claim.expired = false;
        claim.attempts = 0;
        claim.locked = false;
        return redirect(`${here(address)}?r=send-sent`);
      }
      const code = (form.get("code") ?? "").replace(/\D/g, "");
      if (code.length !== 6) return redirect(`${here(address)}?r=verify-malformed`);
      if (code === CODE) {
        claim.state = "verified";
        return redirect(`${here(address)}?r=verify-verified`);
      }
      claim.attempts += 1;
      if (claim.attempts >= 3) claim.locked = true;
      return redirect(`${here(address)}?r=${claim.locked ? "verify-locked" : "verify-wrong"}`);
    }
    if (!claim)
      return html(
        <AddressNotFound shell={shell()} address={address} switched={false} reference="ref-1" now={NOW} />,
        404,
      );
    // A lock that has ended frees the claim, as the Worker reads it from the clock.
    if (claim.lockedAt && Date.now() > claim.lockedAt) {
      claim.lockedAt = undefined;
      claim.locked = false;
      claim.attempts = 0;
      claim.sent = false;
    }
    const r = url.searchParams.get("r");
    const timed = Boolean(claim.heldUntil || claim.lockedAt);
    return html(
      <AddressPage
        shell={shell()}
        view={viewOf(claim)}
        result={r ? ({ r } as Result) : null}
        now={timed ? new Date() : NOW}
      />,
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
    return new Response(readFileSync(file), { headers: { "content-type": type } });
  }
  return new Response("not found", { status: 404 });
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const out = await answer(req);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});
afterEach(fresh);

const open = async (path: string, width = 1280, js = true) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: js });
  const p: Page = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
};
// Tab to a control by its accessible name and operate it with the key a keyboard user presses.
async function reach(p: Page, role: "link" | "button" | "textbox", name: string | RegExp, selector?: string) {
  const target = selector ? p.locator(selector) : p.getByRole(role, { name, exact: typeof name === "string" });
  let reached = false;
  for (let i = 0; i < 150 && !reached; i++) {
    await p.keyboard.press("Tab");
    reached = await target.evaluate((el) => el === document.activeElement);
  }
  expect(reached, String(name)).toBe(true);
}
const claim = (address: string, changes: Partial<Claim> = {}): Claim => ({
  address,
  state: "pending",
  attempts: 0,
  locked: false,
  sent: true,
  expired: false,
  held: false,
  ...changes,
});

describe.skipIf(!chromiumPath() && !process.env.CI)("the single-address flow in Chromium", { timeout: 120_000 }, () => {
  for (const js of [true, false])
    it(`adds an address from the empty state, verifies it by keyboard, and sees it in the table ${js ? "with" : "without"} JavaScript`, async () => {
      const { p, context } = await open("/settings/domains", 1280, js);
      // The empty state offers the single address beside the domain.
      expect(await p.getByText("No mail is accepted yet").count()).toBe(1);
      await reach(p, "button", "Add a single address", "#add-address summary");
      await p.keyboard.press("Enter");
      await p.locator("#add-address-email").fill("accounts@fynbos.example");
      await p.keyboard.press("Enter");
      await p.waitForURL(/\/settings\/addresses\/accounts%40fynbos\.example\?r=add-sent/);
      await p.waitForFunction(() =>
        document.body.textContent?.includes("A code was mailed to accounts@fynbos.example."),
      );
      // A wrong code: the field keeps its error with the tries left; then the right one.
      await p.getByLabel("Code from the email").fill("000000");
      await p.keyboard.press("Enter");
      await p.waitForURL(/r=verify-wrong/);
      const field = p.getByLabel("Code from the email");
      expect(await field.getAttribute("aria-invalid")).toBe("true");
      expect(await p.locator("#address-code-error").textContent()).toContain("That code is not right. 2 tries left");
      await field.fill(CODE);
      await field.press("Enter");
      await p.waitForURL(/r=verify-verified/);
      expect(await p.getByText("Done: accounts@fynbos.example is verified.").count()).toBe(1);
      expect(await p.getByRole("heading", { name: "accounts@fynbos.example is verified" }).count()).toBe(1);
      // The table shows it verified.
      await p.getByRole("link", { name: "Back to Domains and addresses" }).click();
      await p.waitForURL(`${origin}/settings/domains`);
      expect(await p.getByText("Single address, confirmed by a code").count()).toBeGreaterThan(0);
      await context.close();
    });

  it("opens a pending address from the table's Continue and sends a new code from there, held controls explained", async () => {
    state.claims = [claim("finance@fynbos.example")];
    const { p, context } = await open("/settings/domains");
    await reach(p, "link", "Continue verifying finance@fynbos.example");
    await p.keyboard.press("Enter");
    await p.waitForURL(/\/settings\/addresses\/finance%40fynbos\.example$/);
    expect(await p.getByRole("button", { name: "Send a new code" }).isEnabled()).toBe(true);
    await reach(p, "button", "Send a new code");
    await p.keyboard.press("Enter");
    await p.waitForURL(/r=send-sent/);
    expect(await p.getByText("A code was mailed to finance@fynbos.example.").count()).toBe(1);
    // The hour's codes spent: the control is held with its reason and time.
    state.claims = [claim("held@fynbos.example", { heldUntil: Date.now() + 3_600_000 })];
    await p.goto(`${origin}${here("held@fynbos.example")}`, { waitUntil: "load" });
    const send = p.getByRole("button", { name: "Send a new code" });
    expect(await send.isDisabled()).toBe(true);
    expect(await send.getAttribute("aria-describedby")).toBe("send-code-reason");
    expect(await p.locator("#send-code-reason").textContent()).toMatch(/The next code can go at \d{2}:\d{2} SAST\./);
    await context.close();
  });

  it("keeps the typed address under its field after a refusal, with the error associated, with and without JavaScript", async () => {
    for (const js of [true, false]) {
      state.claims = [claim("someone@fynbos.example")];
      const { p, context } = await open("/settings/domains", 1280, js);
      await p.locator("#add-address summary").click();
      await p.locator("#add-address-email").fill("not an address");
      await p.getByRole("button", { name: "Add address" }).click();
      await p.waitForSelector("#add-address-email-error");
      const field = p.locator("#add-address-email");
      expect(await field.inputValue()).toBe("not an address");
      expect(await field.getAttribute("aria-invalid")).toBe("true");
      expect(await field.getAttribute("aria-describedby")).toContain("add-address-email-error");
      expect(await p.locator("#add-address-email-error").textContent()).toContain("that is not an email address");
      // The form is open again for the correction, and nothing was added.
      expect(state.claims).toHaveLength(1);
      await context.close();
    }
  });

  it("has the code field ready after a code is mailed, so keyboard entry needs no tabbing, and the field names where it went and until when", async () => {
    state.claims = [claim("ready@fynbos.example")];
    const { p, context } = await open(`${here("ready@fynbos.example")}?r=send-sent`);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("address-code");
    expect(await p.locator("#address-code-hint").textContent()).toMatch(
      /^Sent to ready@fynbos\.example at \d{2}:\d{2} SAST\. It works until \d{2}:\d{2} SAST\./,
    );
    // Typed, not filled: the keyboard alone, from where the page left it.
    await p.keyboard.type(CODE);
    await p.keyboard.press("Enter");
    await p.waitForURL(/r=verify-verified/);
    expect(
      await p.locator("[role=status]").filter({ hasText: "Done: ready@fynbos.example is verified." }).count(),
    ).toBe(1);
    await context.close();
  });

  it("says the work under way on the Verify button, and offers a read-only look at where it stands within two seconds", async () => {
    state.claims = [claim("slow@fynbos.example")];
    state.delay = 8000;
    const { p, context } = await open(`${here("slow@fynbos.example")}?r=send-sent`);
    // The page reports its own button and look-link as they change: a locator would wait for the pending navigation.
    await p.evaluate(() => {
      const say = () => {
        const b = document.querySelector<HTMLButtonElement>(
          "form[data-busy] button[type=submit][data-busy-label='Verifying']",
        );
        const link = document.querySelector("[data-busy-check-link]")?.getAttribute("href") ?? "";
        navigator.sendBeacon("/probe", `${b?.disabled} ${b?.getAttribute("aria-busy")} ${b?.textContent} ${link}`);
      };
      new MutationObserver(say).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
    await p.keyboard.type(CODE);
    await p.keyboard.press("Enter");
    await expect.poll(() => state.probes.join("\n")).toContain("true true Verifying");
    await expect
      .poll(() => state.probes.join("\n"), { timeout: 5000 })
      .toContain(`Verifying ${here("slow@fynbos.example")}`);
    // The look is a plain read: it sends nothing again, and shows the claim as stored.
    state.delay = 0;
    await p.goto(`${origin}${here("slow@fynbos.example")}`, { waitUntil: "load" });
    expect(state.posts).toBe(1);
    await context.close();
  });

  for (const [what, label, setup] of [
    ["Add", "Adding…", "add"],
    ["Send a new code", "Sending", "send"],
  ] as const)
    it(`says the work under way on ${what}, holds it, and offers a read-only look at where it stands within two seconds`, async () => {
      state.claims = setup === "add" ? [claim("seen@fynbos.example")] : [claim("slow2@fynbos.example")];
      state.delay = 8000;
      const { p, context } = await open(setup === "add" ? "/settings/domains" : here("slow2@fynbos.example"));
      await p.evaluate(
        ([words, scope]) => {
          const say = () => {
            const b = document.querySelector<HTMLButtonElement>(
              `${scope} button[type=submit][data-busy-label='${words}']`,
            );
            const link = document.querySelector("[data-busy-check-link]")?.getAttribute("href") ?? "";
            navigator.sendBeacon("/probe", `${b?.disabled} ${b?.getAttribute("aria-busy")} ${b?.textContent} ${link}`);
          };
          new MutationObserver(say).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        },
        [label, setup === "add" ? "#add-address form" : "form[data-busy]"] as const,
      );
      if (setup === "add") {
        await p.locator("#add-address summary").click();
        await p.locator("#add-address-email").fill("new@fynbos.example");
        await p.getByRole("button", { name: "Add address" }).click({ noWaitAfter: true });
      } else {
        await p.getByRole("button", { name: "Send a new code" }).click({ noWaitAfter: true });
      }
      await expect.poll(() => state.probes.join("\n")).toContain(`true true ${label}`);
      const look = setup === "add" ? "/settings/domains" : here("slow2@fynbos.example");
      await expect.poll(() => state.probes.join("\n"), { timeout: 5000 }).toContain(`${label} ${look}`);
      // The look sends nothing again.
      state.delay = 0;
      await p.goto(`${origin}${look}`, { waitUntil: "load" });
      expect(state.posts).toBe(1);
      await context.close();
    });

  it("sends a new code without JavaScript from an address's own page", async () => {
    state.claims = [claim("nojs@fynbos.example")];
    const { p, context } = await open("/settings/domains", 1280, false);
    await Promise.all([
      p.waitForNavigation(),
      p.getByRole("link", { name: "Continue verifying nojs@fynbos.example" }).click(),
    ]);
    await Promise.all([p.waitForNavigation(), p.getByRole("button", { name: "Send a new code" }).click()]);
    expect(await p.getByText("A code was mailed to nojs@fynbos.example.").count()).toBe(1);
    expect(state.posts).toBe(1);
    await context.close();
  });

  it("frees the held Send a new code when its time comes, on the open page, and clears the reason", async () => {
    state.claims = [claim("wait@fynbos.example", { heldUntil: Date.now() + 2500 })];
    const { p, context } = await open(here("wait@fynbos.example"));
    const send = p.getByRole("button", { name: "Send a new code" });
    expect(await send.isDisabled()).toBe(true);
    expect(await p.locator("#send-code-reason").textContent()).toMatch(/The next code can go at \d{2}:\d{2} SAST\./);
    await expect.poll(() => send.isEnabled(), { timeout: 8000 }).toBe(true);
    expect(await p.locator("#send-code-reason").textContent()).toBe("");
    expect(await send.getAttribute("aria-describedby")).toBeNull();
    await context.close();
  });

  it("reloads a locked page itself when the lock ends, and without JavaScript offers Check again", async () => {
    state.claims = [claim("lock@fynbos.example", { locked: true, attempts: 3, lockedAt: Date.now() + 2500 })];
    const { p, context } = await open(here("lock@fynbos.example"));
    expect(await p.getByText("Code entry is locked until").count()).toBe(1);
    await expect.poll(() => p.getByRole("button", { name: "Send a new code" }).count(), { timeout: 10_000 }).toBe(1);
    await context.close();
    // Without the script the same page offers the plain way to look again.
    state.claims = [claim("lock2@fynbos.example", { locked: true, attempts: 3, lockedAt: Date.now() + 1500 })];
    const bare = await open(here("lock2@fynbos.example"), 1280, false);
    expect(await bare.p.getByRole("link", { name: "Check again" }).count()).toBe(1);
    await bare.p.waitForTimeout(2000);
    await Promise.all([bare.p.waitForNavigation(), bare.p.getByRole("link", { name: "Check again" }).click()]);
    expect(await bare.p.getByRole("button", { name: "Send a new code" }).count()).toBe(1);
    await bare.context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280] as const)
      it(`passes the accessibility rules for every state (${theme}, ${width} px)`, async () => {
        const pages: [string, Partial<Claim>[], string][] = [
          ["empty list", [], "/settings/domains"],
          ["list with a pending address", [{ address: "finance@fynbos.example" }], "/settings/domains"],
          ["pending with a code", [{ address: "a@fynbos.example" }], here("a@fynbos.example")],
          ["code mailed", [{ address: "a@fynbos.example" }], `${here("a@fynbos.example")}?r=add-sent`],
          [
            "uncertain",
            [{ address: "a@fynbos.example", delivery: "uncertain" }],
            `${here("a@fynbos.example")}?r=add-unknown`,
          ],
          [
            "failed to send",
            [{ address: "a@fynbos.example", sent: false }],
            `${here("a@fynbos.example")}?r=add-failed`,
          ],
          ["wrong code", [{ address: "a@fynbos.example", attempts: 1 }], `${here("a@fynbos.example")}?r=verify-wrong`],
          ["malformed", [{ address: "a@fynbos.example" }], `${here("a@fynbos.example")}?r=verify-malformed`],
          [
            "locked",
            [{ address: "a@fynbos.example", locked: true, attempts: 3 }],
            `${here("a@fynbos.example")}?r=verify-locked`,
          ],
          ["expired", [{ address: "a@fynbos.example", expired: true }], here("a@fynbos.example")],
          ["no code waiting", [{ address: "a@fynbos.example", sent: false }], here("a@fynbos.example")],
          ["held", [{ address: "a@fynbos.example", heldUntil: Date.now() + 3_600_000 }], here("a@fynbos.example")],
          ["taken meanwhile", [{ address: "a@fynbos.example" }], `${here("a@fynbos.example")}?r=verify-taken`],
          ["unavailable", [{ address: "a@fynbos.example" }], `${here("a@fynbos.example")}?r=verify-unavailable`],
          ["verified", [{ address: "a@fynbos.example", state: "verified" }], here("a@fynbos.example")],
          [
            "already verified",
            [{ address: "a@fynbos.example", state: "verified" }],
            `${here("a@fynbos.example")}?r=already`,
          ],
          ["not found", [], here("nobody@fynbos.example")],
        ];
        for (const [label, claims, path] of pages) {
          state.claims = claims.map((c) => claim(c.address ?? "a@fynbos.example", c));
          const { p, context } = await open(path, width);
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), label).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), label).toEqual([]);
          await context.close();
        }
      });
});
