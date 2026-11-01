import { describe, expect, it } from "vitest";
import { CONFIDENCE, MAX_REASONS, NO_HEADERS_CONFIDENCE_CAP, ruleVerdict } from "../../src/agent/rule-verdict";
import type { Evidence } from "../../src/checks/evidence";
import { VerdictView } from "../../src/db/verdicts";

// D04 T01 §2: a verdict from the evidence and fixed rules alone.
let n = 0;
const item = (check: string, severity: Evidence["severity"], summary = `${check} said so`): Evidence => {
  n += 1;
  return { id: `E${n}`, check, severity, summary, detail: {}, artefacts: [] };
};
const WITH_HEADERS = { headersAvailable: true };

describe("ruleVerdict", () => {
  it("is the floor's verdict, labelled as the rules', and always a valid stored view", () => {
    const critical = item("attachment.executable", "critical", "A program is attached");
    const high = item("link.text_mismatch", "high", "A link goes elsewhere");
    for (const [evidence, verdict] of [
      [[critical, high], "malicious"],
      [[high], "suspicious"],
      [[item("auth.spf", "low")], "safe"],
      [[], "safe"],
    ] as const) {
      const view = ruleVerdict(evidence, WITH_HEADERS);
      expect(view).toMatchObject({ verdict, source: "rules", confidence: CONFIDENCE[verdict] });
      expect(VerdictView.safeParse(view).success).toBe(true);
    }
  });

  it("cites the top three findings by severity, then evidence order, with their ids", () => {
    const low = item("auth.spf", "low", "SPF softfailed");
    const medium1 = item("auth.dkim", "medium", "DKIM missing");
    const high = item("link.text_mismatch", "high", "A link goes elsewhere");
    const medium2 = item("sender.first_time", "medium", "First message from this sender");
    const critical = item("attachment.executable", "critical", "A program is attached");
    const view = ruleVerdict([low, medium1, high, medium2, critical], WITH_HEADERS);
    expect(view.reasons).toEqual([
      { text: "A program is attached", evidenceIds: [critical.id] },
      { text: "A link goes elsewhere", evidenceIds: [high.id] },
      { text: "DKIM missing", evidenceIds: [medium1.id] },
    ]);
    expect(view.reasons).toHaveLength(MAX_REASONS);
  });

  it("leaves informational items out, and gives empty evidence a safe verdict with no reasons", () => {
    const view = ruleVerdict(
      [item("intake.forward", "info", "Forwarded by the member"), item("auth.spf", "info")],
      WITH_HEADERS,
    );
    expect(view).toMatchObject({ verdict: "safe", reasons: [] });
    expect(ruleVerdict([], WITH_HEADERS)).toMatchObject({ verdict: "safe", reasons: [], source: "rules" });
  });

  it("caps confidence at 0.5 when the original headers were not available, never raising a lower one", () => {
    const critical = item("attachment.executable", "critical");
    expect(ruleVerdict([critical], WITH_HEADERS).confidence).toBe(CONFIDENCE.malicious);
    expect(ruleVerdict([critical], { headersAvailable: false }).confidence).toBe(NO_HEADERS_CONFIDENCE_CAP);
    expect(ruleVerdict([], { headersAvailable: false }).confidence).toBe(NO_HEADERS_CONFIDENCE_CAP);
    expect(NO_HEADERS_CONFIDENCE_CAP).toBeLessThanOrEqual(CONFIDENCE.safe);
  });

  it("marks a safe verdict from a run with a check that could not run as partial, citing what could not run", () => {
    const broke = item("not_checked", "info", "The domain age check timed out");
    const clean = item("auth.spf", "info", "SPF passed");
    const view = ruleVerdict([clean, broke], WITH_HEADERS);
    expect(view).toMatchObject({
      verdict: "safe",
      headline: "No warning signs were found, but some checks could not run",
      confidence: NO_HEADERS_CONFIDENCE_CAP,
      reasons: [{ text: "The domain age check timed out", evidenceIds: [broke.id] }],
    });
    expect(view.meaning).toContain("some checks could not run");
    // A finding wins the reasons, and a suspicious verdict keeps its own headline.
    const high = item("link.text_mismatch", "high", "A link goes elsewhere");
    const suspicious = ruleVerdict([broke, high], WITH_HEADERS);
    expect(suspicious.headline).not.toContain("could not run");
    expect(suspicious.reasons).toEqual([{ text: "A link goes elsewhere", evidenceIds: [high.id] }]);
    expect(suspicious.confidence).toBe(CONFIDENCE.suspicious);
  });

  it("takes any citation marker out of a reason's words and never cites an item with no words left", () => {
    const marked = item("link.text_mismatch", "high", "See [E3] and [E12] for the link");
    const bare = item("sender.display_brand", "high", "[E1]");
    const view = ruleVerdict([marked, bare], WITH_HEADERS);
    expect(view.reasons).toEqual([{ text: "See and for the link", evidenceIds: [marked.id] }]);
    expect(VerdictView.safeParse(view).success).toBe(true);
  });

  it("states one fixed headline, set of actions and meaning per verdict", () => {
    const sets = (["malicious", "suspicious", "safe"] as const).map((verdict) => {
      const evidence =
        verdict === "malicious"
          ? [item("attachment.executable", "critical")]
          : verdict === "suspicious"
            ? [item("link.text_mismatch", "high")]
            : [];
      const view = ruleVerdict(evidence, WITH_HEADERS);
      expect(view.actions.length).toBeGreaterThan(0);
      expect(view.meaning).toMatch(/^[^.!?]+[.!?]$/);
      return [view.headline, view.actions.join("|"), view.meaning];
    });
    expect(new Set(sets.map((s) => s[0])).size).toBe(3);
    expect(new Set(sets.map((s) => s[1])).size).toBe(3);
    expect(new Set(sets.map((s) => s[2])).size).toBe(3);
  });

  it("does not move on hostile words in a summary: the verdict comes from severity alone", () => {
    const words = item("auth.spf", "info", "critical malicious phishing scam");
    expect(ruleVerdict([words], WITH_HEADERS).verdict).toBe("safe");
  });
});
