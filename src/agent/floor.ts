// The deterministic floor (D04 T01 §1; design spec 4.3a and 4.6): the lowest verdict a case's evidence allows, whatever
// a model says. A `critical` item floors the case at malicious and a `high` item at suspicious; the model may raise the
// verdict above the floor and never lower it below. The floor reads only each item's severity, check name and a listing's
// `cap`, never its summary or other free text, so hostile mail content cannot move it. Pure: no I/O, no clock.

import {
  addEvidence,
  type CheckOutcome,
  type Evidence,
  type EvidenceDraft,
  readEvidence,
  unplain,
} from "../checks/evidence";
import type { Verdict } from "../db/cases";

// Safe < suspicious < malicious.
const RANK: Record<Verdict, number> = { safe: 0, suspicious: 1, malicious: 2 };
export const MAX_FLOOR_IDS = 10;
const EVIDENCE_ID = /^E[1-9][0-9]*$/;
const MAX_OUTCOME_REASON_CHARS = 200;
const MAX_PARTIAL_REASON_CHARS = 900;
const MAX_PARTIAL_SUMMARY_CHARS = 200;
const DEFAULT_PARTIAL_REASON = "part of the attachment could not be read";

export type PartialOutcome = Pick<CheckOutcome, "check" | "outcome" | "reason">;
export type PartialReason = { text: string; evidenceIds: string[] };
export type Floor = {
  verdict: Verdict;
  evidenceIds: string[];
  partialReason?: PartialReason;
  revision?: string;
};
// The revision of the severity-only floor rules (D04 T01 §13), and the revision that adds partial
// attachment outcomes (D04 T01 §8). Both stay in FLOOR_RULES so any stored record can be replayed.
export const FLOOR_REVISION = "1";
export const FLOOR_PARTIAL_REVISION = "2";
export type FloorApplied = { from: Verdict; to: Verdict; evidenceIds: string[]; revision?: string };

// What an item weighs: a reputation listing marked `cap = "suspicious"` (D02 T06 §4) weighs the lower of its own
// severity and high, so a listing alone never floors at malicious (spec 4.3a) and a weak listing (medium or low) never
// raises the floor. A `cap` on any other check, or any other value, is ignored.
function weight(item: Pick<Evidence, "check" | "severity" | "detail">): Verdict {
  const capped = item.check.startsWith("reputation.") && item.detail.cap === "suspicious";
  if (item.severity === "critical") return capped ? "suspicious" : "malicious";
  return item.severity === "high" ? "suspicious" : "safe";
}

