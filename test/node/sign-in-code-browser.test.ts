import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InboxPage, LinkRequestPage, pageResponse } from "../../src/auth/confirm-page.tsx";
import { CODE_COOKIE, handleCookie, newHandle, normaliseCode } from "../../src/auth/signin-code.ts";
import { chromiumPath, launch } from "./browser";

// The sign-in code in a real browser (D07 T02 §11): the browser keeps the handle cookie the link request sets and sends
// it with the code form, the code is typed as the mail shows it and submitted from the keyboard, a refusal's message is
// the field's description, and the page fits a phone. The pages and the cookie are the real ones; the two POSTs are
// answered here by the server's rule (the Worker's own redemption, with D1 and the mail, is test/auth/sign-in-code.test.ts),
// because the Worker tests' stubbed mail is not reachable from this browser.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
const CODE = "012345";
let browser: Browser;

beforeAll(async () => {
  browser = await launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type Post = { path: string; cookie: string; body: URLSearchParams; origin: string | undefined };

// A browser on the app: the request form at /signin/start; POST /signin/link answers with the inbox page and the handle
// cookie as the Worker sets it; POST /signin/code signs in when the cookie is that handle and the code is right, and
// otherwise answers with the inbox page's refusal.
async function open(viewport = { width: 1280, height: 800 }, context?: BrowserContext) {
  const handle = newHandle();
  const ctx = context ?? (await browser.newContext({ viewport }));
  const page = await ctx.newPage();
  const posts: Post[] = [];
  const html = async (body: unknown, status = 200, headers: Record<string, string> = {}) => {
    const shown = await pageResponse(body, status);
    return { status, headers: { ...Object.fromEntries(shown.headers), ...headers }, body: await shown.text() };
  };
  await page.route(`${APP}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const all = await request.allHeaders();
      const body = new URLSearchParams(request.postData() ?? "");
      posts.push({ path, cookie: all.cookie ?? "", body, origin: all.origin });
      const email = body.get("email") ?? "";
      const callbackURL = body.get("callbackURL") ?? "/cases";
      if (path === "/signin/link")
        return route.fulfill(
          await html(InboxPage({ email, callbackURL }), 200, { "set-cookie": handleCookie(handle) }),
        );
      if (path === "/signin/code") {
        const held = (all.cookie ?? "").includes(`${CODE_COOKIE}=${handle}`);
        if (held && normaliseCode(body.get("code")) === CODE)
          return route.fulfill({ status: 303, headers: { location: `${APP}${callbackURL}` } });
        return route.fulfill(
          await html(
            InboxPage({
              email,
              callbackURL,
              codeError: held
                ? "That code is not right. 2 tries left."
                : "This code works only in the browser where you asked for the link, while the link is new. Send another link from here.",
            }),
            400,
          ),
        );
      }
    }
    if (path === "/signin/start")
      return route.fulfill(
        await html(LinkRequestPage({ callbackURL: "/cases/12", heading: "Sign in", title: "Sign in" })),
      );
    if (path === "/cases/12")
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Cases</title>" });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${APP}/signin/start`);
  return { page, posts, context: ctx };
}

// Ask for a link on the real form, by keyboard.
async function ask(page: Page) {
  await page.getByRole("textbox", { name: "Email" }).fill("reader@example.org");
  await page.keyboard.press("Enter");
  await page.waitForURL(`${APP}/signin/link`);
}

describe.skipIf(!chromiumPath())("the sign-in code in Chromium", () => {
  it("signs in the browser that asked with the code typed as mailed and Enter, the handle cookie sent along", async () => {
    const { page, posts, context } = await open();
    await ask(page);
    const field = page.getByRole("textbox", { name: "Code from the email" });
    await field.fill("012 345");
    await field.press("Enter");
    await page.waitForURL(`${APP}/cases/12`);
    const sent = posts.find((p) => p.path === "/signin/code");
    expect(sent?.cookie).toContain(`${CODE_COOKIE}=`);
    expect(sent?.body.get("code")).toBe("012 345");
    expect(sent?.body.get("email")).toBe("reader@example.org");
    expect(sent?.body.get("callbackURL")).toBe("/cases/12");
    expect(sent?.origin).toBe(APP);
    // The cookie is HttpOnly: the page's script cannot read it.
    expect(await page.evaluate(() => document.cookie)).not.toContain(CODE_COOKIE);
    await context.close();
  });

  it("refuses the code in a browser that did not ask: no cookie goes with it", async () => {
    const laptop = await open();
    await ask(laptop.page);
    await laptop.context.close();
    const phone = await browser.newContext();
    const page = await phone.newPage();
    const posts: Post[] = [];
    await page.route(`${APP}/**`, async (route) => {
      const request = route.request();
      posts.push({
        path: new URL(request.url()).pathname,
        cookie: (await request.allHeaders()).cookie ?? "",
        body: new URLSearchParams(request.postData() ?? ""),
        origin: undefined,
      });
      const shown = await pageResponse(InboxPage({ email: "reader@example.org", callbackURL: "/cases/12" }));
      return route.fulfill({ status: 200, headers: Object.fromEntries(shown.headers), body: await shown.text() });
    });
    await page.goto(`${APP}/signin/link`);
    await page.getByRole("textbox", { name: "Code from the email" }).fill(CODE);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => posts.filter((p) => p.path === "/signin/code").length).toBe(1);
    expect(posts.find((p) => p.path === "/signin/code")?.cookie).not.toContain(CODE_COOKIE);
    await phone.close();
  });

  it("ties a refusal's message to the field, keeps the field focused for the next try, and fits a 360 px phone", async () => {
    const { page, context } = await open({ width: 360, height: 740 });
    await ask(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const field = page.getByRole("textbox", { name: "Code from the email" });
    await field.fill("999 999");
    await field.press("Enter");
    await page.waitForLoadState();
    const refused = page.getByRole("textbox", { name: "Code from the email" });
    expect(await refused.getAttribute("aria-invalid")).toBe("true");
    const description = await refused.evaluate((input) =>
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    expect(description).toContain("That code is not right. 2 tries left.");
    expect(await refused.getAttribute("maxlength")).toBe("7");
    expect(await refused.getAttribute("inputmode")).toBe("numeric");
    expect(await refused.getAttribute("autocomplete")).toBe("one-time-code");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    // Tab from the top reaches the code field first, then its button, then the two recoveries.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name)).toBe("code");
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    expect(order).toEqual(["Sign in", "Send another link", "Use a different email"]);
    await context.close();
  });
});
