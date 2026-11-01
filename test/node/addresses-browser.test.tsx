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
  address: string;
  state: "pending" | "verified";
  attempts: number;
  locked: boolean;
  sent: boolean;
  expired: boolean;
  held: boolean;
};
const state: { claims: Claim[]; refuse: string | null } = { claims: [], refuse: null };
const fresh = () => {
  state.claims = [];
  state.refuse = null;
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
    lockedUntil: c.locked ? LATER : null,
    nextCodeAt: c.held ? LATER : null,
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

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString());
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
  if (url.pathname === "/settings/domains" && req.method === "POST") {
    const form = await body(req);
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
      const form = await body(req);
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
    const r = url.searchParams.get("r");
    return html(<AddressPage shell={shell()} view={viewOf(claim)} result={r ? ({ r } as Result) : null} now={NOW} />);
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
    state.claims = [claim("held@fynbos.example", { held: true })];
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

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280] as const)
      it(`passes the accessibility rules for every state (${theme}, ${width} px)`, async () => {
        const pages: [string, Partial<Claim>[], string][] = [
          ["empty list", [], "/settings/domains"],
          ["list with a pending address", [{ address: "finance@fynbos.example" }], "/settings/domains"],
          ["pending with a code", [{ address: "a@fynbos.example" }], here("a@fynbos.example")],
          ["code mailed", [{ address: "a@fynbos.example" }], `${here("a@fynbos.example")}?r=add-sent`],
          ["uncertain", [{ address: "a@fynbos.example" }], `${here("a@fynbos.example")}?r=add-unknown`],
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
          ["held", [{ address: "a@fynbos.example", held: true }], here("a@fynbos.example")],
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
