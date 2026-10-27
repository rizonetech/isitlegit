import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CSS } from "../../src/web/assets";
import { EvidenceCard, EvidenceFigure, EvidenceQuote, EvidenceRef } from "../../src/web/components/Evidence";
import { VerdictBand, type VerdictBandProps } from "../../src/web/components/Verdict";
import { chromiumPath, focused, launch, openPage } from "./browser";

// The verdict band and the evidence parts in Chromium (D07 T01 §7), with the shipped stylesheet and art: a reason's
// pill is reached with Tab and followed with Enter to its card, its focus ring stands out from the reason it sits in,
// the band's words are readable on every state in both themes, and at phone width the band stacks and nothing overflows.
const BANDS: [string, Omit<VerdictBandProps, "children">][] = [
  ["malicious", { state: "complete", verdict: "malicious", confidence: "high", headline: "Do not pay this invoice" }],
  ["suspicious", { state: "complete", verdict: "suspicious", confidence: "medium", headline: "Check before you pay" }],
  ["safe", { state: "complete", verdict: "safe", confidence: "high", headline: "This looks like a real invoice" }],
  ["partial", { state: "partial", verdict: "suspicious", confidence: "medium", headline: "Check before you pay" }],
  ["failed", { state: "failed", headline: "We could not finish this check" }],
  ["running", { state: "running", elapsed: 21, headline: "Checking the link and the attachment" }],
];

function page(theme: "light" | "dark"): string {
  const body = String(
    <main class="flex flex-col gap-24 p-16">
      {BANDS.map(([id, props]) => (
        <div id={`band-${id}`}>
          <VerdictBand {...props}>
            The link opens a fake sign-in page that sends your password to a stranger's server.
          </VerdictBand>
        </div>
      ))}
      <section id="reasons" class="flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large">
        <p id="reason-e7" class="flex items-center gap-12">
          <EvidenceRef id="E7" level="critical" />
          The link asks for your mail password and sends it to another site.
        </p>
        <p class="flex items-center gap-12">
          <EvidenceRef id="E4" level="high" />
          The sender's domain imitates your supplier's and is 3 days old.
        </p>
      </section>
      {/* Far enough down that following a pill has to scroll. */}
      <div style="height: 1600px" />
      <EvidenceCard
        id="E7"
        level="critical"
        title="Muse Wonder walked the link like a victim would"
        meta="6 steps · 31 s · contained browser"
        layout="split"
      >
        <EvidenceFigure caption='1. Lure page: one button, "View invoice"'>
          <EvidenceQuote>nimbusmai1-login.example/invoice/2026-10-27/account-verification</EvidenceQuote>
        </EvidenceFigure>
        <EvidenceFigure caption="2. Fake NimbusMail sign-in, canary values typed" />
        <EvidenceFigure caption="3. Where the password went" />
      </EvidenceCard>
      <EvidenceCard id="E4" level="high" title="Lookalike domain, 3 days old">
        <EvidenceQuote>nimbusmai1-login.example</EvidenceQuote>
      </EvidenceCard>
      <div style="height: 1600px" />
    </main>,
  );
  return `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="${APP_CSS}"></head><body class="bg-surface text-ink font-text">${body}</body></html>`;
}

// The WCAG ratio of an element's text colour against what is painted behind it (every ancestor's background composited,
// page first), as a viewer sees it.
function textContrast(p: Page, selector: string): Promise<number> {
  return p.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const pixel = (fill: string[]) => {
      const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
      if (!ctx) throw new Error("no canvas");
      for (const colour of fill) {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
      }
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const behind: string[] = [];
    for (let node: HTMLElement | null = el; node; node = node.parentElement)
      behind.unshift(getComputedStyle(node).backgroundColor);
    const back = luminance(pixel(behind));
    const fore = luminance(pixel([...behind, getComputedStyle(el).color]));
    const [hi, lo] = fore > back ? [fore, back] : [back, fore];
    return (hi + 0.05) / (lo + 0.05);
  }, selector);
}

