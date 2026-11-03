// Registry comparison evidence (D05 T02 §3; design spec 2a and 4.5): compares a claiming message,
// document, or voice note against IsItLegit's registry in match or no-match terms only.
//
// Findings state only what the message itself carried and whether it matches what the claimed
// business registered with IsItLegit ("Fynbos Freight is not registered on IsItLegit as sending from
// gmail.com", "These bank details are not the ones Fynbos Freight registered with IsItLegit").
// Registered domains (other than the public domain observed on the message itself), registered
// addresses, finance contacts, and registered account numbers or fragments never enter any evidence
// summary, detail, or check outcome.
import { addressParser } from "postal-mime";
import { claimable, registrable } from "../auth/senders";
import {
  aligned,
  asciiDomain,
  bounded,
  dkimIdentifier,
  fittedDetail,
  fromDomain,
  plain,
  spfIdentifier,
  stateOf,
} from "../checks/auth";
import { trustedAuthResults } from "../checks/auth-results";
import type { CaseView } from "../checks/case-view";
import type { EvidenceDraft } from "../checks/evidence";
import { CheckRegistry, MAX_OUTCOME_SUMMARY } from "../checks/registry";
import type { CheckOutcome } from "../checks/runner";
import { mailbox } from "../checks/sender";
import { oneLine, originalHeaderOf } from "../intake/original-header";
import { type BankKeys, bankKeys, canonicalAccount, type MatchCaller, matchBankAccount } from "./bank";
import {
  type ClaimInput,
  type ClaimLogoSummary,
  type ClaimRoute,
  claimInputFromView,
  detectClaims,
  ROUTE_ORDER,
  readTrustClaimDetail,
} from "./claim";
import { AccountRefused, BankKeysMissing, IdentityRefused, KeyMismatch, MatchLimited, NoBaseline } from "./errors";
import { getIdentity } from "./identity";
import { normaliseName } from "./names";

export const COMPARISON_CHECKS = [
  "trust.impersonation",
  "trust.sender_not_registered",
  "trust.bank_mismatch",
  "trust.verified_sender",
] as const;

export type ComparisonCheckName = (typeof COMPARISON_CHECKS)[number];

const TEXTUAL_OR_HEADER_ROUTES: ReadonlySet<ClaimRoute> = new Set([
  "display-name",
  "from-domain",
  "from-lookalike",
  "reply-to-domain",
  "reply-to-lookalike",
  "signature",
  "voice",
]);

export type ExtractedBankAccount = {
  number: string | null | undefined;
  branchCode: string | null | undefined;
  bankName?: string | null;
  holder?: string | null;
  supplierName?: string | null;
  supplierDomain?: string | null;
  role?: "payee" | "beneficiary" | "payer" | null;
  artefactKey?: string | null;
};

export type ComparisonClaimInput = {
  orgId: string;
  name: string;
  routes: readonly (ClaimRoute | string)[];
  support?: readonly string[];
  logos?: readonly ClaimLogoSummary[];
  cropKeys?: readonly string[];
};

export type BankMatchEntry = {
  matched: boolean;
  bankName: string | null;
  artefactKey: string | null;
};

export type RegistryComparisonBusiness = {
  orgId: string;
  name: string;
  knownNames?: string[];
  routes: ClaimRoute[];
  support: string[];
  logos: ClaimLogoSummary[];
  cropKeys: string[];
  senderChecked: boolean;
  senderDomainRegistered: boolean;
  senderAddressRegistered: boolean;
  dmarcAlignedPass: boolean;
  // Set per business when the message's From domain/address belongs to a separate verified business that
  // the From display name identifies, so a partner logo inside a genuine third-party message is not misread
  // as sender impersonation of the logo's owner.
  senderIsOtherVerifiedBusiness?: boolean;
  senderUnavailable: string[];
  bankChecked: boolean;
  bankMatches: BankMatchEntry[];
  bankUnavailable: string[];
};

export type RegistryComparisonInput = {
  fromAddress: string | null;
  fromDomain: string | null;
  fromDisplayName: string | null;
  fromHeader: string | null;
  rawKey: string | null;
  headersAvailable: boolean;
  senderIsOtherVerifiedBusiness: boolean;
  businesses: RegistryComparisonBusiness[];
  unavailable: string[];
};

export type CaseViewWithRegistryComparison = CaseView & {
  registryComparison?: RegistryComparisonInput;
};

export function withRegistryComparison(
  view: CaseView,
  registryComparison: RegistryComparisonInput,
): CaseViewWithRegistryComparison {
  return {
    ...view,
    registryComparison,
  };
}

export type RegistryComparisonDeps = {
  db: D1Database;
  keys?: BankKeys | null;
  env?: { BANK_KEY?: string; BANK_MATCH_KEY?: string };
  now?: Date;
};

function isCaseArtefactKey(key: string | null | undefined): key is string {
  if (!key || typeof key !== "string") return false;
  return (key.startsWith("raw/") || key.startsWith("art/")) && !key.startsWith("ident/");
}

function normaliseRoute(route: string): ClaimRoute | null {
  const hyphenated = route.trim().toLowerCase().replace(/_/g, "-");
  return (ROUTE_ORDER as readonly string[]).includes(hyphenated) ? (hyphenated as ClaimRoute) : null;
}

