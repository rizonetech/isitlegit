// The monitor's page signals counted in a real page (D05 T04 §3, correction 10): the expression `browserCapture` runs in
// Browser Run, run here in Chromium over pages that say nothing of a form in words but hold one in their elements.
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parkedPage } from "../../src/monitor/parked";
import { pageSignals, SHADOW_HOOK } from "../../src/monitor/signals";
import { launch } from "./browser";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => browser?.close());

async function signalsOf(html: string, options: { hook?: boolean } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // As `browserCapture` does, the hook goes in before the page's own scripts when it is wanted.
  if (options.hook !== false) await page.addInitScript(SHADOW_HOOK);
  // A real navigation, as the capture's `goto` is: an init script runs on those, and `setContent` is none.
  await page.route("http://monitor.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://monitor.test/");
  const signals = await pageSignals(page);
  const text = await page.evaluate(() => document.body.innerText);
  await context.close();
  return { signals, text };
}

const SALE = "<p>kestrelfreight.example. This domain is for sale. Sedo domain parking.</p>";

describe("page signals in Chromium", () => {
  it("counts a placeholder-only password field that names no form word in the page's text", async () => {
    const { signals, text } = await signalsOf(`${SALE}<input type="PASSWORD" placeholder="Secret">`);
    expect(signals).toEqual({ inputs: 1, passwords: 1, forms: 0, iframes: 0, components: 0 });
    // innerText cannot see the field: the page reads as a plain sale page, which only the signals refuse to park.
    expect(parkedPage(text, null, 6_000)).toEqual({ parked: false });
    expect(parkedPage(text, { inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 }, 6_000)).toMatchObject({
      parked: true,
    });
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
  });

  it("counts a form, a frame and every kind of field a visitor can type into, and none the visitor cannot", async () => {
    const page = await signalsOf(`${SALE}
      <form><input type="text"><input type="email"><textarea></textarea><select><option>a</option></select>
      <input type="hidden" value="x"><input type="submit" value="Go"><input type="button" value="Go">
      <input type="image" alt="Go"><input type="reset"></form>
      <iframe src="about:blank"></iframe>`);
    expect(page.signals).toEqual({ inputs: 4, passwords: 0, forms: 1, iframes: 1, components: 0 });
  });

  it("counts nothing on a page with no form, so a sale page is parked", async () => {
    const { signals, text } = await signalsOf(`${SALE}<a href="https://example.test/offer">Make an offer</a>`);
    expect(signals).toEqual({ inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 });
    expect(parkedPage(text, signals, 6_000)).toMatchObject({ parked: true, reason: "sedo" });
  });

  // A password field in a shadow root, with the sale words outside it and no word of a form in the page's text: the
  // hostile page of completion review G1. The page script makes the root, so the hook sees it whether it is open or not.
  const HIDDEN = (mode: "open" | "closed", tag = "div") => `${SALE}
    <${tag} id="host"></${tag}>
    <script>
      const root = document.getElementById("host").attachShadow({ mode: "${mode}" });
      root.innerHTML = '<input type="password" placeholder="Secret">';
    </script>`;

  for (const mode of ["open", "closed"] as const)
    it(`counts a password field in a ${mode} shadow root, so a sale page around it is screened`, async () => {
      const { signals, text } = await signalsOf(HIDDEN(mode));
      expect(signals?.passwords).toBe(1);
      expect(signals?.inputs).toBe(1);
      expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
    });

  it("counts a custom element as a component, whose shadow root may not have been reached, and never parks around one", async () => {
    const { signals, text } = await signalsOf(`${SALE}<login-box></login-box>`);
    expect(signals).toEqual({ inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 1 });
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
    // A page whose script made its root before the hook (a component with a closed root) is still only a component.
    const late = await signalsOf(HIDDEN("closed", "login-box"), { hook: false });
    expect(late.signals?.components).toBe(1);
    expect(parkedPage(late.text, late.signals, 6_000)).toEqual({ parked: false });
  });

  it("shows the hook is what reaches a closed root: without it a plain element's closed root hides its field", async () => {
    const without = await signalsOf(HIDDEN("closed"), { hook: false });
    expect(without.signals).toEqual({ inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 });
    const withHook = await signalsOf(HIDDEN("closed"));
    expect(withHook.signals?.passwords).toBe(1);
  });

  it("reads an answer that is not five whole counts as no signals, which screens the page", async () => {
    const answering = (value: unknown) => ({ evaluate: async () => value });
    expect(await pageSignals(answering("not json"))).toBeNull();
    expect(
      await pageSignals(answering(JSON.stringify({ inputs: 1, passwords: -1, forms: 0, iframes: 0, components: 0 }))),
    ).toBeNull();
    expect(await pageSignals(answering(JSON.stringify({ inputs: 1, passwords: 0, forms: 0, iframes: 0 })))).toBeNull();
    expect(
      await pageSignals(answering(JSON.stringify({ inputs: "1", passwords: 0, forms: 0, iframes: 0, components: 0 }))),
    ).toBeNull();
    expect(await pageSignals({ evaluate: async () => Promise.reject(new Error("closed")) })).toBeNull();
  });
});
