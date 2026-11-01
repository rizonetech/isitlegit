import { describe, expect, it } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import { runChecksWithOutcomes } from "../../src/checks/runner";
import { INTERPRETATION, VOICE_LIMITS } from "../../src/checks/voice";
import type { Request, VerifiedClaim, VoiceRead } from "../../src/voice/schema";

// D01 T03 §4: the voice evidence from what the `voice` step stored, through the registered checks and the runner, so the
// items, their severities, the outcomes and the plain summaries are the ones stored.
const RAW = "raw/case-voice/message.eml";
function view(voice: VoiceRead | null | undefined): CaseView {
  return {
    tenant: {
      orgId: "org-voice",
      channel: "upload",
      receivers: [],
      headersAvailable: false,
      trusted: { own: [], suppliers: [] },
    },
    raw: RAW,
    brands: { version: 1, revision: "2026-10-30", brands: [] } as unknown as CaseView["brands"],
    senderHistory: null,
    domainAges: null,
    attachmentHeads: null,
    hiddenText: null,
    htmlAttachments: null,
    attachmentRisks: null,
    instructions: null,
    invisibleText: null,
    links: null,
    ...(voice === undefined ? {} : { voice }),
    source: { kind: "upload", fileKind: "audio", mediaType: "audio/ogg", key: "art/case-voice/audio/x", bytes: 1000 },
    headers: [],
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
  };
}
const claim = (over: Partial<VerifiedClaim> = {}): VerifiedClaim => ({
  request: "pay",
  requestQuote: "Please pay the invoice today",
  claimedIdentity: "Thandi from Karoo Parts",
  identityQuote: "this is Thandi from Karoo Parts",
  urgency: "high",
  urgencyQuote: "It must be done today",
  paymentQuote: "into account 1234 5678 90 at Kestrel Bank",
  ...over,
});
const read = (c: VerifiedClaim, extra: Partial<Extract<VoiceRead, { state: "read" }>> = {}): VoiceRead => ({
  state: "read",
  claim: c,
  dropped: 0,
  complete: true,
  ...extra,
});
async function run(v: CaseView) {
  const { items, outcomes } = await runChecksWithOutcomes(v);
  const voice = items.filter((i) => i.check.startsWith("voice."));
  return { voice, outcome: (name: string) => outcomes.find((o) => o.check === name) };
}