function normaliseRoutes(routes: readonly string[]): ClaimRoute[] {
  const out: ClaimRoute[] = [];
  for (const r of routes) {
    const norm = normaliseRoute(r);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out.sort((a, b) => ROUTE_ORDER.indexOf(a) - ROUTE_ORDER.indexOf(b));
}

export function refusalReasonOf(error: unknown): string {
  if (error instanceof AccountRefused) {
    return "the extracted bank details were incomplete or not a valid account and branch code";
  }
  if (error instanceof NoBaseline) {
    return "the business has not registered an account";
  }
  if (error instanceof KeyMismatch) {
    return "account checks are paused while keys are replaced";
  }
  if (error instanceof IdentityRefused) {
    return "the business's protection is not active";
  }
  if (error instanceof MatchLimited) {
    return "too many checks this hour";
  }
  if (error instanceof BankKeysMissing) {
    return "account comparison keys are not configured";
  }
  return "the registered-account comparison could not be read right now";
}

function pushUnique(list: string[], reason: string): void {
  const cleaned = plain(reason, 180);
  if (cleaned && !list.includes(cleaned)) list.push(cleaned);
}

// Evaluates whether trusted Authentication-Results show DMARC passing and aligned with the visible From domain.
export function hasAlignedDmarcPass(view: Readonly<CaseView>, observedFromDomain: string | null): boolean {
  if (!view.tenant.headersAvailable || !observedFromDomain) return false;
  const site = registrable(observedFromDomain);
  if (!site) return false;
  const selection = trustedAuthResults(
    view.headers,
    view.tenant.receivers,
    view.tenant.headersAvailable,
    view.tenant.chains,
  );
  if (!("trusted" in selection)) return false;
  const results = selection.trusted.results;
  const dmarcPassed = results.some((r) => r.method === "dmarc" && stateOf("dmarc", r) === "passed");
  if (!dmarcPassed) return false;

  const spfAlignedPass = results.some((r) => {
    if (r.method !== "spf" || stateOf("spf", r) !== "passed") return false;
    const id = spfIdentifier(r);
    return Boolean(id?.alignable && aligned(id.domain, site));
  });
  const dkimAlignedPass = results.some((r) => {
    if (r.method !== "dkim" || stateOf("dkim", r) !== "passed") return false;
    return aligned(dkimIdentifier(r), site);
  });
  if (spfAlignedPass || dkimAlignedPass) return true;
  const hasSpfOrDkim = results.some((r) => r.method === "spf" || r.method === "dkim");
  if (hasSpfOrDkim) return false;
  return results.some((r) => {
    if (r.method !== "dmarc" || stateOf("dmarc", r) !== "passed") return false;
    const headerFrom = r.props.get("header.from");
    return headerFrom ? aligned(headerFrom, site) : true;
  });
}

function parseClaimsFromItemsOrHits(
  view: Readonly<CaseView>,
  claimsSource?: readonly (EvidenceDraft | ComparisonClaimInput)[],
): { claims: ComparisonClaimInput[]; unavailable: string[] } {
  const unavailable: string[] = [];
  if (!claimsSource) {
    const input: ClaimInput = claimInputFromView(view);
    const hits = detectClaims(input);
    const draftItems = hits.map((h) => ({
      orgId: h.orgId,
      name: h.name,
      routes: h.routes,
      support: h.support,
      logos: h.logos,
      cropKeys: h.cropKeys,
    }));
    for (const u of input.unavailable) pushUnique(unavailable, u);
    return { claims: draftItems, unavailable };
  }

  const byOrg = new Map<string, ComparisonClaimInput>();
  for (const entry of claimsSource) {
    if ("check" in entry) {
      if (entry.check !== "trust.claim") continue;
      try {
        const parsed = readTrustClaimDetail(entry.detail);
        if (parsed.kind === "unavailable") {
          for (const u of parsed.detail.unavailable) pushUnique(unavailable, u);
          continue;
        }
        const d = parsed.detail;
        const cropKeys = entry.artefacts.filter((a) => a.startsWith("art/"));
        byOrg.set(d.orgId, {
          orgId: d.orgId,
          name: d.name,
          routes: d.routes,
          support: d.support,
          logos: d.logos ?? [],
          cropKeys,
        });
      } catch {
        pushUnique(unavailable, "a stored trust.claim item was malformed and could not be read");
      }
      continue;
    }
    byOrg.set(entry.orgId, entry);
  }
  return { claims: [...byOrg.values()], unavailable };
}

function parseSenderFromView(view: Readonly<CaseView>): {
  fromAddress: string | null;
  fromDomain: string | null;
  fromDisplayName: string | null;
  fromHeader: string | null;
  senderUnavailable: string | null;
} {
  if (!view.tenant.headersAvailable) {
    return {
      fromAddress: null,
      fromDomain: null,
      fromDisplayName: null,
      fromHeader: null,
      senderUnavailable: "the original message's headers were not available",
    };
  }
  const fromHeaders = view.headers.filter((h) => h.name.trim().toLowerCase() === "from");
  if (fromHeaders.length === 0) {
    return {
      fromAddress: null,
      fromDomain: null,
      fromDisplayName: null,
      fromHeader: null,
      senderUnavailable: "the original message had no From header",
    };
  }
  if (fromHeaders.length > 1) {
    return {
      fromAddress: null,
      fromDomain: null,
      fromDisplayName: null,
      fromHeader: null,
      senderUnavailable: "multiple From headers were present and could not be trusted",
    };
  }
  const headerLine = oneLine(`${fromHeaders[0]?.name ?? "From"}: ${fromHeaders[0]?.value ?? ""}`);
  const orig = originalHeaderOf(view.headers);
  const domain = fromDomain(view.headers);
  const parsed = addressParser((fromHeaders[0]?.value ?? "").replace(/\r?\n[ \t]*/g, " "), { flatten: true }).filter(
    (a) => a.address,
  );
  const singleAddress = parsed.length === 1 && parsed[0]?.address ? mailbox(parsed[0].address.trim()) : null;
  const address = orig.fromAddress ?? singleAddress;
  const effectiveDomain = domain ?? (address ? asciiDomain(address.slice(address.lastIndexOf("@") + 1)) : null);
  const displayName = orig.fromName ?? (parsed.length === 1 && parsed[0]?.name ? parsed[0].name.trim() || null : null);

  if (!address || !effectiveDomain) {
    return {
      fromAddress: null,
      fromDomain: null,
      fromDisplayName: displayName,
      fromHeader: headerLine,
      senderUnavailable: "the original message's From address could not be read",
    };
  }
  return {
    fromAddress: address,
    fromDomain: effectiveDomain,
    fromDisplayName: displayName,
    fromHeader: headerLine,
    senderUnavailable: null,
  };
}

function nameMatchesList(candidateName: string | null | undefined, names: readonly string[]): boolean {
  const target = candidateName ? normaliseName(candidateName) : "";
  if (target.length < 3) return false;
  return names.some((n) => {
    const norm = normaliseName(n);
    return norm.length >= 3 && (norm === target || norm.includes(target) || target.includes(norm));
  });
}

// Evaluates how an extracted bank account's supplierName and supplierDomain relate to a claimed business:
// - "match": at least one field (name or domain) matches the business, and the other field (if present) does not conflict.
// - "conflict": a provided supplierName or supplierDomain does not match this business.
// - "unattributed": neither supplierName nor supplierDomain was provided on the account.
function evaluateAccountAttribution(
  account: ExtractedBankAccount,
  business: { orgId: string; name: string; knownNames: string[]; knownDomains: string[] },
): "match" | "conflict" | "unattributed" {
  const hasDomainField = Boolean(account.supplierDomain && account.supplierDomain.trim().length > 0);
  const supDomain = hasDomainField
    ? (registrable(account.supplierDomain ?? "") ?? asciiDomain(account.supplierDomain ?? ""))
    : null;
  const hasNameField = Boolean(account.supplierName && normaliseName(account.supplierName).length >= 3);

  if (!hasDomainField && !hasNameField) {
    return "unattributed";
  }

  let domainResult: "match" | "conflict" | "none" = "none";
  if (hasDomainField) {
    if (!supDomain || business.knownDomains.length === 0) {
      domainResult = "conflict";
    } else {
      const matched = business.knownDomains.some((d) => {
        const reg = registrable(d) ?? asciiDomain(d);
        return reg !== null && reg === supDomain;
      });
      domainResult = matched ? "match" : "conflict";
    }
  }

  let nameResult: "match" | "conflict" | "none" = "none";
  if (hasNameField) {
    const allNames = [business.name, ...business.knownNames];
    nameResult = nameMatchesList(account.supplierName, allNames) ? "match" : "conflict";
  }

  if (domainResult === "conflict" || nameResult === "conflict") {
    return "conflict";
  }
  return domainResult === "match" || nameResult === "match" ? "match" : "unattributed";
}

// Runs the store-backed registry comparisons for a case's claimed businesses and extracted bank accounts,
// returning a pure `RegistryComparisonInput` (with zero registered secrets, domains, addresses, or account digits)
// that `comparisonEvidence` and the registered checks consume.
export async function prepareRegistryComparison(
  deps: RegistryComparisonDeps,
  caseId: string,
  view: Readonly<CaseView>,
  claimsSource?: readonly (EvidenceDraft | ComparisonClaimInput)[],
  accounts: readonly ExtractedBankAccount[] = [],
): Promise<RegistryComparisonInput> {
  const { claims, unavailable } = parseClaimsFromItemsOrHits(view, claimsSource);
  const sender = parseSenderFromView(view);
  const rawKey = isCaseArtefactKey(view.raw) ? view.raw : null;

  // Identify every active protected business that owns the message's From domain and matches the From display name.
  const verifiedSenderOrgIds = new Set<string>();
  if (sender.fromDomain && sender.fromDisplayName) {
    const fromSite = registrable(sender.fromDomain) ?? sender.fromDomain;
    try {
      const rows = await deps.db
        .prepare(
          `SELECT DISTINCT org_id FROM org_domains WHERE state = 'verified' AND ${claimable()} AND (domain = ? OR domain = ?)`,
        )
        .bind(sender.fromDomain, fromSite)
        .all<{ org_id: string }>();
      for (const row of rows.results) {
        const otherIdentity = await getIdentity(deps.db, row.org_id);
        if (!otherIdentity?.effective.on) continue;
        if (nameMatchesList(sender.fromDisplayName, otherIdentity.displayNames)) {
          verifiedSenderOrgIds.add(row.org_id);
        }
      }
    } catch {
      // Non-fatal: do not suppress sender checks if lookup fails.
    }
  }

  let resolvedKeys: BankKeys | null = deps.keys ?? null;
  let keysError: unknown = null;
  const beneficiaryAccounts = accounts.filter((a) => a.role !== "payer");
  if (!resolvedKeys && beneficiaryAccounts.length > 0 && claims.length > 0) {
    if (deps.env) {
      try {
        resolvedKeys = await bankKeys(deps.env);
      } catch (error) {
        keysError = error;
      }
    } else {
      keysError = new BankKeysMissing("BANK_KEY is not set");
    }
  }

  const candidateLookup = new Map<string, { names: string[]; domains: string[] }>();
  for (const c of view.protectedCandidates?.candidates ?? []) {
    candidateLookup.set(c.orgId, { names: c.names, domains: c.domains });
  }

  const businessRecords: {
    claim: ComparisonClaimInput;
    routes: ClaimRoute[];
    knownNames: string[];
    knownDomains: string[];
    business: RegistryComparisonBusiness;
  }[] = [];

  for (const claim of claims) {
    const routes = normaliseRoutes(claim.routes);
    const cand = candidateLookup.get(claim.orgId);
    const knownNames = [...(cand?.names ?? [claim.name])];
    const knownDomains = [...(cand?.domains ?? [])];
    const senderUnavailable: string[] = [];
    let senderChecked = false;
    let senderDomainRegistered = false;
    let senderAddressRegistered = false;
    let dmarcAlignedPass = false;

    try {
      const identity = await getIdentity(deps.db, claim.orgId);
      if (!identity?.effective.on) {
        pushUnique(senderUnavailable, "the business's protection is not active");
      } else {
        for (const n of identity.displayNames) {
          if (!knownNames.includes(n)) knownNames.push(n);
        }
        // Populate verified domains from the registry if not already in knownDomains so domain attribution is exact.
        if (knownDomains.length === 0) {
          const domRows = await deps.db
            .prepare(
              `SELECT domain FROM org_domains WHERE org_id = ? AND state = 'verified' AND ${claimable()} ORDER BY domain`,
            )
            .bind(claim.orgId)
            .all<{ domain: string }>();
          for (const r of domRows.results) {
            if (!knownDomains.includes(r.domain)) knownDomains.push(r.domain);
          }
        }
        if (sender.senderUnavailable) {
          pushUnique(senderUnavailable, sender.senderUnavailable);
        } else if (sender.fromDomain && sender.fromAddress) {
          const fromSite = registrable(sender.fromDomain) ?? sender.fromDomain;
          const [domainRow, addressRow] = await Promise.all([
            deps.db
              .prepare(
                `SELECT 1 AS ok FROM org_domains WHERE org_id = ? AND state = 'verified' AND ${claimable()} AND (domain = ? OR domain = ?) LIMIT 1`,
              )
              .bind(claim.orgId, sender.fromDomain, fromSite)
              .first<{ ok: number }>(),
            deps.db
              .prepare(
                "SELECT 1 AS ok FROM org_addresses WHERE org_id = ? AND state = 'verified' AND address = ? LIMIT 1",
              )
              .bind(claim.orgId, sender.fromAddress)
              .first<{ ok: number }>(),
          ]);
          senderChecked = true;
          senderDomainRegistered = domainRow !== null;
          senderAddressRegistered = addressRow !== null;
          if (senderDomainRegistered) {
            dmarcAlignedPass = hasAlignedDmarcPass(view, sender.fromDomain);
          }
        }
      }
    } catch {
      pushUnique(senderUnavailable, "the sender's registration could not be read right now");
    }

    // Relative to `claim.orgId`, is the message's From sender a separate verified protected business?
    const senderIsOtherForThisBusiness = [...verifiedSenderOrgIds].some((id) => id !== claim.orgId);

    businessRecords.push({
      claim,
      routes,
      knownNames,
      knownDomains,
      business: {
        orgId: claim.orgId,
        name: plain(claim.name, 80) || "protected business",
        knownNames,
        routes,
        support: (claim.support ?? []).map((s) => plain(s, 200)),
        logos: [...(claim.logos ?? [])],
        cropKeys: (claim.cropKeys ?? []).filter(isCaseArtefactKey),
        senderChecked,
        senderDomainRegistered,
        senderAddressRegistered,
        dmarcAlignedPass,
        senderIsOtherVerifiedBusiness: senderIsOtherForThisBusiness,
        senderUnavailable,
        bankChecked: false,
        bankMatches: [],
        bankUnavailable: [],
      },
    });
  }

  // Attribute beneficiary bank accounts to claimed businesses and run matchBankAccount.
  if (beneficiaryAccounts.length > 0 && businessRecords.length > 0) {
    const caller: MatchCaller = view.tenant.orgId
      ? { orgId: view.tenant.orgId }
      : { sender: sender.fromAddress ?? `case@${caseId}.local` };

    for (const account of beneficiaryAccounts) {
      const evaluations = businessRecords.map((b) => ({
        record: b,
        status: evaluateAccountAttribution(account, {
          orgId: b.claim.orgId,
          name: b.business.name,
          knownNames: b.knownNames,
          knownDomains: b.knownDomains,
        }),
      }));

      const matchedRecords = evaluations.filter((e) => e.status === "match").map((e) => e.record);
      let target: (typeof businessRecords)[number] | null = null;

      if (matchedRecords.length === 1 && matchedRecords[0]) {
        target = matchedRecords[0];
      } else if (matchedRecords.length > 1) {
        const reason = "the extracted bank account could not be tied to one claimed business";
        for (const r of matchedRecords) pushUnique(r.business.bankUnavailable, reason);
        continue;
      } else if (businessRecords.length === 1 && evaluations[0]?.status === "unattributed") {
        // Sole claimed business and no conflicting supplierName/supplierDomain on the account.
        target = businessRecords[0] ?? null;
      } else {
        const reason = "the extracted bank account could not be tied to one claimed business";
        for (const b of businessRecords) pushUnique(b.business.bankUnavailable, reason);
        continue;
      }

      if (!target) continue;

      if (keysError) {
        pushUnique(target.business.bankUnavailable, refusalReasonOf(keysError));
        continue;
      }
      if (!resolvedKeys) {
        pushUnique(target.business.bankUnavailable, refusalReasonOf(new BankKeysMissing("BANK_KEY is not set")));
        continue;
      }

      try {
        const canonical = canonicalAccount({
          number: account.number ?? "",
          branchCode: account.branchCode ?? "",
        });
        const res = await matchBankAccount(
          deps.db,
          resolvedKeys,
          caller,
          target.claim.orgId,
          canonical,
          deps.now ?? new Date(),
        );
        target.business.bankChecked = true;
        target.business.bankMatches.push({
          matched: res.match,
          bankName: account.bankName ? plain(account.bankName, 80) : null,
          artefactKey: isCaseArtefactKey(account.artefactKey) ? account.artefactKey : null,
        });
      } catch (error) {
        pushUnique(target.business.bankUnavailable, refusalReasonOf(error));
      }
    }
  }

  const anyOtherVerified = businessRecords.some((r) => r.business.senderIsOtherVerifiedBusiness === true);

  return {
    fromAddress: sender.fromAddress,
    fromDomain: sender.fromDomain,
    fromDisplayName: sender.fromDisplayName,
    fromHeader: sender.fromHeader,
    rawKey,
    headersAvailable: view.tenant.headersAvailable,
    senderIsOtherVerifiedBusiness: anyOtherVerified,
    businesses: businessRecords.map((r) => r.business),
    unavailable,
  };
}

function isOtherVerifiedSenderFor(business: RegistryComparisonBusiness, input: RegistryComparisonInput): boolean {
  return business.senderIsOtherVerifiedBusiness ?? input.senderIsOtherVerifiedBusiness;
}

function hasStrongSenderClaim(business: RegistryComparisonBusiness, input: RegistryComparisonInput): boolean {
  if (business.routes.some((r) => TEXTUAL_OR_HEADER_ROUTES.has(r))) {
    return true;
  }
  const hasPositiveLogo =
    business.routes.includes("logo") && (business.logos.length === 0 || business.logos.some((l) => l.same === true));
  if (hasPositiveLogo && !isOtherVerifiedSenderFor(business, input)) {
    return true;
  }
  return false;
}

function hasTextualOrVoiceClaim(business: RegistryComparisonBusiness): boolean {
  return business.routes.some((r) => TEXTUAL_OR_HEADER_ROUTES.has(r));
}

// A negative logo judgement (`same === false`) counts as a logo mismatch for `business` only when:
// 1. No crop in the message matched `business`'s registered logo (`!business.logos.some(l => l.same === true)`), and
// 2. The mismatching crop purports to be `business` (`l.brandSeen` matches `business.name` or `business.knownNames`),
//    so an unrelated second graphic or partner badge never triggers false logo impersonation or suppresses
//    `trust.verified_sender`.
function hasIdentityLogoMismatch(business: RegistryComparisonBusiness): boolean {
  if (business.logos.some((l) => l.same === true)) {
    return false;
  }
  const allNames = [business.name, ...(business.knownNames ?? [])];
  return business.logos.some((l) => l.same === false && nameMatchesList(l.brandSeen, allNames));
}

function businessArtefacts(business: RegistryComparisonBusiness, rawKey: string | null): string[] {
  const out: string[] = [];
  if (rawKey && isCaseArtefactKey(rawKey)) out.push(rawKey);
  for (const k of business.cropKeys) {
    if (isCaseArtefactKey(k) && !out.includes(k)) out.push(k);
  }
  for (const l of business.logos) {
    if (isCaseArtefactKey(l.cropKey) && !out.includes(l.cropKey)) out.push(l.cropKey);
  }
  return out;
}

export function senderNotRegisteredEvidence(input: RegistryComparisonInput): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const business of input.businesses) {
    if (!hasStrongSenderClaim(business, input)) continue;
    if (!business.senderChecked) continue;
    if (business.senderDomainRegistered || business.senderAddressRegistered) continue;
    const observed = input.fromDomain ?? input.fromAddress ?? "this sender";
    items.push({
      check: "trust.sender_not_registered",
      severity: "critical",
      summary: bounded(
        `${plain(business.name, 60)} never sends from ${plain(observed, 60)} according to its IsItLegit registration.`,
      ),
      detail: fittedDetail({
        checked: true,
        orgId: business.orgId,
        business: business.name,
        routes: business.routes,
        senderRegistered: false,
        ...(input.fromDomain ? { fromDomain: input.fromDomain } : {}),
        ...(input.fromAddress ? { from: input.fromAddress } : {}),
        ...(input.fromHeader ? { headers: [input.fromHeader] } : {}),
      }) as EvidenceDraft["detail"],
      artefacts: businessArtefacts(business, input.rawKey),
    });
  }
  return items;
}

