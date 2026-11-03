// Claim detection (D05 T02 §2): the routes by which a mail, upload or voice note claims a
// protected identity, as pure detection over the CaseView inputs the pipeline supplies plus
// the bounded registered-logo comparison phase (`compareClaimLogos`) that runs over SAM crops.
// The registered check (`trust.claim`) is pure and store-free (`src/checks/registry.ts`),
// reading `view.protectedCandidates` (populated by `boundProtectedCandidates(await protectedIdentities(db))`
// in `src/pipeline/analysis-workflow.ts`, D02 T01 §9), `view.headers`, `view.text`, `view.voice`
// (`src/voice/schema.ts`), and `view.claimLogos` (populated by `compareClaimLogos`).
// Only the claimed organisation (`orgId`), its matched display name or domain, the matched routes,
// the observed message support, and case-owned artefact keys (`raw/...`, `art/<caseId>/crop/...`)
// enter evidence: no finance contact, bank detail, registered address list, or registered-logo
// storage key (`ident/...`) ever leaves this module.
import type { Browser } from "@cloudflare/puppeteer";
import { addressParser } from "postal-mime";
import { z } from "zod";
import { registrable } from "../auth/senders";
import { asciiDomain, bounded, fittedDetail, plain } from "../checks/auth";
import {
  type CaseView,
  MAX_CANDIDATE_DOMAINS,
  MAX_CANDIDATE_NAMES,
  MAX_PROTECTED_CANDIDATES,
  type ProtectedCandidates,
} from "../checks/case-view";
import { split, techniqueOf } from "../checks/domain-lookalike";
import type { EvidenceDraft } from "../checks/evidence";
import { labelSkeleton } from "../checks/lookalike";
import { type CheckRegistry, MAX_OUTCOME_SUMMARY } from "../checks/registry";
import { mailbox } from "../checks/sender";
import { oneLine, originalHeaderOf } from "../intake/original-header";
import { artefactsOf, readArtefact, type Store, type Stored } from "../intake/store";
import { type MetaContext, ModelError } from "../meta/client";
import { BudgetExceeded } from "../meta/guard";
import { ModelOutputError } from "../meta/structured";
import { compareLogo, LogoCompareError } from "../vision/logo-compare";
import type { VoiceRead } from "../voice/schema";
import { MAX_LOGO_BYTES, pngPixelsProblem, pngProblem, sanitiseSvg } from "./logo";
import { normaliseName } from "./names";

export const ROUTE_ORDER = [
  "display-name",
  "from-domain",
  "from-lookalike",
  "reply-to-domain",
  "reply-to-lookalike",
  "signature",
  "voice",
  "logo",
] as const;

export type ClaimRoute = (typeof ROUTE_ORDER)[number];

export type ClaimCandidate = {
  orgId: string;
  // The identity's display names, any of which a claim may use.
  names: string[];
  // Its verified domains, in registrable form.
  domains: string[];
  namesOmitted?: number;
  domainsOmitted?: number;
};

export type LogoJudgementFor = {
  orgId: string;
  // The validated judgement's same-logo answer for the mail's crop against this identity.
  same: boolean;
  cropKey: string;
  brandSeen?: string | null;
  differences?: string[];
  confidence?: number;
};

export type LegacyVoiceInput = {
  state: string;
  claimedIdentity: string | null;
  identityQuote?: string | null;
  reason?: string;
  complete?: boolean;
  cut?: boolean;
  dropped?: number;
};

export type ClaimVoiceInput = VoiceRead | LegacyVoiceInput | null | undefined;

export type ClaimInput = {
  fromName: string | null;
  fromDomain: string | null;
  replyToDomain: string | null;
  // Additional Reply-To domains when a message carries multiple Reply-To addresses or headers.
  replyToDomains?: string[];
  // Observed From and Reply-To header lines (sanitised one-line excerpts) when read from a CaseView.
  fromHeader?: string | null;
  replyToHeaders?: string[];
  // The body's plain text; the signature is its last 15 lines.
  text: string | null;
  voice: ClaimVoiceInput;
  candidates: ClaimCandidate[];
  logoJudgements: LogoJudgementFor[];
  // What could not be read (a crop, a registered logo, a comparison, a cut body, a failed voice or candidate read),
  // stated explicitly so unavailable coverage never masquerades as a clean no-match.
  unavailable: string[];
  // Optional case-owned raw artefact key (`view.raw`) to attach to header, signature, and voice claim evidence items.
  rawKey?: string | null;
};

export type ClaimLogoSummary = {
  same: boolean;
  brandSeen: string | null;
  differences: string[];
  confidence: number;
  cropKey: string;
};

export type ClaimHit = {
  orgId: string;
  // The display name the claim matched, or the claimed domain for a domain-only claim.
  name: string;
  routes: ClaimRoute[];
  support: string[];
  cropKeys: string[];
  logos: ClaimLogoSummary[];
};

export type ClaimLogoPhaseResult = {
  logoJudgements: LogoJudgementFor[];
  unavailable: string[];
};

export type CaseViewWithClaimLogos = CaseView & {
  claimLogos?: ClaimLogoPhaseResult | null;
  claims?: ClaimInput;
};

export const MAX_CANDIDATES = 50;
export const SIGNATURE_LINE_WINDOW = 15;
export const MIN_LOGO_CLAIM_CONFIDENCE = 0.5;
export const CLAIM_LOGO_PHASE_MS = 60_000;
export const MAX_CLAIM_CROPS = 4;
export const MAX_CLAIM_LOGO_COMPARISONS = 8;
const MAX_CROP_IMAGE_BYTES = 5 * 1024 * 1024;
const SVG_RASTER_SIDE = 512;

// Case-owned artefact keys only: a registered logo key (`ident/<orgId>/...`) must never enter public evidence.
const isCaseArtefactKey = (key: string): boolean => {
  const trimmed = key.trim();
  return trimmed.length > 0 && !trimmed.startsWith("ident/");
};

