import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type AddressRow,
  type DomainRow,
  DomainsListPage,
  OUTCOMES,
  type Outcome,
  RemoveConfirm,
} from "../../src/web/pages/domains-list-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The Domains and addresses page in Chromium (D07 T04 §4), served by this process with the shipped stylesheet and app
// script: adding a domain by keyboard from the disclosure, a refusal under the field with what was typed kept, a removal
// by keyboard through its confirm page and Cancel keeping the claim, and the accessibility gate's rules at both widths
// in both themes for the empty state, a member's read-only view and every row state.
const PUBLIC = join(import.meta.dirname, "../../public");
const ORG = { id: "org-karoo", name: "Karoo Couriers" };
const fresh = (): { domains: DomainRow[]; addresses: AddressRow[] } => ({
  domains: [
    {
      domain: "karoocouriers.example",
      state: "verified",
      method: "dns",
      verifiedAt: "2026-10-12T08:00:00Z",
      verifiedBy: { kind: "member", name: "Thandi Nkosi" },
      challenge: null,
      protectedIdentity: "Yes",
    },
    {
      domain: "kcexpress.example",
      state: "pending",
      method: null,
      verifiedAt: null,
      verifiedBy: null,
      challenge: { codeExpiresAt: null, lockedUntil: "2026-11-01T10:20:00Z", nextCodeAt: null },
      protectedIdentity: "After verifying",
    },
  ],
  addresses: [
    {
      kind: "domain",
      label: "Anyone @karoocouriers.example",
      state: "verified",
      verifiedAt: "2026-10-12T08:00:00Z",
      verifiedBy: { kind: "member", name: "Thandi Nkosi" },
      casesThisMonth: 58,
    },
    {
      kind: "single",
      label: "karoo.dispatch@mailhost.example",
      state: "verified",
      verifiedAt: "2026-10-14T08:00:00Z",
      verifiedBy: { kind: "member", name: "Thandi Nkosi" },
      casesThisMonth: 6,
    },
  ],
});
type State = { lists: ReturnType<typeof fresh>; manage: boolean; empty: boolean };
const state: State = { lists: fresh(), manage: true, empty: false };

const html = (body: unknown, status = 200) =>
  new Response(String(body), { status, headers: { "content-type": "text/html; charset=utf-8" } });
const shell = () => {
  const { children: _, ...rest } = shellOf({ organization: ORG, active: "domains" });
  return rest;
};
const page = (outcome: Outcome | null, add?: { value: string; error: string | null }, status = 200) =>
  html(
    <DomainsListPage
      shell={shell()}
      domains={state.empty ? [] : state.lists.domains}
      addresses={state.empty ? [] : state.lists.addresses}
      manage={state.manage}
      outcome={outcome}
      {...(add ? { add } : {})}
    />,
    status,
  );

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/settings/domains" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (form.get("action") === "add") {
      const domain = (form.get("domain") ?? "").trim();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
        return page(null, { value: domain, error: "that is not a domain an organisation can claim" }, 400);
      return new Response(null, { status: 303, headers: { location: `/settings/domains/${domain}` } });
    }
    const name = form.get("target") ?? "";
    state.lists.domains = state.lists.domains.filter((d) => d.domain !== name);
    return new Response(null, {
      status: 303,
      headers: { location: `/settings/domains?r=removed&w=${encodeURIComponent(name)}` },
    });
  }
  if (url.pathname === "/settings/domains") {
    const r = url.searchParams.get("r");
    const outcome =
      r && (OUTCOMES as readonly string[]).includes(r)
        ? ({ r, what: url.searchParams.get("w") ?? undefined } as Outcome)
        : null;
    return page(outcome);
  }
  if (url.pathname.startsWith("/settings/domains/remove/")) {
    const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    return html(
      <RemoveConfirm
        shell={shell()}
        kind="domain"
        name={name}
        consequences={[
          `Mail from addresses at ${name} will no longer be accepted for ${ORG.name}, except from an address you proved separately.`,
        ]}
      />,
    );
  }
  if (url.pathname.startsWith("/settings/domains/"))
    return html(`<!doctype html><title>Claim</title><h1>Claim ${url.pathname.split("/").at(-1)}</h1>`);
  const file = join(PUBLIC, url.pathname);
  if (url.pathname.startsWith("/static/") && existsSync(file)) {
    const type = url.pathname.endsWith(".css")
      ? "text/css"
      : url.pathname.endsWith(".js")
        ? "text/javascript"
        : url.pathname.endsWith(".svg")
          ? "image/svg+xml"
          : "font/woff2";
    return new Response(readFileSync(file), {
      headers: { "content-type": type, "cache-control": "public, max-age=3600, immutable" },
    });
  }
  return new Response("not found", { status: 404 });
}

let browser: Browser;
let server: Server;
let origin: string;
const pool = new Map<string, BrowserContext>();
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
afterEach(() => {
  Object.assign(state, { lists: fresh(), manage: true, empty: false });
});

async function open(path = "/settings/domains", width = 1280) {
  let context = pool.get(String(width));
  if (!context) {
    context = await browser.newContext({ viewport: { width, height: 900 } });
    pool.set(String(width), context);
  }
  const p: Page = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return p;
}
const outcome = (p: Page) => p.locator("#domains-outcome").textContent();

