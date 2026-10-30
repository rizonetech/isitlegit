// Hidden text as evidence (D02 T05 §1): text a reader never sees in the message, read from the view's `hiddenText`
// (the `checks` step's scan). A short hidden preheader before any visible text, with no instruction words, is medium;
// anything else hidden is high. Bounded: the strongest MAX_HIDDEN_ITEMS spans, then one item counting the rest; and one
// item saying what could not be scanned, so a partial scan never reads as a clean one.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { isPreheader } from "./hidden-text";
import type { CheckRegistry } from "./registry";

export const MAX_HIDDEN_ITEMS = 20;
const QUOTE = 300;

const HOW: Record<string, string> = {
  "hidden-attribute": "marked hidden",
  "display:none": "not displayed",
  "visibility:hidden": "made invisible",
  "font-size": "in a font too small to read",
  opacity: "fully transparent",
  "color-match": "coloured like its background",
  "off-screen": "placed off the screen",
  collapsed: "in a box collapsed to nothing",
  comment: "in an HTML comment",
};

export function hiddenTextEvidence(view: CaseView): EvidenceDraft[] {
  const read = view.hiddenText;
  if (!read) return [];
  const ranked = read.spans
    .map((span) => ({ span, severity: isPreheader(span) ? ("medium" as const) : ("high" as const) }))
    // Instruction words first, then the other high spans, then preheaders, so the strongest are listed (plan review).
    .map((r) => ({ ...r, rank: r.span.instruction ? 0 : r.severity === "high" ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank);
  const items: EvidenceDraft[] = ranked.slice(0, MAX_HIDDEN_ITEMS).map(({ span, severity }) => ({
    check: "content.hidden_text",
    severity,
    summary: bounded(`Text ${HOW[span.reason] ?? "hidden"}: "${plain(span.text, 120)}"`),
    detail: fittedDetail({
      reason: span.reason,
      quote: span.text.slice(0, QUOTE),
      length: span.text.length,
      preheader: severity === "medium",
      part: span.part,
    }) as EvidenceDraft["detail"],
    artefacts: [view.raw],
  }));
  const rest = ranked.slice(MAX_HIDDEN_ITEMS);
  // Spans the scan found but could not keep are counted with those not listed (completion review).
  const omitted = read.omittedSpans;
  if (rest.length || omitted) {
    const byReason: Record<string, number> = {};
    for (const { span } of rest) byReason[span.reason] = (byReason[span.reason] ?? 0) + 1;
    items.push({
      check: "content.hidden_text",
      severity: rest.some((r) => r.severity === "high") || omitted ? "high" : "medium",
      summary: bounded(`${rest.length + omitted} more pieces of hidden text are not listed one by one.`),
      detail: { more: rest.length + omitted, byReason, omitted },
      artefacts: [view.raw],
    });
  }
  if (read.unresolvedRules > 0 || read.unreadColours > 0 || read.notScanned.length)
    items.push({
      check: "content.hidden_text",
      severity: "info",
      summary: bounded(
        "The scan for hidden text was not complete: some style rules or parts of the message could not be read.",
      ),
      detail: fittedDetail({
        complete: false,
        unresolvedRules: read.unresolvedRules,
        unreadColours: read.unreadColours,
        notScanned: read.notScanned,
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  return items;
}

export function registerHiddenTextCheck(registry: CheckRegistry): void {
  registry.register({ name: "content.hidden_text", needs: [], timeoutMs: 1_000, run: hiddenTextEvidence });
}