export function bankMismatchEvidence(input: RegistryComparisonInput): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const business of input.businesses) {
    for (const match of business.bankMatches) {
      if (match.matched) continue;
      const artefacts: string[] = [];
      if (match.artefactKey && isCaseArtefactKey(match.artefactKey)) {
        artefacts.push(match.artefactKey);
      } else if (input.rawKey && isCaseArtefactKey(input.rawKey)) {
        artefacts.push(input.rawKey);
      }
      items.push({
        check: "trust.bank_mismatch",
        severity: "critical",
        summary: bounded(`These bank details are not the ones ${plain(business.name, 60)} registered with IsItLegit.`),
        detail: fittedDetail({
          checked: true,
          orgId: business.orgId,
          business: business.name,
          matched: false,
          baseline: "isitlegit-registry",
          ...(match.bankName ? { bankName: plain(match.bankName, 80) } : {}),
          ...(match.artefactKey && isCaseArtefactKey(match.artefactKey) ? { attachment: match.artefactKey } : {}),
        }) as EvidenceDraft["detail"],
        artefacts,
      });
    }
  }
  return items;
}

export function impersonationEvidence(input: RegistryComparisonInput): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const business of input.businesses) {
    const strongClaim = hasStrongSenderClaim(business, input);
    const senderUnregistered =
      strongClaim && business.senderChecked && !business.senderDomainRegistered && !business.senderAddressRegistered;
    const bankMismatch = business.bankMatches.some((m) => !m.matched);
    const logoMismatch = hasTextualOrVoiceClaim(business) && hasIdentityLogoMismatch(business);

    if (!senderUnregistered && !bankMismatch && !logoMismatch) continue;

    const signals: string[] = [];
    const reasons: string[] = [];
    if (senderUnregistered) {
      signals.push("sender-not-registered");
      const observed = input.fromDomain ?? input.fromAddress ?? "an unregistered sender";
      reasons.push(`sends from ${plain(observed, 50)} rather than a registered sender`);
    }
    if (bankMismatch) {
      signals.push("bank-mismatch");
      reasons.push("gives bank details not registered with IsItLegit");
    }
    if (logoMismatch) {
      signals.push("logo-mismatch");
      reasons.push("uses a logo that differs from the registered logo");
    }

    const artefacts = businessArtefacts(business, input.rawKey);
    for (const m of business.bankMatches) {
      if (!m.matched && m.artefactKey && isCaseArtefactKey(m.artefactKey) && !artefacts.includes(m.artefactKey)) {
        artefacts.push(m.artefactKey);
      }
    }

    items.push({
      check: "trust.impersonation",
      severity: "critical",
      summary: bounded(
        `Impersonates ${plain(business.name, 55)}: claims ${plain(business.name, 45)} yet ${reasons.join(" and ")}.`,
      ),
      detail: fittedDetail({
        checked: true,
        orgId: business.orgId,
        business: business.name,
        routes: business.routes,
        signals,
        baseline: "isitlegit-registry",
        ...(input.fromDomain ? { fromDomain: input.fromDomain } : {}),
        ...(input.fromAddress ? { from: input.fromAddress } : {}),
      }) as EvidenceDraft["detail"],
      artefacts,
    });
  }
  return items;
}