describe.skipIf(!chromiumPath() && !process.env.CI)("the domains page in Chromium", { timeout: 120_000 }, () => {
  it("adds a domain by keyboard from the disclosure and lands on its claim page", async () => {
    const p = await open();
    await p.locator("#add-domain summary").focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => p.locator("#add-domain-name").isVisible()).toBe(true);
    await p.locator("#add-domain-name").fill("newco.co.za");
    await p.keyboard.press("Enter");
    await expect.poll(() => p.locator("h1").textContent()).toBe("Claim newco.co.za");
    await p.close();
  });

  it("keeps what was typed and says why under the field when a domain is refused", async () => {
    const p = await open();
    await p.locator("#add-domain summary").click();
    await p.locator("#add-domain-name").fill("not a domain");
    await p.locator("#add-domain-name").press("Enter");
    await expect
      .poll(() => p.locator("#add-domain-name-error").textContent())
      .toContain("that is not a domain an organisation can claim");
    expect(await p.locator("#add-domain-name").inputValue()).toBe("not a domain");
    expect(await p.locator("#add-domain-name").getAttribute("aria-invalid")).toBe("true");
    await p.close();
  });

  it("removes a domain by keyboard through the confirm page, and Cancel keeps it", async () => {
    const p = await open();
    await p.getByRole("link", { name: "Remove kcexpress.example" }).first().focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => p.locator("h1").textContent()).toBe("Remove kcexpress.example?");
    await p.getByRole("link", { name: "Cancel" }).click();
    await expect.poll(() => p.locator("h1").textContent()).toBe("Domains and addresses");
    expect(state.lists.domains).toHaveLength(2);
    await p.getByRole("link", { name: "Remove kcexpress.example" }).first().click();
    await p.getByRole("button", { name: "Remove kcexpress.example" }).focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => outcome(p)).toContain("kcexpress.example was removed.");
    expect(await p.locator("table").first().getByText("kcexpress.example").count()).toBe(0);
    await p.close();
  });

  it("adds and removes with JavaScript disabled", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const p = await context.newPage();
    await p.goto(`${origin}/settings/domains`);
    await p.locator("#add-domain summary").click();
    await p.locator("#add-domain-name").fill("newco.co.za");
    await p.getByRole("button", { name: "Add domain" }).click();
    expect(await p.locator("h1").textContent()).toBe("Claim newco.co.za");
    await p.goto(`${origin}/settings/domains`);
    await p.getByRole("link", { name: "Remove kcexpress.example" }).first().click();
    await p.getByRole("button", { name: "Remove kcexpress.example" }).click();
    expect(await outcome(p)).toContain("kcexpress.example was removed.");
    await context.close();
  });

  // The verifier's name is visible on a domain row and a single-address row at both widths, in both themes
  // (D07 T04 §28): getByText with a visibility check reads the phone list at 360 px and the table at 1280 px.
  for (const width of [360, 1280])
    it(`shows who proved a domain and an address (${width} px, light and dark)`, async () => {
      const p = await open("/settings/domains", width);
      // The page draws each row twice (the desktop table and the phone list); at each width one copy is hidden.
      const visible = (text: string) => p.getByText(text, { exact: true }).locator("visible=true").first();
      for (const theme of ["light", "dark"] as const) {
        await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(await visible("DNS TXT record, 12 Oct 2026 by Thandi N.").isVisible(), theme).toBe(true);
        expect(
          await visible("Single address, confirmed by a code on 14 Oct 2026 by Thandi N.").isVisible(),
          theme,
        ).toBe(true);
      }
      await p.close();
    });

  it("shows a member both tables with no controls", async () => {
    state.manage = false;
    const p = await open();
    expect(await p.getByText("karoocouriers.example").first().isVisible()).toBe(true);
    expect(await p.getByRole("table", { name: "Domains", exact: true }).count()).toBe(1);
    expect(await p.getByRole("table", { name: "Addresses that can forward to check@" }).count()).toBe(1);
    expect(await p.locator("#add-domain").count()).toBe(0);
    expect(await p.getByRole("link", { name: /^Remove / }).count()).toBe(0);
    await p.close();
  });

  // Each state is loaded once per width and scanned in light and dark by switching the theme in place.
  for (const width of [360, 1280])
    it(`passes the accessibility gate's rules on the lists, the empty state and a member's view (light and dark, ${width} px)`, async () => {
      const scenarios: [string, Partial<State>][] = [
        ["lists with a pending claim and a lock", {}],
        ["empty", { empty: true }],
        ["a member's read-only view", { manage: false }],
      ];
      for (const [name, change] of scenarios) {
        Object.assign(state, { lists: fresh(), manage: true, empty: false }, change);
        const p = await open("/settings/domains", width);
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${name}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${theme} ${name}`).toEqual([]);
        }
        await p.close();
      }
      Object.assign(state, { lists: fresh(), manage: true, empty: false });
      const refused = await open("/settings/domains", width);
      await refused.locator("#add-domain summary").click();
      await refused.locator("#add-domain-name").fill("not a domain");
      await refused.locator("#add-domain-name").press("Enter");
      await refused.locator("#add-domain-name-error").waitFor();
      await refused.addScriptTag({ path: AXE });
      for (const theme of ["light", "dark"] as const) {
        await refused.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(problems(await scan(refused)), `${theme} refusal`).toEqual([]);
      }
      await refused.close();
      // The confirm page.
      Object.assign(state, { lists: fresh(), manage: true, empty: false });
      for (const path of ["/settings/domains/remove/karoocouriers.example"]) {
        const p = await open(path, width);
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(problems(await scan(p)), `${theme} ${path}`).toEqual([]);
        }
        await p.close();
      }
    });
});