// Whole-word normalised phrase containment: "Fynbos Freight" matches "Fynbos Freight",
// "Fynbos Freight (Pty) Ltd", and "Regards, Fynbos Freight", without matching substrings inside unrelated words.
function containsNamePhrase(haystack: string, candidateName: string): boolean {
  const normCandidate = normaliseName(candidateName);
  if (normCandidate.length < 3) return false;
  const hayWords = normaliseName(haystack).split(" ").filter(Boolean);
  const needleWords = normCandidate.split(" ").filter(Boolean);
  if (!needleWords.length || needleWords.length > hayWords.length) return false;
  return hayWords.some((_, i) => needleWords.every((w, j) => hayWords[i + j] === w));
}

function matchesDisplayName(observed: string, candidateName: string): boolean {
  const normObserved = normaliseName(observed);
  const normCandidate = normaliseName(candidateName);
  if (!normObserved || !normCandidate) return false;
  if (normObserved === normCandidate) return true;
  return containsNamePhrase(observed, candidateName);
}

function lookalikeOf(domain: string, candidateDomain: string): boolean {
  const asciiA = asciiDomain(domain);
  const asciiB = asciiDomain(candidateDomain);
  if (!asciiA || !asciiB) return false;
  const splitA = split(asciiA);
  const splitB = split(asciiB);
  if (!splitA || !splitB || splitA.domain === splitB.domain) return false;
  return techniqueOf(splitA, splitB) !== null;
}

function domainComparableForLookalike(domain: string): boolean {
  const ascii = asciiDomain(domain);
  if (!ascii) return false;
  const s = split(ascii);
  return s !== null && labelSkeleton(s.label) !== null;
}

type NormalisedVoice = {
  claimedIdentity: string | null;
  identityQuote: string | null;
  unavailable: string[];
};

function readVoiceInput(voice: ClaimVoiceInput): NormalisedVoice {
  if (!voice || voice.state === "silent") {
    return { claimedIdentity: null, identityQuote: null, unavailable: [] };
  }
  if (voice.state === "not_checked" || voice.state === "failed") {
    const reason = "reason" in voice && typeof voice.reason === "string" && voice.reason.trim() ? voice.reason : null;
    return {
      claimedIdentity: null,
      identityQuote: null,
      unavailable: [
        reason ? `the voice note could not be checked (${plain(reason, 80)})` : "the voice note could not be checked",
      ],
    };
  }
  if (voice.state === "read") {
    const unavailable: string[] = [];
    const claimedIdentity =
      "claim" in voice ? voice.claim.claimedIdentity : "claimedIdentity" in voice ? voice.claimedIdentity : null;
    const identityQuote =
      "claim" in voice
        ? voice.claim.identityQuote
        : "identityQuote" in voice && typeof voice.identityQuote === "string"
          ? voice.identityQuote
          : null;
    if ("complete" in voice && voice.complete === false) {
      unavailable.push("part of the voice note was not transcribed");
    }
    if ("cut" in voice && voice.cut === true) {
      unavailable.push("the voice note was cut short before its end");
    }
    if ("dropped" in voice && typeof voice.dropped === "number" && voice.dropped > 0) {
      unavailable.push("an unsupported voice claim was left out");
    }
    return { claimedIdentity, identityQuote, unavailable };
  }
  return {
    claimedIdentity: null,
    identityQuote: null,
    unavailable: ["the voice note could not be checked"],
  };
}

function positiveLogoJudgement(judgement: LogoJudgementFor): boolean {
  return judgement.same && (judgement.confidence ?? 1) >= MIN_LOGO_CLAIM_CONFIDENCE;
}

