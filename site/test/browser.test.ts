// The built marketing site in Chromium (D07 T06 §2): the phone menu by keyboard, the Copy address action, and every
// width and theme free of overflow and axe violations. Run after `pnpm --filter site build`. Chromium comes from the
// app's helpers (MOCKUP_CHROMIUM, else Playwright's headless shell); screenshots go to build/site-shots/ for review.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { AXE, problems, scan } from "../../test/node/axe.ts";
import { launch } from "../../test/node/browser.ts";
import { CHECK_ADDRESS } from "../src/lib/links.ts";
import { COPIED, COPY_FAILED } from "../src/scripts/copy.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");
const SHOTS = join(SITE, "..", "build/site-shots");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

let server: Server;
let origin: string;
let browser: Browser;

// site/dist on loopback, as Workers static assets serves it: `/x` and `/x/` answer `x/index.html`.
before(async () => {
  assert.ok(existsSync(join(DIST, "index.html")), "site/dist is missing: run `pnpm --filter site build` first");
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
    let file = join(DIST, path);
    if (!file.startsWith(DIST)) file = DIST;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launch();
  mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function open(context: BrowserContext, route = "/"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
  return page;
}

// Every page the site builds so far, as its route and a name for its screenshots.
const ROUTES = [
  { route: "/", name: "home" },
  { route: "/how-it-works", name: "how-it-works" },
  { route: "/invoice-fraud", name: "invoice-fraud" },
  { route: "/pricing", name: "pricing" },
  { route: "/privacy", name: "privacy" },
  { route: "/protect", name: "protect" },
  { route: "/terms", name: "terms" },
  { route: "/security", name: "security" },
  { route: "/about", name: "about" },
  // The error pages (D07 T08 §9): served at their own files, which is what Cloudflare serves for a 404 and the 500.
  { route: "/404.html", name: "404" },
  { route: "/500.html", name: "500" },
];

// What has focus: its accessible name, else its text.
const focusName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "";
    return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
  });

// The expanded state Chromium's accessibility tree gives the named button, as a screen reader reads it (a popover's
// invoker gets it from the browser, not from an aria-expanded attribute).
async function expanded(page: Page, name: string): Promise<boolean | undefined> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: { role?: { value: string }; name?: { value: string }; properties?: { name: string; value: { value: unknown } }[] }[];
    };
    // A details element's summary is a "DisclosureTriangle" in Chromium's tree, a popover's invoker a "button".
    const node = nodes.find((n) => (n.role?.value === "button" || n.role?.value === "DisclosureTriangle") && n.name?.value === name);
    assert.ok(node, `no button or disclosure named ${name} in the accessibility tree`);
    const state = node.properties?.find((p) => p.name === "expanded");
    return state === undefined ? undefined : Boolean(state.value.value);
  } finally {
    await cdp.detach();
  }
}

describe("every page, width and theme", () => {
  for (const { route, name } of ROUTES) {
  for (const width of [390, 1440]) {
    for (const colorScheme of ["light", "dark"] as const) {
      it(`${route} at ${width} px, ${colorScheme}: no horizontal overflow and no axe violation`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
        try {
          const page = await open(context, route);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 0, `the page is ${overflow} px wider than the ${width} px viewport`);
          await page.addScriptTag({ path: AXE });
          assert.deepEqual(problems(await scan(page)), []);
          await page.screenshot({ path: join(SHOTS, `${name}-${width}-${colorScheme}.png`), fullPage: true });
        } finally {
          await context.close();
        }
      });
    }
  }
  }
});

