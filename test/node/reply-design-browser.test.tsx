import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ReplyDesign, replyDesign } from "../../src/mail/templates/reply";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The reply's HTML in Chromium (D07 T03 §7): drawn as a mail client's reading pane would, at a phone's 360 px and a
// desktop pane's 640 px, with a long headline and domain, with images blocked, through the accessibility gate's rules,
// and its button leading to the report. Real mail clients are §25's.
const LONG = "accountverificationnimbusmai1securelogin.portal.example";
const BASE: ReplyDesign = {
  appUrl: "https://app.isitlegit.co.za",
  reportUrl: "https://app.isitlegit.co.za/r/01JCASE?o=org&e=1793664000&s=sig",
  organisation: "Karoo Couriers",
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
  // A mail client with images off, or no network: every image fails and only its alt text stands.
  await p.route("**/*", (route) =>
    images && route.request().resourceType() !== "image" ? route.continue() : route.abort(),
  );
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
    await context.close();
  });
});
