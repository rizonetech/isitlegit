import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppShell } from "../../src/web/components/AppShell";
import { Document } from "../../src/web/components/Document";
import { chromiumPath, launch, openPage } from "./browser";
import { admin, member } from "./shell-fixtures";

// The frames at phone and desktop width in Chromium, with the shipped stylesheet (D07 T01 §3, `Report-Mobile`): no
// horizontal overflow; below `md` the member and admin sidebars hide behind Menu, which opens them as a popover with no
// script and closes on Esc; at desktop width the sidebar sits in the page at its token width and Menu is gone.
const FRAMES = {
  member: String(
    <Document title="Cases">
      <AppShell {...member()} />
    </Document>,
  ),
  admin: String(
    <Document title="Overview">
      <AppShell {...admin()} />
    </Document>,
  ),
  public: String(
    <Document title="Report">
      <AppShell variant="public">
        <h1>Statement request</h1>
      </AppShell>
    </Document>,
  ),
};
let browser: Browser;

beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const open = (frame: keyof typeof FRAMES, width: number) =>
  openPage(browser, FRAMES[frame], { viewport: { width, height: 800 }, javaScriptEnabled: false });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shown = (page: Page, selector: string) => page.locator(selector).first().isVisible();

describe.skipIf(!chromiumPath() && !process.env.CI)("frames at phone and desktop width", () => {
  for (const frame of ["member", "admin"] as const) {
    it(`${frame}: the sidebar hides behind Menu at 360 px, opens without a script and closes on Esc`, async () => {
      const page = await open(frame, 360);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await shown(page, "#nav")).toBe(false);
      expect(await shown(page, 'button[aria-label="Menu"]')).toBe(true);
      await page.click('button[aria-label="Menu"]');
      expect(await shown(page, "#nav")).toBe(true);
      const first = frame === "member" ? "Cases" : "Overview";
      expect(await page.locator("#nav a", { hasText: first }).first().isVisible()).toBe(true);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
      expect(await shown(page, "#nav")).toBe(false);
      await page.context().close();
    });

    it(`${frame}: the sidebar sits in the page at 1280 px, 256 px wide, with no Menu`, async () => {
      const page = await open(frame, 1280);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await shown(page, "#nav")).toBe(true);
      expect(await shown(page, 'button[aria-label="Menu"]')).toBe(false);
      const nav = await page.locator("#nav").boundingBox();
      expect(nav?.width).toBe(256);
      expect(nav?.x).toBe(0);
      const main = await page.locator("main").boundingBox();
      expect(main?.x).toBeGreaterThanOrEqual(256);
      await page.context().close();
    });
  }

  it("member: the sidebar's footer and user block stay inside it at 1280 px, and its logos load", async () => {
    const page = await open("member", 1280);
    const nav = await page.locator("#nav").boundingBox();
    for (const text of ["check@isitlegit.co.za", "Thandi Nkosi", "Sign out"]) {
      const box = await page.getByText(text, { exact: true }).boundingBox();
      expect(box && nav && box.x + box.width <= nav.x + nav.width, text).toBe(true);
    }
    const broken = await page.evaluate(
      () => [...document.images].filter((img) => !img.complete || !img.naturalWidth).length,
    );
    expect(broken).toBe(0);
    await page.context().close();
  });

  for (const width of [360, 1280])
    it(`public: the header and content fit at ${width} px, with no menu and no navigation`, async () => {
      const page = await open("public", width);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await page.locator("nav, [popovertarget]").count()).toBe(0);
      expect(await shown(page, "text=link valid for 7 days")).toBe(true);
      await page.context().close();
    });
});