describe("the phone menu", () => {
  it("opens, lists every link, closes on Escape and gives focus back, by keyboard alone", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await open(context);
      const seen: string[] = [];
      for (let i = 0; i < 8 && (await focusName(page)) !== "Open menu"; i++) {
        await page.keyboard.press("Tab");
        seen.push(await focusName(page));
      }
      assert.equal(await focusName(page), "Open menu", `Tab order: ${seen.join(" | ")}`);
      for (const desktopOnly of ["How it works", "Sign in", "Get started free"]) {
        assert.ok(!seen.includes(desktopOnly), `${desktopOnly} is in the phone's tab order before the menu`);
      }
      const menu = page.locator("#site-menu");
      const toggle = page.getByRole("button", { name: "Open menu" });
      await page.keyboard.press("Enter");
      assert.equal(await menu.evaluate((el) => el.matches(":popover-open")), true, "Enter did not open the menu");
      assert.equal(await expanded(page, "Open menu"), true, "the browser does not report the menu button expanded");
      // Tab through the menu to its last link, staying inside it, as a reader of the menu would.
      const inMenu: string[] = [];
      for (let i = 0; i < 10 && inMenu.at(-1) !== "Sign in"; i++) {
        await page.keyboard.press("Tab");
        inMenu.push(await focusName(page));
      }
      for (const link of ["Close menu", "How it works", "Invoice fraud", "Protect your business", "Pricing", "Results", "Sign in"]) {
        assert.ok(inMenu.includes(link), `Tab never reached ${link} in the menu: ${inMenu.join(" | ")}`);
      }
      await page.keyboard.press("Escape");
      assert.equal(await menu.evaluate((el) => el.matches(":popover-open")), false, "Escape did not close the menu");
      assert.equal(await focusName(page), "Open menu", "focus did not return to the menu button");
      assert.equal(await expanded(page, "Open menu"), false, "the browser still reports the menu button expanded");
      await toggle.click();
      await page.getByRole("button", { name: "Close menu" }).click();
      assert.equal(await menu.evaluate((el) => el.matches(":popover-open")), false, "Close menu did not close it");
    } finally {
      await context.close();
    }
  });
});

describe("Copy address", () => {
  it("copies the exact address and says so", async () => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    try {
      const page = await open(context);
      const button = page.getByRole("button", { name: "Copy address" });
      assert.equal(await button.isVisible(), true, "the button stayed hidden with a clipboard present");
      await button.click();
      await page.waitForFunction((text) => document.getElementById("copy-status")?.textContent === text, COPIED);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), CHECK_ADDRESS);
    } finally {
      await context.close();
    }
  });

  it("says how to copy by hand when the browser refuses", async () => {
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: () => Promise.reject(new Error("refused")) },
        });
      });
      const page = await open(context);
      await page.getByRole("button", { name: "Copy address" }).click();
      await page.waitForFunction((text) => document.getElementById("copy-status")?.textContent === text, COPY_FAILED);
    } finally {
      await context.close();
    }
  });

  it("stays hidden without JavaScript, leaving the address to select", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await open(context);
      assert.equal(await page.locator("button[data-copy]").isVisible(), false);
      assert.equal(await page.locator("#check-address").isVisible(), true);
      assert.equal((await page.locator("#check-address").textContent())?.trim(), CHECK_ADDRESS);
    } finally {
      await context.close();
    }
  });
});

describe("the privacy and terms pages' contents links", () => {
  for (const route of ["/privacy", "/terms"] as const) {
    it(`${route}: move focus to each section's heading when followed by keyboard, and the next Tab continues from there`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        const page = await open(context, route);
        const links = await page.locator('nav[aria-label="On this page"] a').evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
        assert.equal(links.length, 6);
        for (const href of links) {
          await page.locator(`nav[aria-label="On this page"] a[href="${href}"]`).focus();
          await page.keyboard.press("Enter");
          const active = await page.evaluate(() => document.activeElement?.id ?? "");
          assert.equal(`#${active}`, href, `following ${href} left focus on "${active}"`);
          await page.keyboard.press("Tab");
          const next = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            const heading = document.getElementById(location.hash.slice(1));
            return { inside: Boolean(el && heading?.closest("section")?.contains(el)), tag: el?.tagName ?? "" };
          });
          assert.ok(next.inside || next.tag === "A", `Tab after ${href} landed outside the section or any link (${next.tag})`);
        }
      } finally {
        await context.close();
      }
    });
  }
});

describe("the protect page's monitor table on phones", () => {
  it("keeps every column header, cell and status pill visibly inside the card at 390 px without clipping", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    try {
      const page = await open(context, "/protect");
      const clipped = await page.evaluate(() => {
        const container = document.querySelector('[data-example="monitor"] > div') as HTMLElement | null;
        if (!container) return ["missing monitor container"];
        const box = container.getBoundingClientRect();
        const out: string[] = [];
        if (container.scrollWidth > container.clientWidth) {
          out.push(`scrollWidth ${container.scrollWidth} > clientWidth ${container.clientWidth}`);
        }
        for (const el of container.querySelectorAll("th, td, [data-status-pill]")) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > window.innerWidth) {
            out.push(`${el.textContent?.trim()}: [${Math.round(r.left)}, ${Math.round(r.right)}] outside [${Math.round(box.left)}, ${Math.round(box.right)}]`);
          }
        }
        return out;
      });
      assert.deepEqual(clipped, []);
    } finally {
      await context.close();
    }
  });
});

