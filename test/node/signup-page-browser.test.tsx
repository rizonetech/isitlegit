import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { InboxPage, pageResponse, retryIn } from "../../src/auth/confirm-page.tsx";
import { Document } from "../../src/web/components/Document.tsx";
import { SignupNotConfirmedPage, SignupPage, type SignupValues } from "../../src/web/pages/signup.tsx";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The signup page in Chromium (D07 T02 §13), served over HTTP by this process with the shipped app script; its posts
// answered here with the shapes the Worker's routes draw (their own answers are test/web/signup-page.test.ts). It
// proves Create account held until consent and sent once, the page working with JavaScript off through to the first
// code, a keyboard-only journey that corrects a refused field with the other values kept, and every state passing the
// accessibility gate's rules at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const UNUSABLE =
  "We do not recognise that code, or it has been used up or has expired. Ask whoever gave it to you for a new one.";

const state = { delayMs: 0, posts: [] as { path: string; body: Record<string, string> }[] };
afterEach(() => Object.assign(state, { delayMs: 0, posts: [] }));

const pages: Record<string, () => unknown> = {
  "/signup": () => SignupPage({}),
  "/signup/refused": () =>
    SignupPage({
      values: {
        invite: "OLD",
        email: "thandi@karoocouriers.example",
        organizationName: "Karoo Couriers",
        consent: true,
      },
      errors: { invite: UNUSABLE },
    }),
  "/signup/limited": () =>
    SignupPage({
      values: {
        invite: "WELCOME",
        email: "thandi@karoocouriers.example",
        organizationName: "Karoo Couriers",
        consent: true,
      },
      problem: { text: "Too many signups from here.", retry: retryIn(5) },
    }),
  "/signup/inbox": () => InboxPage({ email: "thandi@karoocouriers.example", callbackURL: "/cases" }),
  "/signup/not-confirmed": () => SignupNotConfirmedPage({ email: "thandi@karoocouriers.example" }),
};

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}
const send = async (res: import("node:http").ServerResponse, rendered: Response, status = 200) => {
  res.writeHead(status, Object.fromEntries(rendered.headers));
  res.end(await rendered.text());
};

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") {
      const fields = await body(req);
      state.posts.push({ path: url.pathname, body: fields });
      await new Promise((done) => setTimeout(done, state.delayMs));
      if (url.pathname === "/signup") {
        const values: SignupValues = {
          invite: fields.invite ?? "",
          email: fields.email ?? "",
          organizationName: fields.organizationName ?? "",
          consent: fields.consent === "yes",
        };
        if (!values.consent)
          return send(
            res,
            await pageResponse(
              SignupPage({ values, errors: { consent: "Tick the box to agree before creating your account." } }),
            ),
            400,
          );
        if (values.invite === "OLD")
          return send(res, await pageResponse(SignupPage({ values, errors: { invite: UNUSABLE } })), 400);
        return send(res, await pageResponse(InboxPage({ email: values.email ?? "", callbackURL: "/cases" })), 201);
      }
      res.writeHead(303, { location: fields.callbackURL ?? "/cases" });
      return res.end();
    }
    const page = pages[url.pathname];
    if (url.pathname === "/signup" && url.searchParams.has("code"))
      return send(res, await pageResponse(SignupPage({ values: { invite: url.searchParams.get("code") ?? "" } })));
    if (page) return send(res, await pageResponse(page()));
    if (url.pathname === "/cases") {
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
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

async function open(path: string, options: { width?: number; js?: boolean } = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const p: Page = await context.newPage();
  await p.goto(`${origin}${path}`, { waitUntil: "load" });
  return { p, context };
}
const fill = async (p: Page, invite = "WELCOME") => {
  await p.getByLabel("Invite code").fill(invite);
  await p.getByLabel("Work email").fill("thandi@karoocouriers.example");
  await p.getByLabel("Organisation name").fill("Karoo Couriers");
};

describe.skipIf(!chromiumPath() && !process.env.CI)("the signup page in Chromium", { timeout: 120_000 }, () => {
  it("holds Create account until consent is ticked, and sends it once for two presses", async () => {
    state.delayMs = 1200;
    const { p, context } = await open("/signup");
    await fill(p);
    const create = p.getByRole("button", { name: "Create account" });
    expect(await create.isDisabled()).toBe(true);
    await p.getByLabel("I agree to IsItLegit processing mail I forward").check();
    expect(await create.isEnabled()).toBe(true);
    await p.getByLabel("I agree to IsItLegit processing mail I forward").uncheck();
    expect(await create.isDisabled()).toBe(true);
    await p.getByLabel("I agree to IsItLegit processing mail I forward").check();
    await p.evaluate(() =>
      document.addEventListener("submit", (event) =>
        setTimeout(() => (event.target as HTMLFormElement).requestSubmit(), 100),
      ),
    );
    await create.click({ noWaitAfter: true });
    await p.waitForURL(`${origin}/signup`, { waitUntil: "load" });
    await expect.poll(() => p.getByRole("heading", { name: "Check your inbox" }).isVisible()).toBe(true);
    expect(state.posts.filter((x) => x.path === "/signup")).toHaveLength(1);
    await context.close();
  });

  it("keeps Create account held when a retry's time comes with consent unticked", async () => {
    const { p, context } = await open("/signup/limited");
    const create = p.getByRole("button", { name: /^Create account/ });
    expect(await create.isDisabled()).toBe(true);
    await p.getByLabel("I agree to IsItLegit processing mail I forward").uncheck();
    await p.waitForTimeout(6000);
    expect(await create.isDisabled()).toBe(true);
    await p.getByLabel("I agree to IsItLegit processing mail I forward").check();
    expect(await create.isEnabled()).toBe(true);
    await context.close();
  });

  it("takes a shared invite code into the form and out of the address", async () => {
    const { p, context } = await open("/signup?code=GARDEN-ROUTE-24");
    expect(await p.getByLabel("Invite code").inputValue()).toBe("GARDEN-ROUTE-24");
    expect(p.url()).toBe(`${origin}/signup`);
    await context.close();
  });

  it("works with JavaScript off, through to the first code", async () => {
    const { p, context } = await open("/signup", { js: false });
    await fill(p);
    // Nothing holds the button without script; the box's own `required` stops a form without consent before it is
    // sent (and the server refuses one that gets through, test/web/signup-page.test.ts).
    await p.getByRole("button", { name: "Create account" }).click();
    expect(
      await p
        .getByLabel("I agree to IsItLegit processing mail I forward")
        .evaluate((box) => (box as HTMLInputElement).validity.valueMissing),
    ).toBe(true);
    expect(state.posts).toEqual([]);
    await p.getByLabel("I agree to IsItLegit processing mail I forward").check();
    await p.getByRole("button", { name: "Create account" }).click();
    await expect.poll(() => p.getByRole("heading", { name: "Check your inbox" }).isVisible()).toBe(true);
    await p.getByLabel("Code from the email").fill("123 456");
    await p.getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => p.getByRole("heading", { name: "Cases page" }).isVisible()).toBe(true);
    expect(state.posts.map((x) => x.path)).toEqual(["/signup", "/signin/code"]);
    await context.close();
  });

  it("goes by keyboard alone: a refused code tied to its field, corrected, the other values kept", async () => {
    const { p, context } = await open("/signup");
    const focus = async (label: string) => {
      for (let i = 0; i < 20; i++) {
        const id = await p.evaluate(() => document.activeElement?.id ?? "");
        const name = id
          ? await p.evaluate((i) => document.querySelector(`label[for="${i}"]`)?.textContent ?? "", id)
          : "";
        if (name.trim() === label) return;
        await p.keyboard.press("Tab");
      }
      throw new Error(`never reached ${label}`);
    };
    await focus("Invite code");
    await p.keyboard.type("OLD");
    await p.keyboard.press("Tab");
    await p.keyboard.type("thandi@karoocouriers.example");
    await p.keyboard.press("Tab");
    await p.keyboard.type("Karoo Couriers");
    // On to the box (past the notice's link), ticked with Space, then Create account with Enter.
    for (let i = 0; i < 5 && (await p.evaluate(() => document.activeElement?.id)) !== "signup-consent"; i++)
      await p.keyboard.press("Tab");
    await p.keyboard.press("Space");
    await p.keyboard.press("Tab");
    await p.keyboard.press("Enter");
    await p.waitForLoadState("load");
    const invite = p.getByLabel("Invite code");
    await expect.poll(() => invite.getAttribute("aria-invalid")).toBe("true");
    const described = (await invite.getAttribute("aria-describedby")) ?? "";
    expect(
      await p.evaluate(
        (ids) =>
          ids
            .split(" ")
            .map((id) => document.getElementById(id)?.textContent)
            .join(" "),
        described,
      ),
    ).toContain("We do not recognise that code");
    expect(await p.getByLabel("Work email").inputValue()).toBe("thandi@karoocouriers.example");
    expect(await p.getByLabel("Organisation name").inputValue()).toBe("Karoo Couriers");
    expect(await p.getByLabel("I agree to IsItLegit processing mail I forward").isChecked()).toBe(true);
    await focus("Invite code");
    await p.keyboard.press("ControlOrMeta+A");
    await p.keyboard.type("WELCOME");
    await p.keyboard.press("Enter");
    await expect.poll(() => p.getByRole("heading", { name: "Check your inbox" }).isVisible()).toBe(true);
    expect(state.posts.at(-1)?.body).toMatchObject({
      invite: "WELCOME",
      email: "thandi@karoocouriers.example",
      organizationName: "Karoo Couriers",
      consent: "yes",
    });
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules in every state (${theme}, ${width} px)`, async () => {
        for (const path of Object.keys(pages)) {
          const { p, context } = await open(path, { width });
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), path).toEqual([]);
          await context.close();
        }
      });
});
