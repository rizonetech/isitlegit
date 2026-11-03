import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AccountConfirm,
  AccountPage,
  type AccountProps,
  type AccountSession,
  OUTCOMES,
  type Outcome,
  PasskeyRename,
} from "../../src/web/pages/settings-account-view";
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
const state = {
  name: "Thandi Nkosi",
  mode: "full" as "full" | "empty" | "bare",
  keys: passkeys(),
  others: sessions().slice(1),
  closed: false,
};
const shell = () => {
  const { children: _, ...rest } = shellOf({ organization: ORG, active: "account" });
  return rest;
};
const page = (
  outcome: Outcome | null,
  draft?: { name: string; error: string },
  status = 200,
  reconcile?: AccountProps["reconcile"],
) =>
  new Response(
    String(
      <AccountPage
        shell={state.mode === "bare" ? null : shell()}
        user={{ name: state.name, email: "thandi@karoo.example" }}
        passkeys={state.mode === "full" ? state.keys : []}
        sessions={state.mode === "full" ? [sessions()[0] as AccountSession, ...state.others] : sessions().slice(0, 1)}
        outcome={outcome}
        {...(draft ? { draft } : {})}
        {...(reconcile ? { reconcile } : {})}
        now={NOW}
      />,
    ),
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function answer(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const confirm = (
    title: string,
    action: string,
    id: string,
    label: string,
    extra?: { href: string; label: string },
    token?: string,
  ) =>
    new Response(
      String(
        <AccountConfirm
          shell={shell()}
          title={title}
          lines={["What it does.", "What it leaves."]}
          action={action}
          id={id}
          label={label}
          {...(extra ? { extra } : {})}
          {...(token ? { confirm: token } : {})}
        />,
      ),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  const rn = /^\/settings\/account\/passkeys\/([^/]+)\/rename$/.exec(url.pathname);
  if (rn) {
    const key = state.keys.find((k) => k.id === rn[1]);
    return new Response(
      String(
        <PasskeyRename
          shell={shell()}
          id={rn[1] as string}
          name={key?.name ?? ""}
          added={url.searchParams.get("added") === "1"}
          {...(url.searchParams.get("bad")
            ? { draft: { name: "x".repeat(101), error: "A name is one line of at most 100 characters." } }
            : {})}
        />,
      ),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  if (url.pathname === "/settings/account/close/export")
    return new Response("case,received,status,verdict\ncase-a,2026-10-26T01:00:00.000Z,done,malicious\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="cases-org-karoo.csv"',
      },
    });
  if (url.pathname === "/settings/account/close")
    return url.searchParams.get("stale") === "1"
      ? confirm("Sign in again to close Karoo Couriers", "step-up", ORG.id, "Sign in again")
      : confirm(
          "Close Karoo Couriers?",
          "close-account",
          ORG.id,
          "Close account",
          { href: `/settings/account/close/export?org=${ORG.id}`, label: "Download the case summaries first" },
          "tok",
        );
  if (url.pathname === "/signin")
    return new Response("<!doctype html><title>Sign in</title><main><h1>Sign in</h1></main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  const pk = /^\/settings\/account\/passkeys\/([^/]+)\/remove$/.exec(url.pathname);
  if (pk) return confirm("Remove iPhone?", "remove-passkey", pk[1] as string, "Remove passkey");
  const ss = /^\/settings\/account\/sessions\/([^/]+)\/sign-out$/.exec(url.pathname);
  if (ss) return confirm("Sign out Safari on iPhone?", "sign-out-session", ss[1] as string, "Sign out session");
  if (url.pathname === "/settings/account/sessions/sign-out-others")
    return confirm("Sign out every other session?", "sign-out-others", "others", "Sign out other sessions");
  if (url.pathname === "/settings/account" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const act = form.get("action");
    if (act === "rename-passkey") {
      state.keys = state.keys.map((k) => (k.id === form.get("id") ? { ...k, name: form.get("name") ?? k.name } : k));
      return new Response(null, { status: 303, headers: { location: "/settings/account?r=passkey-renamed" } });
    }
    if (act === "step-up")
      return new Response(null, {
        status: 303,
        headers: { location: `/signin?next=${encodeURIComponent(`/settings/account/close?org=${ORG.id}`)}` },
      });
    if (act === "close-account") {
      state.closed = true;
      return new Response(null, { status: 303, headers: { location: "/settings/account?r=org-closed" } });
    }
    if (act === "remove-passkey") {
      state.keys = state.keys.filter((k) => k.id !== form.get("id"));
      return new Response(null, { status: 303, headers: { location: "/settings/account?r=passkey-removed" } });
    }
    if (act === "sign-out-session" || act === "sign-out-others") {
      state.others = act === "sign-out-others" ? [] : state.others.filter((o) => o.id !== form.get("id"));
      return new Response(null, {
        status: 303,
        headers: { location: `/settings/account?r=${act === "sign-out-others" ? "others-out" : "session-out"}` },
      });
    }
    const name = (form.get("name") ?? "").trim();
    if (!name) return page(null, { name: form.get("name") ?? "", error: "Enter your name." }, 400);
    state.name = name;
    return new Response(null, { status: 303, headers: { location: "/settings/account?r=saved" } });
  }
  if (url.pathname === "/settings/account") {
    const r = url.searchParams.get("r");
    const rec = url.searchParams.get("reconcile");
    return page(
      r && (OUTCOMES as readonly string[]).includes(r)
        ? ({ r, ...(r === "rename-still" ? { name: "Office PC" } : {}) } as Outcome)
        : null,
      undefined,
      200,
      rec === "added"
        ? { kind: "added", id: "k2", name: "New" }
        : rec === "none"
          ? { kind: "none", cred: "c1" }
          : undefined,
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
afterEach(() => {
  state.name = "Thandi Nkosi";
  state.mode = "full";
  state.keys = passkeys();
  state.others = sessions().slice(1);
  state.closed = false;
});
const context = (width: number): Promise<BrowserContext> => browser.newContext({ viewport: { width, height: 900 } });

describe.skipIf(!chromiumPath() && !process.env.CI)("the account page in Chromium", { timeout: 120_000 }, () => {
  it("saves the name by keyboard with the result announced, and keeps a refused name under its field", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    const field = p.getByLabel("Name", { exact: true });
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
    expect(await p.getByLabel("Name", { exact: true }).inputValue()).toBe("Thandi N.");
    // A refusal keeps what was typed and marks the field.
    await p.getByLabel("Name", { exact: true }).fill("   ");
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

  it("removes a passkey and signs a session and all others out by keyboard through their confirmations, Cancel keeping them", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    const press = async (role: "link" | "button", name: string) => {
      const target = p.getByRole(role, { name, exact: true });
      let reached = false;
      for (let i = 0; i < 90 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await target.evaluate((el) => el === document.activeElement);
      }
      expect(reached, name).toBe(true);
      await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
    };
    // Cancel keeps the passkey.
    await press("link", "Remove passkey iPhone");
    expect(await p.locator("#confirm-title").textContent()).toContain("Remove iPhone?");
    await press("link", "Cancel");
    expect(state.keys).toHaveLength(2);
    // Remove it: the page says so and the list is shorter.
    await press("link", "Remove passkey iPhone");
    await press("button", "Remove passkey");
    expect(await p.locator("#account-outcome").textContent()).toContain("Passkey removed.");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("account-outcome");
    expect(state.keys.map((k) => k.id)).toEqual(["k1"]);
    // One session, then the rest.
    await press("link", "Sign out Safari on iPhone, last active Yesterday");
    await press("button", "Sign out session");
    expect(await p.locator("#account-outcome").textContent()).toContain("That session was signed out.");
    expect(state.others).toHaveLength(0);
    await ctx.close();
  });

  it("offers the export, steps a stale session up, and cancels and completes closure by keyboard (D07 T02 s26)", async () => {
    for (const width of [360, 1280]) {
      state.closed = false;
      const ctx = await context(width);
      const p = await ctx.newPage();
      const press = async (role: "link" | "button", name: string) => {
        const target = p.getByRole(role, { name, exact: true });
        let reached = false;
        for (let i = 0; i < 90 && !reached; i++) {
          await p.keyboard.press("Tab");
          reached = await target.evaluate((el) => el === document.activeElement);
        }
        expect(reached, name).toBe(true);
        await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
      };
      // Stale: the confirmation asks for a fresh sign-in and returns to the same organisation.
      await p.goto(`${origin}/settings/account/close?stale=1`, { waitUntil: "load" });
      expect(await p.locator("#confirm-title").textContent()).toContain("Sign in again to close Karoo Couriers");
      expect(await p.getByRole("link", { name: "Download the case summaries first", exact: true }).count()).toBe(0);
      await press("button", "Sign in again");
      expect(p.url()).toContain("/signin");
      expect(decodeURIComponent(p.url())).toContain(`next=/settings/account/close?org=${ORG.id}`);
      expect(state.closed).toBe(false);
      // Fresh: the export is offered first, at both themes; Cancel closes nothing.
      await p.goto(`${origin}/settings/account/close`, { waitUntil: "load" });
      await p.addScriptTag({ path: AXE });
      for (const theme of ["light", "dark"] as const) {
        await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(await p.evaluate(() => document.documentElement.scrollWidth), theme).toBeLessThanOrEqual(width);
        expect(problems(await scan(p)), theme).toEqual([]);
      }
      const download = p.waitForEvent("download");
      await p.getByRole("link", { name: "Download the case summaries first", exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("cases-org-karoo.csv");
      await press("link", "Cancel");
      expect(state.closed).toBe(false);
      // Complete it by keyboard: the account page reads the closure back.
      await p.goto(`${origin}/settings/account/close`, { waitUntil: "load" });
      await press("button", "Close account");
      expect(await p.locator("#account-outcome").textContent()).toContain("Your organisation is closed.");
      expect(state.closed).toBe(true);
      await ctx.close();
    }
  });

  it("signs every other session out by keyboard, the confirmation's heading focused, and works without JavaScript", async () => {
    for (const js of [true, false]) {
      state.keys = passkeys();
      state.others = sessions().slice(1);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: js });
      const p = await ctx.newPage();
      await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
      const bulk = p.getByRole("link", { name: "Sign out other sessions", exact: true });
      let reached = false;
      for (let i = 0; i < 90 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await bulk.evaluate((el) => el === document.activeElement);
      }
      expect(reached, `js ${js}`).toBe(true);
      await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
      // The confirmation's heading takes focus when it opens (with the app script), so what it says is read first.
      if (js) expect(await p.evaluate(() => document.activeElement?.id)).toBe("confirm-title");
      await Promise.all([
        p.waitForNavigation(),
        p.getByRole("button", { name: "Sign out other sessions", exact: true }).click(),
      ]);
      expect(await p.locator("#account-outcome").textContent()).toContain("Every other session was signed out.");
      expect(state.others).toHaveLength(0);
      // Nothing left to sign out: the bulk action is gone, and the empty state says why.
      expect(await p.getByRole("link", { name: "Sign out other sessions", exact: true }).count()).toBe(0);
      expect(await p.getByText("This is your only session.").count()).toBe(1);
      await ctx.close();
    }
  });

  it("removes both passkeys and signs one session out without JavaScript, ending on the empty state", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    for (const name of ["Remove passkey Windows Hello on the office PC", "Remove passkey iPhone"]) {
      await Promise.all([p.waitForNavigation(), p.getByRole("link", { name, exact: true }).click()]);
      await Promise.all([
        p.waitForNavigation(),
        p.getByRole("button", { name: "Remove passkey", exact: true }).click(),
      ]);
      expect(await p.locator("#account-outcome").textContent()).toContain("Passkey removed.");
    }
    expect(state.keys).toHaveLength(0);
    expect(await p.getByText("No passkeys yet. You sign in with an email link.").count()).toBe(1);
    await Promise.all([p.waitForNavigation(), p.getByRole("link", { name: /^Sign out Safari on iPhone/ }).click()]);
    await Promise.all([
      p.waitForNavigation(),
      p.getByRole("button", { name: "Sign out session", exact: true }).click(),
    ]);
    expect(await p.locator("#account-outcome").textContent()).toContain("That session was signed out.");
    expect(await p.getByText("This is your only session.").count()).toBe(1);
    await ctx.close();
  });

  it("renames a passkey by keyboard from its row, the naming page's heading focused, Cancel keeping the name", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account`, { waitUntil: "load" });
    const press = async (role: "link" | "button", name: string) => {
      const target = p.getByRole(role, { name, exact: true });
      let reached = false;
      for (let i = 0; i < 90 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await target.evaluate((el) => el === document.activeElement);
      }
      expect(reached, name).toBe(true);
      await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
    };
    await press("link", "Rename passkey iPhone");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("rename-title");
    await press("link", "Cancel");
    expect(state.keys.find((k) => k.name === "iPhone")).toBeDefined();
    await press("link", "Rename passkey iPhone");
    await p.getByLabel("Passkey name").fill("Phone");
    await Promise.all([p.waitForNavigation(), p.keyboard.press("Enter")]);
    expect(await p.locator("#account-outcome").textContent()).toContain("Passkey renamed.");
    expect(state.keys.map((k) => k.name)).toContain("Phone");
    await ctx.close();
  });

  it("puts focus on the name field when the naming page refuses a name, and on the heading when it opens", async () => {
    const ctx = await context(1280);
    const p = await ctx.newPage();
    await p.goto(`${origin}/settings/account/passkeys/k1/rename?bad=1`, { waitUntil: "load" });
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("passkey-name");
    await p.goto(`${origin}/settings/account/passkeys/k1/rename`, { waitUntil: "load" });
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("rename-title");
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
      // The failure states, with the same rules.
      for (const r of [
        "passkey-still",
        "session-still",
        "others-none",
        "partial",
        "unresolved",
        "gone",
        "this-device",
      ]) {
        const p = await ctx.newPage();
        await p.goto(`${origin}/settings/account?r=${r}`, { waitUntil: "load" });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(problems(await scan(p)), `${theme} ${r}`).toEqual([]);
        }
        await p.close();
      }
      // The add whose answer was lost, read back, with the same rules.
      for (const rec of ["added", "none"]) {
        const p = await ctx.newPage();
        await p.goto(`${origin}/settings/account?reconcile=${rec}`, { waitUntil: "load" });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(problems(await scan(p)), `${theme} reconcile ${rec}`).toEqual([]);
        }
        await p.close();
      }
      // The naming page, added and renamed and with its refusal, with the same rules.
      for (const path of [
        "/settings/account/passkeys/k1/rename",
        "/settings/account/passkeys/k1/rename?added=1",
        "/settings/account/passkeys/k1/rename?bad=1",
      ]) {
        const p = await ctx.newPage();
        await p.goto(`${origin}${path}`, { waitUntil: "load" });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${path}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${theme} ${path}`).toEqual([]);
        }
        await p.close();
      }
      // The confirmation pages, with the same rules.
      state.mode = "full";
      for (const path of [
        "/settings/account/passkeys/k2/remove",
        "/settings/account/sessions/s2/sign-out",
        "/settings/account/sessions/sign-out-others",
      ]) {
        const p = await ctx.newPage();
        await p.goto(`${origin}${path}`, { waitUntil: "load" });
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${theme} ${path}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${theme} ${path}`).toEqual([]);
        }
        await p.close();
      }
      await ctx.close();
    });
  }
});
