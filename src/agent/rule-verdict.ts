// The rule-based verdict (D04 T01 §2; design spec 4.6 and 4.9): a verdict built only from a case's evidence and fixed
// rules, with no model. It is what every case gets until the agent exists, the fallback when the agent fails, the answer
// when the budget is spent, and the ablation baseline for the eval. The verdict is the floor's (§1), the reasons are the
// strongest findings with the ids they rest on, and the headline, actions and meaning are fixed per verdict. Pure: no
// I/O, no clock, no model.

import type { Evidence } from "../checks/evidence";
import type { Verdict } from "../db/cases";
import type { VerdictView } from "../db/verdicts";
import { floorFor } from "./floor";

export const MAX_REASONS = 3;
// Fixed confidence per verdict; with the original headers missing, or a check that could not run, it is capped (D01 T01 §4).
export const CONFIDENCE: Record<Verdict, number> = { malicious: 0.9, suspicious: 0.7, safe: 0.6 };
export const NO_HEADERS_CONFIDENCE_CAP = 0.5;

const HEADLINES: Record<Verdict, string> = {
  malicious: "This looks like a scam: serious warning signs were found",
  suspicious: "Be careful with this: some warning signs were found",
  safe: "No warning signs were found in what we could check",
};
// A safe verdict from a run in which some check could not run (an error, a time-out, a missing input) says so: it
// is a verdict on what could be checked, never a clean bill.
const PARTIAL_HEADLINE = "No warning signs were found, but some checks could not run";
const PARTIAL_MEANING =
  "We found nothing wrong in what we could check, but some checks could not run, so confirm with the sender if anything feels off.";
const MEANINGS: Record<Verdict, string> = {
  malicious: "Treat it as unsafe: do not click its links, open its attachments or pay anything it asks for.",
  suspicious: "Confirm with the sender another way before you act on it.",
  safe: "We found nothing wrong in what we could check.",
};
const ACTIONS: Record<Verdict, string[]> = {
  malicious: [
    "Do not click any link, open any attachment or pay anything it asks for.",
    "Delete it, and warn anyone else who may have received it.",
  ],
  suspicious: [
    "Do not pay, click or reply until you have checked with the sender on a phone number you already have, not one in the message.",
  ],
  safe: ["If it asks for money or details you did not expect, check with the sender first."],
};

const WEIGHT: Record<Evidence["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

// A reason's words are the item's summary with any citation marker taken out (a marker belongs to `evidenceIds`).
const wordsOf = (summary: string) => summary.replace(/\s*\[E\d+\]/g, "").trim();

export function ruleVerdict(
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "summary" | "detail">[],
  options: { headersAvailable: boolean },
): VerdictView {
  const { verdict } = floorFor(evidence);
  const unchecked = evidence.filter((item) => item.check === "not_checked" && wordsOf(item.summary).length > 0);
  const partial = verdict === "safe" && unchecked.length > 0;
  // The strongest findings: severity first, then evidence order; items at `info` are not findings. A safe verdict that
  // is partial cites what could not run instead, so the reader sees why it is not a clean one.
  const findings = evidence
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => WEIGHT[item.severity] > 0 && wordsOf(item.summary).length > 0)
    .sort((a, b) => WEIGHT[b.item.severity] - WEIGHT[a.item.severity] || a.at - b.at)
    .map(({ item }) => item);
  const reasons = (findings.length ? findings : partial ? unchecked : [])
    .slice(0, MAX_REASONS)
    .map((item) => ({ text: wordsOf(item.summary), evidenceIds: [item.id] }));
  const capped = !options.headersAvailable || partial;
  const confidence = capped ? Math.min(CONFIDENCE[verdict], NO_HEADERS_CONFIDENCE_CAP) : CONFIDENCE[verdict];
  return {
    verdict,
    headline: partial ? PARTIAL_HEADLINE : HEADLINES[verdict],
    confidence,
    reasons,
    actions: [...ACTIONS[verdict]],
    meaning: partial ? PARTIAL_MEANING : MEANINGS[verdict],
    source: "rules",
  };
}
