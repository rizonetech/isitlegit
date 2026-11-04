// The rule-based verdict (D04 T01 §2; design spec 4.6 and 4.9): a verdict built only from a case's evidence and fixed
// rules, with no model. It is what every case gets until the agent exists, the fallback when the agent fails, the answer
// when the budget is spent, and the ablation baseline for the eval. The verdict is the floor's (§1), the reasons are the
// strongest findings with the ids they rest on, and the headline, actions and meaning are fixed per verdict. Pure: no
// I/O, no clock, no model.

import type { Evidence } from "../checks/evidence";
import type { Verdict } from "../db/cases";
import type { Reason, VerdictView } from "../db/verdicts";
import { type Floor, floorFor, type PartialOutcome, type PartialReason } from "./floor";

export const MAX_REASONS = 3;
// Fixed confidence per verdict; with the original headers missing, or a check that could not run, it is capped (D01 T01 §4).
export const CONFIDENCE: Record<Verdict, number> = { malicious: 0.9, suspicious: 0.7, safe: 0.6 };
export const NO_HEADERS_CONFIDENCE_CAP = 0.5;

const HEADLINES: Record<Verdict, string> = {
  malicious: "This looks like a scam: serious warning signs were found",
  suspicious: "Be careful with this: some warning signs were found",
  safe: "No warning signs were found in what we could check",
};
// A safe verdict never claims more than the evidence holds. With low or medium findings it says there is no clear sign
// of fraud and points at them; from a run in which some check could not run (an error, a time-out, a missing input)
// it says so; with both it says both. It is a verdict on what could be checked, never a clean bill.
const NOTED_HEADLINE = "No clear sign of fraud, but some points are worth a look";
export const PARTIAL_HEADLINE = "No warning signs were found, but some checks could not run";
const NOTED_PARTIAL_HEADLINE = "No clear sign of fraud, but some points are worth a look and some checks could not run";
const NOTED_MEANING = "We found no clear sign of fraud, but check the points below before you act on it.";
export const PARTIAL_MEANING =
  "We found nothing wrong in what we could check, but some checks could not run, so confirm with the sender if anything feels off.";
const NOTED_PARTIAL_MEANING =
  "We found no clear sign of fraud, but check the points below, and confirm with the sender, as some checks could not run.";
export const MEANINGS: Record<Verdict, string> = {
  malicious: "Treat it as unsafe: do not click its links, open its attachments or pay anything it asks for.",
  suspicious: "Confirm with the sender another way before you act on it.",
  safe: "We found nothing wrong in what we could check.",
};

// Message-specific consequence sentences (D04 T01 §16): when the floor raises the verdict and the
// floor-raising evidence establishes one of these four concrete harms, the stored meaning names that
// consequence from code rather than the generic per-verdict sentence.
export type ConsequenceFamily = "credential" | "bank" | "malware" | "lookalike";
export const FLOOR_CONSEQUENCES: Readonly<Record<ConsequenceFamily, string>> = {
  credential: "The sign-in page would take the password it asks for.",
  bank: "The payment would go to bank details that differ from the supplier's record.",
  malware: "Opening the attachment could run a program or hidden code on your device.",
  lookalike: "Replying or following its links would reach a lookalike domain, not the organisation it names.",
};

export function consequenceFamilyOf(item: Pick<Evidence, "check" | "severity" | "detail">): ConsequenceFamily | null {
  if (item.detail.checked === false) return null;
  if (
    item.check === "walkthrough.credential_target" ||
    item.check === "link.credential_form" ||
    (item.check === "walkthrough.form_fields" &&
      typeof item.detail.credentialCount === "number" &&
      item.detail.credentialCount > 0) ||
    (item.check === "attachment.html" &&
      (item.detail.passwordField === true || item.detail.hasPasswordInput === true)) ||
    (item.check === "vision.requested_action" && (item.detail.action === "log_in" || item.detail.action === "sign_in"))
  ) {
    return "credential";
  }
  if (
    item.check === "invoice.bank_changed" ||
    item.check === "invoice.bank_change" ||
    (item.check === "agent.ledger_lookup" && (item.detail.match === false || item.detail.matched === false))
  ) {
    return "bank";
  }
  if (
    item.check === "attachment.executable" ||
    item.check === "attachment.macro" ||
    (item.check === "attachment.type_mismatch" &&
      (!("family" in item.detail) ||
        item.detail.family === "executable" ||
        item.detail.family === "script" ||
        item.detail.family === "shortcut"))
  ) {
    return "malware";
  }
  if (item.check === "domain.lookalike" || item.detail.lookalike === true) {
    return "lookalike";
  }
  return null;
}

export function floorConsequenceFor(
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[],
  floor: Floor,
): string | null {
  if (floor.verdict === "safe") return null;
  const byId = new Map(evidence.map((item) => [item.id, item]));
  for (const id of floor.evidenceIds) {
    const item = byId.get(id);
    if (!item) continue;
    const family = consequenceFamilyOf(item);
    if (family) return FLOOR_CONSEQUENCES[family];
  }
  return null;
}

