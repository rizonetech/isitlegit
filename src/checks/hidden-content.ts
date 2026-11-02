// Hidden text as evidence (D02 T05 §1): text a reader never sees in the message, read from the view's `hiddenText`
// (the `checks` step's scan). A short hidden preheader before any visible text, with no instruction words, is medium;
// anything else hidden is high. Bounded: the strongest MAX_HIDDEN_ITEMS spans, then one item counting the rest; and one
// item saying what could not be scanned, so a partial scan never reads as a clean one.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { isPreheader } from "./hidden-text";
import { counted } from "./outcome-summary";
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
  const invisible = invisibleEvidence(view);
  if (!read) return invisible;
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
  return [...items, ...invisible];
}

// Text in characters no font draws (D02 T05 §3), as the phrase streams logged it: a tag run's decoded words, high when
// they read as an instruction, else medium; a run of other invisible characters, low; then a count of the rest carrying
// the highest severity among them.
const RUN_MAX = 8_000;
const detailBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function invisibleEvidence(view: CaseView): EvidenceDraft[] {
  const found = view.invisibleText;
  if (!found) return [];
  const items: EvidenceDraft[] = found.runs.map((run) => {
    const detail = fittedDetail({
      reason: "invisible-characters",
      kind: run.kind,
      quote: run.decoded?.slice(0, QUOTE) ?? null,
      length: run.length,
      location: run.location,
      // Where the instruction is, however far into the run (D02 T05 §6); absent when the run holds none.
      ...(run.instruction ? { instruction: run.instruction } : {}),
    }) as Record<string, unknown>;
    if (run.decoded !== null) {
      // The whole decoded run, past the quote's opening (D02 T05 §11): attached after the fitting so its
      // generic string clip cannot cut it first, bounded at RUN_MAX code points and then only to the
      // detail's byte budget, with the cut always marked.
      const chars = Array.from(run.decoded);
      let kept = chars.slice(0, RUN_MAX);
      while (kept.length && detailBytes({ ...detail, run: { text: kept.join(""), truncated: true } }) > 60_000)
        kept = kept.slice(0, Math.floor(kept.length / 2));
      detail.run = { text: kept.join(""), truncated: kept.length < chars.length || run.decodedCut === true };
    }
    return {
      check: "content.hidden_text",
      severity: run.severity,
      summary: bounded(
        run.decoded === null
          ? `A run of ${run.length} invisible characters sits in ${run.location === "subject" ? "the subject" : "the text"}.`
          : `Text spelled in invisible characters${run.location === "subject" ? " in the subject" : ""}: "${plain(run.decoded, 120)}"`,
      ),
      detail: detail as EvidenceDraft["detail"],
      artefacts: [view.raw],
    };
  });
  if (found.more > 0)
    items.push({
      check: "content.hidden_text",
      severity: found.moreSeverity ?? "low",
      summary: bounded(`${found.more} more runs of invisible characters are not listed one by one.`),
      detail: { reason: "invisible-characters", more: found.more },
      artefacts: [view.raw],
    });
  return items;
}

export function registerHiddenTextCheck(registry: CheckRegistry): void {
  registry.register({
    name: "content.hidden_text",
    needs: [],
    timeoutMs: 1_000,
    run: hiddenTextEvidence,
    summary: (_, items) => {
      // Each listed passage, and the count an overflow card stands for (completion review: those were left out).
      const runs = items
        .filter((i) => i.detail.reason !== undefined || typeof i.detail.more === "number")
        .reduce((n, i) => n + (typeof i.detail.more === "number" ? i.detail.more : 1), 0);
      return runs ? counted(runs, "hidden passage", "hidden passages") : "none found";
    },
    applies: (view) =>
      view.hiddenText || view.invisibleText?.runs.length
        ? null
        : "the message has no HTML or invisible characters to read",
    // Parts not scanned, style rules not resolved and colours not read each leave hidden text possibly unseen.
    partial: (view) => {
      const read = view.hiddenText;
      if (!read) return null;
      const gaps = [
        read.notScanned.length
          ? `${read.notScanned.length} body part${read.notScanned.length === 1 ? "" : "s"} not scanned`
          : "",
        read.unresolvedRules
          ? `${read.unresolvedRules} style rule${read.unresolvedRules === 1 ? "" : "s"} not resolved`
          : "",
        read.unreadColours ? `${read.unreadColours} colour${read.unreadColours === 1 ? "" : "s"} not read` : "",
      ].filter(Boolean);
      return gaps.length ? gaps.join(", ") : null;
    },
  });
}
