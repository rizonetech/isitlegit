import { describe, expect, it } from "vitest";
import { floorFor } from "../../src/agent/floor";
import {
  CONFIDENCE,
  FLOOR_CONSEQUENCES,
  MAX_REASONS,
  MEANINGS,
  NO_HEADERS_CONFIDENCE_CAP,
  PARTIAL_MEANING,
  ruleVerdict,
} from "../../src/agent/rule-verdict";
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
    const medium = item("domain.age", "medium", "The sending domain was registered recently");
    const view = ruleVerdict([item("auth.spf", "info"), medium], WITH_HEADERS);
    expect(view).toMatchObject({
      verdict: "safe",
      headline: "No clear sign of fraud, but some points are worth a look",
      reasons: [{ text: "The sending domain was registered recently", evidenceIds: [medium.id] }],
    });
    expect(`${view.headline} ${view.meaning}`).not.toMatch(/No warning signs|nothing wrong/);
    expect(view.confidence).toBe(CONFIDENCE.safe);
    const low = ruleVerdict([item("auth.spf", "low", "SPF softfailed")], WITH_HEADERS);
    expect(low.headline).toBe("No clear sign of fraud, but some points are worth a look");
  });

  it("keeps a cited reason for what could not run beside lesser findings, within three reasons", () => {
    const medium1 = item("auth.dkim", "medium", "DKIM missing");
    const medium2 = item("domain.age", "medium", "A link goes elsewhere");
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

  it("calls a medium finding from the impersonation checks suspicious, and the redirect checks only in pairs", () => {
    for (const check of ["sender.display_address", "sender.display_brand", "link.text_mismatch"]) {
      const finding = item(check, "medium", "The sender is not who the name says");
      expect(floorFor([finding]).verdict).toBe("safe"); // the floor is untouched
      expect(ruleVerdict([finding], WITH_HEADERS)).toMatchObject({
        verdict: "suspicious",
        reasons: [{ evidenceIds: [finding.id] }],
      });
      // The same check at low is not enough; a malicious floor is not lowered.
      expect(ruleVerdict([item(check, "low")], WITH_HEADERS).verdict).toBe("safe");
      expect(ruleVerdict([finding, item("attachment.executable", "critical")], WITH_HEADERS).verdict).toBe("malicious");
    }
    for (const check of ["auth.dkim", "sender.first_time", "domain.age", "sender.reply_to"])
      expect(ruleVerdict([item(check, "medium")], WITH_HEADERS).verdict).toBe("safe");
    // A legitimate tracking link ends on another site: alone, a changed final domain or a lure button is not enough,
    // however many items the one check gives.
    const changed = item("link.final_domain_changed", "medium", "The link ends at a different site");
    const lure = [1, 2, 3].map(() => item("link.lure_button", "medium", "The page holds only a Log in button"));
    expect(ruleVerdict([changed], WITH_HEADERS).verdict).toBe("safe");
    expect(ruleVerdict(lure, WITH_HEADERS).verdict).toBe("safe");
    // Two distinct checks of the family are: the production case with a final-domain change and lure buttons.
    expect(ruleVerdict([item("sender.first_time", "low"), changed, ...lure], WITH_HEADERS).verdict).toBe("suspicious");
  });

  it("puts the findings that made a verdict suspicious among its three reasons, whatever else came first", () => {
    const noise = ["domain.age", "auth.dkim", "sender.first_time"].map((c) => item(c, "medium", `${c} said so`));
    const trigger = item("sender.display_brand", "medium", "The name says DocuSign, the domain is not");
    const view = ruleVerdict([...noise, trigger], WITH_HEADERS);
    expect(view.verdict).toBe("suspicious");
    expect(view.reasons).toHaveLength(MAX_REASONS);
    expect(view.reasons[0]).toEqual({ text: "The name says DocuSign, the domain is not", evidenceIds: [trigger.id] });
    // Two checks of the family: one reason for each, both first.
    const a = item("link.final_domain_changed", "medium", "ends elsewhere");
    const b = item("link.lure_button", "medium", "only a button");
    const pair = ruleVerdict([...noise, a, b], WITH_HEADERS);
    expect(pair.verdict).toBe("suspicious");
    expect(pair.reasons.slice(0, 2).map((r) => r.evidenceIds[0])).toEqual([a.id, b.id]);
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

  it("keeps the incomplete-check warning, the capped confidence and the coverage reason when the family rule promotes a verdict", () => {
    const trigger = item("sender.display_brand", "medium", "The name says DocuSign, the domain is not");
    const broke = item("not_checked", "info", "The domain age check timed out");
    const view = ruleVerdict([trigger, broke], WITH_HEADERS);
    expect(view.verdict).toBe("suspicious");
    expect(view.confidence).toBe(NO_HEADERS_CONFIDENCE_CAP);
    expect(view.headline).not.toContain("No warning signs");
    expect(view.reasons.map((r) => r.evidenceIds[0])).toEqual([trigger.id, broke.id]);
    // A verdict the floor itself raised keeps its own confidence, as before.
    const high = item("link.text_mismatch", "high", "A link goes elsewhere");
    expect(ruleVerdict([high, broke], WITH_HEADERS).confidence).toBe(CONFIDENCE.suspicious);
  });

  it("maps floor-raising evidence to message-specific consequence sentences and falls back when unsupported (D04 T01 §16)", () => {
    const withDetail = (
      check: string,
      severity: Evidence["severity"],
      detail: Evidence["detail"],
      summary = `${check} finding`,
    ): Evidence => ({
      ...item(check, severity, summary),
      detail,
    });

    // 1. All four consequence families map to distinct, schema-valid sentences with no message values
    const credView = ruleVerdict([withDetail("walkthrough.credential_target", "critical", {})], WITH_HEADERS);
    const bankView = ruleVerdict([withDetail("invoice.bank_changed", "critical", {})], WITH_HEADERS);
    const malwareView = ruleVerdict([withDetail("attachment.executable", "critical", {})], WITH_HEADERS);
    const lookalikeView = ruleVerdict([withDetail("domain.lookalike", "high", {})], WITH_HEADERS);

    expect(credView.meaning).toBe(FLOOR_CONSEQUENCES.credential);
    expect(bankView.meaning).toBe(FLOOR_CONSEQUENCES.bank);
    expect(malwareView.meaning).toBe(FLOOR_CONSEQUENCES.malware);
    expect(lookalikeView.meaning).toBe(FLOOR_CONSEQUENCES.lookalike);
    expect(new Set([credView.meaning, bankView.meaning, malwareView.meaning, lookalikeView.meaning]).size).toBe(4);
    for (const v of [credView, bankView, malwareView, lookalikeView]) {
      expect(VerdictView.safeParse(v).success).toBe(true);
      expect(v.floorApplied).toBeNull();
    }

    // 2. Competing families at the floor level resolve in evidence order
    const credThenBank = ruleVerdict(
      [withDetail("walkthrough.credential_target", "critical", {}), withDetail("invoice.bank_changed", "critical", {})],
      WITH_HEADERS,
    );
    const bankThenCred = ruleVerdict(
      [withDetail("invoice.bank_changed", "critical", {}), withDetail("walkthrough.credential_target", "critical", {})],
      WITH_HEADERS,
    );
    expect(credThenBank.meaning).toBe(FLOOR_CONSEQUENCES.credential);
    expect(bankThenCred.meaning).toBe(FLOOR_CONSEQUENCES.bank);

    // 3. Mapped item below the actual floor level does not choose the consequence sentence
    const lookalikeBelowCriticalUnmapped = ruleVerdict(
      [withDetail("domain.lookalike", "high", {}), withDetail("reputation.listing", "critical", {})],
      WITH_HEADERS,
    );
    expect(lookalikeBelowCriticalUnmapped.verdict).toBe("malicious");
    expect(lookalikeBelowCriticalUnmapped.meaning).toBe(MEANINGS.malicious);

    // 4. Counterexamples whose structured facts do not establish the specific consequence fall back to MEANINGS[verdict]
    const visionPay = ruleVerdict([withDetail("vision.requested_action", "high", { action: "pay" })], WITH_HEADERS);
    expect(visionPay.verdict).toBe("suspicious");
    expect(visionPay.meaning).toBe(MEANINGS.suspicious);

    const visionLogIn = ruleVerdict(
      [withDetail("vision.requested_action", "high", { action: "log_in" })],
      WITH_HEADERS,
    );
    expect(visionLogIn.meaning).toBe(FLOOR_CONSEQUENCES.credential);

    const supplierDomainChanged = ruleVerdict(
      [withDetail("invoice.supplier_domain_changed", "critical", {})],
      WITH_HEADERS,
    );
    expect(supplierDomainChanged.verdict).toBe("malicious");
    expect(supplierDomainChanged.meaning).toBe(MEANINGS.malicious);

    const brandMismatchOnly = ruleVerdict([withDetail("vision.brand_domain_mismatch", "high", {})], WITH_HEADERS);
    expect(brandMismatchOnly.verdict).toBe("suspicious");
    expect(brandMismatchOnly.meaning).toBe(MEANINGS.suspicious);

    // HTML attachment with passwordField === true maps to credential; card-only / smuggling or unchecked HTML falls back
    const htmlWithPassword = ruleVerdict(
      [withDetail("attachment.html", "high", { passwordField: true, cardField: false })],
      WITH_HEADERS,
    );
    expect(htmlWithPassword.meaning).toBe(FLOOR_CONSEQUENCES.credential);

    const htmlCardOnly = ruleVerdict(
      [withDetail("attachment.html", "high", { passwordField: false, cardField: true })],
      WITH_HEADERS,
    );
    expect(htmlCardOnly.meaning).toBe(MEANINGS.suspicious);

    const htmlUncheckedPartial = ruleVerdict([withDetail("attachment.html", "info", { checked: false, unread: 1 })], {
      headersAvailable: true,
      outcomes: [{ check: "attachment.html", outcome: "partial", reason: "1 more web-page attachment not read" }],
    });
    expect(htmlUncheckedPartial.verdict).toBe("suspicious");
    expect(htmlUncheckedPartial.meaning).toBe(MEANINGS.suspicious);

    // Encrypted archive alone establishes unreadable contents, not executable code -> falls back to generic suspicious meaning
    const encryptedArchiveOnly = ruleVerdict(
      [
        withDetail("attachment.encrypted_archive", "high", {
          filename: "invoice.zip",
          findings: [{ kind: "encrypted", where: "invoice.zip", by: "content", how: "encrypted", type: "zip" }],
        }),
      ],
      WITH_HEADERS,
    );
    expect(encryptedArchiveOnly.verdict).toBe("suspicious");
    expect(encryptedArchiveOnly.meaning).toBe(MEANINGS.suspicious);

    // Voice change_bank_details request alone does not claim a supplier-record mismatch
    const voiceBankRequestOnly = ruleVerdict(
      [withDetail("voice.request", "critical", { request: "change_bank_details", quote: "pay into our new account" })],
      WITH_HEADERS,
    );
    expect(voiceBankRequestOnly.verdict).toBe("malicious");
    expect(voiceBankRequestOnly.meaning).toBe(MEANINGS.malicious);

    // Return-Path-only lookalike does not claim replying or following links reaches the lookalike domain
    const returnPathOnlyLookalike = ruleVerdict(
      [withDetail("domain.lookalike", "high", { domain: "fynb0s.co.za", fields: ["Return-Path"] })],
      WITH_HEADERS,
    );
    expect(returnPathOnlyLookalike.verdict).toBe("suspicious");
    expect(returnPathOnlyLookalike.meaning).toBe(MEANINGS.suspicious);

    const fromLookalike = ruleVerdict(
      [withDetail("domain.lookalike", "high", { domain: "fynb0s.co.za", fields: ["From"] })],
      WITH_HEADERS,
    );
    expect(fromLookalike.meaning).toBe(FLOOR_CONSEQUENCES.lookalike);

    // 5. Unfloored rule verdicts and safe/partial/noted cases keep their fixed wordings
    const familyOnly = ruleVerdict([withDetail("sender.display_brand", "medium", {})], WITH_HEADERS);
    expect(familyOnly.verdict).toBe("suspicious");
    expect(familyOnly.meaning).toBe(MEANINGS.suspicious);

    const safePartial = ruleVerdict([withDetail("not_checked", "info", {})], WITH_HEADERS);
    expect(safePartial.verdict).toBe("safe");
    expect(safePartial.meaning).toBe(PARTIAL_MEANING);
  });
});
