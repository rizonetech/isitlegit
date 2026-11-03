import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ReplyDesign, replyDesign } from "../../src/mail/templates/reply";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The reply's HTML in Chromium (D07 T03 §7): drawn as a mail client's reading pane would, at a phone's 360 px and a
// desktop pane's 640 px, with a long headline and domain, with images blocked, through the accessibility gate's rules,
// its sections headings and its actions and reasons lists, and its button followed from the keyboard to the report. The
// images are served from public/ as the app serves them. Real mail clients are §25's.
const LONG = "accountverificationnimbusmai1securelogin.portal.example";
const BASE: ReplyDesign = {
  appUrl: "https://app.isitlegit.co.za",
  reportUrl: "https://app.isitlegit.co.za/r/01JCASE?o=org&e=1793664000&s=sig",
  // The longest unbroken name the organisation validator accepts (src/auth/schema.ts) must still wrap.
  organisation: "W".repeat(120),
  verdict: {
    verdict: "malicious",
    headline: `${"A very long headline about a lookalike domain that keeps going ".repeat(4)}${LONG}.`.slice(0, 300),
    confidence: 0.93,
    reasons: [
      { text: `The link goes to ${LONG}, a lookalike registered 3 days ago.`, evidenceIds: ["E1"] },
      "Hidden white text tells AI scanners the email is safe.",
    ],
    actions: ["Do not click the link or open the attachment.", "Delete the email and warn your team."],
  },
  evidence: [
    { id: "E1", severity: "critical" },
    { id: "E2", severity: "low" },
  ],
  voice: false,
  coverage: [
    { check: "auth.spf", outcome: "ran" },
    { check: "domain.age", outcome: "failed" },
  ],
  headers: { spf: "pass", dkim: "pass", dmarc: "fail" },
  notes: ["Your forward held more than one message and we checked only the first."],
};
const VARIANTS: Record<string, ReplyDesign> = {
  malicious: BASE,
  suspicious: {
    ...BASE,
    verdict: { ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>), verdict: "suspicious", confidence: 0.6 },
  },
  safe: {
    ...BASE,
    verdict: { ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>), verdict: "safe", confidence: 0.95 },
  },
  failed: {
    ...BASE,
    verdict: null,
    failure: {
      lead: "We could not finish checking this message.",
      advice: "Please forward the message again in a few minutes.",
    },
  },
};

const PUBLIC = join(import.meta.dirname, "../../public");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});
async function open(design: ReplyDesign, width: number, images = true) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  // The app's origin serves its images from public/ and the report a page of its own; a mail client with images off
  // gets none, and only the alt text stands.
  await p.route(`${BASE.appUrl}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/static/"))
      return images
        ? route.fulfill({ contentType: "image/png", body: readFileSync(join(PUBLIC, path)) })
        : route.abort();
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Report</title><h1>The report</h1>" });
  });
  await p.setContent(replyDesign(design).html, { waitUntil: "load" });
  return { p, context };
}

describe.skipIf(!chromiumPath() && !process.env.CI)("the reply in Chromium", { timeout: 120_000 }, () => {
  for (const width of [360, 640])
    it(`fits ${width} px with long words and passes the accessibility gate's rules, in every variant`, async () => {
      for (const [name, design] of Object.entries(VARIANTS)) {
        const { p, context } = await open(design, width);
        expect(await p.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p)), name).toEqual([]);
        await context.close();
      }
    });

  it("fits a 300-character hostile stored sentence in the band at phone and desktop widths (D07 T03 s10)", async () => {
    const longest = `<script>alert(1)</script> ${"Do not use it. ".repeat(30)}`.slice(0, 300);
    expect(longest).toHaveLength(300);
    const design: ReplyDesign = {
      ...BASE,
      verdict: { ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>), meaning: longest },
    };
    for (const width of [360, 640]) {
      const { p, context } = await open(design, width);
      expect(await p.evaluate(() => document.documentElement.scrollWidth), String(width)).toBeLessThanOrEqual(width);
      expect(await p.locator("script").count()).toBe(0);
      const text = (await p.locator("body").textContent())?.replace(/\s+/g, " ") ?? "";
      expect(text).toContain(longest);
      await context.close();
    }
  });

  it("loads every image with images on", async () => {
    const { p, context } = await open(BASE, 640);
    const images = await p
      .locator("img")
      .evaluateAll((all) =>
        all.map((img) => ({ src: (img as HTMLImageElement).src, ok: (img as HTMLImageElement).naturalWidth > 0 })),
      );
    expect(images.length).toBe(2);
    for (const image of images) expect(image, image.src).toMatchObject({ ok: true });
    await context.close();
  });

  it("gives a screen reader its headings and lists", async () => {
    const { p, context } = await open(BASE, 640);
    expect(await p.getByRole("heading", { level: 1 }).count()).toBe(1);
    expect(await p.getByRole("heading", { level: 2, name: "What to do now" }).count()).toBe(1);
    expect(await p.getByRole("heading", { level: 2, name: "Why we say so" }).count()).toBe(1);
    const lists = p.getByRole("list");
    expect(await lists.count()).toBe(2);
    expect(await lists.nth(0).getByRole("listitem").count()).toBe(2);
    expect(await lists.nth(1).getByRole("listitem").count()).toBe(2);
    await context.close();
  });

  it("reads whole with images blocked, the logo's name standing in", async () => {
    const { p, context } = await open(BASE, 640, false);
    expect(await p.locator('img[alt="IsItLegit"]').count()).toBe(1);
    expect(await p.getByText("What to do now").isVisible()).toBe(true);
    expect(await p.getByRole("link", { name: "Open the full report" }).isVisible()).toBe(true);
    await context.close();
  });

  it("reads in order, verdict, then actions, then reasons, then the report, and its button leads there", async () => {
    const { p, context } = await open(BASE, 640);
    const at = (text: string) =>
      p
        .getByText(text, { exact: false })
        .first()
        .evaluate((el) => el.getBoundingClientRect().top);
    const tops = [
      await at("Malicious · high confidence"),
      await at("What to do now"),
      await at("Why we say so"),
      await at("Open the full report"),
    ];
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(await p.getByRole("link", { name: "Open the full report" }).getAttribute("href")).toBe(BASE.reportUrl);
    // Tab to it and press Enter: the report opens.
    await p.keyboard.press("Tab");
    expect(await p.evaluate(() => document.activeElement?.textContent)).toBe("Open the full report");
    await Promise.all([p.waitForURL(BASE.reportUrl), p.keyboard.press("Enter")]);
    expect(await p.getByRole("heading", { name: "The report" }).isVisible()).toBe(true);
    await context.close();
  });
});