export function verifiedSenderEvidence(input: RegistryComparisonInput): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const business of input.businesses) {
    if (!business.senderChecked || !business.senderDomainRegistered || !business.dmarcAlignedPass) continue;
    const hasBankMismatch = business.bankMatches.some((m) => !m.matched);
    const hasLogoMismatch = hasIdentityLogoMismatch(business);
    if (hasBankMismatch || hasLogoMismatch) continue;

    const hasBankMatch = business.bankMatches.some((m) => m.matched);
    const observed = input.fromDomain ?? input.fromAddress ?? "a registered domain";
    const bankClause = hasBankMatch
      ? `, and the payment details match what ${plain(business.name, 45)} registered with IsItLegit`
      : "";

    items.push({
      check: "trust.verified_sender",
      severity: "info",
      summary: bounded(
        `Sent from ${plain(observed, 50)}, a domain ${plain(business.name, 45)} registered with IsItLegit, with DMARC aligned${bankClause}.`,
      ),
      detail: fittedDetail({
        checked: true,
        orgId: business.orgId,
        business: business.name,
        senderDomainRegistered: true,
        dmarcAligned: true,
        baseline: "isitlegit-registry",
        ...(hasBankMatch ? { bankMatched: true } : {}),
        ...(input.fromDomain ? { fromDomain: input.fromDomain } : {}),
        ...(input.fromAddress ? { from: input.fromAddress } : {}),
      }) as EvidenceDraft["detail"],
      artefacts: businessArtefacts(business, input.rawKey),
    });
  }
  return items;
}

