import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AXE, problems, scan } from "./axe";
import { launch } from "./browser";
import { passkeyHarness } from "./passkey-stub.tsx";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// D07 T02 §16: every passkey state through the accessibility gate's own rules (test/node/axe.ts), at a phone's 375 px
// and at desktop width, in both themes, with no sideways scroll, on the stubbed pages (test/node/passkey-stub.tsx). Its
// own file so it runs beside the recoveries (D07 T02 §23).
describe("the passkey states through the accessibility gate", () => {
  const h = passkeyHarness(() => browser);
  const { stub, reset, signinWith, message, press } = h;
  // Every passkey state through the accessibility gate's own rules (test/node/axe.ts, as §7's states are scanned), at
  // a phone's 375 px and at desktop width, in both themes, with no sideways scroll: the option on each page that offers
  // it, the prompt open, and a recovery's message shown.
  for (const width of [375, 1280])
    it(`passes the accessibility gate in every passkey state, in both themes (${width} px)`, async () => {
      // Each page as drawn, its prompt open, and every recovery's message shown (the stall's words are drawn in the
      // same line as these, and its 15-second bound is the timing test's).
      const refusal = (status: number, code: string, words: string) => async (p: Page) => {
        stub.answers = [{ status, code }];
        await press(p);
        await expect.poll(() => message(p)).toContain(words);
      };
      const states: [string, (p: Page) => Promise<unknown>][] = [];
      for (const path of ["/signin", "/signin/limited", "/invite/demo"]) {
        states.push([path, async () => {}]);
        states.push([
          `${path} prompt`,
          async (p) => {
            stub.optionsHang = true;
            await press(p);
            await p.getByRole("heading", { name: "Confirm it is you" }).waitFor();
          },
        ]);
        states.push([`${path} unlocked`, refusal(401, "USER_VERIFICATION_REQUIRED", "not unlocked")]);
        states.push([`${path} removed`, refusal(401, "PASSKEY_NOT_FOUND", "no longer on your account")]);
        states.push([`${path} failed`, refusal(401, "AUTHENTICATION_FAILED", "could not be checked")]);
        states.push([`${path} service`, refusal(500, "SERVER", "did not finish")]);
      }
      // The browser's own refusals, on every page: no passkey or cancelled, and a device prompt that timed out (both
      // as the browser rejects them); and the connection lost before the options came.
      const rejected = (name: string, words: string) => async (p: Page) => {
        await p.evaluate(
          (n) =>
            Object.defineProperty(navigator.credentials, "get", {
              value: () => Promise.reject(new DOMException("refused", n)),
            }),
          name,
        );
        await press(p);
        await expect.poll(() => message(p)).toContain(words);
      };
      for (const path of ["/signin", "/signin/limited", "/invite/demo"]) {
        states.push([`${path} none`, rejected("NotAllowedError", "No passkey was used")]);
        states.push([`${path} timeout`, rejected("TimeoutError", "took too long")]);
        states.push([
          `${path} network`,
          async (p) => {
            stub.optionsDrop = true;
            await press(p);
            await expect.poll(() => message(p)).toContain("did not reach us");
          },
        ]);
      }
      // One browser context, its virtual authenticator and passkey, for every state at this width; each state starts
      // from its page loaded afresh, the stub's answers reset.
      const { p, context } = await signinWith("/signin", { width });
      for (const [name, act] of states) {
        reset();
        await p.goto(`${h.site}${name.split(" ")[0]}`, { waitUntil: "load" });
        expect(await p.locator("[data-passkey]").isVisible(), name).toBe(true);
        await act(p);
        // Focus is somewhere a keyboard can go on from, never left on the page, and a recovery's reason is in the
        // alert line.
        if (name.includes(" "))
          expect(await p.evaluate(() => document.activeElement !== document.body), name).toBe(true);
        if (/ (unlocked|removed|failed|service|none|timeout|network)$/.test(name))
          expect(await p.locator("[data-passkey-message][role=alert]").textContent(), name).not.toBe("");
        // Each theme is the page's own attribute, so one state is scanned in both without being reached twice.
        await p.addScriptTag({ path: AXE });
        for (const theme of ["light", "dark"] as const) {
          await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), `${name} ${theme}`).toBeLessThanOrEqual(
            width,
          );
          expect(problems(await scan(p)), `${name} ${theme}`).toEqual([]);
        }
      }
      await context.close();
    }, 60_000);
});
