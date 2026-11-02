import { createServer } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { chromiumPath, launch } from "./browser";

// The gallery's own controls (D07 T01 §15) against the Worker as wrangler serves it in development: theme and
// width reach every preview (states and frames are documents of their own), the session remembers them, and
// axe-core runs from the Worker's own /dev/axe.min.js, with findings under their preview and a highlight press.
const ROOT = join(import.meta.dirname, "../..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let browser: Browser;
let origin = "";

beforeAll(async () => {
  const port = await freePort();
  origin = `http://localhost:${port}`;
  worker = await unstable_startWorker({
    config: join(ROOT, "wrangler.jsonc"),
    bindings: { ENV: { type: "plain_text", value: "development" } },
    dev: {
      server: { hostname: "localhost", port },
      inferOriginFromRoutes: false,
      inspector: false,
      logLevel: "error",
      persist: false,
      remote: false,
    },
  });
  [browser] = await Promise.all([launch(), worker.ready]);
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
}, 120_000);

async function openGallery(p: Page) {
  await p.goto(`${origin}/dev/components`);
  await p.getByRole("heading", { name: "Component gallery" }).waitFor();
}

const preview = (p: Page, label: string) => p.locator(`section[data-a11y-label="${label}"] iframe`);

describe.skipIf(!chromiumPath() && !process.env.CI)("gallery controls in Chromium", { timeout: 180_000 }, () => {
  it("serves axe only in development and applies theme and width to every preview", async () => {
    const axe = await worker.fetch("http://localhost/dev/axe.min.js");
    expect(axe.status).toBe(200);
    expect(await axe.text()).toContain("axe");
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    await openGallery(p);
    // Theme: dark reaches a state document and a frame document.
    await p.getByRole("button", { name: "Dark", exact: true }).click();
    const stateFrame = preview(p, "state button/primary");
    await stateFrame.waitFor();
    const stateDoc = await (await stateFrame.elementHandle())?.contentFrame();
    await expect.poll(() => stateDoc?.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    // Width: 360 px gives the verdict band its phone layout inside its own document.
    await p.getByRole("button", { name: "360 px" }).click();
    const bandFrame = preview(p, "state verdict-band/complete-malicious");
    await bandFrame.scrollIntoViewIfNeeded();
    const bandDoc = await (await bandFrame.elementHandle())?.contentFrame();
    await bandDoc?.locator("section[aria-label='Verdict']").waitFor();
    const bandWidth = await bandDoc?.evaluate(
      () => document.querySelector("section[aria-label='Verdict']")?.getBoundingClientRect().width ?? 0,
    );
    expect(bandWidth).toBeLessThan(400);
    // Session restore: a reload keeps the choices.
    await p.reload();
    await p.getByRole("heading", { name: "Component gallery" }).waitFor();
    await expect.poll(() => p.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    await context.close();
  });

  it("runs axe from the Worker, lists a planted defect under its state, and highlights it", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    await openGallery(p);
    const frame = preview(p, "state button/primary");
    await frame.scrollIntoViewIfNeeded();
    const doc = await (await frame.elementHandle())?.contentFrame();
    await expect
      .poll(() => doc?.evaluate(() => document.location.pathname + ":" + document.readyState).catch(() => ""))
      .toBe("/dev/components/state/state-button-primary:complete");
    await doc?.evaluate(() => {
      const b = document.createElement("button");
      b.innerHTML = '<svg aria-hidden="true" width="20" height="20"></svg>';
      document.querySelector("main")?.appendChild(b);
    });
    await p
      .locator('section[data-a11y-label="state button/primary"]')
      .getByRole("button", { name: "Scan this preview" })
      .click();
    const box = p.locator('section[data-a11y-label="state button/primary"] [data-a11y-results]');
    await expect.poll(() => box.getAttribute("data-a11y-state"), { timeout: 120_000 }).toBe("findings");
    expect(await box.textContent()).toContain("button-name");
    await box.getByRole("button", { name: "Highlight" }).first().click();
    const highlighted = await doc?.evaluate(() => document.querySelector("[data-gallery-mark]")?.tagName ?? "");
    expect(highlighted).toBe("BUTTON");
    // Changing a setting invalidates the findings.
    await p.getByRole("button", { name: "Light", exact: true }).click();
    expect(await box.getAttribute("data-a11y-state")).toBe("idle");
    await context.close();
  });

  it("restores full width, and attributes frame, duplicate and undecided findings", async () => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const p = await context.newPage();
    await openGallery(p);
    await p.getByRole("button", { name: "360 px" }).click();
    await p.getByRole("button", { name: "Full", exact: true }).click();
    const bandFrame = preview(p, "state verdict-band/complete-malicious");
    await bandFrame.scrollIntoViewIfNeeded();
    const bandDoc = await (await bandFrame.elementHandle())?.contentFrame();
    await bandDoc?.locator("section[aria-label='Verdict']").waitFor({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          bandDoc?.evaluate(
            () => document.querySelector("section[aria-label='Verdict']")?.getBoundingClientRect().width ?? 0,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(900);
    const plant = async (label: string, html: string) => {
      const frame = preview(p, label);
      await frame.scrollIntoViewIfNeeded();
      const doc = await (await frame.elementHandle())?.contentFrame();
      await expect.poll(() => doc?.evaluate(() => document.readyState).catch(() => "")).toBe("complete");
      await doc?.evaluate((h) => {
        const div = document.createElement("div");
        div.innerHTML = h;
        document.querySelector("main")?.appendChild(div.firstElementChild as Node);
      }, html);
      return doc;
    };
    await plant(
      "state button/primary",
      '<button type="button"><svg aria-hidden="true" width="20" height="20"></svg></button>',
    );
    await plant(
      "frame member-cases",
      '<button type="button"><svg aria-hidden="true" width="20" height="20"></svg></button>',
    );
    await plant(
      "state button/dark",
      '<p style="background-image: linear-gradient(90deg, var(--color-ink), var(--color-surface)); color: var(--color-ink)">Gradient text</p>',
    );
    for (const label of ["state button/primary", "frame member-cases", "state button/dark"])
      await p.locator(`section[data-a11y-label="${label}"]`).getByRole("button", { name: "Scan this preview" }).click();
    for (const label of ["state button/primary", "frame member-cases"]) {
      const box = p.locator(`section[data-a11y-label="${label}"] [data-a11y-results]`);
      await expect.poll(() => box.getAttribute("data-a11y-state"), { timeout: 120_000 }).toBe("findings");
      expect(await box.textContent()).toContain("button-name");
    }
    const gradient = p.locator('section[data-a11y-label="state button/dark"] [data-a11y-results]');
    await expect.poll(() => gradient.getAttribute("data-a11y-state"), { timeout: 120_000 }).toBe("findings");
    expect(await gradient.textContent()).toContain("undecided");
    await context.close();
  });

  it("fails then retries, stays idle when settings change mid-scan, and cleans up on rerun", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    let blocked = true;
    await p.route("**/dev/axe.min.js", async (route) => {
      if (blocked) return route.abort();
      return route.continue();
    });
    await openGallery(p);
    await p.getByRole("button", { name: "Run accessibility checks" }).click();
    await expect.poll(() => p.locator("[data-a11y-status]").textContent(), { timeout: 60_000 }).toContain("failed");
    blocked = false;
    const frame = preview(p, "state button/primary");
    await frame.scrollIntoViewIfNeeded();
    const doc = await (await frame.elementHandle())?.contentFrame();
    await expect
      .poll(() => doc?.evaluate(() => document.location.pathname + ":" + document.readyState).catch(() => ""))
      .toBe("/dev/components/state/state-button-primary:complete");
    await doc?.evaluate(() => {
      const b = document.createElement("button");
      b.innerHTML = '<svg aria-hidden="true" width="20" height="20"></svg>';
      b.id = "planted-defect";
      document.querySelector("main")?.appendChild(b);
    });
    const box = p.locator('section[data-a11y-label="state button/primary"] [data-a11y-results]');
    // Mid-scan invalidation: start, change the theme at once, and the stale run must not publish.
    await p.getByRole("button", { name: "Run accessibility checks" }).click();
    await p.getByRole("button", { name: "Dark", exact: true }).click();
    await p.waitForTimeout(8000);
    expect(await box.getAttribute("data-a11y-state")).toBe("idle");
    // Per-preview rerun finds it, removal plus rerun is clean.
    await p
      .locator('section[data-a11y-label="state button/primary"]')
      .getByRole("button", { name: "Scan this preview" })
      .click();
    await expect.poll(() => box.getAttribute("data-a11y-state"), { timeout: 60_000 }).toBe("findings");
    await doc?.evaluate(() => document.getElementById("planted-defect")?.remove());
    await p
      .locator('section[data-a11y-label="state button/primary"]')
      .getByRole("button", { name: "Scan this preview" })
      .click();
    await expect.poll(() => box.getAttribute("data-a11y-state"), { timeout: 60_000 }).toBe("clean");
    await context.close();
  });

  it("restores a preview that navigated away", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    await openGallery(p);
    const frame = preview(p, "state empty/filtered");
    await frame.scrollIntoViewIfNeeded();
    const doc = await (await frame.elementHandle())?.contentFrame();
    await doc?.getByRole("link", { name: "Clear filters" }).click();
    await expect
      .poll(
        async () => {
          const fresh = await (await frame.elementHandle())?.contentFrame();
          return fresh?.evaluate(() => document.location.pathname).catch(() => "");
        },
        { timeout: 30_000 },
      )
      .toContain("/dev/components/state/");
    await context.close();
  });

  it("bounds a stalled axe download and leaves the controls ready to retry", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    await p.route("**/dev/axe.min.js", async (route) => {
      await new Promise((done) => setTimeout(done, 30_000));
      await route.abort().catch(() => {});
    });
    await openGallery(p);
    await p.getByRole("button", { name: "Run accessibility checks" }).click();
    await expect.poll(() => p.locator("[data-a11y-status]").textContent(), { timeout: 60_000 }).toContain("failed");
    expect(await p.getByRole("button", { name: "Run accessibility checks" }).isEnabled()).toBe(true);
    await context.close();
  });

  it("follows the system theme and works when session storage is unavailable", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const p = await context.newPage();
    await p.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        get: () => {
          throw new Error("blocked");
        },
      });
    });
    await openGallery(p);
    await p.getByRole("button", { name: "System", exact: true }).click();
    const frame = preview(p, "state button/primary");
    await frame.scrollIntoViewIfNeeded();
    const doc = await (await frame.elementHandle())?.contentFrame();
    const bg = await doc?.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(18, 16, 20)");
    await p.getByRole("button", { name: "Light", exact: true }).click();
    await expect.poll(() => doc?.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("light");
    await context.close();
  });
});