// Returns all comparison evidence items in registration order (`trust.impersonation`,
// `trust.sender_not_registered`, `trust.bank_mismatch`, `trust.verified_sender`).
export function comparisonEvidence(input: RegistryComparisonInput): EvidenceDraft[] {
  return [
    ...impersonationEvidence(input),
    ...senderNotRegisteredEvidence(input),
    ...bankMismatchEvidence(input),
    ...verifiedSenderEvidence(input),
  ];
}

function comparisonFromView(view: Readonly<CaseView>): RegistryComparisonInput | null {
  return (view as Readonly<CaseViewWithRegistryComparison>).registryComparison ?? null;
}

function senderSkipReason(view: Readonly<CaseView>): string | null {
  const cmp = comparisonFromView(view);
  if (!cmp) return "the registry comparison was not prepared for this case";
  if (cmp.businesses.length === 0) {
    return cmp.unavailable[0] ?? "no protected business was claimed";
  }
  const strong = cmp.businesses.filter((b) => hasStrongSenderClaim(b, cmp));
  if (strong.length === 0) {
    return "no sender-asserting protected identity claim was made";
  }
  if (strong.every((b) => !b.senderChecked)) {
    const reasons = strong.flatMap((b) => b.senderUnavailable);
    return reasons[0] ?? cmp.unavailable[0] ?? "the original message's sender could not be checked";
  }
  return null;
}

