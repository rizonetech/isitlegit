// What the page holds that a text read cannot show (D05 T04 §3, correction 10), counted by the browser at capture time: its
// input fields (not the hidden, submit, button, image or reset kinds), its password fields, forms and frames. The
// parking rules (./parked.ts) park a page only when it has none, however few words it says. The expression runs in the
// page, so it is a string, and this module has no Worker imports and can be proven in a real browser.
import type { Signals } from "./parked";

export const SIGNALS = `(() => {
  const count = (selector) => document.querySelectorAll(selector).length;
  const skipped = ["hidden", "submit", "button", "image", "reset"];
  const inputs = [...document.querySelectorAll("input, textarea, select")].filter(
    (el) => !skipped.includes((el.getAttribute("type") || "").toLowerCase()),
  ).length;
  return JSON.stringify({ inputs, passwords: count('input[type="password" i]'), forms: count("form"), iframes: count("iframe") });
})()`;
// The page's counts, or null when the expression fails or answers anything but four whole counts: no signals, which
// screens the page, never zero counts, which could park it.
export async function pageSignals(page: {
  evaluate: (expression: string) => Promise<unknown>;
}): Promise<Signals | null> {
  try {
    const v = JSON.parse(String(await page.evaluate(SIGNALS))) as Record<string, unknown>;
    const count = (k: string) => (Number.isInteger(v[k]) && (v[k] as number) >= 0 ? (v[k] as number) : null);
    const inputs = count("inputs");
    const passwords = count("passwords");
    const forms = count("forms");
    const iframes = count("iframes");
    return inputs === null || passwords === null || forms === null || iframes === null
      ? null
      : { inputs, passwords, forms, iframes };
  } catch {
    return null;
  }
}