// Every identity the input claims, with every route that matched for it, deduplicated per identity in ROUTE_ORDER.
export function detectClaims(input: ClaimInput): ClaimHit[] {
  const hits = new Map<string, ClaimHit>();
  const boundedCandidates = input.candidates.slice(0, MAX_CANDIDATES);
  const candidateByOrg = new Map(boundedCandidates.map((c) => [c.orgId, c]));

  const ensureHit = (candidate: ClaimCandidate, preferredName: string): ClaimHit => {
    const existing = hits.get(candidate.orgId);
    if (existing) {
      // Upgrade a domain-fallback name to a matched display name when a later route names one.
      if (candidate.domains.includes(existing.name) && !candidate.domains.includes(preferredName)) {
        existing.name = preferredName;
      }
      return existing;
    }
    const created: ClaimHit = {
      orgId: candidate.orgId,
      name: preferredName,
      routes: [],
      support: [],
      cropKeys: [],
      logos: [],
    };
    hits.set(candidate.orgId, created);
    return created;
  };

  const add = (candidate: ClaimCandidate, name: string, route: ClaimRoute, support: string, cropKey?: string) => {
    const hit = ensureHit(candidate, name);
    if (!hit.routes.includes(route)) {
      hit.routes.push(route);
      hit.routes.sort((a, b) => ROUTE_ORDER.indexOf(a) - ROUTE_ORDER.indexOf(b));
    }
    const cleanSupport = plain(support, 200);
    if (cleanSupport && !hit.support.includes(cleanSupport)) {
      hit.support.push(cleanSupport);
    }
    if (cropKey && isCaseArtefactKey(cropKey) && !hit.cropKeys.includes(cropKey)) {
      hit.cropKeys.push(cropKey);
    }
  };

  const fromAscii = input.fromDomain ? asciiDomain(input.fromDomain) : null;
  const fromDomain = fromAscii ? registrable(fromAscii) : null;
  const rawReplyDomains = [...(input.replyToDomain ? [input.replyToDomain] : []), ...(input.replyToDomains ?? [])];
  const replyEntries: { raw: string; registrable: string }[] = [];
  const seenReply = new Set<string>();
  for (const raw of rawReplyDomains) {
    const ascii = asciiDomain(raw);
    const reg = ascii ? registrable(ascii) : null;
    if (reg && !seenReply.has(`${raw.toLowerCase()}\n${reg}`)) {
      seenReply.add(`${raw.toLowerCase()}\n${reg}`);
      replyEntries.push({ raw, registrable: reg });
    }
  }

  const voice = readVoiceInput(input.voice);
  const lines = input.text !== null ? input.text.split(/\r?\n/) : [];
  const signatureLines = lines.slice(-SIGNATURE_LINE_WINDOW);

  for (const candidate of boundedCandidates) {
    const matchedName =
      input.fromName !== null
        ? candidate.names.find((n) => matchesDisplayName(input.fromName as string, n))
        : undefined;
    if (matchedName && input.fromName) {
      const headerNote = input.fromHeader ? ` (${plain(input.fromHeader, 120)})` : "";
      add(candidate, matchedName, "display-name", `From name "${plain(input.fromName, 80)}"${headerNote}`);
    }

    const voiceMatch =
      voice.claimedIdentity !== null
        ? candidate.names.find(
            (n) =>
              matchesDisplayName(voice.claimedIdentity as string, n) ||
              containsNamePhrase(n, voice.claimedIdentity as string),
          )
        : undefined;
    if (voiceMatch && voice.claimedIdentity) {
      const quoteNote = voice.identityQuote ? `: "${plain(voice.identityQuote, 100)}"` : "";
      add(candidate, voiceMatch, "voice", `The voice note names ${plain(voiceMatch, 60)}${quoteNote}`);
    }

    for (const rawCandidateDomain of candidate.domains) {
      const candAscii = asciiDomain(rawCandidateDomain);
      const domain = candAscii
        ? (registrable(candAscii) ?? rawCandidateDomain.toLowerCase())
        : rawCandidateDomain.toLowerCase();
      if (fromDomain && fromDomain === domain && input.fromDomain) {
        add(
          candidate,
          matchedName ?? candidate.names[0] ?? domain,
          "from-domain",
          `From domain ${plain(input.fromDomain, 120)}`,
        );
      } else if (fromDomain && lookalikeOf(fromDomain, domain) && input.fromDomain) {
        add(
          candidate,
          matchedName ?? candidate.names[0] ?? domain,
          "from-lookalike",
          `From domain ${plain(input.fromDomain, 120)} looks like ${domain}`,
        );
      }
      for (const reply of replyEntries) {
        if (reply.registrable === domain) {
          add(
            candidate,
            matchedName ?? candidate.names[0] ?? domain,
            "reply-to-domain",
            `Reply-To domain ${plain(reply.raw, 120)}`,
          );
        } else if (lookalikeOf(reply.registrable, domain)) {
          add(
            candidate,
            matchedName ?? candidate.names[0] ?? domain,
            "reply-to-lookalike",
            `Reply-To domain ${plain(reply.raw, 120)} looks like ${domain}`,
          );
        }
      }
    }

    if (signatureLines.length > 0) {
      for (const candidateName of candidate.names) {
        if (normaliseName(candidateName).length < 3) continue;
        const matchedLine = signatureLines.find((line) => containsNamePhrase(line, candidateName));
        if (matchedLine !== undefined) {
          const excerpt = oneLine(matchedLine) ?? candidateName;
          add(
            candidate,
            candidateName,
            "signature",
            `The signature block names ${plain(candidateName, 60)}: "${plain(excerpt, 100)}"`,
          );
          break;
        }
      }
    }
  }

  for (const judgement of input.logoJudgements) {
    const candidate = candidateByOrg.get(judgement.orgId);
    if (!candidate) continue;
    if (positiveLogoJudgement(judgement)) {
      add(
        candidate,
        candidate.names[0] ?? candidate.domains[0] ?? "the business",
        "logo",
        "The mail's logo matches the registered logo",
        judgement.cropKey,
      );
    }
  }

  // Attach all validated logo judgements (positive or negative) for any claimed identity so §3 can consume them.
  for (const judgement of input.logoJudgements) {
    const hit = hits.get(judgement.orgId);
    if (!hit || !isCaseArtefactKey(judgement.cropKey)) continue;
    hit.logos.push({
      same: positiveLogoJudgement(judgement),
      brandSeen: judgement.brandSeen ?? null,
      differences: (judgement.differences ?? []).map((d) => plain(d, 200)),
      confidence: judgement.confidence ?? 1,
      cropKey: judgement.cropKey,
    });
  }

  return [...hits.values()];
}

const ROUTE_WORDS: Record<ClaimRoute, string> = {
  "display-name": "its display name",
  "from-domain": "its From domain",
  "from-lookalike": "a lookalike From domain",
  "reply-to-domain": "its Reply-To domain",
  "reply-to-lookalike": "a lookalike Reply-To domain",
  signature: "its signature block",
  voice: "a voice claim",
  logo: "its logo",
};

function collectUnavailable(input: ClaimInput): string[] {
  const reasons: string[] = [];
  const push = (reason: string) => {
    const cleaned = plain(reason.replace(/ident\/[^\s,;)]+/g, "registered-logo"), 160);
    if (cleaned && !reasons.includes(cleaned)) reasons.push(cleaned);
  };

  if (input.candidates.length > MAX_CANDIDATES) {
    const omitted = input.candidates.length - MAX_CANDIDATES;
    push(
      `${omitted} protected ${omitted === 1 ? "identity" : "identities"} past the candidate bound could not be compared`,
    );
  }
  for (const candidate of input.candidates.slice(0, MAX_CANDIDATES)) {
    if ((candidate.namesOmitted ?? 0) > 0 || (candidate.domainsOmitted ?? 0) > 0) {
      const label = plain(candidate.names[0] ?? candidate.domains[0] ?? "a protected business", 60);
      push(`some registered names or domains for ${label} were past the candidate bound`);
    }
    for (const d of candidate.domains) {
      if (!domainComparableForLookalike(d)) {
        push("a registered domain could not be compared for lookalikes");
      }
    }
  }

  if (input.fromDomain && !domainComparableForLookalike(input.fromDomain)) {
    push("the From domain could not be compared for lookalikes");
  }
  const replyDomains = [...(input.replyToDomain ? [input.replyToDomain] : []), ...(input.replyToDomains ?? [])];
  for (const r of replyDomains) {
    if (r && !domainComparableForLookalike(r)) {
      push("a Reply-To domain could not be compared for lookalikes");
    }
  }

  for (const v of readVoiceInput(input.voice).unavailable) {
    push(v);
  }

  for (const j of input.logoJudgements) {
    if (j.same && (j.confidence ?? 1) < MIN_LOGO_CLAIM_CONFIDENCE) {
      push("a logo comparison had low confidence");
    }
  }

  for (const u of input.unavailable) {
    push(u);
  }

  return reasons;
}

