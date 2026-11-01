// The monitor's page signals counted in a real page (D05 T04 §3, correction 10): the expression `browserCapture` runs in
// Browser Run, run here in Chromium over pages that say nothing of a form in words but hold one in their elements.
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parkedPage } from "../../src/monitor/parked";
import { pageSignals } from "../../src/monitor/signals";
import { launch } from "./browser";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => browser?.close());

async function signalsOf(html: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(html);
  const signals = await pageSignals(page);
  const text = await page.evaluate(() => document.body.innerText);
  await context.close();
  return { signals, text };
}

const SALE = "<p>kestrelfreight.example. This domain is for sale. Sedo domain parking.</p>";

describe("page signals in Chromium", () => {
  it("counts a placeholder-only password field that names no form word in the page's text", async () => {
    const { signals, text } = await signalsOf(`${SALE}<input type="PASSWORD" placeholder="Secret">`);
    expect(signals).toEqual({ inputs: 1, passwords: 1, forms: 0, iframes: 0 });
    // innerText cannot see the field: the page reads as a plain sale page, which only the signals refuse to park.
    expect(parkedPage(text, null, 6_000)).toEqual({ parked: false });
    expect(parkedPage(text, { inputs: 0, passwords: 0, forms: 0, iframes: 0 }, 6_000)).toMatchObject({ parked: true });
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
  });

  it("counts a form, a frame and every kind of field a visitor can type into, and none the visitor cannot", async () => {
    const page = await signalsOf(`${SALE}
      <form><input type="text"><input type="email"><textarea></textarea><select><option>a</option></select>
      <input type="hidden" value="x"><input type="submit" value="Go"><input type="button" value="Go">
      <input type="image" alt="Go"><input type="reset"></form>
      <iframe src="about:blank"></iframe>`);
    expect(page.signals).toEqual({ inputs: 4, passwords: 0, forms: 1, iframes: 1 });
  });

  it("counts nothing on a page with no form, so a sale page is parked", async () => {
    const { signals, text } = await signalsOf(`${SALE}<a href="https://example.test/offer">Make an offer</a>`);
    expect(signals).toEqual({ inputs: 0, passwords: 0, forms: 0, iframes: 0 });
    expect(parkedPage(text, signals, 6_000)).toMatchObject({ parked: true, reason: "sedo" });
  });

  it("reads an answer that is not four whole counts as no signals, which screens the page", async () => {
    const answering = (value: unknown) => ({ evaluate: async () => value });
    expect(await pageSignals(answering("not json"))).toBeNull();
    expect(await pageSignals(answering(JSON.stringify({ inputs: 1, passwords: -1, forms: 0, iframes: 0 })))).toBeNull();
    expect(await pageSignals(answering(JSON.stringify({ inputs: 1, passwords: 0, forms: 0 })))).toBeNull();
    expect(
      await pageSignals(answering(JSON.stringify({ inputs: "1", passwords: 0, forms: 0, iframes: 0 }))),
    ).toBeNull();
    expect(await pageSignals({ evaluate: async () => Promise.reject(new Error("closed")) })).toBeNull();
  });
});
