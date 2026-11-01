import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountPage, type AccountSession, OUTCOMES, type Outcome } from "../../src/web/pages/settings-account-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member as shellOf } from "./shell-fixtures";

// The Account page in Chromium (D07 T08 §3), served by this process with the shipped stylesheet and app script: the name
// saved by keyboard with the result announced, a refusal keeping what was typed under its field, the empty states, the
// account-only frame, and the accessibility gate's rules at 360 and 1280 px in both themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const NOW = new Date();
const ORG = { id: "org-karoo", name: "Karoo Couriers" };
const sessions = (): AccountSession[] => [
  {
    id: "s1",
    device: "Edge on Windows",
    current: true,
    signedInAt: NOW.toISOString(),
    lastActiveAt: NOW.toISOString(),
  },
  {
    id: "s2",
    device: "Safari on iPhone",
    current: false,
    signedInAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
    lastActiveAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
  },
];
const passkeys = () => [
  {
    id: "k1",
    name: "Windows Hello on the office PC",
    addedAt: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(),
    deviceType: "multiDevice",
  },
  {
    id: "k2",
    name: "iPhone",
    addedAt: new Date(NOW.getTime() - 19 * 86_400_000).toISOString(),
    deviceType: "singleDevice",
  },
];
const state = { name: "Thandi Nkosi", mode: "full" as "full" | "empty" | "bare" };
const shell = () => {
  const { children: _, ...rest } = shellOf({ organization: ORG, active: "account" });
  return rest;
};
const page = (outcome: Outcome | null, draft?: { name: string; error: string }, status = 200) =>
  new Response(
    String(
      <AccountPage
        shell={state.mode === "bare" ? null : shell()}
        user={{ name: state.name, email: "thandi@karoo.example" }}
        passkeys={state.mode === "full" ? passkeys() : []}
        sessions={state.mode === "full" ? sessions() : sessions().slice(0, 1)}
        outcome={outcome}
        {...(draft ? { draft } : {})}
        now={NOW}
      />,
    ),
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/settings/account" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const name = (form.get("name") ?? "").trim();
    if (!name) return page(null, { name: form.get("name") ?? "", error: "Enter your name." }, 400);
    state.name = name;
    return new Response(null, { status: 303, headers: { location: "/settings/account?r=saved" } });
  }
  if (url.pathname === "/settings/account") {
    const r = url.searchParams.get("r");
    return page(r && (OUTCOMES as readonly string[]).includes(r) ? ({ r } as Outcome) : null);
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
afterEach(() => {
  state.name = "Thandi Nkosi";
  state.mode = "full";
});
const context = (width: number): Promise<BrowserContext> => browser.newContext({ viewport: { width, height: 900 } });

describe.skipIf(!chromiumPath() && !process.env.CI)("the account page in Chromium", { timeout: 120_000 }, () => {
  it("saves the name by keyboard with the result announced, and keeps a refused name under its field", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    const field = p.getByLabel("Name");
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await p.keyboard.press("Tab");
      reached = await field.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await p.keyboard.press("Control+A");
    await p.keyboard.type("Thandi N.");
    await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
    expect(await p.locator("#account-outcome").textContent()).toContain("Name saved.");
    // The result takes focus when the page opens, so it is read out.
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("account-outcome");
    expect(await p.getByLabel("Name").inputValue()).toBe("Thandi N.");
    // A refusal keeps what was typed and marks the field.
    await p.getByLabel("Name").fill("   ");
    await Promise.all([p.waitForNavigation(), p.getByRole("button", { name: "Save", exact: true }).click()]);
    expect(await p.locator("#account-name").getAttribute("aria-invalid")).toBe("true");
    expect(await p.getByText("Enter your name.").count()).toBeGreaterThan(0);
    await ctx.close();
  });

  it("reaches every control by Tab: the name, Save and Sign out, with a visible focus", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    for (const [role, name] of [
      ["textbox", "Name"],
      ["button", "Save"],
      ["button", "Sign out"],
    ] as const) {
      const target = p.getByRole(role, { name, exact: true }).last();
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await target.evaluate((el) => el === document.activeElement);
      }
      expect(reached, name).toBe(true);
      const ring = await target.evaluate((el) => {
        const style = getComputedStyle(el);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), shadow: style.boxShadow };
      });
      expect(ring.style !== "none" || ring.shadow !== "none", name).toBe(true);
    }
    await ctx.close();
  });

  it("draws the empty states and the account-only frame", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    state.mode = "empty";
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    expect(await p.getByText("No passkeys yet. You sign in with an email link.").count()).toBe(1);
    expect(await p.getByText("This is your only session.").count()).toBe(1);
    state.mode = "bare";
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    expect(await p.getByRole("link", { name: "IsItLegit" }).first().getAttribute("href")).toBe("/");
    expect(await p.getByRole("heading", { name: "Account", exact: true }).count()).toBe(1);
    await ctx.close();
  });

  for (const width of [360, 1280]) {
    it(`passes the accessibility rules in both themes with no sideways scroll at ${width} px`, async () => {
      const ctx = await context(width);
      for (const mode of ["full", "empty", "bare"] as const) {
        state.mode = mode;
        const p = await ctx.newPage();
        await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${mode}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${theme} ${mode}`).toEqual([]);
        }
        await p.close();
      }
      await ctx.close();
    });
  }
});