describe("the voice checks", () => {
  it("turns the fixture claim into the request, the identity and the urgency, each with its words", async () => {
    const { voice, outcome } = await run(view(read(claim())));
    expect(voice.map((i) => [i.check, i.severity])).toEqual([
      ["voice.request", "high"],
      ["voice.claimed_identity", "info"],
      ["voice.urgency", "medium"],
      ["voice.limits", "info"],
    ]);
    expect(voice[0]?.detail).toMatchObject({
      request: "pay",
      quote: "Please pay the invoice today",
      paymentQuote: "into account 1234 5678 90 at Kestrel Bank",
    });
    expect(voice[0]?.summary).toBe('The voice note asks for a payment: "Please pay the invoice today"');
    expect(voice[1]?.detail).toEqual({ identity: "Thandi from Karoo Parts", quote: "this is Thandi from Karoo Parts" });
    expect(voice[2]?.detail).toEqual({ urgency: "high", quote: "It must be done today" });
    for (const name of ["voice.request", "voice.claimed_identity", "voice.urgency", "voice.limits"])
      expect(outcome(name)?.outcome, name).toBe("ran");
    expect(outcome("voice.request")?.summary).toBe("asks for a payment");
    expect(outcome("voice.claimed_identity")?.summary).toBe("the speaker names who they are");
    expect(outcome("voice.urgency")?.summary).toBe("pressed to act at once");
    expect(outcome("voice.limits")?.summary).toBe(
      "no Afrikaans, isiZulu or isiXhosa, no voice-clone detection, and the reading may be wrong",
    );
  });

  it("gives each request its severity: money and its destination high, a code or a link medium, anything else info", async () => {
    const expected: [Request, string | null][] = [
      ["pay", "high"],
      ["change_bank_details", "high"],
      ["share_code", "medium"],
      ["click_link", "medium"],
      ["other", "info"],
      ["none", null],
    ];
    for (const [request, severity] of expected) {
      const { voice } = await run(
        view(read(claim({ request, requestQuote: request === "none" ? null : "the words", paymentQuote: null }))),
      );
      const item = voice.find((i) => i.check === "voice.request");
      expect(item?.severity ?? null, request).toBe(severity);
    }
  });

  it("gives each urgency its severity, and none without words to rest on", async () => {
    for (const [urgency, severity] of [
      ["high", "medium"],
      ["medium", "low"],
      ["low", "info"],
    ] as const) {
      const { voice } = await run(view(read(claim({ urgency, urgencyQuote: "the words" }))));
      expect(voice.find((i) => i.check === "voice.urgency")?.severity, urgency).toBe(severity);
    }
    const { voice } = await run(view(read(claim({ urgency: "low", urgencyQuote: null }))));
    expect(voice.find((i) => i.check === "voice.urgency")).toBeUndefined();
  });

  it("makes no identity item for a null identity, nor for one without its words", async () => {
    for (const over of [{ claimedIdentity: null, identityQuote: null }, { identityQuote: null }]) {
      const { voice, outcome } = await run(view(read(claim(over))));
      expect(voice.some((i) => i.check === "voice.claimed_identity")).toBe(false);
      expect(outcome("voice.claimed_identity")?.outcome).toBe("ran");
    }
  });

  it("says a voice note that asks for nothing asks for nothing, and checks it whole", async () => {
    const { voice, outcome } = await run(
      view(
        read(
          claim({
            request: "none",
            requestQuote: null,
            claimedIdentity: null,
            identityQuote: null,
            urgency: "low",
            urgencyQuote: null,
            paymentQuote: null,
          }),
        ),
      ),
    );
    expect(voice.map((i) => i.check)).toEqual(["voice.limits"]);
    expect(outcome("voice.request")).toMatchObject({ outcome: "ran", summary: "asks for nothing" });
  });

  it("states silence, a failed reading, what was left out and a partly transcribed recording as not checked, never clean", async () => {
    const cases: [string, VoiceRead, RegExp][] = [
      ["silence", { state: "silent" }, /no speech was heard/],
      [
        "a failed reading",
        { state: "not_checked", reason: "output-refused" },
        /did not give an answer that could be used/,
      ],
      ["a transcript longer than the part read", read(claim(), { cut: true }), /longer than the part that was read/],
      ["support dropped", read(claim(), { dropped: 2 }), /not in the words spoken/],
      ["an incomplete transcript", read(claim(), { complete: false }), /part of the recording was not transcribed/],
    ];
    for (const [name, voiceRead, why] of cases) {
      const { voice, outcome } = await run(view(voiceRead));
      const notChecked = voice.filter((i) => i.check === "voice.request" && i.detail.checked === false);
      expect(notChecked, name).toHaveLength(1);
      expect(notChecked[0]?.severity).toBe("info");
      expect(notChecked[0]?.summary, name).toMatch(why);
      expect(outcome("voice.request")?.outcome, name).toBe("partial");
      // The limits are stated whatever the reading did.
      expect(
        voice.some((i) => i.check === "voice.limits"),
        name,
      ).toBe(true);
    }
  });

  it("states the limits on every voice case and on no other", async () => {
    const { voice } = await run(view({ state: "not_checked", reason: "budget" }));
    const limits = voice.find((i) => i.check === "voice.limits");
    expect(limits?.summary).toBe(`${VOICE_LIMITS}. ${INTERPRETATION}.`);
    expect(limits?.summary.length).toBeLessThanOrEqual(200);
    expect(limits?.summary).toContain("the meaning is the model's reading");
    expect(limits?.detail).toEqual({
      unsupportedLanguages: ["Afrikaans", "isiZulu", "isiXhosa"],
      voiceCloneDetection: false,
      interpretation: `${INTERPRETATION}.`,
    });
    for (const none of [null, undefined]) {
      const { voice: items, outcome } = await run(view(none));
      expect(items).toEqual([]);
      for (const name of ["voice.request", "voice.claimed_identity", "voice.urgency", "voice.limits"])
        expect(outcome(name), name).toMatchObject({ outcome: "skipped", reason: "not a voice note" });
    }
  });

  it("skips the identity and urgency checks, saying why, when nothing was read", async () => {
    const { outcome } = await run(view({ state: "silent" }));
    expect(outcome("voice.claimed_identity")).toMatchObject({
      outcome: "skipped",
      reason: "what the voice note says was not read",
    });
    expect(outcome("voice.urgency")).toMatchObject({ outcome: "skipped" });
  });

  it("summarises every request value as it is: something else is a request, only none asks for nothing", async () => {
    const words: [Request, string][] = [
      ["pay", "asks for a payment"],
      ["change_bank_details", "asks for bank details to be changed"],
      ["share_code", "asks for a code to be shared"],
      ["click_link", "asks for a link to be opened"],
      ["other", "asks for something else"],
      ["none", "asks for nothing"],
    ];
    for (const [request, summary] of words) {
      const { outcome } = await run(
        view(read(claim({ request, requestQuote: request === "none" ? null : "the words" }))),
      );
      expect(outcome("voice.request")?.summary, request).toBe(summary);
    }
  });

  it("keeps payment details the speaker states without asking for anything, as said, and invents no request", async () => {
    const { voice } = await run(view(read(claim({ request: "none", requestQuote: null }))));
    const stated = voice.find((i) => i.check === "voice.request");
    expect(stated).toMatchObject({
      severity: "info",
      detail: { paymentQuote: "into account 1234 5678 90 at Kestrel Bank" },
    });
    expect(stated?.detail.request).toBeUndefined();
    expect(stated?.summary).toMatch(/gives payment details without asking for a payment/);
  });

  it("keeps a supported low urgency as an info item, and says nothing of one with no words", async () => {
    const { voice } = await run(view(read(claim({ urgency: "low", urgencyQuote: "There is no hurry" }))));
    expect(voice.find((i) => i.check === "voice.urgency")).toMatchObject({
      severity: "info",
      detail: { urgency: "low", quote: "There is no hurry" },
    });
  });

  it("summarises the urgency read, whatever the items: a supported no-hurry is no hurry", async () => {
    for (const [urgency, summary] of [
      ["high", "pressed to act at once"],
      ["medium", "some hurry"],
      ["low", "no hurry"],
    ] as const) {
      const { outcome } = await run(view(read(claim({ urgency, urgencyQuote: "the words" }))));
      expect(outcome("voice.urgency")?.summary, urgency).toBe(summary);
    }
  });

  it("words a failure in plain language with a next step, keeping the typed reason apart", async () => {
    const reasons: [string, RegExp][] = [
      ["budget", /allowance for reading voice notes today is used up/],
      ["output-invalid", /did not give an answer that could be used/],
      ["model-server", /reading service did not answer/],
      ["the reading did not finish (Error)", /did not finish in time/],
      ["something odd", /did not work this time/],
    ];
    for (const [reason, plain] of reasons) {
      const { voice } = await run(view({ state: "not_checked", reason }));
      const item = voice.find((i) => i.check === "voice.request");
      expect(item?.summary, reason).toMatch(plain);
      expect(item?.summary, reason).toMatch(/Listen to it yourself, and confirm any request by phoning the person/);
      expect(item?.summary, reason).not.toMatch(/output-|model-|budget:|Error/);
      expect(item?.detail.reason, reason).toBe(reason);
    }
  });
});