describe("the one-step demo", () => {
  it("shows the sample's verdict after one activation and no sign-up step, by mouse or keyboard", async () => {
    const context = await browser.newContext();
    try {
      const page = await open(context);
      const verdict = page.locator("[data-demo-verdict]");
      assert.equal(await verdict.isVisible(), false, "the verdict showed before the control was used");
      await page.getByText("See a sample check").click();
      await verdict.waitFor({ state: "visible" });
      assert.match((await verdict.textContent()) ?? "", /Verdict: Malicious\./);
      assert.equal(await page.locator("[data-region=demo] a, [data-region=demo] input").count(), 0);
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("See a sample check").focus();
      await page.keyboard.press("Enter");
      await page.locator("[data-demo-verdict]").waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });

  it("is reachable by Tab, reports its expanded state, and closes again", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await open(context);
      const seen: string[] = [];
      for (let i = 0; i < 20 && (await focusName(page)) !== "See a sample check"; i++) {
        await page.keyboard.press("Tab");
        seen.push(await focusName(page));
      }
      assert.equal(await focusName(page), "See a sample check", `Tab order: ${seen.join(" | ")}`);
      assert.equal(await expanded(page, "See a sample check"), false);
      await page.keyboard.press("Enter");
      assert.equal(await expanded(page, "See a sample check"), true);
      assert.equal(await page.locator("[data-demo-verdict]").isVisible(), true);
      await page.keyboard.press("Enter");
      assert.equal(await expanded(page, "See a sample check"), false);
      assert.equal(await page.locator("[data-demo-verdict]").isVisible(), false);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 1440]) {
    for (const colorScheme of ["light", "dark"] as const) {
      it(`opened at ${width} px, ${colorScheme}: no horizontal overflow and no axe violation`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
        try {
          const page = await open(context);
          await page.getByText("See a sample check").click();
          await page.locator("[data-demo-verdict]").waitFor({ state: "visible" });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 0, `the page is ${overflow} px wider than the ${width} px viewport with the demo open`);
          await page.addScriptTag({ path: AXE });
          assert.deepEqual(problems(await scan(page)), []);
        } finally {
          await context.close();
        }
      });
    }
  }
});

describe("the error pages", () => {
  it("404: every recovery link is reachable by Tab, named and visibly focused", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await open(context, "/404.html");
      const seen: string[] = [];
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        const name = await focusName(page);
        if (name) seen.push(name);
      }
      for (const label of ["Home", "How it works", "Pricing", "Sign up first"]) assert.ok(seen.includes(label), `${label} is not in the tab order: ${seen.join(" | ")}`);
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
      assert.notEqual(outline, "none", "the focused element shows no outline");
    } finally {
      await context.close();
    }
  });

  it("500: renders its content with JavaScript off and every request but its own document blocked", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const blocked: string[] = [];
      await context.route("**/*", (route) => {
        if (route.request().resourceType() === "document") return route.continue();
        blocked.push(route.request().url());
        return route.abort();
      });
      const page = await open(context, "/500.html");
      assert.equal(await page.locator("h1").textContent(), "This page didn't load.");
      assert.equal(await page.getByRole("link", { name: "Try again" }).isVisible(), true);
      assert.equal(await page.getByRole("link", { name: "Home" }).isVisible(), true);
      assert.deepEqual(blocked, [], "the page asked for something other than its own document");
    } finally {
      await context.close();
    }
  });

  it("500: Try again reloads the address that failed, and every link is reachable by Tab", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/500.html?from=/pricing`, { waitUntil: "networkidle" });
      const seen: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        const name = await focusName(page);
        if (name) seen.push(name);
      }
      for (const label of ["Try again", "Home", "Sign up first"]) assert.ok(seen.includes(label), `${label} is not in the tab order: ${seen.join(" | ")}`);
      const href = await page.getByRole("link", { name: "Try again" }).evaluate((a) => (a as HTMLAnchorElement).href);
      assert.equal(href, `${origin}/500.html?from=/pricing`, "Try again does not reload the address that failed");
    } finally {
      await context.close();
    }
  });
});