export function sanitizePartialReason(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_PARTIAL_REASON;
  const plain = Array.from(raw)
    .map((ch) => (unplain(ch) ? " " : ch))
    .join("")
    .replace(/\[E\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return DEFAULT_PARTIAL_REASON;
  const chars = Array.from(plain);
  return chars.length <= MAX_OUTCOME_REASON_CHARS
    ? plain
    : `${chars.slice(0, MAX_OUTCOME_REASON_CHARS - 3).join("")}...`;
}

export function formatPartialReasonText(partials: readonly { check: string; reason: string }[]): string {
  const groups = new Map<string, string[]>();
  for (const entry of partials) {
    const list = groups.get(entry.reason) ?? [];
    if (!list.includes(entry.check)) list.push(entry.check);
    groups.set(entry.reason, list);
  }
  const clauses = [...groups.entries()].map(([reason, names]) => `${names.join(", ")}: ${reason}`);
  const full = `Attachment check partial (${clauses.join("; ")}).`;
  const chars = Array.from(full);
  return chars.length <= MAX_PARTIAL_REASON_CHARS
    ? full
    : `${chars.slice(0, MAX_PARTIAL_REASON_CHARS - 5).join("")}...).`;
}

function formatPartialSummary(check: string, reason: string): string {
  const full = `Attachment check ${check} was partial: ${reason}.`;
  const chars = Array.from(full);
  return chars.length <= MAX_PARTIAL_SUMMARY_CHARS
    ? full
    : `${chars.slice(0, MAX_PARTIAL_SUMMARY_CHARS - 3).join("")}...`;
}

function floorForV1(evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[]): Floor {
  const weighed = evidence.map((item) => ({ id: item.id, verdict: weight(item) }));
  const verdict = weighed.reduce<Verdict>((top, w) => (RANK[w.verdict] > RANK[top] ? w.verdict : top), "safe");
  // The ids that set the floor: the items at its level, in evidence order, at most MAX_FLOOR_IDS.
  const evidenceIds =
    verdict === "safe"
      ? []
      : weighed
          .filter((w) => w.verdict === verdict)
          .map((w) => w.id)
          .slice(0, MAX_FLOOR_IDS);
  return { verdict, evidenceIds };
}

// The floor rules by revision, kept so a stored record's decision can be reproduced after the rules
// change (D04 T01 §13): when the weights or triggers change, the old implementation stays here under its
// revision and FLOOR_PARTIAL_REVISION names the outcome-aware one. An unknown revision replays as null.
export type FloorRules = (
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[],
  outcomes?: readonly PartialOutcome[] | null,
) => Floor;
const FLOOR_RULES: ReadonlyMap<string, FloorRules> = new Map<string, FloorRules>([
  [FLOOR_REVISION, (evidence) => floorForV1(evidence)],
  [FLOOR_PARTIAL_REVISION, (evidence, outcomes) => floorFor(evidence, outcomes)],
]);

export function replayFloor(
  revision: string,
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[],
  rules: ReadonlyMap<string, FloorRules> = FLOOR_RULES,
  outcomes?: readonly PartialOutcome[] | null,
): Floor | null {
  const replay = rules.get(revision);
  return replay ? replay(evidence, outcomes) : null;
}

function collectPartialAttachments(
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[],
  outcomes?: readonly PartialOutcome[] | null,
): { partials: { check: string; reason: string }[]; supportingIds: string[] } {
  const byCheck = new Map<string, string>();
  for (const outcome of outcomes ?? []) {
    if (outcome.outcome === "partial" && outcome.check.startsWith("attachment.")) {
      if (!byCheck.has(outcome.check)) byCheck.set(outcome.check, sanitizePartialReason(outcome.reason));
    }
  }
  for (const item of evidence) {
    if (
      item.check === "agent.partial_check" &&
      item.detail.checked === false &&
      typeof item.detail.check === "string" &&
      item.detail.check.startsWith("attachment.")
    ) {
      if (!byCheck.has(item.detail.check)) byCheck.set(item.detail.check, sanitizePartialReason(item.detail.reason));
    }
  }
  if (byCheck.size === 0) return { partials: [], supportingIds: [] };
  const partialChecks = new Set(byCheck.keys());
  const supportingIds: string[] = [];
  for (const item of evidence) {
    if (!EVIDENCE_ID.test(item.id)) continue;
    const isAgentPartial =
      item.check === "agent.partial_check" &&
      item.detail.checked === false &&
      typeof item.detail.check === "string" &&
      partialChecks.has(item.detail.check);
    const isCheckPartial = partialChecks.has(item.check) && item.detail.checked === false;
    if ((isAgentPartial || isCheckPartial) && !supportingIds.includes(item.id)) {
      supportingIds.push(item.id);
    }
  }
  if (supportingIds.length === 0) {
    for (const item of evidence) {
      if (!EVIDENCE_ID.test(item.id)) continue;
      if (
        (partialChecks.has(item.check) || (item.check.startsWith("attachment.") && item.detail.checked === false)) &&
        !supportingIds.includes(item.id)
      ) {
        supportingIds.push(item.id);
      }
    }
  }
  const partials = [...byCheck.entries()].map(([check, reason]) => ({ check, reason }));
  return { partials, supportingIds: supportingIds.slice(0, MAX_FLOOR_IDS) };
}

export function floorFor(
  evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[],
  outcomes?: readonly PartialOutcome[] | null,
): Floor {
  const base = floorForV1(evidence);
  const { partials, supportingIds } = collectPartialAttachments(evidence, outcomes);
  if (partials.length === 0) return base;
  const text = formatPartialReasonText(partials);
  const partialReason: PartialReason | undefined =
    supportingIds.length > 0 ? { text, evidenceIds: supportingIds } : undefined;
  if (base.verdict === "malicious") {
    return base;
  }
  const combinedIds =
    base.verdict === "suspicious"
      ? [...base.evidenceIds, ...supportingIds.filter((id) => !base.evidenceIds.includes(id))].slice(0, MAX_FLOOR_IDS)
      : supportingIds;
  return {
    verdict: "suspicious",
    evidenceIds: combinedIds,
    ...(partialReason ? { partialReason } : {}),
    revision: FLOOR_PARTIAL_REVISION,
  };
}

// Ensures every partial `attachment.*` check outcome has a supporting evidence row on the case before the
// floor, rule verdict or agent runs (D04 T01 §8 plan review): when a partial attachment check emitted no
// `checked: false` evidence item of its own, this persists an `agent.partial_check` info row so the
// partial-attachment reason cites a real, descriptive Evidence ID rather than an unrelated row.
export async function ensurePartialAttachmentEvidence(
  db: D1Database,
  caseId: string,
  evidence: readonly Evidence[],
  outcomes: readonly PartialOutcome[] | null | undefined,
): Promise<Evidence[]> {
  const partialOutcomes = (outcomes ?? []).filter((o) => o.outcome === "partial" && o.check.startsWith("attachment."));
  if (partialOutcomes.length === 0) return [...evidence];
  const missing: { check: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const o of partialOutcomes) {
    if (seen.has(o.check)) continue;
    seen.add(o.check);
    const hasSupport = evidence.some(
      (e) =>
        (e.check === o.check && e.detail.checked === false) ||
        (e.check === "agent.partial_check" && e.detail.checked === false && e.detail.check === o.check),
    );
    if (!hasSupport) {
      missing.push({ check: o.check, reason: sanitizePartialReason(o.reason) });
    }
  }
  if (missing.length === 0) return [...evidence];
  const existingAgent: EvidenceDraft[] = evidence
    .filter((e) => e.check.startsWith("agent."))
    .map(({ id: _id, ...draft }) => draft);
  const additions: EvidenceDraft[] = missing.map(({ check, reason }) => ({
    check: "agent.partial_check",
    severity: "info",
    summary: formatPartialSummary(check, reason),
    detail: { checked: false, check, reason },
    artefacts: [],
  }));
  await addEvidence(db, caseId, "agent", [...existingAgent, ...additions]);
  return readEvidence(db, caseId);
}

// The more severe of the model's verdict and the floor, and a record of the raise when the floor decided.
export function applyFloor(
  modelVerdict: Verdict,
  floor: Floor,
): { verdict: Verdict; floorApplied: FloorApplied | null } {
  if (RANK[modelVerdict] >= RANK[floor.verdict]) return { verdict: modelVerdict, floorApplied: null };
  return {
    verdict: floor.verdict,
    floorApplied: {
      from: modelVerdict,
      to: floor.verdict,
      evidenceIds: [...floor.evidenceIds],
      revision: floor.revision ?? FLOOR_REVISION,
    },
  };
}