// The trust.claim evidence (info): one item per claimed identity, its routes, support, logo judgements, and
// case-owned artefacts, plus one item naming what could not be compared when that leaves a route unread.
export function claimEvidence(input: ClaimInput): EvidenceDraft[] {
  const unavailable = collectUnavailable(input);
  const rawKey = input.rawKey && isCaseArtefactKey(input.rawKey) ? input.rawKey : null;

  const items: EvidenceDraft[] = detectClaims(input).map((hit) => {
    const artefacts: string[] = [];
    for (const cropKey of hit.cropKeys) {
      if (isCaseArtefactKey(cropKey) && !artefacts.includes(cropKey)) {
        artefacts.push(cropKey);
      }
    }
    if (rawKey && hit.routes.some((r) => r !== "logo") && !artefacts.includes(rawKey)) {
      artefacts.push(rawKey);
    }
    return {
      check: "trust.claim",
      severity: "info",
      summary: bounded(`Claims ${plain(hit.name, 80)} by ${hit.routes.map((r) => ROUTE_WORDS[r]).join(", ")}`),
      detail: fittedDetail({
        checked: true,
        orgId: hit.orgId,
        name: hit.name,
        routes: hit.routes,
        support: hit.support,
        ...(hit.logos.length ? { logos: hit.logos } : {}),
      }) as EvidenceDraft["detail"],
      artefacts,
    };
  });

  if (unavailable.length > 0) {
    items.push({
      check: "trust.claim",
      severity: "info",
      summary: bounded(`Some claim routes could not be compared: ${unavailable.join(", ")}`),
      detail: fittedDetail({
        checked: false,
        unavailable,
      }) as EvidenceDraft["detail"],
      artefacts: rawKey ? [rawKey] : [],
    });
  }

  return items;
}

// Consumer schema for D05 T02 §3 (`trust.sender_not_registered`, `trust.bank_mismatch`, `trust.verified_sender`):
// validates stored `trust.claim` evidence details without guessing their shape.
export const trustClaimLogoDetailSchema = z.strictObject({
  same: z.boolean(),
  brandSeen: z.string().max(255).nullable(),
  differences: z.array(z.string().max(255)).max(20),
  confidence: z.number().min(0).max(1),
  cropKey: z.string().min(1).max(255).refine(isCaseArtefactKey, "must be a case-owned artefact key"),
});

export const trustClaimHitDetailSchema = z.strictObject({
  checked: z.literal(true).optional(),
  orgId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  routes: z.array(z.enum(ROUTE_ORDER)).min(1).max(8),
  support: z.array(z.string().min(1).max(255)).min(1).max(20),
  logos: z.array(trustClaimLogoDetailSchema).max(20).optional(),
  trimmed: z.boolean().optional(),
});

export const trustClaimUnavailableDetailSchema = z.strictObject({
  checked: z.literal(false).optional(),
  unavailable: z.array(z.string().min(1).max(255)).min(1).max(20),
  trimmed: z.boolean().optional(),
});

export type TrustClaimReading =
  | { kind: "claim"; detail: z.infer<typeof trustClaimHitDetailSchema> }
  | { kind: "unavailable"; detail: z.infer<typeof trustClaimUnavailableDetailSchema> };

export function readTrustClaimDetail(detail: unknown): TrustClaimReading {
  if (
    typeof detail === "object" &&
    detail !== null &&
    (("checked" in detail && detail.checked === false) || ("unavailable" in detail && !("orgId" in detail)))
  ) {
    return { kind: "unavailable", detail: trustClaimUnavailableDetailSchema.parse(detail) };
  }
  return { kind: "claim", detail: trustClaimHitDetailSchema.parse(detail) };
}

