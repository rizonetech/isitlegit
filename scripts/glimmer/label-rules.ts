// Labels that follow by a fixed rule from a page's other labels (D03 T04 §9), stored with label source `rule`.
//
//   node scripts/glimmer/label-rules.ts        # apply to every stored page, printing counts
//
// A lure's type, when its source gave none, follows from the screener prompt's own definitions
// (`SCREENER_SYSTEM_PROMPT`): a page that asks for card details is `payment`; one that asks for a sign-in is
// `credential`; one with neither form is `impersonation`. `fake_shop` is never derived: a shop is told from a lookalike
// only by a source or a judge, so a source's own `fake_shop` stands. Training may use a rule label; evaluation never
// trusts one (§10), and Astra and Claude's decision replaces it where they judge the page.
import type { LURE_TYPES } from "../../src/vision/page-screen.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

export function derivedLureType(page: StoredPage): (typeof LURE_TYPES)[number] | null {
  const { labels } = page;
  if (labels.lure !== true || labels.lure_type !== undefined) return null;
  if (labels.has_payment_form === undefined || labels.has_login_form === undefined) return null;
  if (labels.has_payment_form) return "payment";
  if (labels.has_login_form) return "credential";
  return "impersonation";
}

export function applyRules(store: ReturnType<typeof openStore>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const page of store.manifest()) {
    const type = derivedLureType(page);
    if (!type) continue;
    store.setLabels(page.id, { ...page.labels, lure_type: type }, { ...page.label_source, lure_type: "rule" });
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

if (import.meta.filename === process.argv[1]) console.log(JSON.stringify(applyRules(openStore(storeDir()))));
