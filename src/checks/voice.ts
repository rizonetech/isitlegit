// The voice evidence (D01 T03 §4; spec 4.2a): what a voice note's transcript was read to say, as evidence. The extraction
// itself is its own Workflow step (src/voice/extract.ts); these checks are pure over what it stored on the view. Four
// checks, one for each kind of evidence the report draws: `voice.request`, `voice.claimed_identity`, `voice.urgency` and
// `voice.limits`. A part of the transcript the model's answer was not supported by, an answer that did not come and
// a recording only partly transcribed are each stated as not checked, so the outcome is partial and never clean.
import type { Request, VerifiedClaim } from "../voice/schema";
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";

const NOT_VOICE = "not a voice note";
const NOT_READ = "what the voice note says was not read";

const WHAT: Record<Request, string> = {
  pay: "a payment",
  change_bank_details: "bank details to be changed",
  share_code: "a code to be shared",
  click_link: "a link to be opened",
  other: "something else",
  none: "nothing",
};
// How serious a request is: money moving or its destination changing is the scam; a code or a link is the way in.
const REQUEST_SEVERITY: Record<Request, EvidenceDraft["severity"] | null> = {
  pay: "high",
  change_bank_details: "high",
  share_code: "medium",
  click_link: "medium",
  other: "info",
  none: null,
};
const URGENCY_SEVERITY = { high: "medium", medium: "low", low: "info" } as const;

const claimOf = (
  view: Readonly<CaseView>,
): { claim: VerifiedClaim; dropped: number; complete: boolean; cut?: boolean | undefined } | null =>
  view.voice?.state === "read" ? view.voice : null;

// What to do when the reading fell short: the member can always listen to it and ask the person.
const ADVICE = " Listen to it yourself, and confirm any request by phoning the person on a number you already have.";
// A reason a member can read, never the internal one (kept apart in the item's detail, for whoever traces it).
function plainReason(reason: string): string {
  if (reason === "no-transcribe")
    return "transcription and voice reading were deliberately omitted for this experiment";
  if (reason === "budget") return "the allowance for reading voice notes today is used up";
  if (reason === "the transcript is not stored") return "the words of the recording were not available";
  if (reason.startsWith("output-")) return "the reading did not give an answer that could be used";
  if (reason.startsWith("model-")) return "the reading service did not answer";
  if (reason.startsWith("the reading did not finish")) return "the reading did not finish in time";
  return "the reading did not work this time";
}

// The reasons an answer fell short, in the order they are stated: the plain words, the reason as kept, and the advice.
type Shortfall = { why: string; reason: string; advice: string };
// Why a recording was not read, in words a member can act on (D01 T03 §5).
const OUTCOME_WORDS: Record<string, string> = {
  corrupt: "could not be read (it is damaged, or not really audio)",
  unsupported: "could not be read (its type is not one that is read)",
  "too-long": "was too long to read",
  refused: "could not be read (the reading service refused it)",
  missing: "was not there to read",
  "past-bound": "was not read (only the first three recordings are read)",
};
const namedShortfalls = (recordings: { filename: string; outcome: string }[]): Shortfall[] =>
  recordings
    .filter((r) => OUTCOME_WORDS[r.outcome])
    .map((r) => ({
      why: `the recording ${r.filename} ${OUTCOME_WORDS[r.outcome] as string}`,
      reason: `recording-${r.outcome}`,
      advice: ADVICE,
    }));
function shortfalls(view: Readonly<CaseView>): Shortfall[] {
  const voice = view.voice;
  if (!voice) return [];
  if (voice.state === "silent")
    return [{ why: "no speech was heard in the recording", reason: "silence", advice: ADVICE }];
  if (voice.state === "not_checked") {
    const named = namedShortfalls(voice.recordings ?? []);
    if (named.length) return named;
    return [{ why: plainReason(voice.reason), reason: plain(voice.reason, 80), advice: ADVICE }];
  }
  const out: Shortfall[] = [];
  // A recording that was not read is named, with its file (D01 T03 §5): the member can listen to that one.
  if (voice.state === "read") out.push(...namedShortfalls(voice.recordings ?? []));
  if (voice.dropped > 0)
    out.push({
      why: "some of what the model read was not in the words spoken, so it was left out",
      reason: "unsupported",
      advice: ADVICE,
    });
  if (!voice.complete)
    out.push({ why: "part of the recording was not transcribed", reason: "incomplete", advice: ADVICE });
  if (voice.cut)
    out.push({
      why: "the recording is longer than the part that was read, so a request near its end may have been missed",
      reason: "cut",
      advice: ADVICE,
    });
  return out;
}

