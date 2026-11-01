import { describe, expect, it } from "vitest";
import { CONFIDENCE, MAX_REASONS, NO_HEADERS_CONFIDENCE_CAP, ruleVerdict } from "../../src/agent/rule-verdict";
import type { CaseView } from "../../src/checks/case-view";
import type { Evidence } from "../../src/checks/evidence";
import { checks as registry } from "../../src/checks/index";
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

  it("never calls a case with low or medium findings clean: it says there is no clear sign of fraud and points at them", () => {
    const medium = item("link.text_mismatch", "medium", "A link text differs from where it goes");
    const view = ruleVerdict([item("auth.spf", "info"), medium], WITH_HEADERS);
    expect(view).toMatchObject({
      verdict: "safe",
      headline: "No clear sign of fraud, but some points are worth a look",
      reasons: [{ text: "A link text differs from where it goes", evidenceIds: [medium.id] }],
    });
    expect(`${view.headline} ${view.meaning}`).not.toMatch(/No warning signs|nothing wrong/);
    expect(view.confidence).toBe(CONFIDENCE.safe);
    const low = ruleVerdict([item("auth.spf", "low", "SPF softfailed")], WITH_HEADERS);
    expect(low.headline).toBe("No clear sign of fraud, but some points are worth a look");
  });

  it("keeps a cited reason for what could not run beside lesser findings, within three reasons", () => {
    const medium1 = item("auth.dkim", "medium", "DKIM missing");
    const medium2 = item("link.text_mismatch", "medium", "A link goes elsewhere");
    const low = item("auth.spf", "low", "SPF softfailed");
    const broke = item("not_checked", "info", "The domain age check timed out");
    const view = ruleVerdict([medium1, medium2, low, broke], WITH_HEADERS);
    expect(view.headline).toBe(
      "No clear sign of fraud, but some points are worth a look and some checks could not run",
    );
    expect(view.confidence).toBe(NO_HEADERS_CONFIDENCE_CAP);
    expect(view.reasons).toEqual([
      { text: "DKIM missing", evidenceIds: [medium1.id] },
      { text: "A link goes elsewhere", evidenceIds: [medium2.id] },
      { text: "The domain age check timed out", evidenceIds: [broke.id] },
    ]);
    // With a single finding the unchecked item follows it; with none it stands alone.
    expect(ruleVerdict([medium1, broke], WITH_HEADERS).reasons.map((r) => r.evidenceIds[0])).toEqual([
      medium1.id,
      broke.id,
    ]);
  });

  it("treats a check's own coverage item as unrun checks, from real producer output", async () => {
    // The links check's output when it read only part of the message: informational, `detail.checked === false`.
    const check = registry.all().find((c) => c.name === "link.text_mismatch");
    const drafts = await check?.run(
      {
        links: { items: [], more: 3, unread: [{ key: "k", why: "encrypted" }] },
      } as unknown as CaseView,
      new AbortController().signal,
    );
    expect(drafts?.length).toBeGreaterThan(0);
    const real = (drafts ?? []).map((d, i) => ({ ...d, id: `E${i + 1}` }));
    expect(real[0]).toMatchObject({ severity: "info", detail: { checked: false } });
    const view = ruleVerdict(real, WITH_HEADERS);
    expect(view).toMatchObject({
      verdict: "safe",
      headline: "No warning signs were found, but some checks could not run",
      confidence: NO_HEADERS_CONFIDENCE_CAP,
    });
    expect(view.reasons[0]).toMatchObject({ evidenceIds: ["E1"] });
    // The same shape from the domain age check.
    const age = item("domain.age", "info", "Ages not checked: no registration date.");
    age.detail = { checked: false };
    expect(ruleVerdict([age], WITH_HEADERS)).toMatchObject({
      confidence: NO_HEADERS_CONFIDENCE_CAP,
      reasons: [{ evidenceIds: [age.id] }],
    });
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
