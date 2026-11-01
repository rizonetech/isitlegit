// What the page holds that a text read cannot show (D05 T04 §3, correction 10), counted by the browser at capture time: its
// input fields (not the hidden, submit, button, image or reset kinds), its password fields, forms and frames, and its
// components. The parking rules (./parked.ts) park a page only when it has none, however few words it says. The
// expressions run in the page, so they are strings, and this module has no Worker imports and can be proven in a real
// browser.
//
// A form can sit in a shadow root, out of the document's own tree (completion review G1). `SHADOW_HOOK` runs before the
// page's scripts and keeps every shadow root a script attaches, closed ones too, which page script cannot reach any
// other way; `SIGNALS` counts through the document and every root kept or open. Custom elements are counted as
// components besides, since a page may have made its shadow root before the hook or reached the browser's own
// `attachShadow` by another route: a page with any component is never parked, so the doubt always screens it.
import type { Signals } from "./parked";

export const SHADOW_HOOK = `(() => {
  const roots = [];
  Object.defineProperty(window, "__monitorShadowRoots", { value: roots, enumerable: false });
  const native = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = native.call(this, init);
    roots.push(root);
    return root;
  };
})()`;

export const SIGNALS = `(() => {
  const skipped = ["hidden", "submit", "button", "image", "reset"];
  const trees = [document];
  const seen = new Set();
  let components = 0;
  for (const root of window.__monitorShadowRoots || []) trees.push(root);
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    if (seen.has(tree)) continue;
    seen.add(tree);
    for (const el of tree.querySelectorAll("*")) {
      if (el.tagName.includes("-")) components++;
      if (el.shadowRoot) trees.push(el.shadowRoot);
    }
  }
  let inputs = 0, passwords = 0, forms = 0, iframes = 0;
  for (const tree of seen) {
    for (const el of tree.querySelectorAll("input, textarea, select")) {
      if (!skipped.includes((el.getAttribute("type") || "").toLowerCase())) inputs++;
      if ((el.getAttribute("type") || "").toLowerCase() === "password") passwords++;
    }
    forms += tree.querySelectorAll("form").length;
    iframes += tree.querySelectorAll("iframe").length;
  }
  return JSON.stringify({ inputs, passwords, forms, iframes, components });
})()`;

// The page's counts, or null when the expression fails or answers anything but five whole counts: no signals, which
// screens the page, never zero counts, which could park it.
export async function pageSignals(page: {
  evaluate: (expression: string) => Promise<unknown>;
}): Promise<Signals | null> {
  try {
    return readCounts(JSON.parse(String(await page.evaluate(SIGNALS))));
  } catch {
    return null;
  }
}

// Five whole counts as signals, or null: also what the stored `signals.json` is read through.
export function readCounts(value: unknown): Signals | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (k: string) => (Number.isInteger(v[k]) && (v[k] as number) >= 0 ? (v[k] as number) : null);
  const inputs = count("inputs");
  const passwords = count("passwords");
  const forms = count("forms");
  const iframes = count("iframes");
  const components = count("components");
  return inputs === null || passwords === null || forms === null || iframes === null || components === null
    ? null
    : { inputs, passwords, forms, iframes, components };
}