// Extracts `ClaimInput` from a `CaseView`: reads `view.protectedCandidates` (D02 T01 §9), the original message's
// From and Reply-To headers when `view.tenant.headersAvailable` is true, the plain-text body (`view.text`),
// the voice reading (`view.voice`), and the bounded logo-comparison result (`view.claimLogos`).
export function claimInputFromView(view: Readonly<CaseView>): ClaimInput {
  const withCustom = view as Readonly<CaseViewWithClaimLogos>;
  if (withCustom.claims) {
    return withCustom.claims;
  }

  const unavailable: string[] = [];
  const protectedSet = view.protectedCandidates;
  if (!protectedSet) {
    return {
      fromName: null,
      fromDomain: null,
      replyToDomain: null,
      text: null,
      voice: null,
      candidates: [],
      logoJudgements: [],
      unavailable: ["the protected-identity candidates were not read for this case"],
      rawKey: view.raw || null,
    };
  }

  if (protectedSet.omitted > 0) {
    unavailable.push(
      `${protectedSet.omitted} protected ${protectedSet.omitted === 1 ? "identity" : "identities"} past the candidate bound (${MAX_PROTECTED_CANDIDATES}) could not be compared`,
    );
  }

  const candidates: ClaimCandidate[] = protectedSet.candidates.map((c) => {
    if (c.namesOmitted > 0 || c.domainsOmitted > 0) {
      const label = plain(c.names[0] ?? c.domains[0] ?? "a protected business", 60);
      unavailable.push(
        `some registered names or domains for ${label} past the bound (${MAX_CANDIDATE_NAMES}/${MAX_CANDIDATE_DOMAINS}) could not be compared`,
      );
    }
    return {
      orgId: c.orgId,
      names: c.names,
      domains: c.domains,
      namesOmitted: c.namesOmitted,
      domainsOmitted: c.domainsOmitted,
    };
  });

  let fromName: string | null = null;
  let fromDomain: string | null = null;
  let fromHeader: string | null = null;
  const replyToDomains: string[] = [];
  const replyToHeaders: string[] = [];

  if (view.tenant.headersAvailable) {
    const fromHeaders = view.headers.filter((h) => h.name.trim().toLowerCase() === "from");
    const orig = originalHeaderOf(view.headers);
    fromName = orig.fromName;
    if (orig.fromAddress) {
      fromDomain = orig.fromAddress.slice(orig.fromAddress.lastIndexOf("@") + 1);
    }
    if (fromHeaders.length === 1 && fromHeaders[0]) {
      fromHeader = oneLine(`${fromHeaders[0].name}: ${fromHeaders[0].value}`);
      if (!fromName && !orig.fromAddress) {
        // Check if a single From header had a display name even when its mailbox was invalid, and record the unread mailbox.
        const unfolded = fromHeaders[0].value.replace(/\r?\n[ \t]*/g, " ");
        const parsed = addressParser(unfolded, { flatten: true });
        if (parsed.length === 1 && parsed[0]?.name) {
          fromName = oneLine(parsed[0].name);
        }
        if (unfolded.trim()) {
          unavailable.push("the From address could not be read");
        }
      }
    } else if (fromHeaders.length > 1) {
      unavailable.push("multiple From headers were present and could not be trusted");
    }

    const replyHeaders = view.headers.filter((h) => h.name.trim().toLowerCase() === "reply-to");
    for (const h of replyHeaders) {
      const unfolded = h.value.replace(/\r?\n[ \t]*/g, " ");
      if (!unfolded.trim()) continue;
      const parsed = addressParser(unfolded, { flatten: true });
      if (!parsed.length) {
        unavailable.push("the Reply-To header could not be read");
        continue;
      }
      let anyUnread = false;
      for (const entry of parsed) {
        const box = entry.address ? mailbox(entry.address.trim()) : null;
        if (!box) {
          anyUnread = true;
          continue;
        }
        const dom = box.slice(box.lastIndexOf("@") + 1);
        if (!replyToDomains.includes(dom)) replyToDomains.push(dom);
      }
      const line = oneLine(`${h.name}: ${h.value}`);
      if (line && !replyToHeaders.includes(line)) replyToHeaders.push(line);
      if (anyUnread) unavailable.push("the Reply-To header could not be read");
    }
  } else if (view.source.kind === "message") {
    unavailable.push("the original's headers were not available");
  }

  if (view.truncated.some((t) => t.mediaType.toLowerCase() === "text/plain")) {
    unavailable.push("the plain-text body was cut short before its signature block");
  } else if (view.source.kind === "message" && view.text === null) {
    unavailable.push("the original has no plain-text body");
  }

  const claimLogos = withCustom.claimLogos;
  let logoJudgements: LogoJudgementFor[] = [];
  if (claimLogos) {
    logoJudgements = claimLogos.logoJudgements;
    for (const u of claimLogos.unavailable) {
      if (!unavailable.includes(u)) unavailable.push(u);
    }
  } else {
    const anyLogoRegistered = protectedSet.candidates.some((c) => c.logo !== null);
    const hasVisualSurface =
      view.source.kind === "message" ||
      (view.source.kind === "upload" && (view.source.fileKind === "document" || view.source.fileKind === "image"));
    if (anyLogoRegistered && hasVisualSurface) {
      unavailable.push("logo crops had not been compared when the check ran");
    }
  }

  return {
    fromName,
    fromDomain,
    replyToDomain: replyToDomains[0] ?? null,
    replyToDomains: replyToDomains.slice(1),
    fromHeader,
    replyToHeaders,
    text: view.text,
    voice: view.voice ?? null,
    candidates,
    logoJudgements,
    unavailable,
    rawKey: view.raw || null,
  };
}

export function withClaimLogos(view: CaseView, claimLogos: ClaimLogoPhaseResult): CaseViewWithClaimLogos {
  return {
    ...view,
    claimLogos,
  };
}

export type ClaimLogoDeps = {
  store: Store;
  meta: MetaContext;
  kv: KVNamespace;
  waitUntil?: (promise: Promise<unknown>) => void;
  deadlineMs?: number;
  now?: () => number;
  // Converts sanitised SVG bytes to PNG bytes before `compareLogo` (which requires raster images).
  rasteriseSvg?: (svgBytes: Uint8Array, timeoutMs: number) => Promise<Uint8Array>;
  // Optional Puppeteer Browser launcher for default SVG rasterisation when `rasteriseSvg` is not injected.
  launch?: () => Promise<Browser>;
};

