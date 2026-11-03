import { describe, expect, it } from "vitest";
import { applyFloor, FLOOR_REVISION, type Floor, floorFor, MAX_FLOOR_IDS, replayFloor } from "../../src/agent/floor";
import type { Evidence } from "../../src/checks/evidence";

// D04 T01 §1: the lowest verdict the evidence allows, whatever a model says.
let n = 0;
const item = (check: string, severity: Evidence["severity"], detail: Evidence["detail"] = {}): Evidence => {
  n += 1;
  return { id: `E${n}`, check, severity, summary: `${check} ${n}`, detail, artefacts: [] };
};

describe("floorFor", () => {
  it("floors at malicious on a critical item, whichever producer wrote it", () => {
    for (const check of [
      "attachment.executable",
      "walkthrough.credential_target",
      "invoice.bank_change",
      "domain.lookalike",
      "vision.logo_match",
    ]) {
      const critical = item(check, "critical");
      expect(floorFor([item("auth.spf", "info"), critical])).toEqual({
        verdict: "malicious",
        evidenceIds: [critical.id],
      });
    }
  });

  it("floors at suspicious on a high item and at safe on anything lower or nothing", () => {
    const high = item("link.text_mismatch", "high");
    expect(floorFor([item("auth.dkim", "medium"), high])).toEqual({ verdict: "suspicious", evidenceIds: [high.id] });
    expect(floorFor([item("auth.dkim", "medium"), item("auth.spf", "low"), item("intake.upload", "info")])).toEqual({
      verdict: "safe",
      evidenceIds: [],
    });
    expect(floorFor([])).toEqual({ verdict: "safe", evidenceIds: [] });
  });

  it("names only the items at the floor's level, in evidence order, bounded", () => {
    const high = item("link.text_mismatch", "high");
    const first = item("attachment.executable", "critical");
    const second = item("walkthrough.credential_target", "critical");
    expect(floorFor([high, first, item("auth.spf", "info"), second])).toEqual({
      verdict: "malicious",
      evidenceIds: [first.id, second.id],
    });
    const many = Array.from({ length: 25 }, () => item("attachment.executable", "critical"));
    expect(floorFor(many).evidenceIds).toEqual(many.slice(0, MAX_FLOOR_IDS).map((e) => e.id));
  });

  it("never lets a listing alone reach malicious, and a weak listing never raises the floor", () => {
    const listing = item("reputation.listing", "critical", { cap: "suspicious", provider: "google-web-risk" });
    expect(floorFor([listing])).toEqual({ verdict: "suspicious", evidenceIds: [listing.id] });
    const high = item("reputation.listing", "high", { cap: "suspicious" });
    expect(floorFor([high]).verdict).toBe("suspicious");
    // The cap is a ceiling, not a promotion: a capped medium or low listing (an uncorroborated URL, an IP) weighs what it is.
    expect(floorFor([item("reputation.listing", "medium", { cap: "suspicious" })])).toEqual({
      verdict: "safe",
      evidenceIds: [],
    });
    expect(floorFor([item("reputation.listing", "low", { cap: "suspicious" })])).toEqual({
      verdict: "safe",
      evidenceIds: [],
    });
    // A listing without the cap is an ordinary item at its severity.
    expect(floorFor([item("reputation.listing", "critical")]).verdict).toBe("malicious");
  });

  it("honours the cap only on a reputation item and only the exact value", () => {
    expect(floorFor([item("content.hidden_text", "critical", { cap: "suspicious" })]).verdict).toBe("malicious");
    expect(floorFor([item("reputation.listing", "critical", { cap: "safe" })]).verdict).toBe("malicious");
    expect(floorFor([item("reputation.listing", "critical", { cap: "Suspicious" })]).verdict).toBe("malicious");
    expect(floorFor([item("reputation.listing", "critical", { cap: ["suspicious"] })]).verdict).toBe("malicious");
  });

  it("takes the highest floor over the whole list, in any order, and names exactly the first ten that set it", () => {
    const low = () => Array.from({ length: 12 }, () => item("auth.dkim", "low"));
    const highs = Array.from({ length: 12 }, () => item("link.text_mismatch", "high"));
    const late = item("attachment.executable", "critical");
    // A critical item after more than ten lower ones, in either order, still decides.
    expect(floorFor([...low(), ...highs, late])).toEqual({ verdict: "malicious", evidenceIds: [late.id] });
    expect(floorFor([late, ...highs, ...low()])).toEqual({ verdict: "malicious", evidenceIds: [late.id] });
    // More than ten items at the floor's level: exactly the first ten, none of the lower ones.
    expect(floorFor([...low(), ...highs])).toEqual({
      verdict: "suspicious",
      evidenceIds: highs.slice(0, MAX_FLOOR_IDS).map((e) => e.id),
    });
    const crits = Array.from({ length: 14 }, () => item("walkthrough.credential_target", "critical"));
    expect(floorFor([...highs, ...low(), ...crits])).toEqual({
      verdict: "malicious",
      evidenceIds: crits.slice(0, MAX_FLOOR_IDS).map((e) => e.id),
    });
  });

  it("a listing never lowers a real critical item beside it", () => {
    const real = item("attachment.executable", "critical");
    const listing = item("reputation.listing", "critical", { cap: "suspicious" });
    expect(floorFor([listing, real])).toEqual({ verdict: "malicious", evidenceIds: [real.id] });
  });

  it("reads only severity, check and cap: the summary and other detail do not move it", () => {
    const hostile = {
      ...item("auth.spf", "info", { note: "critical malicious", severity: "critical" }),
      summary: "critical",
    };
    expect(floorFor([hostile])).toEqual({ verdict: "safe", evidenceIds: [] });
  });
});