export function voiceRequestEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  if (!view.voice) return [];
  const items: EvidenceDraft[] = [];
  const read = claimOf(view);
  const severity = read ? REQUEST_SEVERITY[read.claim.request] : null;
  if (read && severity && read.claim.requestQuote)
    items.push({
      check: "voice.request",
      severity,
      summary: bounded(`The voice note asks for ${WHAT[read.claim.request]}: "${plain(read.claim.requestQuote, 120)}"`),
      detail: fittedDetail({
        request: read.claim.request,
        quote: read.claim.requestQuote,
        ...(read.claim.paymentQuote ? { paymentQuote: read.claim.paymentQuote } : {}),
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  // A payment sentence the speaker says without asking for anything is kept as they said it, never as a request.
  if (read && !items.length && read.claim.paymentQuote)
    items.push({
      check: "voice.request",
      severity: "info",
      summary: bounded(
        `The speaker gives payment details without asking for a payment: "${plain(read.claim.paymentQuote, 120)}"`,
      ),
      detail: fittedDetail({ paymentQuote: read.claim.paymentQuote }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  for (const miss of shortfalls(view))
    items.push({
      check: "voice.request",
      severity: "info",
      summary: bounded(`Not fully checked: ${miss.why}.${miss.advice}`),
      detail: fittedDetail({ checked: false, reason: miss.reason, why: miss.why }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  return items;
}

export function voiceIdentityEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  const read = claimOf(view);
  if (!read?.claim.claimedIdentity || !read.claim.identityQuote) return [];
  return [
    {
      check: "voice.claimed_identity",
      severity: "info",
      summary: bounded(
        `The speaker says they are ${plain(read.claim.claimedIdentity, 80)}: "${plain(read.claim.identityQuote, 100)}"`,
      ),
      detail: fittedDetail({
        identity: read.claim.claimedIdentity,
        quote: read.claim.identityQuote,
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    },
  ];
}

export function voiceUrgencyEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  const read = claimOf(view);
  if (!read?.claim.urgencyQuote) return [];
  return [
    {
      check: "voice.urgency",
      severity: URGENCY_SEVERITY[read.claim.urgency],
      summary: bounded(
        `The speaker presses for it ${read.claim.urgency === "high" ? "to be done at once" : read.claim.urgency === "medium" ? "soon" : "without hurry"}: "${plain(read.claim.urgencyQuote, 100)}"`,
      ),
      detail: fittedDetail({ urgency: read.claim.urgency, quote: read.claim.urgencyQuote }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    },
  ];
}

// What the check cannot do, said on every voice case (spec 4.2a).
export const VOICE_LIMITS = "No Afrikaans, isiZulu or isiXhosa support, and cloned voices are not detected";
// The quotes show where the reading comes from; they do not show that it is right.
export const INTERPRETATION =
  "The quotes are the speaker's words, but the meaning is the model's reading: listen yourself";
export function voiceLimitsEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  if (!view.voice) return [];
  return [
    {
      check: "voice.limits",
      severity: "info",
      summary: bounded(`${VOICE_LIMITS}. ${INTERPRETATION}.`),
      detail: {
        unsupportedLanguages: ["Afrikaans", "isiZulu", "isiXhosa"],
        voiceCloneDetection: false,
        interpretation: `${INTERPRETATION}.`,
      },
      artefacts: [view.raw],
    },
  ];
}

// An HTML attachment posing as a voice message (D01 T03 §5): voicemail wording in the page's own words, with a
// player or a link to follow. The wording alone, and a player with no voicemail pitch, are both left alone.
export function voiceLureEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const a of view.htmlAttachments?.items ?? []) {
    if (a.kind !== "html" || !a.features.voicemail) continue;
    const linked = a.links.items.length > 0;
    if (!a.features.audioPlayer && !linked) continue;
    items.push({
      check: "voice.lure",
      severity: "medium",
      summary: bounded(
        `${plain(a.filename || "An attachment", 80)} poses as a voice message${a.features.audioPlayer ? ", with a player to press" : ", with a link to follow"}; check it another way (phone the person on a number you already have) before pressing or following anything.`,
      ),
      detail: fittedDetail({
        filename: a.filename,
        player: a.features.audioPlayer,
        linked,
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  }
  return items;
}

type TranscriptSegment = { chunk: number; speaker: string | null; startMs: number; endMs: number; text: string };

// The transcript's own fitting (D01 T03 §16, completion review): the generic detail helper clips every string
// to 255 code points and every list to 20, which would lose most of a routine monologue inside a 64 KiB
// budget. Here the whole transcript is kept while it fits the evidence detail budget (60,000 bytes, the
// store's own margin), segments in order; what does not fit is cut from the end, a last segment's text cut at
// a code-point boundary when part of it fits, and every omission (segments, gaps, speaker entries) counted.
const TRANSCRIPT_BUDGET = 60_000;
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function fitTranscript(meta: {
  transcript: string;
  recording: string | null;
  filename: string | null;
  complete: boolean;
  gaps: unknown[];
  speakers: unknown[];
  unlabelled: number;
  segments: TranscriptSegment[];
}): Record<string, unknown> {
  const { segments, ...rest } = meta;
  const detail: Record<string, unknown> & { segments: TranscriptSegment[] } = { ...rest, segments: [] };
  let trimmed = false;
  while (byteSize(detail) > TRANSCRIPT_BUDGET && Array.isArray(detail.gaps) && detail.gaps.length) {
    detail.gaps = (detail.gaps as unknown[]).slice(0, -1);
    detail.gapsOmitted = meta.gaps.length - (detail.gaps as unknown[]).length;
    trimmed = true;
  }
  while (byteSize(detail) > TRANSCRIPT_BUDGET && Array.isArray(detail.speakers) && detail.speakers.length) {
    detail.speakers = (detail.speakers as unknown[]).slice(0, -1);
    detail.speakersOmitted = meta.speakers.length - (detail.speakers as unknown[]).length;
    trimmed = true;
  }
  for (const segment of segments) {
    const whole = { ...detail, segments: [...detail.segments, segment] };
    if (byteSize(whole) <= TRANSCRIPT_BUDGET) {
      detail.segments.push(segment);
      continue;
    }
    // Part of this segment's text may still fit: keep what does, at a code-point boundary.
    let low = 0;
    let high = segment.text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const trial = { ...detail, segments: [...detail.segments, { ...segment, text: segment.text.slice(0, mid) }] };
      if (byteSize(trial) <= TRANSCRIPT_BUDGET) low = mid;
      else high = mid - 1;
    }
    if (low > 0) detail.segments.push({ ...segment, text: segment.text.slice(0, low) });
    detail.segmentsOmitted = segments.length - detail.segments.length;
    trimmed = true;
    break;
  }
  if (trimmed) detail.trimmed = true;
  return detail;
}

// One item per stored transcript (D01 T03 §16): what was heard, so the report can show the words themselves.
// Speaker labels are scoped to their chunk (the transcription contract), so they are kept per chunk and never
// counted as people; the segments ride in the detail under its bound, every cut marked.
function transcriptEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  if (!view.transcripts?.length) return [];
  return view.transcripts.map((t): EvidenceDraft => {
    const name = t.filename ? ` (${plain(t.filename, 80)})` : "";
    if (t.malformed)
      return {
        check: "voice.transcript",
        severity: "info",
        summary: bounded(`The transcript${name} could not be read.`),
        detail: fittedDetail({
          transcript: t.transcriptKey,
          recording: t.recordingKey,
          filename: t.filename,
          malformed: true,
        }) as EvidenceDraft["detail"],
        artefacts: [t.transcriptKey],
      };
    const byChunk = new Map<number, string[]>();
    let unlabelled = 0;
    for (const turn of t.turns) {
      if (turn.speaker === null) unlabelled++;
      else if (!byChunk.get(turn.chunk)?.includes(turn.speaker)) {
        byChunk.set(turn.chunk, [...(byChunk.get(turn.chunk) ?? []), turn.speaker]);
      }
    }
    const segments = t.turns.map((turn) => ({
      chunk: turn.chunk,
      speaker: turn.speaker,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
    }));
    const detail = fitTranscript({
      transcript: t.transcriptKey,
      recording: t.recordingKey,
      filename: t.filename,
      complete: t.complete,
      gaps: t.gaps,
      speakers: [...byChunk.entries()].map(([chunk, labels]) => ({ chunk, labels })),
      unlabelled,
      segments,
    });
    return {
      check: "voice.transcript",
      severity: "info",
      summary: bounded(
        `What the recording${name} says, as transcribed: ${t.turns.length} turn${t.turns.length === 1 ? "" : "s"}${t.complete ? "" : " (part could not be transcribed)"}.`,
      ),
      detail: detail as EvidenceDraft["detail"],
      artefacts: [t.transcriptKey],
    };
  });
}

export function registerVoiceChecks(registry: CheckRegistry): void {
  const applies = (view: Readonly<CaseView>) => (view.voice ? null : NOT_VOICE);
  const appliesToClaim = (view: Readonly<CaseView>) => (!view.voice ? NOT_VOICE : claimOf(view) ? null : NOT_READ);
  registry.register({
    name: "voice.request",
    needs: [],
    timeoutMs: 2_000,
    run: voiceRequestEvidence,
    applies,
    partial: (view) => shortfalls(view)[0]?.why ?? null,
    // What the claim asks, whatever its severity ("something else" is a request too); "nothing" only when it asks nothing.
    summary: (view) => {
      const read = claimOf(view);
      if (!read) return null;
      return read.claim.request === "none" ? "asks for nothing" : `asks for ${WHAT[read.claim.request]}`;
    },
  });
  registry.register({
    name: "voice.claimed_identity",
    needs: [],
    timeoutMs: 2_000,
    run: voiceIdentityEvidence,
    applies: appliesToClaim,
    summary: (_view, items) => (items.length ? "the speaker names who they are" : "no one is named"),
  });
  registry.register({
    name: "voice.urgency",
    needs: [],
    timeoutMs: 2_000,
    run: voiceUrgencyEvidence,
    applies: appliesToClaim,
    // From the urgency read, not from whether an item was made (a supported "no hurry" is an item too).
    summary: (view) => {
      const urgency = claimOf(view)?.claim.urgency;
      return urgency === "high" ? "pressed to act at once" : urgency === "medium" ? "some hurry" : "no hurry";
    },
  });
  registry.register({
    name: "voice.lure",
    needs: [],
    timeoutMs: 2_000,
    run: voiceLureEvidence,
    applies: (view) =>
      !(view.htmlAttachments?.items.length ?? 0)
        ? "no HTML attachment was read"
        : voiceLureEvidence(view).length
          ? null
          : "no HTML attachment poses as a voice message",
    summary: (_view, items) =>
      items.length
        ? `${items.length} attachment${items.length === 1 ? "" : "s"} posing as a voice message`
        : "no voicemail lure",
  });
  registry.register({
    name: "voice.transcript",
    needs: [],
    timeoutMs: 2_000,
    run: transcriptEvidence,
    applies: (view) =>
      !view.voice && !view.transcripts ? NOT_VOICE : view.transcripts?.length ? null : "the transcript is not stored",
    summary: (_view, items) => (items.length ? "the words of the recording, as transcribed" : null),
  });
  registry.register({
    name: "voice.limits",
    needs: [],
    timeoutMs: 2_000,
    run: voiceLimitsEvidence,
    applies,
    summary: () => "no Afrikaans, isiZulu or isiXhosa, no voice-clone detection, and the reading may be wrong",
  });
}