const cropManifestSchema = z.strictObject({
  source: z.strictObject({
    name: z.string().min(1),
    key: z.string().min(1),
    sha256: z.string().min(1),
  }),
  crops: z.array(z.string().min(1)),
});

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function rasteriseSvgInBrowser(browser: Browser, svgBytes: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("svg-raster-timeout")), Math.max(1, timeoutMs));
  });
  let landed: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  let settled = false;
  const startedAt = Date.now();
  try {
    const page = await Promise.race([
      browser.newPage().then((p) => {
        landed = p;
        if (settled) void p.close().catch(() => undefined);
        return p;
      }),
      late,
    ]);
    const b64 = await Promise.race([
      page.evaluate(
        async (svgB64: string, maxSide: number) => {
          const g = globalThis as unknown as {
            createImageBitmap: (blob: Blob) => Promise<{ width: number; height: number; close: () => void }>;
            document: {
              createElement: (tag: string) => {
                width: number;
                height: number;
                getContext: (kind: string) => { drawImage: (img: unknown, ...args: number[]) => void } | null;
                toBlob: (cb: (blob: Blob | null) => void, type: string) => void;
              };
            };
          };
          const raw = Uint8Array.from(atob(svgB64), (c) => c.charCodeAt(0));
          const blob = new Blob([raw.buffer as ArrayBuffer], { type: "image/svg+xml;charset=utf-8" });
          const image = await g.createImageBitmap(blob);
          try {
            const w = Math.max(1, Math.min(maxSide, image.width || maxSide));
            const h = Math.max(1, Math.min(maxSide, image.height || maxSide));
            const canvas = g.document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no-2d-context");
            ctx.drawImage(image, 0, 0, w, h);
            const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!pngBlob) throw new Error("no-png-blob");
            const buf = new Uint8Array(await pngBlob.arrayBuffer());
            let encoded = "";
            for (let i = 0; i < buf.length; i += 0x8000) {
              encoded += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            }
            return btoa(encoded);
          } finally {
            image.close();
          }
        },
        toBase64(svgBytes),
        SVG_RASTER_SIDE,
      ),
      late,
    ]);
    return fromBase64(b64);
  } finally {
    settled = true;
    clearTimeout(timer);
    if (landed) {
      await Promise.race([
        landed.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, startedAt + timeoutMs - Date.now()))),
      ]);
    }
  }
}