function senderPartialReason(view: Readonly<CaseView>): string | null {
  if (senderSkipReason(view) !== null) return null;
  const cmp = comparisonFromView(view);
  if (!cmp) return null;
  const reasons = [
    ...cmp.unavailable,
    ...cmp.businesses.filter((b) => hasStrongSenderClaim(b, cmp)).flatMap((b) => b.senderUnavailable),
  ];
  return reasons[0] ?? null;
}

function bankSkipReason(view: Readonly<CaseView>): string | null {
  const cmp = comparisonFromView(view);
  if (!cmp) return "the registry comparison was not prepared for this case";
  if (cmp.businesses.length === 0) {
    return cmp.unavailable[0] ?? "no protected business was claimed";
  }
  const anyChecked = cmp.businesses.some((b) => b.bankChecked);
  const reasons = cmp.businesses.flatMap((b) => b.bankUnavailable);
  if (!anyChecked) {
    return reasons[0] ?? "no beneficiary bank details were extracted";
  }
  return null;
}

function bankPartialReason(view: Readonly<CaseView>): string | null {
  if (bankSkipReason(view) !== null) return null;
  const cmp = comparisonFromView(view);
  if (!cmp) return null;
  const reasons = cmp.businesses.flatMap((b) => b.bankUnavailable);
  return reasons[0] ?? null;
}

