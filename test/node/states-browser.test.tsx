import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CSS } from "../../src/web/assets";
import { Button } from "../../src/web/components/Button";
import {
  EmptyState,
  ErrorState,
  type ErrorStateProps,
  LoadingState,
  PartialNotice,
} from "../../src/web/components/States";
import { chromiumPath, focused, launch, openPage } from "./browser";
import { ERRORS } from "./states-fixtures";

// The empty, loading, error and partial states in Chromium (D07 T01 §8), with the shipped stylesheet and art: the
// loading region is announced and its square is still under reduced motion, every word is readable in both themes, the
// art sits on a light ground in both, and at phone width, with text at 100% and 200%, every state stacks, keeps its
// words and actions inside its card and the window, and every action is reached by Tab.
const LONG_TERM = "accountverificationnimbusmai1securelogin.portal.example";
const LONG_ADDRESS = "ayesha.van.der.westhuizen-accounts@outeniquapaperandpackaging.example";

const ERROR_KEYS = ["404", "403", "410", "429", "500", "maintenance"] as const;

function errorProps(key: (typeof ERROR_KEYS)[number]): ErrorStateProps {
  const props = ERRORS[key] as ErrorStateProps;
  if (key !== "403") return props;
  return {
    ...props,
    children: (
      <>
        You are signed in as <strong class="text-ink">{LONG_ADDRESS}</strong>, which has no access here. Ask an owner of
        the organisation to invite this address, or sign in with another one.
      </>
    ),
  };
}

function page(theme: "light" | "dark"): string {
  const body = String(
    <main class="flex flex-col gap-24 p-16 bg-subtle">
      <div id="state-first-run" data-state>
        <EmptyState
          layout="first-run"
          eyebrow="No cases yet"
          title="Check your first suspicious email."
          sentence="Forward it as an attachment, so its original headers come along. The verdict comes back by email in about a minute and appears here."
        >
          <p class="type-small text-muted">Only mail sent from your verified domain is accepted.</p>
        </EmptyState>
      </div>
      <div id="state-filtered" data-state>
        <EmptyState
          layout="filtered"
          title={`No cases match "${LONG_TERM}", Malicious, last 7 days.`}
          sentence="64 cases in total. Try a wider date range or another verdict."
          action={
            <Button variant="ghost" href="/cases">
              Clear filters
            </Button>
          }
        />
      </div>
      <div id="state-loading" data-state class="p-16 bg-surface">
        <LoadingState>Running</LoadingState>
      </div>
      {ERROR_KEYS.map((key) => (
        <div id={`state-error-${key}`} data-state>
          <ErrorState {...errorProps(key)} />
        </div>
      ))}
      <div id="state-partial" data-state>
        <PartialNotice
          ran={6}
          skipped={[
            {
              name: "Walkthrough (Muse Wonder)",
              reason: `today's model limit was reached at 15:20. We could not see where ${LONG_TERM} sends passwords.`,
            },
            { name: "Google Web Risk", reason: `the service did not answer within 10 seconds for ${LONG_TERM}.` },
          ]}
        />
      </div>
    </main>,
  );
  return `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="${APP_CSS}"></head><body class="bg-surface text-ink font-text">${body}</body></html>`;
}

// What is painted behind an element (every ancestor's background composited, page first) and its text's WCAG ratio
// against that, as a viewer sees it; for an image, the luminance of the ground behind it.
function measure(p: Page, selector: string): Promise<{ contrast: number; ground: number }[]> {
  return p.evaluate((sel) => {
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
    return [...document.querySelectorAll(sel)].map((el) => {
      const behind: string[] = [];
      for (let node: Element | null = el; node; node = node.parentElement)
        behind.unshift(getComputedStyle(node).backgroundColor);
      const back = luminance(pixel(behind));
      const fore = luminance(pixel([...behind, getComputedStyle(el).color]));
      const [hi, lo] = fore > back ? [fore, back] : [back, fore];
      return { contrast: (hi + 0.05) / (lo + 0.05), ground: back };
    });
  }, selector);
}