export function withPartialReason(
  reasons: readonly Reason[],
  partialReason: PartialReason | undefined,
  primary: boolean,
): Reason[] {
  if (!partialReason || partialReason.evidenceIds.length === 0) return reasons.slice(0, MAX_REASONS);
  const partialSet = new Set(partialReason.evidenceIds);
  const filtered = reasons.filter(
    (r) => r.text !== partialReason.text && !r.evidenceIds.every((id) => partialSet.has(id)),
  );
  if (primary) {
    return [partialReason, ...filtered].slice(0, MAX_REASONS);
  }
  return [...filtered.slice(0, MAX_REASONS - 1), partialReason];
}
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

// The checks whose medium finding is a sign of impersonation or of a link that is not what it says (D04 T01 §9).
// The first three were measured on their own (no false positive on 100 genuine samples), so one is enough. The last two
// need the network and were not measured, and a legitimate tracking link or shortener also ends on another site, so
// they count only beside a second finding of the family.
export const IMPERSONATION: ReadonlySet<string> = new Set([
  "sender.display_address",
  "sender.display_brand",
  "link.text_mismatch",
]);
export const CORROBORATING: ReadonlySet<string> = new Set(["link.final_domain_changed", "link.lure_button"]);
const WEIGHT: Record<Evidence["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

// A reason's words are the item's summary with any citation marker taken out (a marker belongs to `evidenceIds`).
const wordsOf = (summary: string) => summary.replace(/\s*\[E\d+\]/g, "").trim();

export function ruleVerdict(
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "summary" | "detail">[],
  options: { headersAvailable: boolean; outcomes?: readonly PartialOutcome[] | null | undefined },
): VerdictView {
  // The floor decides the least the evidence allows; on top of it the rules count one more kind of finding as enough
  // (D04 T01 §9): a medium-or-higher finding from the impersonation checks, or two distinct checks of the family. The
  // floor itself is not touched.
  const severityFloor = floorFor(evidence);
  const floorOut = floorFor(evidence, options.outcomes);
  const floor = floorOut.verdict;
  const familyHits = evidence.filter(
    (item) =>
      (IMPERSONATION.has(item.check) || CORROBORATING.has(item.check)) && WEIGHT[item.severity] >= WEIGHT.medium,
  );
  const distinct = new Set(familyHits.map((item) => item.check));
  const family = floor === "safe" && (familyHits.some((item) => IMPERSONATION.has(item.check)) || distinct.size >= 2);
  const verdict: Verdict = family ? "suspicious" : floor;
  // The findings that made it suspicious come first in the reasons, one for each check, so the report shows why.
  const trigger = family
    ? [...distinct].map((check) => familyHits.find((item) => item.check === check) as (typeof familyHits)[number])
    : [];
  // What could not be checked: the runner's `not_checked` item for a check that failed, and a check's own informational
  // item for coverage it could not read (`detail.checked === false`: unread files, links past the cap, lookups with no answer).
  const unchecked = evidence.filter(
    (item) => (item.check === "not_checked" || item.detail.checked === false) && wordsOf(item.summary).length > 0,
  );
  // A verdict the evidence alone does not settle (safe, or suspicious only through the family rule) is partial when a check
  // could not run: it keeps that warning, its reasons and a capped confidence.
  const partial = floor === "safe" && unchecked.length > 0;
  // The strongest findings: severity first, then evidence order; items at `info` are not findings.
  const findings = evidence
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => WEIGHT[item.severity] > 0 && wordsOf(item.summary).length > 0)
    .sort((a, b) => WEIGHT[b.item.severity] - WEIGHT[a.item.severity] || a.at - b.at)
    .map(({ item }) => item);
  const noted = verdict === "safe" && findings.length > 0;
  // A partial verdict always cites what could not run, whatever else it cites: the findings fill the rest of the three.
  const ordered = [...trigger, ...findings.filter((item) => !trigger.includes(item))];
  const cited = partial ? [...ordered.slice(0, MAX_REASONS - 1), ...unchecked] : ordered;
  const baseReasons = cited
    .slice(0, MAX_REASONS)
    .map((item) => ({ text: wordsOf(item.summary), evidenceIds: [item.id] }));
  const reasons =
    verdict === "suspicious" && floorOut.partialReason
      ? withPartialReason(baseReasons, floorOut.partialReason, severityFloor.verdict === "safe" && trigger.length === 0)
      : baseReasons;
  const capped = !options.headersAvailable || partial || Boolean(floorOut.partialReason && verdict === "suspicious");
  const confidence = capped ? Math.min(CONFIDENCE[verdict], NO_HEADERS_CONFIDENCE_CAP) : CONFIDENCE[verdict];
  // The safe wording changes with what is known; a suspicious verdict keeps its own, partial or not.
  const safePartial = partial && verdict === "safe";
  const headline = noted
    ? safePartial
      ? NOTED_PARTIAL_HEADLINE
      : NOTED_HEADLINE
    : safePartial
      ? PARTIAL_HEADLINE
      : HEADLINES[verdict];
  const consequence = floorConsequenceFor(evidence, floorOut);
  const meaning = noted
    ? safePartial
      ? NOTED_PARTIAL_MEANING
      : NOTED_MEANING
    : safePartial
      ? PARTIAL_MEANING
      : (consequence ?? MEANINGS[verdict]);
  return {
    verdict,
    headline,
    confidence,
    reasons,
    actions: [...ACTIONS[verdict]],
    meaning,
    source: "rules",
    floorApplied: null,
    ablated: null,
  };
}
