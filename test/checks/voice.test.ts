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
    expansions: null,
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

describe("the transcript item (D01 T03 §16)", () => {
  const turns = [
    { chunk: 1, speaker: "A", startMs: 0, endMs: 1000, text: "Hello, pay today." },
    { chunk: 1, speaker: "B", startMs: 1000, endMs: 2000, text: "Who is this?" },
    { chunk: 2, speaker: "A", startMs: 2000, endMs: 3000, text: "It is Thandi." },
    { chunk: 2, speaker: null, startMs: 3000, endMs: 4000, text: "..." },
  ];
  const withTranscripts = (list: unknown) => ({ ...view(read(claim())), transcripts: list }) as CaseView;

  it("stores one item per transcript with per-chunk speaker labels, never a people count", async () => {
    const { voice, outcome } = await run(
      withTranscripts([
        {
          transcriptKey: "art/c/audio/t-transcript.json",
          recordingKey: "art/c/audio/r-rec.ogg",
          filename: "note.ogg",
          turns,
          gaps: [{ chunk: 2, startMs: 3500, endMs: 3600 }],
          complete: false,
        },
      ]),
    );
    const item = voice.find((i) => i.check === "voice.transcript");
    expect(item?.severity).toBe("info");
    expect(item?.artefacts).toEqual(["art/c/audio/t-transcript.json"]);
    expect(item?.detail).toMatchObject({
      transcript: "art/c/audio/t-transcript.json",
      recording: "art/c/audio/r-rec.ogg",
      filename: "note.ogg",
      complete: false,
      speakers: [
        { chunk: 1, labels: ["A", "B"] },
        { chunk: 2, labels: ["A"] },
      ],
      unlabelled: 1,
    });
    expect(outcome("voice.transcript")?.summary).toBe("the words of the recording, as transcribed");
  });

  it("keeps a long turn whole while it fits, and cuts only past the budget", async () => {
    const long = "é".repeat(4000);
    const { voice } = await run(
      withTranscripts([
        {
          transcriptKey: "art/c/audio/t-transcript.json",
          recordingKey: null,
          filename: null,
          turns: [{ chunk: 1, speaker: "A", startMs: 0, endMs: 9000, text: long }],
          gaps: [],
          complete: true,
        },
      ]),
    );
    const item = voice.find((i) => i.check === "voice.transcript");
    // 4,000 multibyte characters fit the byte budget whole: nothing is cut or marked.
    const segments = item?.detail.segments as { text: string }[];
    expect(segments[0]?.text).toBe(long);
    expect(item?.detail.trimmed).toBeUndefined();
    expect(item?.detail).toMatchObject({ complete: true, speakers: [{ chunk: 1, labels: ["A"] }] });
  });

  it("keeps what fits the byte budget and counts what it omits (completion review)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      chunk: 1,
      speaker: "A",
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      text: "é".repeat(1500),
    }));
    const gaps = Array.from({ length: 25 }, (_, i) => ({ chunk: 1, startMs: i * 10, endMs: i * 10 + 5 }));
    const { voice } = await run(
      withTranscripts([
        {
          transcriptKey: "art/c/audio/t-transcript.json",
          recordingKey: null,
          filename: null,
          turns: many,
          gaps,
          complete: false,
        },
      ]),
    );
    const item = voice.find((i) => i.check === "voice.transcript");
    const detail = item?.detail as {
      segments: unknown[];
      gaps: unknown[];
      segmentsOmitted?: number;
      trimmed?: boolean;
    };
    expect(detail.trimmed).toBe(true);
    expect(detail.segmentsOmitted).toBeGreaterThan(0);
    expect(detail.segments.length + (detail.segmentsOmitted ?? 0)).toBe(30);
    // The gaps are small enough to stand whole, so none is omitted or silently lost.
    expect(detail.gaps).toHaveLength(25);
    expect(new TextEncoder().encode(JSON.stringify(item?.detail)).length).toBeLessThanOrEqual(65_536);
  });

  it("names a malformed transcript beside a valid one, and states none stored apart", async () => {
    const { voice } = await run(
      withTranscripts([
        {
          transcriptKey: "art/c/audio/t-transcript-1.json",
          recordingKey: "raw/c/a.ogg",
          filename: "a.ogg",
          turns,
          gaps: [],
          complete: true,
        },
        {
          transcriptKey: "art/c/audio/t-transcript-2.json",
          recordingKey: "raw/c/b.ogg",
          filename: "b.ogg",
          turns: [],
          gaps: [],
          complete: false,
          malformed: true,
        },
      ]),
    );
    const items = voice.filter((i) => i.check === "voice.transcript");
    expect(items).toHaveLength(2);
    expect(items[1]?.detail).toMatchObject({ malformed: true, filename: "b.ogg" });
    const none = await run(view(read(claim())));
    expect(none.outcome("voice.transcript")).toMatchObject({
      outcome: "skipped",
      reason: "the transcript is not stored",
    });
  });
});