function impersonationSkipReason(view: Readonly<CaseView>): string | null {
  const cmp = comparisonFromView(view);
  if (!cmp) return "the registry comparison was not prepared for this case";
  if (cmp.businesses.length === 0) {
    return cmp.unavailable[0] ?? "no protected business was claimed";
  }
  const anyEvaluated = cmp.businesses.some(
    (b) =>
      (hasStrongSenderClaim(b, cmp) && b.senderChecked) ||
      b.bankChecked ||
      (hasTextualOrVoiceClaim(b) && b.logos.length > 0),
  );
  if (!anyEvaluated) {
    const reasons = [
      ...cmp.unavailable,
      ...cmp.businesses.flatMap((b) => [...b.senderUnavailable, ...b.bankUnavailable]),
    ];
    return reasons[0] ?? "no registry comparison surface could be evaluated";
  }
  return null;
}

function impersonationPartialReason(view: Readonly<CaseView>): string | null {
  if (impersonationSkipReason(view) !== null) return null;
  const cmp = comparisonFromView(view);
  if (!cmp) return null;
  const reasons = [
    ...cmp.unavailable,
    ...cmp.businesses.flatMap((b) => [...b.senderUnavailable, ...b.bankUnavailable]),
  ];
  return reasons[0] ?? null;
}

function verifiedSenderSkipReason(view: Readonly<CaseView>): string | null {
  const cmp = comparisonFromView(view);
  if (!cmp) return "the registry comparison was not prepared for this case";
  if (cmp.businesses.length === 0) {
    return cmp.unavailable[0] ?? "no protected business was claimed";
  }
  if (cmp.businesses.every((b) => !b.senderChecked)) {
    const reasons = cmp.businesses.flatMap((b) => b.senderUnavailable);
    return reasons[0] ?? cmp.unavailable[0] ?? "the original message's sender could not be checked";
  }
  return null;
}