type Box = { x: number; y: number; width: number; height: number };
const box = async (p: Page, selector: string): Promise<Box> => {
  const found = await p.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not rendered`);
  return found;
};
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

// The words and actions of a state, each to be inside its card.
const PARTS = "h1, h2, h3, h4, p, li, a, button";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "empty, loading, error and partial states in Chromium",
  { timeout: 60_000 },
  () => {
    it("announces the loading state, and stills its square under reduced motion", async () => {
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        const p = await openPage(browser, page("light"), { viewport: { width: 1280, height: 800 }, reducedMotion });
        const region = p.locator("#state-loading [role=status]");
        expect(await region.getAttribute("aria-live")).toBe("polite");
        expect(await region.textContent()).toBe("Running");
        const animation = await p.evaluate(
          () => getComputedStyle(document.querySelector("#state-loading [aria-hidden]") as Element).animationName,
        );
        expect(animation, reducedMotion).toBe(reducedMotion === "reduce" ? "none" : "pulse");
        await p.context().close();
      }
    });

    for (const theme of ["light", "dark"] as const)
      it(`keeps every word at 4.5:1 or more and every piece of art on a light ground (${theme})`, async () => {
        const p = await openPage(browser, page(theme), { viewport: { width: 1280, height: 800 } });
        const words = "[data-state] :is(h1, h2, h3, h4, p, li, strong, span:not([aria-hidden]):not(:has(img)))";
        const measured = await measure(p, words);
        expect(measured.length).toBeGreaterThan(40);
        measured.forEach(({ contrast }, i) => {
          expect(contrast, `${theme} text ${i}`).toBeGreaterThanOrEqual(4.5);
        });
        // The art is ink on a light ground, as drawn: in the dark theme it sits on its white tile.
        const art = await p.evaluate(() =>
          [...document.querySelectorAll("[data-state] img")].map((img) => {
            const fill: string[] = [];
            for (let node = img.parentElement; node; node = node.parentElement)
              fill.unshift(getComputedStyle(node).backgroundColor);
            fill.push(getComputedStyle(img).backgroundColor);
            const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
            if (!ctx) throw new Error("no canvas");
            for (const colour of fill) {
              ctx.fillStyle = colour;
              ctx.fillRect(0, 0, 1, 1);
            }
            const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
            return {
              src: (img as HTMLImageElement).src,
              light: Math.min(r, g, b) >= 0xe0,
              loaded: (img as HTMLImageElement).naturalWidth > 0,
            };
          }),
        );
        expect(art).toHaveLength(7);
        for (const piece of art) {
          expect(piece.loaded, piece.src).toBe(true);
          expect(piece.light, `${theme} ground behind ${piece.src}`).toBe(true);
        }
        await p.context().close();
      });

    for (const zoom of ["100%", "200%"] as const)
      it(`fits every state at 360 px with text at ${zoom}, stacked, with every action reached by Tab`, async () => {
        const p = await openPage(browser, page("light"), { viewport: { width: 360, height: 800 } });
        await p.evaluate((size) => {
          document.documentElement.style.fontSize = size;
        }, zoom);
        expect(
          await p.evaluate(() => document.documentElement.scrollWidth),
          "no horizontal overflow",
        ).toBeLessThanOrEqual(360);
        const states = await p.locator("[data-state]").evaluateAll((els) => els.map((el) => el.id));
        expect(states).toHaveLength(10);
        for (const id of states) {
          // An error state's first child holds its card and the reference row below it.
          const card = await box(
            p,
            id.startsWith("state-error") ? `#${id} > div > div:first-child` : `#${id} > :first-child`,
          );
          if (id.startsWith("state-error")) {
            const footer = await box(p, `#${id} > div > div:last-child`);
            expect(footer.x >= 0 && footer.x + footer.width <= 360, `${id} reference inside the window`).toBe(true);
          }
          expect(card.x >= 0 && card.x + card.width <= 360, `${id} card inside the window`).toBe(true);
          const parts = await p.locator(`#${id} :is(${PARTS})`).all();
          for (const part of parts) {
            const found = await part.boundingBox();
            if (!found) continue;
            expect(
              inside(found, card),
              `${id}: "${((await part.textContent()) ?? "").slice(0, 40)}" inside its card`,
            ).toBe(true);
          }
          // No word spills out of its own box (a button's text past its edge would not move the box itself).
          const spilled = await p
            .locator(`#${id} :is(${PARTS})`)
            .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
          expect(spilled, `${id}: words spilling out`).toEqual([]);
        }
        // Stacked: the error tile above its eyebrow, the first-run art above its column, the filtered action below its
        // words.
        for (const key of ERROR_KEYS) {
          const tile = await box(p, `#state-error-${key} span:has(> img)`);
          const eyebrow = await box(p, `#state-error-${key} .type-eyebrow`);
          expect(tile.y + tile.height, `${key} tile above its text`).toBeLessThanOrEqual(eyebrow.y);
          expect([tile.width, tile.height], key).toEqual([88, 88]);
        }
        const art = await box(p, "#state-first-run img");
        expect(art.y + art.height).toBeLessThanOrEqual((await box(p, "#state-first-run .type-eyebrow")).y);
        const words = await box(p, "#state-filtered p");
        expect((await box(p, "#state-filtered a")).y, "Clear filters below its words").toBeGreaterThanOrEqual(
          words.y + words.height,
        );
        // Every action is reached by Tab, in order.
        const actions = await p
          .locator("[data-state] :is(a, button)")
          .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
        const reached: string[] = [];
        for (let i = 0; i < actions.length + 4; i++) {
          await p.keyboard.press("Tab");
          const focus = await focused(p);
          if (focus) reached.push(focus.key);
        }
        for (const action of actions) expect(reached, `Tab reaches ${action}`).toContain(action);
        await p.context().close();
      });
  },
);
