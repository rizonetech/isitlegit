import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppShell } from "../../src/web/components/AppShell";
import { Document } from "../../src/web/components/Document";
import { chromiumPath, type Focus, focused, launch, openPage } from "./browser";
import { admin, member } from "./shell-fixtures";

// The frames from the keyboard in Chromium, with JavaScript on and off (D07 T01 §3): Tab reaches the skip link first
// and then every control in visual order, each with a focus ring of 3:1 or more against everything behind it, in both
// themes; the skip link moves focus to the content; Enter and Space open and close the switcher and the phone menu.
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
const ORDER = {
  member: [
    "Skip to content",
    "IsItLegit, cases",
    "Switch organisation, current Karoo Couriers",
    "Check a file",
    "Cases",
    "Suppliers",
    "Protect",
    "Monitor 1 new",
    "Team",
    "Domains and addresses",
    "Account",
    "Plan Trial, 11 days",
    "Copy the check address",
    "Sign out",
  ],
  admin: [
    "Skip to content",
    "IsItLegit admin, overview",
    "Overview",
    "Organisations",
    "Invite codes",
    "Feedback 3 open",
    "Eval runs",
  ],
  public: ["Skip to content", "IsItLegit home"],
};
let browser: Browser;

beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

// Every stop Tab makes until focus leaves the frame for the page content, with its ring.
async function tabStops(page: Page, count: number): Promise<Focus[]> {
  const stops: Focus[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    const focus = await focused(page);
    if (focus) stops.push(focus);
  }
  return stops;
}
const keyOf = (focus: Focus) => focus.key.replace(/\s+/g, " ");

describe.skipIf(!chromiumPath() && !process.env.CI)("frames from the keyboard", () => {
  for (const javaScriptEnabled of [true, false])
    for (const colorScheme of ["light", "dark"] as const)
      for (const frame of ["member", "admin", "public"] as const)
        it(`${frame}, ${colorScheme}, JavaScript ${javaScriptEnabled ? "on" : "off"}: Tab order and focus rings`, async () => {
          const page = await openPage(browser, FRAMES[frame], {
            viewport: { width: 1280, height: 1000 },
            colorScheme,
            javaScriptEnabled,
          });
          const stops = await tabStops(page, ORDER[frame].length);
          expect(stops.map(keyOf)).toEqual(ORDER[frame]);
          for (const stop of stops) {
            expect(stop.outline, stop.key).toMatch(/^solid [1-9]/);
            expect(stop.opaque, stop.key).toBe(true);
            expect(stop.contrast, `${stop.key} focus contrast`).toBeGreaterThanOrEqual(3);
          }
          await page.context().close();
        });

  it("the skip link is shown when focused and moves focus to the content", async () => {
    const page = await openPage(browser, FRAMES.member, {
      viewport: { width: 1280, height: 1000 },
      javaScriptEnabled: false,
    });
    await page.keyboard.press("Tab");
    const box = await page.locator('a[href="#content"]').boundingBox();
    expect(box && box.width > 1 && box.height > 1 && box.y >= 0).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("content");
    await page.context().close();
  });

  it("Enter and Space open and close the organisation switcher, whose forms the keyboard then reaches", async () => {
    const page = await openPage(browser, FRAMES.member, {
      viewport: { width: 1280, height: 1000 },
      javaScriptEnabled: false,
    });
    const open = () => page.evaluate(() => (document.querySelector("details") as HTMLDetailsElement).open);
    await page.focus("summary");
    await page.keyboard.press("Enter");
    expect(await open()).toBe(true);
    await page.keyboard.press("Tab");
    expect(keyOf((await focused(page)) as Focus)).toBe("ST Swartberg Transport");
    await page.focus("summary");
    await page.keyboard.press("Space");
    expect(await open()).toBe(false);
    await page.context().close();
  });

  for (const frame of ["member", "admin"] as const)
    it(`${frame} at 360 px: Enter and Space open and close Menu, Tab enters the opened sidebar, Esc returns`, async () => {
      const page = await openPage(browser, FRAMES[frame], {
        viewport: { width: 360, height: 800 },
        javaScriptEnabled: false,
      });
      const shown = () => page.locator("#nav").isVisible();
      const stops = await tabStops(page, 3);
      expect(stops.map(keyOf)).toEqual([
        "Skip to content",
        frame === "member" ? "IsItLegit, cases" : "IsItLegit admin, overview",
        "Menu",
      ]);
      await page.keyboard.press("Enter");
      expect(await shown()).toBe(true);
      await page.keyboard.press("Space");
      expect(await shown()).toBe(false);
      await page.keyboard.press("Space");
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => !!document.activeElement?.closest("#nav"));
      expect(inside).toBe(true);
      await page.keyboard.press("Escape");
      expect(await shown()).toBe(false);
      await page.context().close();
    });
});