function verifiedSenderPartialReason(view: Readonly<CaseView>): string | null {
  if (verifiedSenderSkipReason(view) !== null) return null;
  const cmp = comparisonFromView(view);
  if (!cmp) return null;
  const reasons = [
    ...cmp.unavailable,
    ...cmp.businesses.flatMap((b) => [...b.senderUnavailable, ...b.bankUnavailable]),
  ];
  return reasons[0] ?? null;
}

function examinedForComparison(view: Readonly<CaseView>): string[] {
  const cmp = comparisonFromView(view);
  if (!cmp) return [];
  const targets: string[] = [];
  const add = (v: string | null | undefined) => {
    if (!v) return;
    const cleaned = plain(v, 120);
    if (cleaned && !targets.includes(cleaned)) targets.push(cleaned);
  };
  add(cmp.fromAddress);
  add(cmp.fromDomain);
  for (const b of cmp.businesses) {
    add(b.name);
  }
  return targets;
}

export function registerComparisonChecks(registry: CheckRegistry): void {
  registry.register({
    name: "trust.impersonation",
    needs: [],
    timeoutMs: 2_000,
    applies: impersonationSkipReason,
    partial: impersonationPartialReason,
    examined: examinedForComparison,
    run: (view) => {
      if (impersonationSkipReason(view) !== null) return [];
      const cmp = comparisonFromView(view);
      return cmp ? impersonationEvidence(cmp) : [];
    },
    summary: (_view, items) =>
      items.length > 0
        ? plain(items[0]?.summary ?? "impersonation of a protected business detected", MAX_OUTCOME_SUMMARY)
        : "no impersonation of a claimed business detected",
  });

  registry.register({
    name: "trust.sender_not_registered",
    needs: [],
    timeoutMs: 2_000,
    applies: senderSkipReason,
    partial: senderPartialReason,
    examined: examinedForComparison,
    run: (view) => {
      if (senderSkipReason(view) !== null) return [];
      const cmp = comparisonFromView(view);
      return cmp ? senderNotRegisteredEvidence(cmp) : [];
    },
    summary: (_view, items) =>
      items.length > 0
        ? plain(items[0]?.summary ?? "sender is not registered to the claimed business", MAX_OUTCOME_SUMMARY)
        : "the sender is registered to the claimed business",
  });

  registry.register({
    name: "trust.bank_mismatch",
    needs: [],
    timeoutMs: 2_000,
    applies: bankSkipReason,
    partial: bankPartialReason,
    examined: examinedForComparison,
    run: (view) => {
      if (bankSkipReason(view) !== null) return [];
      const cmp = comparisonFromView(view);
      return cmp ? bankMismatchEvidence(cmp) : [];
    },
    summary: (_view, items) =>
      items.length > 0
        ? plain(items[0]?.summary ?? "bank details do not match the IsItLegit registration", MAX_OUTCOME_SUMMARY)
        : "extracted bank details match what the business registered with IsItLegit",
  });

  registry.register({
    name: "trust.verified_sender",
    needs: [],
    timeoutMs: 2_000,
    applies: verifiedSenderSkipReason,
    partial: verifiedSenderPartialReason,
    examined: examinedForComparison,
    run: (view) => {
      if (verifiedSenderSkipReason(view) !== null) return [];
      const cmp = comparisonFromView(view);
      return cmp ? verifiedSenderEvidence(cmp) : [];
    },
    summary: (_view, items) =>
      items.length > 0
        ? plain(items[0]?.summary ?? "verified registered sender with DMARC aligned", MAX_OUTCOME_SUMMARY)
        : "sender is not verified by DMARC alignment on a registered domain",
  });
}

// Evaluates the four comparison check outcomes directly from a `CaseView` enriched with `withRegistryComparison`,
// matching the runner's exact outcome semantics (`ran`, `partial`, `skipped`).
export function comparisonOutcomes(view: Readonly<CaseView>): CheckOutcome[] {
  const reg = new CheckRegistry();
  registerComparisonChecks(reg);
  const outcomes: CheckOutcome[] = [];
  for (const check of reg.all()) {
    const skip = check.applies?.(view) ?? null;
    if (skip !== null) {
      outcomes.push({
        check: check.name,
        outcome: "skipped",
        reason: skip.slice(0, 300),
        findings: 0,
      });
      continue;
    }
    const items = check.run(view, new AbortController().signal) as EvidenceDraft[];
    const partial = check.partial?.(view) ?? null;
    if (partial !== null) {
      outcomes.push({
        check: check.name,
        outcome: "partial",
        reason: partial.slice(0, 300),
        findings: items.length,
      });
      continue;
    }
    const summary = check.summary?.(view, items) ?? null;
    const examined = items.length === 0 && check.examined ? { targets: check.examined(view), omitted: 0 } : undefined;
    outcomes.push({
      check: check.name,
      outcome: "ran",
      reason: null,
      findings: items.length,
      ...(summary ? { summary: plain(summary, MAX_OUTCOME_SUMMARY) } : {}),
      ...(examined ? { examined } : {}),
    });
  }
  return outcomes;
}
