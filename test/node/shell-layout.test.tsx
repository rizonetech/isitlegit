import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CSS, LOGO, LOGO_MARK, LOGO_MARK_ON_DARK, LOGO_ON_DARK } from "../../src/web/assets";
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
// Real names run long, some with one long compound word: none may push the sidebar wider or scroll it sideways.
const LONG = "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd";
const LONG_PERSON = "Nomvuyiswa Thandekile Mahlangu-Vanderbijlpark";
const LONG_FRAMES = {
  member: String(
    <Document title="Cases">
      <AppShell
        {...member({
          organization: { id: "org-long", name: LONG },
          otherOrganizations: [{ id: "org-longer", name: `${LONG} Holdings Incorporated` }],
          user: { name: LONG_PERSON, role: "Owner" },
        })}
      />
    </Document>,
  ),
  single: String(
    <Document title="Cases">
      <AppShell {...member({ organization: { id: "org-long", name: LONG }, otherOrganizations: [] })} />
    </Document>,
  ),
  admin: String(
    <Document title="Overview">
      <AppShell {...admin({ operator: LONG_PERSON })} />
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

  for (const frame of ["member", "admin"] as const)
    it(`${frame}: a menu left open while the window widens past md sits beside the content`, async () => {
      const page = await open(frame, 360);
      await page.click('button[aria-label="Menu"]');
      await page.setViewportSize({ width: 1280, height: 800 });
      const nav = await page.locator("#nav").boundingBox();
      const main = await page.locator("main").boundingBox();
      expect(nav).toMatchObject({ x: 0, y: 0, width: 256, height: 800 });
      expect(main?.x).toBeGreaterThanOrEqual(256);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // The skip link, focused, is shown above the open sidebar (the top layer paints over any z-index).
      await page.focus('a[href="#content"]');
      const covered = await page.evaluate(() => {
        const skip = document.querySelector('a[href="#content"]') as HTMLElement;
        const box = skip.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) !== skip;
      });
      expect(covered).toBe(false);
      // The backdrop is clear from md: nothing dims the content beside the sidebar.
      const dim = await page.evaluate(
        () => getComputedStyle(document.getElementById("nav") as Element, "::backdrop").backgroundColor,
      );
      expect(dim).toBe("rgba(0, 0, 0, 0)");
      await page.context().close();
    });

  // A browser without the Popover API, emulated: no `popover` attribute (nothing hides the sidebar by itself) and the
  // stylesheet's `@supports not selector(:popover-open)` rules in force.
  async function withoutPopover(html: string, width: number): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    const css = readFileSync(join(import.meta.dirname, "../../public", APP_CSS), "utf-8");
    expect(css).toContain("@supports not selector(:popover-open)");
    await page.route("http://app.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/")
        return route.fulfill({ contentType: "text/html", body: html.replaceAll(' popover="auto"', "") });
      if (path === APP_CSS)
        return route.fulfill({
          contentType: "text/css",
          body: css.replaceAll("@supports not selector(:popover-open)", "@supports selector(*)"),
        });
      return route.fulfill({ status: 404 });
    });
    await page.goto("http://app.test/");
    return page;
  }

  for (const frame of ["member", "admin"] as const)
    it(`${frame}: without the Popover API the sidebar is a block above the content at 360 px, and beside it at 1280 px`, async () => {
      const phone = await withoutPopover(FRAMES[frame], 360);
      expect(await shown(phone, 'button[aria-label="Menu"]')).toBe(false);
      const nav = await phone.locator("#nav").boundingBox();
      const header = await phone.locator("header").boundingBox();
      const main = await phone.locator("main").boundingBox();
      expect(nav?.width).toBe(360);
      expect(nav && header && nav.y >= header.y + header.height).toBe(true);
      expect(nav && main && main.y >= nav.y + nav.height).toBe(true);
      expect(await overflow(phone)).toBeLessThanOrEqual(0);
      await phone.context().close();
      const desktop = await withoutPopover(FRAMES[frame], 1280);
      expect(await desktop.locator("#nav").boundingBox()).toMatchObject({ x: 0, width: 256 });
      expect((await desktop.locator("main").boundingBox())?.x).toBeGreaterThanOrEqual(256);
      await desktop.context().close();
    });

  it("member: the sidebar stays in place while a long page scrolls at 1280 px", async () => {
    const tall = String(
      <Document title="Cases">
        <AppShell {...member({}, <div style="height: 3000px">Cases</div>)} />
      </Document>,
    );
    const page = await openPage(browser, tall, { viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
    // Scroll the page itself: a wheel at the pointer's resting place (0, 0) lands on the sidebar's own scroll region.
    await page.evaluate(() => window.scrollTo(0, 1500));
    expect(await page.evaluate(() => window.scrollY)).toBe(1500);
    expect((await page.locator("#nav").boundingBox())?.y).toBe(0);
    expect(await page.getByText("Sign out", { exact: true }).isVisible()).toBe(true);
    await page.context().close();
  });

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

  for (const [name, html] of Object.entries(LONG_FRAMES))
    for (const width of [360, 1280])
      it(`${name}: long organisation and person names wrap inside the sidebar at ${width} px`, async () => {
        const page = await openPage(browser, html, { viewport: { width, height: 900 }, javaScriptEnabled: false });
        if (width === 360) await page.click('button[aria-label="Menu"]');
        if (name === "member") await page.click("summary");
        const spill = await page.evaluate(() => {
          const nav = document.getElementById("nav") as HTMLElement;
          const edge = nav.getBoundingClientRect().right;
          const out = [...nav.querySelectorAll("*")].filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.right > edge + 0.5;
          });
          return {
            width: nav.getBoundingClientRect().width,
            scroll: nav.scrollWidth - nav.clientWidth,
            out: out.length,
          };
        });
        expect(spill).toEqual({ width: 256, scroll: 0, out: 0 });
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        if (name === "member") {
          expect(await page.locator("summary").getAttribute("aria-label")).toBe(`Switch organisation, current ${LONG}`);
          expect(await page.getByRole("button", { name: `${LONG} Holdings Incorporated` }).isVisible()).toBe(true);
        }
        await page.context().close();
      });

  for (const colorScheme of ["light", "dark"] as const)
    it(`shows the ${colorScheme} theme's brand artwork in every frame`, async () => {
      const [logo, mark] = colorScheme === "light" ? [LOGO, LOGO_MARK] : [LOGO_ON_DARK, LOGO_MARK_ON_DARK];
      const shownSrc = (page: Page) =>
        page.evaluate(() =>
          [...document.images]
            .filter((img) => img.getBoundingClientRect().width > 0)
            .map((img) => new URL(img.src).pathname),
        );
      for (const frame of ["member", "public"] as const) {
        const desktop = await openPage(browser, FRAMES[frame], { viewport: { width: 1280, height: 900 }, colorScheme });
        expect(await shownSrc(desktop), frame).toEqual([logo]);
        await desktop.context().close();
      }
      const phone = await openPage(browser, FRAMES.member, { viewport: { width: 360, height: 800 }, colorScheme });
      expect(await shownSrc(phone)).toEqual([mark]);
      await phone.context().close();
      const adminPage = await openPage(browser, FRAMES.admin, { viewport: { width: 1280, height: 900 }, colorScheme });
      expect(await shownSrc(adminPage)).toEqual([LOGO_ON_DARK]);
      await adminPage.context().close();
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