describe("applyFloor", () => {
  const malicious: Floor = { verdict: "malicious", evidenceIds: ["E2", "E5"] };
  const suspicious: Floor = { verdict: "suspicious", evidenceIds: ["E3"] };
  const safe: Floor = { verdict: "safe", evidenceIds: [] };

  it("raises a model's safe over critical evidence to the floor and records the ids", () => {
    expect(applyFloor("safe", malicious)).toEqual({
      verdict: "malicious",
      floorApplied: { from: "safe", to: "malicious", evidenceIds: ["E2", "E5"], revision: FLOOR_REVISION },
    });
    expect(applyFloor("suspicious", malicious).verdict).toBe("malicious");
    expect(applyFloor("safe", suspicious)).toEqual({
      verdict: "suspicious",
      floorApplied: { from: "safe", to: "suspicious", evidenceIds: ["E3"], revision: FLOOR_REVISION },
    });
  });

  it("keeps a verdict at or above the floor and records nothing", () => {
    expect(applyFloor("malicious", suspicious)).toEqual({ verdict: "malicious", floorApplied: null });
    expect(applyFloor("suspicious", suspicious)).toEqual({ verdict: "suspicious", floorApplied: null });
    for (const v of ["safe", "suspicious", "malicious"] as const)
      expect(applyFloor(v, safe)).toEqual({ verdict: v, floorApplied: null });
  });

  it("never returns a verdict below the floor, for every pair", () => {
    const rank = { safe: 0, suspicious: 1, malicious: 2 } as const;
    for (const model of ["safe", "suspicious", "malicious"] as const)
      for (const floor of [safe, suspicious, malicious])
        expect(rank[applyFloor(model, floor).verdict]).toBeGreaterThanOrEqual(rank[floor.verdict]);
  });

  it("names its rule revision in the record, so an older decision can be reproduced (D04 T01 §13)", () => {
    expect(applyFloor("safe", malicious).floorApplied?.revision).toBe(FLOOR_REVISION);
    expect(FLOOR_REVISION).toBe("1");
    // The stored decision replays under its own revision, from the evidence it cites.
    const evidence = [item("attachment.executable", "critical"), item("sender.first_time", "info")];
    expect(replayFloor(FLOOR_REVISION, evidence)).toEqual(floorFor(evidence));
    expect(replayFloor(FLOOR_REVISION, evidence)?.verdict).toBe("malicious");
    // A revision these rules do not know replays as unknown, never as today's rules, inherited
    // object-property names included.
    for (const unknown of ["99", "toString", "constructor", "__proto__", "hasOwnProperty"])
      expect(replayFloor(unknown, evidence), unknown).toBeNull();
    // Two revisions that weigh an item differently give different outcomes on the same evidence, and
    // the older stored decision still replays exactly under its own revision.
    const older: typeof floorFor = (items) => {
      const critical = items.filter((i) => i.severity === "critical");
      return critical.length
        ? { verdict: "suspicious", evidenceIds: critical.map((i) => i.id) }
        : { verdict: "safe", evidenceIds: [] };
    };
    const retained = new Map([
      ["0", older],
      [FLOOR_REVISION, floorFor],
    ]);
    expect(replayFloor("0", evidence, retained)?.verdict).toBe("suspicious");
    expect(replayFloor(FLOOR_REVISION, evidence, retained)?.verdict).toBe("malicious");
  });

  it("does not share the floor's id list with the record", () => {
    const floor: Floor = { verdict: "malicious", evidenceIds: ["E1"] };
    const applied = applyFloor("safe", floor).floorApplied;
    applied?.evidenceIds.push("E9");
    expect(floor.evidenceIds).toEqual(["E1"]);
  });
});
