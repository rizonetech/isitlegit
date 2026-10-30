import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfirmPage, LinkRequestPage, pageResponse } from "../../src/auth/confirm-page.tsx";
import { chromiumPath, launch } from "./browser";

// The confirm page in a real browser (D07 T02 §10): the form, submitted by clicking its button with nothing injected,
// sends the page's own origin, which the POST's origin check requires. A page served `Referrer-Policy: no-referrer`
// would send `Origin: null` and every member would be refused. Also the page at phone width and by keyboard.
const APP = "http://app.test";
const PUBLIC = join(import.meta.dirname, "../../public");
let browser: Browser;

beforeAll(async () => {
  browser = await launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// The page as the confirm route answers it (its own document and headers), served to the browser; the form's POST is
// captured and answered with a plain page, so the navigation it starts completes.
async function open(
  viewport = { width: 1280, height: 800 },
  rewrite: (headers: Headers) => void = () => {},
  render: () => unknown = () => ConfirmPage({ token: "tok-123", callbackURL: "/cases/42" }),
) {
  const shown = await pageResponse(render());
  const headers = new Headers(shown.headers);
  rewrite(headers);
  const html = await shown.text();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const posts: { origin: string | undefined; body: string }[] = [];
  await page.route(`${APP}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posts.push({ origin: (await request.allHeaders()).origin, body: request.postData() ?? "" });
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>posted</title>" });
    }
    const path = new URL(request.url()).pathname;
    if (path === "/signin/confirm")
      return route.fulfill({ status: shown.status, headers: Object.fromEntries(headers), body: html });
    // The shipped stylesheet and fonts, as the Worker serves them, so the page is checked as members see it.
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${APP}/signin/confirm?token=tok-123&callbackURL=%2Fcases%2F42`);
  return { page, posts, context };
}

describe.skipIf(!chromiumPath())("the confirm page in Chromium", () => {
  it("submits the token and return path with the page's own origin when the button is clicked", async () => {
    const { page, posts, context } = await open();
    await page.getByRole("button", { name: "Sign in to IsItLegit" }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]?.origin).toBe(APP);
    expect(new URLSearchParams(posts[0]?.body)).toEqual(
      new URLSearchParams({ token: "tok-123", callbackURL: "/cases/42" }),
    );
    await context.close();
  });

  it("would be refused under no-referrer: the browser sends Origin: null", async () => {
    const { page, posts, context } = await open(undefined, (headers) => headers.set("referrer-policy", "no-referrer"));
    await page.getByRole("button", { name: "Sign in to IsItLegit" }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]?.origin).toBe("null");
    await context.close();
  });

  it("fits a 375 px phone and is reached and pressed by keyboard", async () => {
    const { page, posts, context } = await open({ width: 375, height: 700 });
    // Styled as shipped: the stylesheet loaded and its fonts in use.
    expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Exo 2");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
    // A1's frame: the logo's home link first, then the page's own button (D07 T02 §7).
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("https://isitlegit.co.za");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Sign in to IsItLegit");
    await page.keyboard.press("Enter");
    await expect.poll(() => posts.length).toBe(1);
    await context.close();
  });

  it("draws the recovery form at 375 px, its Email field labelled and reached by keyboard before its button", async () => {
    const { page, posts, context } = await open({ width: 375, height: 700 }, undefined, () =>
      LinkRequestPage({ callbackURL: "/cases/42", email: "member@example.org" }),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const email = page.getByRole("textbox", { name: "Email" });
    expect(await email.inputValue()).toBe("member@example.org");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("https://isitlegit.co.za");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name)).toBe("email");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Email me a new link");
    await page.keyboard.press("Enter");
    await expect.poll(() => posts.length).toBe(1);
    expect(new URLSearchParams(posts[0]?.body).get("email")).toBe("member@example.org");
    expect(posts[0]?.origin).toBe(APP);
    await context.close();
  });
});
