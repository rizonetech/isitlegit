import { existsSync } from "node:fs";
import { join } from "node:path";
import { raw } from "hono/html";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Document } from "../../src/web/components/Document.tsx";
import {
  anchorOf,
  GALLERY_FRAMES,
  GALLERY_STATES,
  GalleryFrame,
  GalleryPage,
  GalleryState,
} from "../../src/web/dev/gallery.tsx";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// axe-core 4.11.4 over the component gallery and every shell frame in Chromium (D07 T01 §10; `pnpm test:a11y`, its own
// CI step): the WCAG 2.2 A and AA rules, `target-size` included (off by default in 4.11), at 360 px and 1280 px in both
// themes, scanned again with each closed region open (the phone Menu, the organisation switcher, the copy feedback). A
// result axe could not decide fails unless it is listed below with the reason a person checked it.
const APP = "http://localhost";
const ROOT = join(import.meta.dirname, "../..");
const PUBLIC = join(ROOT, "public");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

// A page on the app's origin serving `pages` by path, the gallery's frames and the shipped static files.
async function open(path: string, pages: Record<string, string>, width: number, theme: "light" | "dark") {
  const context: BrowserContext = await browser.newContext({ viewport: { width, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  const p: Page = await context.newPage();
  await p.route(`${APP}/**`, async (route) => {
    const url = new URL(route.request().url()).pathname;
    const own = pages[url];
    if (own) return route.fulfill({ status: 200, contentType: "text/html", body: own });
    const frame = /^\/dev\/components\/frame\/(.+)$/.exec(url)?.[1];
    if (frame) return route.fulfill({ status: 200, contentType: "text/html", body: String(GalleryFrame(frame)) });
    const state = /^\/dev\/components\/state\/(.+)$/.exec(url)?.[1];
    if (state) return route.fulfill({ status: 200, contentType: "text/html", body: String(GalleryState(state)) });
    const file = join(PUBLIC, url);
    if (url.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}${path}`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await p.addScriptTag({ path: AXE });
  return { p, context };
}

const galleryPages = () => ({ "/dev/components": String(<GalleryPage />) });

describe.skipIf(!chromiumPath() && !process.env.CI)("accessibility of the component set", { timeout: 300_000 }, () => {
  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 360])
      it(`passes on the gallery, its copy feedback shown both ways (${theme}, ${width} px)`, async () => {
        const { p, context } = await open("/dev/components", galleryPages(), width, theme);
        expect(problems(await scan(p))).toEqual([]);
        await context.close();
        const copyPage = await open(
          `/dev/components/state/${anchorOf("state", "copy-group")}`,
          galleryPages(),
          width,
          theme,
        );
        const { p: p2, context: context2 } = copyPage;
        const group = p2.locator("main");
        await group.getByRole("button", { name: "Copy the check address" }).click();
        await expect.poll(() => group.locator("[data-copy-status]").textContent()).toBe("Copied");
        expect(await group.locator("[data-copy-status]").isVisible()).toBe(true);
        expect(problems(await scan(p2))).toEqual([]);
        await p2.evaluate(() => {
          navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
        });
        await group.getByRole("button", { name: "Copy the check address" }).click();
        await expect.poll(() => group.locator("[data-copy-status]").textContent()).toContain("Copy failed");
        expect(problems(await scan(p2))).toEqual([]);
        await context2.close();
      });

  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 360])
      it(`passes on every frame, with the Menu and the switcher opened (${theme}, ${width} px)`, async () => {
        const failures: string[] = [];
        for (const frame of GALLERY_FRAMES) {
          const path = `/dev/components/frame/${frame.id}`;
          const { p, context } = await open(path, {}, width, theme);
          failures.push(...problems(await scan(p)).map((x) => `${frame.id}: ${x}`));
          const menu = p.getByRole("button", { name: "Menu" });
          if (width < 768 && (await menu.count())) {
            await menu.click();
            expect(await p.locator("#nav").isVisible(), `${frame.id} menu open`).toBe(true);
            failures.push(...problems(await scan(p)).map((x) => `${frame.id} (menu open): ${x}`));
          }
          // The sidebar's copy feedback, success then refusal, in the frame's own narrow column.
          const copy = p.locator("#nav").getByRole("button", { name: "Copy the check address" });
          if ((await copy.count()) && (await copy.isVisible())) {
            const line = p.locator("#nav [data-copy-status]");
            await copy.click();
            await expect.poll(() => line.textContent()).toBe("Copied");
            expect(await line.isVisible(), `${frame.id} copied shown`).toBe(true);
            failures.push(...problems(await scan(p)).map((x) => `${frame.id} (copied): ${x}`));
            await p.evaluate(() => {
              navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
            });
            await copy.click();
            await expect.poll(() => line.textContent()).toContain("Copy failed");
            expect(await line.isVisible(), `${frame.id} refusal shown`).toBe(true);
            failures.push(...problems(await scan(p)).map((x) => `${frame.id} (copy refused): ${x}`));
          }
          const switcher = p.locator("nav details > summary");
          if ((await switcher.count()) && (await switcher.isVisible())) {
            await switcher.click();
            expect(await p.locator("nav details[open]").count(), `${frame.id} switcher open`).toBe(1);
            failures.push(...problems(await scan(p)).map((x) => `${frame.id} (switcher open): ${x}`));
          }
          await context.close();
        }
        expect(failures).toEqual([]);
      });

  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 360])
      it(`passes on every gallery state (${theme}, ${width} px)`, async () => {
        const failures: string[] = [];
        for (const state of GALLERY_STATES) {
          const path = `/dev/components/state/${anchorOf("state", state.id)}`;
          const { p, context } = await open(path, {}, width, theme);
          if (state.id === "field/focused") {
            await p.focus("#g-focused");
            expect(await p.evaluate(() => document.activeElement?.id), `${state.id} focused`).toBe("g-focused");
            expect(
              await p.evaluate(() => getComputedStyle(document.getElementById("g-focused") as Element).outlineStyle),
              `${state.id} one-border focus`,
            ).toBe("none");
          }
          failures.push(...problems(await scan(p)).map((x) => `${state.id}: ${x}`));
          await context.close();
        }
        expect(failures).toEqual([]);
      });

  it("loads the gallery's frames as they near the screen, not all at once", async () => {
    const { p, context } = await open("/dev/components", galleryPages(), 1280, "light");
    const requested = new Set<string>();
    p.on("request", (r) => {
      if (r.url().includes("/dev/components/frame/")) requested.add(r.url());
    });
    await p.reload();
    await p.waitForLoadState("networkidle");
    expect(requested.size).toBeLessThan(GALLERY_FRAMES.length);
    // Following a frame's index link brings it in.
    const last = GALLERY_FRAMES.at(-1)?.id ?? "";
    await p.getByRole("link", { name: `frame ${last}` }).click();
    await expect.poll(() => [...requested].some((url) => url.endsWith(`/frame/${last}`))).toBe(true);
    await context.close();
  });

  // Each defect this test exists to catch, planted where a page would have it.
  const planted = (body: string) => String(<Document title="Planted">{raw(body)}</Document>);
  it("fails on a planted icon-only button without a name", async () => {
    const page = planted(
      '<main><h1>x</h1><button type="button"><svg aria-hidden="true" width="20" height="20"></svg></button></main>',
    );
    const { p, context } = await open("/planted", { "/planted": page }, 1280, "light");
    expect(problems(await scan(p)).some((x) => x.startsWith("button-name"))).toBe(true);
    await context.close();
  });

  it("fails on a planted text colour below 4.5:1", async () => {
    const page = planted('<main><h1>x</h1><p style="color: #b5b5b5">Too faint to read on white.</p></main>');
    const { p, context } = await open("/planted", { "/planted": page }, 1280, "light");
    expect(problems(await scan(p)).some((x) => x.startsWith("color-contrast"))).toBe(true);
    await context.close();
  });

  it("fails on a planted undersized target with no spacing", async () => {
    const tiny = 'style="width:10px;height:10px;padding:0;border:0;margin:0" aria-label';
    const page = planted(
      `<main><h1>x</h1><div style="display:flex"><button ${tiny}="One"></button><button ${tiny}="Two"></button></div></main>`,
    );
    const { p, context } = await open("/planted", { "/planted": page }, 1280, "light");
    expect(problems(await scan(p)).some((x) => x.startsWith("target-size"))).toBe(true);
    await context.close();
  });

  it("fails on a defect inside the closed phone Menu once it is opened", async () => {
    // A nameless button as the sidebar's first child: hidden while the Menu is closed, a violation once it opens.
    const page = String(GalleryFrame("member-cases")).replace(
      /<nav id="nav"[^>]*>/,
      (tag) =>
        `${tag}<button type="button" class="planted-defect"><svg aria-hidden="true" width="20" height="20"></svg></button>`,
    );
    expect(page).toContain("planted-defect");
    const { p, context } = await open("/planted", { "/planted": page }, 360, "light");
    expect(problems(await scan(p)).some((x) => x.includes("planted-defect"))).toBe(false);
    await p.getByRole("button", { name: "Menu" }).click();
    expect(problems(await scan(p)).some((x) => x.startsWith("button-name") && x.includes("planted-defect"))).toBe(true);
    await context.close();
  });

  it("fails on a result axe cannot decide that no person has checked", async () => {
    // Text over a background image: axe cannot measure its contrast and reports it undecided.
    const page = planted(
      '<main><h1>x</h1><p style="background-image: linear-gradient(90deg, var(--color-ink), var(--color-surface)); color: var(--color-ink)">Over an image</p></main>',
    );
    const { p, context } = await open("/planted", { "/planted": page }, 1280, "light");
    expect(problems(await scan(p)).some((x) => x.startsWith("incomplete color-contrast"))).toBe(true);
    await context.close();
  });
});