// Bounded registered-logo comparison phase (D05 T02 §2, plan review gap 2):
// discovers the latest generation of case-owned SAM crop manifests (`art/<caseId>/crop/*-manifest-<n>.json`),
// loads and validates each candidate's registered logo from R2 (validating PNGs with `pngPixelsProblem` and
// sanitising + rasterising SVGs to PNG before calling `compareLogo`), and compares each logo crop within a
// shared phase deadline. Every failure mode is recorded in `unavailable`, and no registered-logo storage key
// ever appears in the returned judgements or unavailable reasons.
export async function compareClaimLogos(
  deps: ClaimLogoDeps,
  caseId: string,
  candidates: readonly ProtectedCandidates["candidates"][number][],
): Promise<ClaimLogoPhaseResult> {
  const now = deps.now ?? Date.now;
  const unavailable: string[] = [];
  const addUnavailable = (reason: string) => {
    if (!unavailable.includes(reason)) unavailable.push(reason);
  };

  if (candidates.length > MAX_CANDIDATES) {
    addUnavailable("candidate-cap-reached");
  }
  const withLogo = candidates
    .slice(0, MAX_CANDIDATES)
    .filter(
      (c): c is (typeof candidates)[number] & { logo: NonNullable<(typeof candidates)[number]["logo"]> } =>
        c.logo !== null,
    );
  if (withLogo.length === 0) {
    return { logoJudgements: [], unavailable };
  }

  const phaseAt = now() + (deps.deadlineMs ?? CLAIM_LOGO_PHASE_MS);
  const phaseDeadline = {
    at: phaseAt,
    expired: () => now() > phaseAt,
  };

  const withinPhase = async <T>(
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "error"; error?: unknown }> => {
    const left = phaseAt - now();
    if (left <= 0) return { ok: false, reason: "timeout" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), left);
    });
    try {
      return await Promise.race([
        work().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, reason: "error" as const, error }),
        ),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const listing = await withinPhase(() => artefactsOf(deps.store, caseId, "crop"));
  if (!listing.ok) {
    addUnavailable(listing.reason === "timeout" ? "comparison-timeout" : "crop-listing-unavailable");
    return { logoJudgements: [], unavailable };
  }
  const cropArtefacts: Stored[] = listing.value;
  if (!cropArtefacts.length && phaseDeadline.expired()) {
    addUnavailable("comparison-timeout");
    return { logoJudgements: [], unavailable };
  }

  const escapedCase = caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const manifestPattern = new RegExp(`^art/${escapedCase}/crop/[0-9a-f]+-(.+)-manifest-(\\d+)\\.json$`);
  const cropPrefix = `art/${caseId}/crop/`;

  const manifests = new Map<string, string[]>();
  const generations = new Map<string, number>();
  const stemBySource = new Map<string, string>();
  const failedByStem = new Map<string, number>();
  let failedManifests = 0;

  for (const artefact of cropArtefacts) {
    const match = manifestPattern.exec(artefact.key) ?? /-(.+)-manifest-(\d+)\.json$/.exec(artefact.key);
    if (!match) continue;
    const stem = match[1] ?? "";
    const gen = Number(match[2]);
    if (!Number.isInteger(gen) || gen < 1) continue;

    const read = await withinPhase(() => readArtefact(deps.store, caseId, artefact.key));
    if (!read.ok) {
      failedManifests += 1;
      if (stem) failedByStem.set(stem, Math.max(failedByStem.get(stem) ?? 0, gen));
      if (read.reason === "timeout") addUnavailable("comparison-timeout");
      continue;
    }
    if (!read.value || !("body" in read.value)) {
      failedManifests += 1;
      if (stem) failedByStem.set(stem, Math.max(failedByStem.get(stem) ?? 0, gen));
      continue;
    }
    try {
      const rawJson: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(read.value.body),
      );
      const parsed = cropManifestSchema.safeParse(rawJson);
      if (!parsed.success || !parsed.data.crops.every((k) => k.startsWith(cropPrefix) && isCaseArtefactKey(k))) {
        failedManifests += 1;
        if (stem) failedByStem.set(stem, Math.max(failedByStem.get(stem) ?? 0, gen));
        continue;
      }
      const sourceKey = parsed.data.source.key;
      if (gen >= (generations.get(sourceKey) ?? 0)) {
        generations.set(sourceKey, gen);
        manifests.set(sourceKey, parsed.data.crops);
        if (stem) stemBySource.set(sourceKey, stem);
      }
    } catch {
      failedManifests += 1;
      if (stem) failedByStem.set(stem, Math.max(failedByStem.get(stem) ?? 0, gen));
    }
  }

  for (const [sourceKey, gen] of [...generations.entries()]) {
    const stem = stemBySource.get(sourceKey);
    if (stem && (failedByStem.get(stem) ?? 0) >= gen) {
      manifests.delete(sourceKey);
      addUnavailable("manifest-unreadable");
    }
  }
  const activeStems = new Set(stemBySource.values());
  for (const stem of failedByStem.keys()) {
    if (!activeStems.has(stem)) {
      addUnavailable("manifest-unreadable");
    }
  }
  if (failedManifests > 0 && manifests.size === 0) {
    addUnavailable("manifest-unreadable");
  }

  const allLogoCropKeys: string[] = [];
  for (const crops of manifests.values()) {
    for (const key of crops) {
      if (key.includes("-logo-") && !allLogoCropKeys.includes(key)) {
        allLogoCropKeys.push(key);
      }
    }
  }

  if (allLogoCropKeys.length === 0) {
    return { logoJudgements: [], unavailable };
  }
  if (allLogoCropKeys.length > MAX_CLAIM_CROPS) {
    addUnavailable("logo-crop-cap-reached");
  }
  const selectedCropKeys = allLogoCropKeys.slice(0, MAX_CLAIM_CROPS);

  const loadedCrops: { key: string; bytes: Uint8Array }[] = [];
  for (const cropKey of selectedCropKeys) {
    if (phaseDeadline.expired()) {
      addUnavailable("comparison-timeout");
      break;
    }
    const read = await withinPhase(() => readArtefact(deps.store, caseId, cropKey));
    if (!read.ok) {
      addUnavailable(read.reason === "timeout" ? "comparison-timeout" : "missing-crop");
      continue;
    }
    if (!read.value || !("body" in read.value)) {
      addUnavailable("missing-crop");
      continue;
    }
    const bytes = read.value.body;
    if (bytes.byteLength > MAX_CROP_IMAGE_BYTES) {
      addUnavailable("too-large");
      continue;
    }
    if (pngProblem(bytes) !== null) {
      addUnavailable("unsupported-media");
      continue;
    }
    loadedCrops.push({ key: cropKey, bytes });
  }

  if (loadedCrops.length === 0) {
    return { logoJudgements: [], unavailable };
  }

  let browser: Browser | undefined;
  const logoJudgements: LogoJudgementFor[] = [];
  let comparisonsRun = 0;
  const owner = { kind: "case" as const, caseId, step: "trust-claim" };

  try {
    for (const candidate of withLogo) {
      if (phaseDeadline.expired()) {
        addUnavailable("comparison-timeout");
        break;
      }
      if (comparisonsRun >= MAX_CLAIM_LOGO_COMPARISONS) {
        addUnavailable("logo-comparison-cap-reached");
        break;
      }

      const objRes = await withinPhase(() => deps.store.bucket.get(candidate.logo.key));
      if (!objRes.ok) {
        addUnavailable(objRes.reason === "timeout" ? "comparison-timeout" : "registered-logo-unreadable");
        continue;
      }
      const r2Object = objRes.value;
      if (!r2Object) {
        addUnavailable("registered-logo-unreadable");
        continue;
      }
      const bufRes = await withinPhase(() => r2Object.arrayBuffer());
      if (!bufRes.ok) {
        addUnavailable(bufRes.reason === "timeout" ? "comparison-timeout" : "registered-logo-unreadable");
        continue;
      }
      const rawBytes = new Uint8Array(bufRes.value);
      if (rawBytes.byteLength === 0) {
        addUnavailable("registered-logo-invalid");
        continue;
      }
      if (rawBytes.byteLength > MAX_LOGO_BYTES) {
        addUnavailable("too-large");
        continue;
      }

      let referencePngBytes: Uint8Array | null = null;
      if (candidate.logo.mediaType === "image/png") {
        const checkRes = await withinPhase(() => pngPixelsProblem(rawBytes));
        if (!checkRes.ok) {
          addUnavailable(checkRes.reason === "timeout" ? "comparison-timeout" : "registered-logo-invalid");
          continue;
        }
        if (checkRes.value !== null) {
          addUnavailable("registered-logo-invalid");
          continue;
        }
        referencePngBytes = rawBytes;
      } else if (candidate.logo.mediaType === "image/svg+xml") {
        let sanitisedBytes: Uint8Array;
        try {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBytes);
          sanitisedBytes = new TextEncoder().encode(sanitiseSvg(text));
        } catch {
          addUnavailable("registered-logo-invalid");
          continue;
        }
        if (!deps.rasteriseSvg && !deps.launch) {
          addUnavailable("registered-logo-svg-unrasterised");
          continue;
        }
        const rasterRes = await withinPhase(async () => {
          const left = Math.max(1, phaseAt - now());
          if (deps.rasteriseSvg) {
            return deps.rasteriseSvg(sanitisedBytes, left);
          }
          if (!browser && deps.launch) {
            browser = await deps.launch();
          }
          if (!browser) throw new Error("no-browser-for-svg-raster");
          return rasteriseSvgInBrowser(browser, sanitisedBytes, Math.max(1, phaseAt - now()));
        });
        if (!rasterRes.ok) {
          addUnavailable(rasterRes.reason === "timeout" ? "comparison-timeout" : "registered-logo-svg-unrasterised");
          continue;
        }
        const pngCheck = await withinPhase(() => pngPixelsProblem(rasterRes.value));
        if (!pngCheck.ok || pngCheck.value !== null) {
          addUnavailable(
            !pngCheck.ok && pngCheck.reason === "timeout" ? "comparison-timeout" : "registered-logo-svg-unrasterised",
          );
          continue;
        }
        referencePngBytes = rasterRes.value;
      } else {
        addUnavailable("unsupported-media");
        continue;
      }

      for (const crop of loadedCrops) {
        if (phaseDeadline.expired()) {
          addUnavailable("comparison-timeout");
          break;
        }
        if (comparisonsRun >= MAX_CLAIM_LOGO_COMPARISONS) {
          addUnavailable("logo-comparison-cap-reached");
          break;
        }
        comparisonsRun += 1;
        try {
          const judgement = await compareLogo(
            {
              meta: { ...deps.meta, owner },
              kv: deps.kv,
              owner,
              waitUntil: deps.waitUntil ?? (() => {}),
              deadline: phaseDeadline,
            },
            { bytes: crop.bytes, mediaType: "image/png", label: crop.key },
            { bytes: referencePngBytes, mediaType: "image/png", label: `registered-${candidate.orgId}` },
          );
          if (judgement.same_brand && judgement.confidence < MIN_LOGO_CLAIM_CONFIDENCE) {
            addUnavailable("a logo comparison had low confidence");
            logoJudgements.push({
              orgId: candidate.orgId,
              same: false,
              brandSeen: judgement.brand_seen,
              differences: judgement.differences,
              confidence: judgement.confidence,
              cropKey: crop.key,
            });
          } else {
            logoJudgements.push({
              orgId: candidate.orgId,
              same: judgement.same_brand,
              brandSeen: judgement.brand_seen,
              differences: judgement.differences,
              confidence: judgement.confidence,
              cropKey: crop.key,
            });
            if (judgement.same_brand) break;
          }
        } catch (error) {
          if (error instanceof LogoCompareError) {
            addUnavailable(error.kind);
          } else if (error instanceof BudgetExceeded) {
            addUnavailable("comparison-budget");
          } else if (error instanceof ModelOutputError) {
            addUnavailable(error.kind === "refused" ? "comparison-refused" : "comparison-failed");
          } else if (error instanceof ModelError) {
            if (error.kind === "timeout") addUnavailable("comparison-timeout");
            else if (error.kind === "billing") addUnavailable("comparison-budget");
            else if (error.kind === "content-policy" || error.kind === "refused-model")
              addUnavailable("comparison-refused");
            else addUnavailable("comparison-failed");
          } else {
            addUnavailable(phaseDeadline.expired() ? "comparison-timeout" : "comparison-failed");
          }
        }
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  return { logoJudgements, unavailable };
}

// Runs the bounded registered-logo comparison phase over the case's stored SAM crop manifests and returns
// the enriched `CaseView` (`withClaimLogos`) together with the resulting `trust.claim` evidence items.
export async function runClaimDetectionWithLogos(
  deps: ClaimLogoDeps,
  caseId: string,
  view: CaseView,
): Promise<{ view: CaseViewWithClaimLogos; items: EvidenceDraft[] }> {
  const candidates = view.protectedCandidates?.candidates ?? [];
  const claimLogos = await compareClaimLogos(deps, caseId, candidates);
  const enriched = withClaimLogos(view, claimLogos);
  return {
    view: enriched,
    items: claimEvidence(claimInputFromView(enriched)),
  };
}

function skipReasonForView(view: Readonly<CaseView>): string | null {
  const withCustom = view as Readonly<CaseViewWithClaimLogos>;
  if (withCustom.claims) return null;
  if (!view.protectedCandidates) {
    return "the protected-identity candidates were not read for this case";
  }
  if (
    view.protectedCandidates.candidates.length === 0 &&
    view.protectedCandidates.omitted === 0 &&
    !withCustom.claimLogos?.unavailable.length
  ) {
    return "no protected identity is registered";
  }
  const hasSurface =
    view.tenant.headersAvailable ||
    view.source.kind === "message" ||
    view.text !== null ||
    (view.voice !== undefined && view.voice !== null) ||
    withCustom.claimLogos !== undefined;
  if (!hasSurface) {
    return "the case has no headers, text, voice note or logo crops to check";
  }
  return null;
}

function examinedForView(view: Readonly<CaseView>): string[] {
  const targets: string[] = [];
  const addTarget = (value: string | null | undefined) => {
    if (!value) return;
    const cleaned = plain(value, 120);
    if (cleaned && !targets.includes(cleaned)) targets.push(cleaned);
  };
  const input = claimInputFromView(view);
  addTarget(input.fromName);
  addTarget(input.fromDomain);
  addTarget(input.replyToDomain);
  for (const r of input.replyToDomains ?? []) addTarget(r);
  if (input.text !== null) addTarget("signature block (last 15 lines)");
  if (input.voice && input.voice.state === "read") {
    const claimed = "claim" in input.voice ? input.voice.claim.claimedIdentity : input.voice.claimedIdentity;
    addTarget(claimed ? `voice claim: ${claimed}` : "voice note");
  }
  for (const j of input.logoJudgements) {
    if (isCaseArtefactKey(j.cropKey)) addTarget(j.cropKey);
  }
  return targets;
}

// The registered check (`trust.claim`). It reads `view.protectedCandidates` (D02 T01 §9), `view.headers`,
// `view.text`, `view.voice`, and `view.claimLogos` (or `view.claims` when supplied directly); without
// `protectedCandidates` it skips with a stated reason, never a silent no-claim.
export function registerClaimCheck(registry: CheckRegistry): void {
  registry.register({
    name: "trust.claim",
    needs: [],
    timeoutMs: 5_000,
    applies: skipReasonForView,
    partial: (view) => {
      if (skipReasonForView(view) !== null) return null;
      const unavailable = collectUnavailable(claimInputFromView(view));
      return unavailable[0] ?? null;
    },
    run: (view) => {
      if (skipReasonForView(view) !== null) return [];
      return claimEvidence(claimInputFromView(view));
    },
    examined: examinedForView,
    summary: (_view, items) => {
      const claimItems = items.filter((i) => i.detail.checked !== false);
      if (claimItems.length === 1) {
        return plain(claimItems[0]?.summary ?? "1 protected business claimed", MAX_OUTCOME_SUMMARY);
      }
      if (claimItems.length > 1) {
        return `${claimItems.length} protected businesses claimed`;
      }
      if (items.length === 0) {
        return "no protected business claimed";
      }
      return null;
    },
  });
}
