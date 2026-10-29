import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfirmPage, pageResponse } from "../../src/auth/confirm-page.tsx";
import { chromiumPath, launch } from "./browser";

// The confirm page in a real browser (D07 T02 §10): the form, submitted by clicking its button with nothing injected,
// sends the page's own origin, which the POST's origin check requires. A page served `Referrer-Policy: no-referrer`
// would send `Origin: null` and every member would be refused. Also the page at phone width and by keyboard.
const APP = "http://app.test";
let browser: Browser;

beforeAll(async () => {
  browser = await launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// The page as the confirm route answers it (its own document and headers), served to the browser; the form's POST is
// captured and answered with a plain page, so the navigation it starts completes.
async function open(viewport = { width: 1280, height: 800 }, rewrite: (headers: Headers) => void = () => {}) {
  const shown = await pageResponse(ConfirmPage({ token: "tok-123", callbackURL: "/cases/42" }));
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
    if (new URL(request.url()).pathname === "/signin/confirm")
      return route.fulfill({ status: shown.status, headers: Object.fromEntries(headers), body: html });
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
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Sign in to IsItLegit");
    await page.keyboard.press("Enter");
    await expect.poll(() => posts.length).toBe(1);
    await context.close();
  });
});