type Box = { x: number; y: number; width: number; height: number };
const box = async (p: Page, selector: string): Promise<Box> => {
  const found = await p.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not rendered`);
  return found;
};

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!chromiumPath() && !process.env.CI)("verdict and evidence in Chromium", { timeout: 30_000 }, () => {
  for (const theme of ["light", "dark"] as const) {
    it(`reaches a reason's pill with Tab and follows it with Enter to its card, with a visible focus ring (${theme})`, async () => {
      const p = await openPage(browser, page(theme), { viewport: { width: 1280, height: 800 } });
      let reached = null;
      for (let i = 0; i < 10 && !reached; i++) {
        await p.keyboard.press("Tab");
        const focus = await focused(p);
        if (focus?.key === "Evidence E7, critical") reached = focus;
      }
      expect(reached, "Tab reaches the E7 pill").not.toBeNull();
      expect(reached?.tag).toBe("a");
      expect(reached?.outline).toMatch(/^solid [1-9]/);
      expect(reached?.opaque).toBe(true);
      expect(reached?.contrast, "the ring against the reason it sits in").toBeGreaterThanOrEqual(3);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => location.hash === "#e7");
      expect(await p.evaluate(() => document.querySelector(":target")?.id)).toBe("e7");
      const inView = await p.evaluate(() => {
        const r = (document.getElementById("e7") as HTMLElement).getBoundingClientRect();
        return r.top >= 0 && r.top < innerHeight;
      });
      expect(inView, "the card is scrolled into view").toBe(true);
      await p.context().close();
    });

    it(`keeps every band's words at 4.5:1 or more on every state (${theme})`, async () => {
      const p = await openPage(browser, page(theme), { viewport: { width: 1280, height: 800 } });
      for (const [id] of BANDS)
        for (const part of ["p:first-child", "h2", "p:last-child"]) {
          const selector = `#band-${id} section > div:last-child > ${part}`;
          expect(await textContrast(p, selector), `${id} ${part}`).toBeGreaterThanOrEqual(4.5);
        }
      await p.context().close();
    });
  }

  it("lays the band out in a row at desktop width, with the 72 px art in its 88 px tile", async () => {
    const p = await openPage(browser, page("light"), { viewport: { width: 1280, height: 800 } });
    for (const [id] of BANDS) {
      const tile = await box(p, `#band-${id} section > div:first-child`);
      const art = await box(p, `#band-${id} img`);
      const headline = await box(p, `#band-${id} h2`);
      expect([tile.width, tile.height, art.width, art.height], id).toEqual([88, 88, 72, 72]);
      expect(headline.x, `${id}: the words sit beside the tile`).toBeGreaterThan(tile.x + tile.width);
    }
    await p.context().close();
  });

  it("stacks the band at 360 px (tile and eyebrow on one row, then headline and sentence) and overflows nothing", async () => {
    const p = await openPage(browser, page("light"), { viewport: { width: 360, height: 800 } });
    for (const [id] of BANDS) {
      const tile = await box(p, `#band-${id} section > div:first-child`);
      const art = await box(p, `#band-${id} img`);
      const eyebrow = await box(p, `#band-${id} section p:first-of-type`);
      const headline = await box(p, `#band-${id} h2`);
      const sentence = await box(p, `#band-${id} section p:last-of-type`);
      expect([tile.width, tile.height, art.width, art.height], id).toEqual([56, 56, 40, 40]);
      // The art sits inside its tile.
      expect(art.x >= tile.x && art.x + art.width <= tile.x + tile.width, `${id} art inside`).toBe(true);
      // The eyebrow shares the tile's row, to its right; the headline and the sentence each start a row below.
      expect(eyebrow.x, `${id} eyebrow beside the tile`).toBeGreaterThan(tile.x + tile.width);
      expect(eyebrow.y, `${id} eyebrow on the tile's row`).toBeLessThan(tile.y + tile.height);
      expect(headline.y, `${id} headline below the tile`).toBeGreaterThanOrEqual(tile.y + tile.height);
      expect(sentence.y, `${id} sentence below the headline`).toBeGreaterThanOrEqual(headline.y + headline.height);
    }
    const overflow = await p.evaluate(() => ({
      page: document.documentElement.scrollWidth - innerWidth,
      parts: [...document.querySelectorAll("section, article")]
        .filter((el) => el.scrollWidth > el.clientWidth)
        .map((el) => el.id || el.getAttribute("aria-label")),
    }));
    expect(overflow).toEqual({ page: 0, parts: [] });
    await p.context().close();
  });
});
