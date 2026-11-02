// Claim detection (D05 T02 §2): the routes by which a mail or voice note claims a protected
// identity, as pure detection over the claim input the pipeline supplies. The registered check
// is store-free (src/checks/registry.ts), so candidates arrive typed: each effectively
// protected identity that could be claimed, with its verified domains and registered logo
// reference. Only the organisation, the name matched and the routes are evidence: no contact,
// bank field or registered-logo storage reference leaves this module.
import { registrable } from "../auth/senders";
import type { CaseView } from "../checks/case-view";
import type { EvidenceDraft } from "../checks/evidence";
import { distance, labelSkeleton } from "../checks/lookalike";
import type { CheckRegistry } from "../checks/registry";
import { normaliseName } from "./names";

export type ClaimRoute =
  | "display-name"
  | "from-domain"
  | "from-lookalike"
  | "reply-to-domain"
  | "reply-to-lookalike"
  | "signature"
  | "voice"
  | "logo";

export type ClaimCandidate = {
  orgId: string;
  // The identity's display names, any of which a claim may use.
  names: string[];
  // Its verified domains, in registrable form.
  domains: string[];
};

export type LogoJudgementFor = {
  orgId: string;
  // The validated judgement's same-logo answer for the mail's crop against this identity.
  same: boolean;
  cropKey: string;
};

export type ClaimInput = {
  fromName: string | null;
  fromDomain: string | null;
  replyToDomain: string | null;
  // The body's text; the signature is its last 15 lines.
  text: string | null;
  voice: { state: string; claimedIdentity: string | null } | null;
  candidates: ClaimCandidate[];
  logoJudgements: LogoJudgementFor[];
  // What could not be read (a crop, a registered logo, a comparison), stated, never a no-match.
  unavailable: string[];
};

export type ClaimHit = {
  orgId: string;
  // The display name the claim matched, or the claimed domain for a domain-only claim.
  name: string;
  routes: ClaimRoute[];
  support: string[];
};

const MAX_CANDIDATES = 50;

function lookalikeOf(domain: string, candidateDomain: string): boolean {
  if (domain === candidateDomain) return false;
  const a = domain.split(".")[0] ?? "";
  const b = candidateDomain.split(".")[0] ?? "";
  const skelA = labelSkeleton(a);
  const skelB = labelSkeleton(b);
  if (skelA !== null && skelB !== null && skelA === skelB) return true;
  return distance(a, b) <= 2 && domain.split(".").slice(1).join(".") === candidateDomain.split(".").slice(1).join(".");
}

// Every identity the input claims, with every route that matched for it.
export function detectClaims(input: ClaimInput): ClaimHit[] {
  const hits = new Map<string, ClaimHit>();
  const add = (candidate: ClaimCandidate, name: string, route: ClaimRoute, support: string) => {
    const hit = hits.get(candidate.orgId) ?? { orgId: candidate.orgId, name, routes: [], support: [] };
    if (!hit.routes.includes(route)) hit.routes.push(route);
    if (!hit.support.includes(support)) hit.support.push(support);
    hits.set(candidate.orgId, hit);
  };
  const fromDomain = input.fromDomain ? registrable(input.fromDomain) : null;
  const replyDomain = input.replyToDomain ? registrable(input.replyToDomain) : null;
  const wantedName = input.fromName ? normaliseName(input.fromName) : "";
  const voiceName =
    input.voice?.state === "read" && input.voice.claimedIdentity ? normaliseName(input.voice.claimedIdentity) : "";
  const lines = (input.text ?? "").split(/\r?\n/);
  const signature = lines.slice(-15).join("\n").toLowerCase();

  for (const candidate of input.candidates.slice(0, MAX_CANDIDATES)) {
    const matchedName = candidate.names.find((n) => wantedName !== "" && normaliseName(n) === wantedName);
    if (matchedName && input.fromName)
      add(candidate, matchedName, "display-name", `From name "${input.fromName.slice(0, 80)}"`);
    const voiceMatch = candidate.names.find((n) => voiceName !== "" && normaliseName(n) === voiceName);
    if (voiceMatch) add(candidate, voiceMatch, "voice", "The voice note names this business");
    for (const domain of candidate.domains) {
      if (fromDomain && fromDomain === domain && input.fromDomain)
        add(candidate, matchedName ?? domain, "from-domain", `From domain ${input.fromDomain.slice(0, 120)}`);
      else if (fromDomain && lookalikeOf(fromDomain, domain) && input.fromDomain)
        add(
          candidate,
          matchedName ?? domain,
          "from-lookalike",
          `From domain ${input.fromDomain.slice(0, 120)} looks like ${domain}`,
        );
      if (replyDomain && replyDomain === domain && input.replyToDomain)
        add(
          candidate,
          matchedName ?? domain,
          "reply-to-domain",
          `Reply-To domain ${input.replyToDomain.slice(0, 120)}`,
        );
      else if (replyDomain && lookalikeOf(replyDomain, domain) && input.replyToDomain)
        add(
          candidate,
          matchedName ?? domain,
          "reply-to-lookalike",
          `Reply-To domain ${input.replyToDomain.slice(0, 120)} looks like ${domain}`,
        );
    }
    const signed = candidate.names.find((n) => n.length >= 3 && signature.includes(n.toLowerCase()));
    if (signed) add(candidate, signed, "signature", "The signature block names this business");
  }
  for (const judgement of input.logoJudgements) {
    if (!judgement.same) continue;
    const candidate = input.candidates.find((c) => c.orgId === judgement.orgId);
    if (candidate)
      add(
        candidate,
        candidate.names[0] ?? candidate.domains[0] ?? "the business",
        "logo",
        "The mail's logo matches the registered logo",
      );
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

// The trust.claim evidence (info): one item per claimed identity, its routes and support, plus
// one item naming what could not be compared when that leaves a route unread.
export function claimEvidence(input: ClaimInput): EvidenceDraft[] {
  const items: EvidenceDraft[] = detectClaims(input).map((hit) => ({
    check: "trust.claim",
    severity: "info",
    summary: `Claims ${hit.name} by ${hit.routes.map((r) => ROUTE_WORDS[r]).join(", ")}`.slice(0, 200),
    detail: { orgId: hit.orgId, name: hit.name, routes: hit.routes, support: hit.support },
    artefacts: input.logoJudgements.filter((j) => j.orgId === hit.orgId && j.same).map((j) => j.cropKey),
  }));
  if (input.unavailable.length)
    items.push({
      check: "trust.claim",
      severity: "info",
      summary: `Some claim routes could not be compared: ${input.unavailable.join(", ")}`.slice(0, 200),
      detail: { unavailable: input.unavailable },
      artefacts: [],
    });
  return items;
}

// The registered check. It reads the claim input the checks step fills on the view
// (`claims`, the CaseView field the checks lane adds with the coordinator's agreement);
// without it the check skips, naming why, never a silent no-claim.
export function registerClaimCheck(registry: CheckRegistry): void {
  registry.register({
    name: "trust.claim",
    needs: ["headers", "text"],
    timeoutMs: 5_000,
    applies: (view) =>
      (view as CaseView & { claims?: ClaimInput }).claims ? null : "the claim input was not read for this case",
    run: (view) => claimEvidence((view as CaseView & { claims?: ClaimInput }).claims as ClaimInput),
    summary: (_view, items) => items[0]?.summary ?? null,
  });
}
