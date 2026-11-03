// The deterministic floor (D04 T01 §1; design spec 4.3a and 4.6): the lowest verdict a case's evidence allows, whatever
// a model says. A `critical` item floors the case at malicious and a `high` item at suspicious; the model may raise the
// verdict above the floor and never lower it below. The floor reads only each item's severity, check name and a listing's
// `cap`, never its summary or other free text, so hostile mail content cannot move it. Pure: no I/O, no clock.

import type { Evidence } from "../checks/evidence";
import type { Verdict } from "../db/cases";

// Safe < suspicious < malicious.
const RANK: Record<Verdict, number> = { safe: 0, suspicious: 1, malicious: 2 };
export const MAX_FLOOR_IDS = 10;

export type Floor = { verdict: Verdict; evidenceIds: string[] };
// The revision of these floor rules (weights and triggers above), changed with any change to them, so a
// stored floor record names the rules that produced it and an old decision can be reproduced (D04 T01 §13).
export const FLOOR_REVISION = "1";
export type FloorApplied = { from: Verdict; to: Verdict; evidenceIds: string[]; revision?: string };

// What an item weighs: a reputation listing marked `cap = "suspicious"` (D02 T06 §4) weighs the lower of its own
// severity and high, so a listing alone never floors at malicious (spec 4.3a) and a weak listing (medium or low) never
// raises the floor. A `cap` on any other check, or any other value, is ignored.
function weight(item: Pick<Evidence, "check" | "severity" | "detail">): Verdict {
  const capped = item.check.startsWith("reputation.") && item.detail.cap === "suspicious";
  if (item.severity === "critical") return capped ? "suspicious" : "malicious";
  return item.severity === "high" ? "suspicious" : "safe";
}

export function floorFor(evidence: readonly Pick<Evidence, "id" | "check" | "severity" | "detail">[]): Floor {
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
      revision: FLOOR_REVISION,
    },
  };
}
