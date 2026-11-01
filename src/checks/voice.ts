// The voice evidence (D01 T03 §4; spec 4.2a): what a voice note's transcript was read to say, as evidence. The extraction
// itself is its own Workflow step (src/voice/extract.ts); these checks are pure over what it stored on the view. Four
// checks, one for each kind of evidence the report draws: `voice.request`, `voice.claimed_identity`, `voice.urgency` and
// `voice.limits`. A part of the transcript the model's answer was not supported by, an answer that did not come and
// a recording only partly transcribed are each stated as not checked, so the outcome is partial and never clean.
import type { PaymentDetails, Request, VerifiedClaim } from "../voice/schema";
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

const claimOf = (view: Readonly<CaseView>): { claim: VerifiedClaim; dropped: number; complete: boolean } | null =>
  view.voice?.state === "read" ? view.voice : null;

// The reasons an answer fell short, in the order they are stated.
function shortfalls(view: Readonly<CaseView>): string[] {
  const voice = view.voice;
  if (!voice) return [];
  if (voice.state === "silent") return ["no speech was heard in the recording"];
  if (voice.state === "not_checked") return [`what the voice note says could not be read (${plain(voice.reason, 60)})`];
  const out: string[] = [];
  if (voice.dropped > 0) out.push("some of what the model read was not in the words spoken, so it was left out");
  if (!voice.complete) out.push("part of the recording was not transcribed");
  return out;
}

const details = (d: PaymentDetails) =>
  Object.fromEntries(Object.entries(d).filter(([, value]) => value !== null)) as Record<string, string>;

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
        ...(read.claim.paymentDetails ? { payment: details(read.claim.paymentDetails) } : {}),
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  for (const why of shortfalls(view))
    items.push({
      check: "voice.request",
      severity: "info",
      summary: bounded(`Not fully checked: ${why}.`),
      detail: fittedDetail({ checked: false, reason: why }) as EvidenceDraft["detail"],
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
export const VOICE_LIMITS =
  "No Afrikaans, isiZulu or isiXhosa support, and a cloned voice cannot be told from a real one";
export function voiceLimitsEvidence(view: Readonly<CaseView>): EvidenceDraft[] {
  if (!view.voice) return [];
  return [
    {
      check: "voice.limits",
      severity: "info",
      summary: bounded(`${VOICE_LIMITS}.`),
      detail: {
        unsupportedLanguages: ["Afrikaans", "isiZulu", "isiXhosa"],
        voiceCloneDetection: false,
      },
      artefacts: [view.raw],
    },
  ];
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
    partial: (view) => shortfalls(view)[0] ?? null,
    summary: (view, items) =>
      items.some((i) => i.severity !== "info")
        ? `asks for ${WHAT[claimOf(view)?.claim.request ?? "other"]}`
        : claimOf(view)
          ? "asks for nothing"
          : null,
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
    summary: (_view, items) =>
      items.some((i) => i.severity === "medium") ? "pressed to act at once" : items.length ? "some hurry" : "no hurry",
  });
  registry.register({
    name: "voice.limits",
    needs: [],
    timeoutMs: 2_000,
    run: voiceLimitsEvidence,
    applies,
    summary: () => "no Afrikaans, isiZulu or isiXhosa, and no voice-clone detection",
  });
}
