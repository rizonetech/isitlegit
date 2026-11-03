// Registry comparison evidence tests (D05 T02 §3; spec 2a and 4.5):
// - Demo Fynbos Freight impersonation fixture yields critical `trust.impersonation`,
//   `trust.sender_not_registered`, and `trust.bank_mismatch`.
// - Negative controls: genuine DMARC-aligned mail from a registered domain yields `trust.verified_sender`
//   and no impersonation/mismatch; unauthenticated spoof on a registered domain does not yield
//   `trust.verified_sender`; non-claiming third-party mail, partner-logo mail from a separate verified
//   business, and unrelated negative logo crops do not yield `trust.sender_not_registered` or
//   `trust.impersonation`.
// - Multi-business and conflicting supplier bank account attribution and ambiguity handling.
// - Every typed refusal of `matchBankAccount` and `bankKeys` (`AccountRefused`, `NoBaseline`,
//   `KeyMismatch`, `IdentityRefused`, `MatchLimited`, `BankKeysMissing`) yields zero `trust.bank_mismatch`
//   items, preserves independent sender findings, and records the plain unavailable reason.
// - Registry-baseline wording: names IsItLegit as the baseline and never claims live bank/holder confirmation.
// - Leak detector: proves no evidence item or check outcome ever contains any registered domain list,
//   registered address list, account number fragment, or finance contact, and fails on a planted leak.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_BRANDS } from "../../src/checks/brands";
import { boundProtectedCandidates, type CaseView, caseViewOf } from "../../src/checks/case-view";
import { type EvidenceDraft, readCheckOutcomes, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { type CheckOutcome, runChecksWithOutcomes } from "../../src/checks/runner";
import { ulid } from "../../src/db/ulid";
import { addAccount, bankKeys, MATCHES_PER_HOUR } from "../../src/trust/bank";
import { claimEvidence, claimInputFromView, registerClaimCheck, withClaimLogos } from "../../src/trust/claim";
import {
  comparisonEvidence,
  comparisonOutcomes,
  type ExtractedBankAccount,
  prepareRegistryComparison,
  registerComparisonChecks,
  withRegistryComparison,
} from "../../src/trust/compare";
import { protectedIdentities, setIdentity } from "../../src/trust/identity";
import { addAddress, addDomain, makeOrg } from "./helpers";

const db = env.DB;

const FYNBOS_REGISTERED_ACCOUNT = "62004411223";
const FYNBOS_REGISTERED_BRANCH = "250655";
const FYNBOS_FINANCE_CONTACT = "finance-secret@fynbosfreight.co.za";
const FYNBOS_EXTRA_ADDRESS = "accounts-private@fynbosfreight.co.za";
const FYNBOS_EXTRA_DOMAIN = "fynbosfreight.demo.isitlegit.co.za";

type ForbiddenSecrets = {
  registeredDomainsNotInMail: string[];
  registeredAddressesNotInMail: string[];
  financeContacts: string[];
  accountFragments: string[];
};

function assertNoRegistryLeak(
  items: readonly { summary: string; detail: Record<string, unknown>; artefacts: readonly string[] }[],
  outcomes: readonly CheckOutcome[],
  secrets: ForbiddenSecrets,
): void {
  const haystacks: string[] = [];
  for (const item of items) {
    haystacks.push(item.summary);
    haystacks.push(JSON.stringify(item.detail));
    haystacks.push(JSON.stringify(item.artefacts));
  }
  for (const outcome of outcomes) {
    if (outcome.summary) haystacks.push(outcome.summary);
    if (outcome.reason) haystacks.push(outcome.reason);
    if (outcome.examined) haystacks.push(JSON.stringify(outcome.examined));
  }
  const combined = haystacks.join("\n").toLowerCase();

  for (const addr of secrets.registeredAddressesNotInMail) {
    if (combined.includes(addr.toLowerCase())) {
      throw new Error(`Registry leak detected: registered address "${addr}" appeared in evidence or outcome`);
    }
  }
  for (const contact of secrets.financeContacts) {
    if (combined.includes(contact.toLowerCase())) {
      throw new Error(`Registry leak detected: finance contact "${contact}" appeared in evidence or outcome`);
    }
  }
  for (const domain of secrets.registeredDomainsNotInMail) {
    if (combined.includes(domain.toLowerCase())) {
      throw new Error(`Registry leak detected: registered domain "${domain}" appeared in evidence or outcome`);
    }
  }
  for (const fragment of secrets.accountFragments) {
    const escaped = fragment.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:\\*\\*\\*|(?<![0-9a-z]))${escaped}(?![0-9a-z])`, "i");
    if (pattern.test(combined)) {
      throw new Error(`Registry leak detected: account fragment "${fragment}" appeared in evidence or outcome`);
    }
  }
}

function buildView(opts: {
  caseId: string;
  orgId: string;
  headers: { name: string; value: string }[];
  text?: string | null;
  headersAvailable?: boolean;
  protectedCandidates?: CaseView["protectedCandidates"];
}): CaseView {
  const base = caseViewOf(
    {
      headers: opts.headers,
      text: opts.text ?? "Please see attached tax invoice for urgent settlement.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: {
        path: "rfc822",
        headersAvailable: opts.headersAvailable ?? true,
        otherOriginals: 0,
      },
    },
    {
      orgId: opts.orgId,
      channel: "email",
      receivers: [{ kind: "google", pattern: "*.google.com" }],
      trusted: { own: [], suppliers: [] },
    },
    `raw/${opts.caseId}/message.eml`,
    BUNDLED_BRANDS,
  );
  return {
    ...base,
    ...(opts.protectedCandidates ? { protectedCandidates: opts.protectedCandidates } : {}),
  };
}

async function seedFynbosAndChecker() {
  const keys = await bankKeys(env);
  const checkerOrgId = await makeOrg("Checker Books (Pty) Ltd");
  const fynbosOrgId = await makeOrg("Fynbos Freight (Pty) Ltd");

  await addDomain(fynbosOrgId, "fynbosfreight.co.za", "verified");
  await addDomain(fynbosOrgId, FYNBOS_EXTRA_DOMAIN, "verified");
  await addAddress(fynbosOrgId, FYNBOS_FINANCE_CONTACT, "verified");
  await addAddress(fynbosOrgId, FYNBOS_EXTRA_ADDRESS, "verified");

  await setIdentity(db, fynbosOrgId, "owner-1", {
    displayNames: ["Fynbos Freight", "Fynbos Freight (Pty) Ltd"],
    financeContact: FYNBOS_FINANCE_CONTACT,
    protected: true,
  });

  await addAccount(db, keys, fynbosOrgId, "owner-1", {
    number: FYNBOS_REGISTERED_ACCOUNT,
    branchCode: FYNBOS_REGISTERED_BRANCH,
    bankName: "Protea Bank (fictional)",
    holder: "Fynbos Freight (Pty) Ltd",
  });

  const candidates = boundProtectedCandidates(await protectedIdentities(db));
  return { keys, checkerOrgId, fynbosOrgId, candidates };
}

beforeEach(async () => {
  await db.batch(
    [
      "check_outcomes",
      "evidence",
      "cases",
      "bank_match_counts",
      "bank_accounts",
      "bank_key_epoch",
      "trust_events",
      "identities",
      "org_domains",
      "org_addresses",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

describe("D05 T02 §3: registry comparison evidence that reveals nothing", () => {
  it("emits critical trust.impersonation, trust.sender_not_registered, and trust.bank_mismatch on the Fynbos Freight demo impersonation fixture", async () => {
    const { keys, checkerOrgId, fynbosOrgId, candidates } = await seedFynbosAndChecker();
    const caseId = ulid();

    const baseView = buildView({
      caseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id abc123; Tue, 03 Nov 2026 12:00:00 +0200" },
        {
          name: "Authentication-Results",
          value: "mx.google.com; spf=pass smtp.mailfrom=gmail.com; dkim=pass header.d=gmail.com; dmarc=pass",
        },
        { name: "From", value: '"Fynbos Freight Accounts" <fynbos.dispatch@gmail.com>' },
        { name: "Reply-To", value: "accounts@fynbos-freight.co.za" },
        { name: "Subject", value: "Overdue Invoice INV-8841 - Updated Payment Details" },
      ],
      text: "Dear Customer,\nPlease settle Invoice INV-8841 urgently.\n\nKind regards,\nFynbos Freight Accounts Team",
    });

    const claimItems = claimEvidence(claimInputFromView(baseView));
    expect(claimItems.some((i) => i.check === "trust.claim" && i.detail.orgId === fynbosOrgId)).toBe(true);

    const extractedAccounts: ExtractedBankAccount[] = [
      {
        number: "9112233445",
        branchCode: "632005",
        bankName: "Kestrel Bank",
        supplierName: "Fynbos Freight",
        role: "payee",
        artefactKey: `raw/${caseId}/att-1-invoice.pdf`,
      },
    ];

    const comparison = await prepareRegistryComparison({ db, keys }, caseId, baseView, claimItems, extractedAccounts);
    const enrichedView = withRegistryComparison(baseView, comparison);

    const reg = new CheckRegistry();
    registerClaimCheck(reg);
    registerComparisonChecks(reg);
    const { items, outcomes } = await runChecksWithOutcomes(enrichedView, reg);

    const impersonation = items.find((i) => i.check === "trust.impersonation");
    const senderNotReg = items.find((i) => i.check === "trust.sender_not_registered");
    const bankMismatch = items.find((i) => i.check === "trust.bank_mismatch");
    const verifiedSender = items.find((i) => i.check === "trust.verified_sender");

    expect(impersonation).toBeDefined();
    expect(impersonation?.severity).toBe("critical");
    expect(impersonation?.summary).toContain("Impersonates Fynbos Freight");
    expect(impersonation?.detail).toMatchObject({
      checked: true,
      orgId: fynbosOrgId,
      business: "Fynbos Freight",
      signals: ["sender-not-registered", "bank-mismatch"],
    });

    expect(senderNotReg).toBeDefined();
    expect(senderNotReg?.severity).toBe("critical");
    expect(senderNotReg?.summary).toContain("Fynbos Freight never sends from gmail.com");
    expect(senderNotReg?.artefacts).toContain(`raw/${caseId}/message.eml`);

    expect(bankMismatch).toBeDefined();
    expect(bankMismatch?.severity).toBe("critical");
    expect(bankMismatch?.summary).toBe("These bank details are not the ones Fynbos Freight registered with IsItLegit.");
    expect(bankMismatch?.summary.toLowerCase()).not.toContain("verified by");
    expect(bankMismatch?.summary.toLowerCase()).not.toContain("bank confirmed");
    expect(bankMismatch?.summary.toLowerCase()).not.toContain("account holder confirmed");
    expect(bankMismatch?.artefacts).toEqual([`raw/${caseId}/att-1-invoice.pdf`]);

    expect(verifiedSender).toBeUndefined();

    // Persist and read back to prove schema validity and round-trip integrity.
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, created_at, updated_at) VALUES (?, ?, 'email', 'running', ?, ?)",
      )
      .bind(caseId, checkerOrgId, new Date().toISOString(), new Date().toISOString())
      .run();
    await saveEvidence(db, caseId, items, reg, () => new Date(), outcomes);
    const storedEvidence = await readEvidence(db, caseId);
    const storedOutcomes = await readCheckOutcomes(db, caseId);
    expect(storedEvidence.map((e) => e.check)).toEqual([
      "trust.claim",
      "trust.impersonation",
      "trust.sender_not_registered",
      "trust.bank_mismatch",
    ]);
    expect(storedOutcomes?.find((o) => o.check === "trust.impersonation")?.outcome).toBe("ran");

    assertNoRegistryLeak(storedEvidence, storedOutcomes ?? [], {
      registeredDomainsNotInMail: ["fynbosfreight.co.za", FYNBOS_EXTRA_DOMAIN],
      registeredAddressesNotInMail: [FYNBOS_FINANCE_CONTACT, FYNBOS_EXTRA_ADDRESS],
      financeContacts: [FYNBOS_FINANCE_CONTACT],
      accountFragments: [FYNBOS_REGISTERED_ACCOUNT, "6200", "4411", "1223", "223"],
    });
  });

  it("handles negative controls: genuine DMARC-aligned mail (including mixed unrelated logo crops), partner-logo mail from a separate verified business, unauthenticated spoof on registered domain, and non-claiming third-party mail", async () => {
    const { keys, checkerOrgId, fynbosOrgId } = await seedFynbosAndChecker();
    const hadedaOrgId = await makeOrg("Hadeda Couriers (Pty) Ltd");
    await addDomain(hadedaOrgId, "hadedacouriers.co.za", "verified");
    await addAddress(hadedaOrgId, "finance@hadedacouriers.co.za", "verified");
    await setIdentity(db, hadedaOrgId, "owner-2", {
      displayNames: ["Hadeda Couriers"],
      financeContact: "finance@hadedacouriers.co.za",
      protected: true,
    });
    const candidates = boundProtectedCandidates(await protectedIdentities(db));

    // 1. Genuine DMARC-aligned mail from registered domain with matching bank account AND both a matching Fynbos logo
    //    crop (`same: true`) and an unrelated second badge crop (`same: false, brandSeen: "ISO 9001"`).
    const genuineCaseId = ulid();
    const genuineBaseView = buildView({
      caseId: genuineCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id gen1; Tue, 03 Nov 2026 12:00:00 +0200" },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; spf=pass smtp.mailfrom=fynbosfreight.co.za; dkim=pass header.d=fynbosfreight.co.za; dmarc=pass",
        },
        { name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' },
      ],
      text: "Attached is your monthly statement.\n\nFynbos Freight",
    });
    const genuineView = withClaimLogos(genuineBaseView, {
      logoJudgements: [
        {
          orgId: fynbosOrgId,
          same: true,
          brandSeen: "Fynbos Freight",
          differences: [],
          confidence: 0.96,
          cropKey: `art/${genuineCaseId}/crop/logo-0.png`,
        },
        {
          orgId: fynbosOrgId,
          same: false,
          brandSeen: "ISO 9001 Certification Badge",
          differences: ["circular certification seal, not Fynbos emblem"],
          confidence: 0.94,
          cropKey: `art/${genuineCaseId}/crop/logo-1.png`,
        },
      ],
      unavailable: [],
    });

    const genuineComparison = await prepareRegistryComparison({ db, keys }, genuineCaseId, genuineView, undefined, [
      {
        number: FYNBOS_REGISTERED_ACCOUNT,
        branchCode: FYNBOS_REGISTERED_BRANCH,
        bankName: "Protea Bank",
        supplierName: "Fynbos Freight",
        role: "payee",
        artefactKey: `raw/${genuineCaseId}/att-1.pdf`,
      },
    ]);
    const genuineItems = comparisonEvidence(genuineComparison);
    expect(genuineItems.map((i) => i.check)).toEqual(["trust.verified_sender"]);
    expect(genuineItems[0]?.severity).toBe("info");
    expect(genuineItems[0]?.summary).toContain("registered with IsItLegit, with DMARC aligned");
    expect(genuineItems[0]?.summary).toContain("and the payment details match what Fynbos Freight registered");
    expect(genuineItems[0]?.detail.bankMatched).toBe(true);
    expect(genuineItems[0]?.summary.toLowerCase()).not.toContain("verified by");
    expect(genuineItems[0]?.summary.toLowerCase()).not.toContain("bank confirmed");
    expect(genuineItems[0]?.summary.toLowerCase()).not.toContain("account holder confirmed");

    // 1b. Partially failed bank comparison on authenticated mail (first account matches, second throws AccountRefused):
    //     suppresses `bankMatched: true` and the "payment details match" clause in `trust.verified_sender`.
    const partialBankGenuineCmp = await prepareRegistryComparison({ db, keys }, genuineCaseId, genuineView, undefined, [
      {
        number: FYNBOS_REGISTERED_ACCOUNT,
        branchCode: FYNBOS_REGISTERED_BRANCH,
        bankName: "Protea Bank",
        supplierName: "Fynbos Freight",
        role: "payee",
      },
      {
        number: "123",
        branchCode: "99",
        bankName: "Protea Bank",
        supplierName: "Fynbos Freight",
        role: "payee",
      },
    ]);
    const partialBankGenuineItems = comparisonEvidence(partialBankGenuineCmp);
    expect(partialBankGenuineItems.map((i) => i.check)).toEqual(["trust.verified_sender"]);
    expect(partialBankGenuineItems[0]?.detail.bankMatched).toBeUndefined();
    expect(partialBankGenuineItems[0]?.summary).not.toContain("payment details match");

    // 2. Genuine partner-logo mail: Hadeda Couriers (verified sender) sends DMARC-aligned mail from
    //    `ops@hadedacouriers.co.za` that also includes Fynbos Freight's matching partner logo crop (`same: true`).
    //    Actual claim detection claims both Hadeda (by From domain + display name) and Fynbos (by logo only).
    //    Hadeda gets `trust.verified_sender`; Fynbos gets ZERO `trust.sender_not_registered` and ZERO `trust.impersonation`.
    const partnerCaseId = ulid();
    const partnerBaseView = buildView({
      caseId: partnerCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id part1; Tue, 03 Nov 2026 12:00:00 +0200" },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; spf=pass smtp.mailfrom=hadedacouriers.co.za; dkim=pass header.d=hadedacouriers.co.za; dmarc=pass",
        },
        { name: "From", value: '"Hadeda Couriers" <ops@hadedacouriers.co.za>' },
      ],
      text: "Dispatch update from Hadeda Couriers.",
    });
    const partnerView = withClaimLogos(partnerBaseView, {
      logoJudgements: [
        {
          orgId: fynbosOrgId,
          same: true,
          brandSeen: "Fynbos Freight",
          differences: [],
          confidence: 0.95,
          cropKey: `art/${partnerCaseId}/crop/partner-logo.png`,
        },
      ],
      unavailable: [],
    });
    const partnerClaimItems = claimEvidence(claimInputFromView(partnerView));
    expect(partnerClaimItems.map((i) => i.detail.orgId)).toEqual(expect.arrayContaining([hadedaOrgId, fynbosOrgId]));
    const partnerComparison = await prepareRegistryComparison(
      { db, keys },
      partnerCaseId,
      partnerView,
      partnerClaimItems,
    );
    const partnerItems = comparisonEvidence(partnerComparison);
    expect(partnerItems.filter((i) => i.check === "trust.sender_not_registered")).toEqual([]);
    expect(partnerItems.filter((i) => i.check === "trust.impersonation")).toEqual([]);
    expect(partnerItems.map((i) => ({ check: i.check, orgId: i.detail.orgId }))).toEqual([
      { check: "trust.verified_sender", orgId: hadedaOrgId },
    ]);

    // 2b. Spoofed partner-logo mail: unauthenticated spoof claiming Hadeda Couriers in From (`dmarc=fail`) while
    //     carrying Fynbos Freight's logo (`same: true`). Because Hadeda's sender is NOT authenticated by aligned DMARC,
    //     the partner-logo exception is NOT granted and Fynbos's logo-based claim emits `trust.sender_not_registered`
    //     and `trust.impersonation`.
    const spoofedPartnerCaseId = ulid();
    const spoofedPartnerBaseView = buildView({
      caseId: spoofedPartnerCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id sppart1; Tue, 03 Nov 2026 12:00:00 +0200" },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; spf=fail smtp.mailfrom=hadedacouriers.co.za; dkim=none; dmarc=fail (p=REJECT dis=NONE)",
        },
        { name: "From", value: '"Hadeda Couriers" <ops@hadedacouriers.co.za>' },
      ],
      text: "Dispatch update.",
    });
    const spoofedPartnerView = withClaimLogos(spoofedPartnerBaseView, {
      logoJudgements: [
        {
          orgId: fynbosOrgId,
          same: true,
          brandSeen: "Fynbos Freight",
          differences: [],
          confidence: 0.95,
          cropKey: `art/${spoofedPartnerCaseId}/crop/partner-logo.png`,
        },
      ],
      unavailable: [],
    });
    const spoofedPartnerClaims = claimEvidence(claimInputFromView(spoofedPartnerView));
    const spoofedPartnerComparison = await prepareRegistryComparison(
      { db, keys },
      spoofedPartnerCaseId,
      spoofedPartnerView,
      spoofedPartnerClaims,
    );
    const spoofedPartnerItems = comparisonEvidence(spoofedPartnerComparison);
    expect(
      spoofedPartnerItems.some((i) => i.check === "trust.sender_not_registered" && i.detail.orgId === fynbosOrgId),
    ).toBe(true);
    expect(spoofedPartnerItems.some((i) => i.check === "trust.impersonation" && i.detail.orgId === fynbosOrgId)).toBe(
      true,
    );
    expect(spoofedPartnerItems.find((i) => i.check === "trust.verified_sender")).toBeUndefined();

    // 2c. Transient failure during partner lookup: if the initial verified-partner query fails on genuine partner-logo
    //     mail, Fynbos's logo-only claim records unavailable sender coverage rather than a false critical accusation.
    let firstDistinctPrepare = true;
    const flakyPartnerDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (firstDistinctPrepare && sql.includes("SELECT DISTINCT org_id FROM org_domains")) {
              firstDistinctPrepare = false;
              return {
                bind: () => ({
                  all: async () => {
                    throw new Error("transient D1 partner lookup failure");
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const flakyPartnerComparison = await prepareRegistryComparison(
      { db: flakyPartnerDb, keys },
      partnerCaseId,
      partnerView,
      partnerClaimItems,
    );
    const flakyPartnerItems = comparisonEvidence(flakyPartnerComparison);
    expect(flakyPartnerItems.filter((i) => i.check === "trust.sender_not_registered")).toEqual([]);
    expect(flakyPartnerItems.filter((i) => i.check === "trust.impersonation")).toEqual([]);
    const flakyFynbos = flakyPartnerComparison.businesses.find((b) => b.orgId === fynbosOrgId);
    expect(flakyFynbos?.senderChecked).toBe(false);
    expect(flakyFynbos?.senderUnavailable).toContain("the sender's registration could not be read right now");

    // 3. Doctored logo crop purporting to be Fynbos Freight (`same: false, brandSeen: "Fynbos Freight"`) alongside a
    //    textual claim triggers `logo-mismatch` in `trust.impersonation`.
    const doctoredLogoCaseId = ulid();
    const doctoredBaseView = buildView({
      caseId: doctoredLogoCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id doc1; Tue, 03 Nov 2026 12:00:00 +0200" },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; spf=pass smtp.mailfrom=fynbosfreight.co.za; dkim=pass header.d=fynbosfreight.co.za; dmarc=pass",
        },
        { name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' },
      ],
      text: "Updated invoice from Fynbos Freight.",
    });
    const doctoredView = withClaimLogos(doctoredBaseView, {
      logoJudgements: [
        {
          orgId: fynbosOrgId,
          same: false,
          brandSeen: "Fynbos Freight",
          differences: ["modified protea icon and redrawn wordmark"],
          confidence: 0.93,
          cropKey: `art/${doctoredLogoCaseId}/crop/doctored-logo.png`,
        },
      ],
      unavailable: [],
    });
    const doctoredComparison = await prepareRegistryComparison({ db, keys }, doctoredLogoCaseId, doctoredView);
    const doctoredItems = comparisonEvidence(doctoredComparison);
    expect(doctoredItems.find((i) => i.check === "trust.impersonation")?.detail).toMatchObject({
      orgId: fynbosOrgId,
      signals: ["logo-mismatch"],
    });
    expect(doctoredItems.find((i) => i.check === "trust.verified_sender")).toBeUndefined();

    // 3b. Uncertain / low-confidence Fynbos logo crop (`confidence < MIN_LOGO_CLAIM_CONFIDENCE`, where upstream sets
    //     `same: false`) on genuine authenticated Fynbos mail: records unavailable logo coverage, preserves
    //     `trust.verified_sender`, and emits zero `trust.impersonation`.
    const lowConfCaseId = ulid();
    const lowConfView = withClaimLogos(
      buildView({
        caseId: lowConfCaseId,
        orgId: checkerOrgId,
        protectedCandidates: candidates,
        headers: [
          { name: "Received", value: "by mx.google.com with ESMTPS id lc1; Tue, 03 Nov 2026 12:00:00 +0200" },
          {
            name: "Authentication-Results",
            value:
              "mx.google.com; spf=pass smtp.mailfrom=fynbosfreight.co.za; dkim=pass header.d=fynbosfreight.co.za; dmarc=pass",
          },
          { name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' },
        ],
        text: "Monthly dispatch statement from Fynbos Freight.",
      }),
      {
        logoJudgements: [
          {
            orgId: fynbosOrgId,
            same: false,
            brandSeen: "Fynbos Freight",
            differences: ["blurry low-resolution crop"],
            confidence: 0.35,
            cropKey: `art/${lowConfCaseId}/crop/blurry-logo.png`,
          },
        ],
        unavailable: [],
      },
    );
    const lowConfClaimItems = claimEvidence(claimInputFromView(lowConfView));
    const lowConfComparison = await prepareRegistryComparison(
      { db, keys },
      lowConfCaseId,
      lowConfView,
      lowConfClaimItems,
    );
    const lowConfItems = comparisonEvidence(lowConfComparison);
    expect(lowConfItems.map((i) => i.check)).toEqual(["trust.verified_sender"]);
    expect(lowConfComparison.unavailable).toContain("a logo comparison had low confidence");
    const lowConfOutcomes = comparisonOutcomes(withRegistryComparison(lowConfView, lowConfComparison));
    expect(lowConfOutcomes.find((o) => o.check === "trust.impersonation")).toMatchObject({
      check: "trust.impersonation",
      outcome: "partial",
      reason: "a logo comparison had low confidence",
      findings: 0,
    });

    // 4. Unauthenticated spoof on a registered domain (DMARC fail): yields neither verified_sender nor sender_not_registered.
    const spoofCaseId = ulid();
    const spoofView = buildView({
      caseId: spoofCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id spf1; Tue, 03 Nov 2026 12:00:00 +0200" },
        {
          name: "Authentication-Results",
          value: "mx.google.com; spf=fail smtp.mailfrom=fynbosfreight.co.za; dkim=none; dmarc=fail (p=REJECT dis=NONE)",
        },
        { name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' },
      ],
      text: "Urgent invoice attached.",
    });
    const spoofComparison = await prepareRegistryComparison({ db, keys }, spoofCaseId, spoofView);
    const spoofItems = comparisonEvidence(spoofComparison);
    expect(spoofItems.find((i) => i.check === "trust.verified_sender")).toBeUndefined();
    expect(spoofItems.find((i) => i.check === "trust.sender_not_registered")).toBeUndefined();

    // 5. Non-claiming third-party mail (and negative-only logo judgement without textual claim): zero findings.
    const thirdPartyCaseId = ulid();
    const thirdPartyView = buildView({
      caseId: thirdPartyCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id tp1; Tue, 03 Nov 2026 12:00:00 +0200" },
        { name: "From", value: '"Cape Stationery Supplies" <orders@capestationery.co.za>' },
      ],
      text: "Your paper order is ready for collection.",
    });
    const thirdPartyComparison = await prepareRegistryComparison({ db, keys }, thirdPartyCaseId, thirdPartyView, [
      {
        orgId: fynbosOrgId,
        name: "Fynbos Freight",
        routes: [],
        logos: [
          {
            same: false,
            brandSeen: "Cape Stationery",
            differences: ["completely different emblem"],
            confidence: 0.95,
            cropKey: `art/${thirdPartyCaseId}/crop/logo-0.png`,
          },
        ],
      },
    ]);
    expect(comparisonEvidence(thirdPartyComparison)).toEqual([]);
  });

  it("attributes bank accounts to the matching business when multiple businesses are claimed and marks ambiguous or conflicting accounts unavailable without emitting trust.bank_mismatch", async () => {
    const { keys, checkerOrgId, fynbosOrgId } = await seedFynbosAndChecker();
    const hadedaOrgId = await makeOrg("Hadeda Couriers (Pty) Ltd");
    await addDomain(hadedaOrgId, "hadedacouriers.co.za", "verified");
    await addAddress(hadedaOrgId, "finance@hadedacouriers.co.za", "verified");
    await setIdentity(db, hadedaOrgId, "owner-2", {
      displayNames: ["Hadeda Couriers"],
      financeContact: "finance@hadedacouriers.co.za",
      protected: true,
    });
    await addAccount(db, keys, hadedaOrgId, "owner-2", {
      number: "01122334455",
      branchCode: "198765",
      bankName: "Protea Bank",
      holder: "Hadeda Couriers (Pty) Ltd",
    });

    const candidates = boundProtectedCandidates(await protectedIdentities(db));
    const caseId = ulid();
    const view = buildView({
      caseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id m1; Tue, 03 Nov 2026 12:00:00 +0200" },
        { name: "From", value: '"Fynbos Freight & Hadeda Couriers" <joint@gmail.com>' },
      ],
      text: "Joint statement from Fynbos Freight and Hadeda Couriers.",
    });

    // Account 1 names Hadeda Couriers with wrong details -> mismatch for Hadeda only.
    // Account 2 names neither business -> ambiguous across the two claimed businesses -> unavailable, no mismatch!
    const comparison = await prepareRegistryComparison({ db, keys }, caseId, view, undefined, [
      {
        number: "9998887776",
        branchCode: "198765",
        supplierName: "Hadeda Couriers",
        role: "payee",
        artefactKey: `raw/${caseId}/hadeda.pdf`,
      },
      {
        number: "8887776665",
        branchCode: "250655",
        supplierName: null,
        supplierDomain: null,
        role: "payee",
        artefactKey: `raw/${caseId}/unknown.pdf`,
      },
    ]);

    const items = comparisonEvidence(comparison);
    const bankMismatches = items.filter((i) => i.check === "trust.bank_mismatch");
    expect(bankMismatches).toHaveLength(1);
    expect(bankMismatches[0]?.summary).toBe(
      "These bank details are not the ones Hadeda Couriers registered with IsItLegit.",
    );

    const fynbosEntry = comparison.businesses.find((b) => b.orgId === fynbosOrgId);
    expect(fynbosEntry?.bankUnavailable).toContain(
      "the extracted bank account could not be tied to one claimed business",
    );

    const outcomes = comparisonOutcomes(withRegistryComparison(view, comparison));
    const bankOutcome = outcomes.find((o) => o.check === "trust.bank_mismatch");
    expect(bankOutcome?.outcome).toBe("partial");
    expect(bankOutcome?.reason).toBe("the extracted bank account could not be tied to one claimed business");

    // Sole claimed business with conflicting supplierName vs supplierDomain: records unavailable and emits no bank_mismatch.
    const singleCaseId = ulid();
    const singleView = buildView({
      caseId: singleCaseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id s1; Tue, 03 Nov 2026 12:00:00 +0200" },
        { name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' },
      ],
      text: "Attached invoice from Fynbos Freight.",
    });
    const conflictingCmp = await prepareRegistryComparison({ db, keys }, singleCaseId, singleView, undefined, [
      {
        number: "9998887776",
        branchCode: "250655",
        supplierName: "Fynbos Freight",
        supplierDomain: "capestationery.co.za",
        role: "payee",
        artefactKey: `raw/${singleCaseId}/conflict-domain.pdf`,
      },
      {
        number: "9998887776",
        branchCode: "250655",
        supplierName: "Cape Stationery",
        supplierDomain: "fynbosfreight.co.za",
        role: "payee",
        artefactKey: `raw/${singleCaseId}/conflict-name.pdf`,
      },
    ]);
    expect(comparisonEvidence(conflictingCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(
      comparisonOutcomes(withRegistryComparison(singleView, conflictingCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      ),
    ).toEqual({
      check: "trust.bank_mismatch",
      outcome: "skipped",
      reason: "the extracted bank account could not be tied to one claimed business",
      findings: 0,
    });

    // Overlapping business name ("Fynbos Freight Logistics" when only "Fynbos Freight" is claimed) is treated as a
    // conflict rather than attributed by substring, and payer accounts (`role: "payer"`) are excluded from comparison.
    const overlapAndPayerCmp = await prepareRegistryComparison({ db, keys }, singleCaseId, singleView, undefined, [
      {
        number: "9998887776",
        branchCode: "250655",
        supplierName: "Fynbos Freight Logistics",
        role: "payee",
        artefactKey: `raw/${singleCaseId}/overlapping-supplier.pdf`,
      },
      {
        number: "1112223334",
        branchCode: "632005",
        supplierName: "Fynbos Freight",
        role: "payer",
        artefactKey: `raw/${singleCaseId}/payer-account.pdf`,
      },
    ]);
    expect(comparisonEvidence(overlapAndPayerCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(overlapAndPayerCmp.businesses[0]?.bankMatches).toEqual([]);
    expect(overlapAndPayerCmp.businesses[0]?.bankUnavailable).toContain(
      "the extracted bank account could not be tied to one claimed business",
    );
  });

  it("maps every typed refusal (AccountRefused, NoBaseline, KeyMismatch, IdentityRefused, MatchLimited, BankKeysMissing) to unavailable coverage with zero trust.bank_mismatch items while preserving sender findings", async () => {
    const { keys, checkerOrgId, fynbosOrgId, candidates } = await seedFynbosAndChecker();
    const caseId = ulid();

    const makeSpoofView = () =>
      buildView({
        caseId,
        orgId: checkerOrgId,
        protectedCandidates: candidates,
        headers: [
          { name: "Received", value: "by mx.google.com with ESMTPS id r1; Tue, 03 Nov 2026 12:00:00 +0200" },
          { name: "From", value: '"Fynbos Freight" <impersonator@gmail.com>' },
        ],
        text: "Please pay Fynbos Freight.",
      });

    // 1. AccountRefused: malformed account number / branch code.
    const accountRefusedCmp = await prepareRegistryComparison({ db, keys }, caseId, makeSpoofView(), undefined, [
      { number: "123", branchCode: "99", supplierName: "Fynbos Freight", role: "payee" },
    ]);
    expect(comparisonEvidence(accountRefusedCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(comparisonEvidence(accountRefusedCmp).some((i) => i.check === "trust.sender_not_registered")).toBe(true);
    expect(
      comparisonOutcomes(withRegistryComparison(makeSpoofView(), accountRefusedCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      ),
    ).toEqual({
      check: "trust.bank_mismatch",
      outcome: "skipped",
      reason: "the extracted bank details were incomplete or not a valid account and branch code",
      findings: 0,
    });

    // 2. BankKeysMissing: missing or invalid BANK_KEY in env.
    const keysMissingCmp = await prepareRegistryComparison(
      { db, env: { BANK_KEY: "", BANK_MATCH_KEY: "" } },
      caseId,
      makeSpoofView(),
      undefined,
      [{ number: "9112233445", branchCode: "250655", supplierName: "Fynbos Freight", role: "payee" }],
    );
    expect(comparisonEvidence(keysMissingCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(
      comparisonOutcomes(withRegistryComparison(makeSpoofView(), keysMissingCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      )?.reason,
    ).toBe("account comparison keys are not configured");

    // 3. KeyMismatch: pass a different BankKeys instance than the one the account was registered under.
    const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
    const rotatedKeys = await bankKeys({
      BANK_KEY: b64(Array.from({ length: 32 }, (_, i) => (i + 77) & 255)),
      BANK_MATCH_KEY: b64(Array.from({ length: 32 }, (_, i) => (i * 5 + 77) & 255)),
    });
    const keyMismatchCmp = await prepareRegistryComparison(
      { db, keys: rotatedKeys },
      caseId,
      makeSpoofView(),
      undefined,
      [{ number: "9112233445", branchCode: "250655", supplierName: "Fynbos Freight", role: "payee" }],
    );
    expect(comparisonEvidence(keyMismatchCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(
      comparisonOutcomes(withRegistryComparison(makeSpoofView(), keyMismatchCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      )?.reason,
    ).toBe("account checks are paused while keys are replaced");

    // 4. MatchLimited: exhaust the 20/hour rate limit for this protected business.
    const fixedNow = new Date("2026-11-03T12:00:00Z");
    for (let i = 0; i < MATCHES_PER_HOUR; i++) {
      await prepareRegistryComparison({ db, keys, now: fixedNow }, `${caseId}-${i}`, makeSpoofView(), undefined, [
        { number: FYNBOS_REGISTERED_ACCOUNT, branchCode: FYNBOS_REGISTERED_BRANCH, supplierName: "Fynbos Freight" },
      ]);
    }
    const rateLimitedCmp = await prepareRegistryComparison(
      { db, keys, now: fixedNow },
      `${caseId}-over`,
      makeSpoofView(),
      undefined,
      [{ number: "9112233445", branchCode: "250655", supplierName: "Fynbos Freight", role: "payee" }],
    );
    expect(comparisonEvidence(rateLimitedCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(comparisonEvidence(rateLimitedCmp).some((i) => i.check === "trust.sender_not_registered")).toBe(true);
    expect(
      comparisonOutcomes(withRegistryComparison(makeSpoofView(), rateLimitedCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      )?.reason,
    ).toBe("too many checks this hour");

    // 5. NoBaseline: remove Fynbos's registered bank accounts and clear rate-limit counts.
    await db.batch([
      db.prepare("DELETE FROM bank_accounts WHERE org_id = ?").bind(fynbosOrgId),
      db.prepare("DELETE FROM bank_match_counts"),
    ]);
    const noBaselineCmp = await prepareRegistryComparison(
      { db, keys, now: fixedNow },
      caseId,
      makeSpoofView(),
      undefined,
      [{ number: "9112233445", branchCode: "250655", supplierName: "Fynbos Freight", role: "payee" }],
    );
    expect(comparisonEvidence(noBaselineCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(
      comparisonOutcomes(withRegistryComparison(makeSpoofView(), noBaselineCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      )?.reason,
    ).toBe("the business has not registered an account");

    // 6. IdentityRefused: switch protection off on Fynbos after claim detection.
    await setIdentity(db, fynbosOrgId, "owner-1", {
      displayNames: ["Fynbos Freight"],
      financeContact: FYNBOS_FINANCE_CONTACT,
      protected: false,
    });
    const inactiveCmp = await prepareRegistryComparison(
      { db, keys, now: fixedNow },
      caseId,
      makeSpoofView(),
      [{ orgId: fynbosOrgId, name: "Fynbos Freight", routes: ["display-name"] }],
      [{ number: "9112233445", branchCode: "250655", supplierName: "Fynbos Freight", role: "payee" }],
    );
    expect(comparisonEvidence(inactiveCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(
      comparisonOutcomes(withRegistryComparison(makeSpoofView(), inactiveCmp)).find(
        (o) => o.check === "trust.bank_mismatch",
      )?.reason,
    ).toBe("the business's protection is not active");
  });

  it("handles malformed stored trust.claim items, missing or duplicate From headers while preserving bank mismatches, and transient registry lookup failures", async () => {
    const { keys, checkerOrgId, fynbosOrgId, candidates } = await seedFynbosAndChecker();
    const caseId = ulid();

    // 1. Malformed stored trust.claim item alongside a valid claim: records unavailable reason and still evaluates the valid claim.
    const validView = buildView({
      caseId,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "Received", value: "by mx.google.com with ESMTPS id b1; Tue, 03 Nov 2026 12:00:00 +0200" },
        { name: "From", value: '"Fynbos Freight" <impersonator@gmail.com>' },
      ],
      text: "Urgent payment for Fynbos Freight.",
    });
    const malformedClaimDraft: EvidenceDraft = {
      check: "trust.claim",
      severity: "info",
      summary: "Corrupted claim row",
      detail: { checked: true, broken: true } as unknown as EvidenceDraft["detail"],
      artefacts: [],
    };
    const validClaimDrafts = claimEvidence(claimInputFromView(validView));
    const malformedCmp = await prepareRegistryComparison({ db, keys }, caseId, validView, [
      malformedClaimDraft,
      ...validClaimDrafts,
    ]);
    expect(malformedCmp.unavailable).toContain("a stored trust.claim item was malformed and could not be read");
    expect(comparisonEvidence(malformedCmp).some((i) => i.check === "trust.sender_not_registered")).toBe(true);
    expect(
      comparisonOutcomes(withRegistryComparison(validView, malformedCmp)).find(
        (o) => o.check === "trust.sender_not_registered",
      ),
    ).toMatchObject({
      outcome: "partial",
      reason: "a stored trust.claim item was malformed and could not be read",
      findings: 1,
    });

    // 2. Missing From header: records unavailable sender coverage while still emitting critical trust.bank_mismatch
    //    and trust.impersonation from the mismatched beneficiary bank account.
    const missingFromView = buildView({
      caseId: `${caseId}-nofrom`,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [{ name: "Subject", value: "Fynbos Freight Invoice" }],
      text: "Kind regards,\nFynbos Freight",
    });
    const missingFromCmp = await prepareRegistryComparison(
      { db, keys },
      `${caseId}-nofrom`,
      missingFromView,
      undefined,
      [
        {
          number: "9112233445",
          branchCode: "632005",
          supplierName: "Fynbos Freight",
          role: "payee",
          artefactKey: `raw/${caseId}-nofrom/invoice.pdf`,
        },
      ],
    );
    const missingFromItems = comparisonEvidence(missingFromCmp);
    expect(missingFromItems.some((i) => i.check === "trust.bank_mismatch")).toBe(true);
    expect(missingFromItems.some((i) => i.check === "trust.impersonation")).toBe(true);
    expect(missingFromItems.some((i) => i.check === "trust.sender_not_registered")).toBe(false);
    const missingFromOutcomes = comparisonOutcomes(withRegistryComparison(missingFromView, missingFromCmp));
    expect(missingFromOutcomes.find((o) => o.check === "trust.sender_not_registered")).toEqual({
      check: "trust.sender_not_registered",
      outcome: "skipped",
      reason: "the original message had no From header",
      findings: 0,
    });

    // 3. Duplicate From headers: refuses to trust ambiguous From headers, records unavailable sender coverage, and
    //    preserves independent bank mismatch findings.
    const dupFromView = buildView({
      caseId: `${caseId}-dupfrom`,
      orgId: checkerOrgId,
      protectedCandidates: candidates,
      headers: [
        { name: "From", value: '"Fynbos Freight" <billing@fynbosfreight.co.za>' },
        { name: "From", value: '"Fynbos Freight" <attacker@gmail.com>' },
      ],
      text: "Kind regards,\nFynbos Freight",
    });
    const dupFromCmp = await prepareRegistryComparison({ db, keys }, `${caseId}-dupfrom`, dupFromView, undefined, [
      {
        number: "9112233445",
        branchCode: "632005",
        supplierName: "Fynbos Freight",
        role: "payee",
        artefactKey: `raw/${caseId}-dupfrom/invoice.pdf`,
      },
    ]);
    const dupFromItems = comparisonEvidence(dupFromCmp);
    expect(dupFromItems.some((i) => i.check === "trust.bank_mismatch")).toBe(true);
    expect(dupFromItems.some((i) => i.check === "trust.sender_not_registered")).toBe(false);
    const dupFromOutcomes = comparisonOutcomes(withRegistryComparison(dupFromView, dupFromCmp));
    expect(dupFromOutcomes.find((o) => o.check === "trust.sender_not_registered")).toEqual({
      check: "trust.sender_not_registered",
      outcome: "skipped",
      reason: "multiple From headers were present and could not be trusted",
      findings: 0,
    });

    // 3b. Malformed From headers with control characters or trailing garbage rejected by originalHeaderOf:
    //     never reconstructed into a registered address; recorded as unreadable From coverage.
    for (const badFrom of [
      "Fynbos <bill\u0007ing@fynbosfreight.co.za>",
      "Fynbos <billing@fynbosfreight.co.za> extra@garbage",
    ]) {
      const badFromView = buildView({
        caseId: `${caseId}-badfrom`,
        orgId: checkerOrgId,
        protectedCandidates: candidates,
        headers: [
          { name: "Received", value: "by mx.google.com with ESMTPS id bf1; Tue, 03 Nov 2026 12:00:00 +0200" },
          {
            name: "Authentication-Results",
            value:
              "mx.google.com; spf=pass smtp.mailfrom=fynbosfreight.co.za; dkim=pass header.d=fynbosfreight.co.za; dmarc=pass",
          },
          { name: "From", value: badFrom },
        ],
        text: "Kind regards,\nFynbos Freight",
      });
      const badFromCmp = await prepareRegistryComparison({ db, keys }, `${caseId}-badfrom`, badFromView);
      expect(badFromCmp.fromAddress).toBeNull();
      expect(comparisonEvidence(badFromCmp)).toEqual([]);
      expect(badFromCmp.businesses[0]?.senderUnavailable).toContain(
        "the original message's From address could not be read",
      );
    }

    // 4. Registry lookup failure during per-business identity read: records "the sender's registration could not be read right now".
    const brokenRegistryDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM identities")) {
              return {
                bind: () => ({
                  first: async () => {
                    throw new Error("D1 identity lookup failure");
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const registryFailedCmp = await prepareRegistryComparison({ db: brokenRegistryDb, keys }, caseId, validView, [
      { orgId: fynbosOrgId, name: "Fynbos Freight", routes: ["display-name"] },
    ]);
    expect(registryFailedCmp.businesses[0]?.senderUnavailable).toContain(
      "the sender's registration could not be read right now",
    );
    expect(comparisonEvidence(registryFailedCmp).filter((i) => i.check === "trust.sender_not_registered")).toEqual([]);
    expect(
      comparisonOutcomes(withRegistryComparison(validView, registryFailedCmp)).find(
        (o) => o.check === "trust.sender_not_registered",
      ),
    ).toEqual({
      check: "trust.sender_not_registered",
      outcome: "skipped",
      reason: "the sender's registration could not be read right now",
      findings: 0,
    });

    // 5. Counterparty checks from the same forwarder across different protected businesses share the forwarder's
    //    per-sender bank-check rate limit bucket (`caller:sender:...`) rather than using each protected business's orgId.
    const hadedaOrgId = await makeOrg("Hadeda Couriers (Pty) Ltd");
    await addDomain(hadedaOrgId, "hadedacouriers.co.za", "verified");
    await addAddress(hadedaOrgId, "finance@hadedacouriers.co.za", "verified");
    await setIdentity(db, hadedaOrgId, "owner-2", {
      displayNames: ["Hadeda Couriers"],
      financeContact: "finance@hadedacouriers.co.za",
      protected: true,
    });
    await addAccount(db, keys, hadedaOrgId, "owner-2", {
      number: "01122334455",
      branchCode: "198765",
      bankName: "Protea Bank",
      holder: "Hadeda Couriers (Pty) Ltd",
    });
    const bothCandidates = boundProtectedCandidates(await protectedIdentities(db));
    const fixedHour = new Date("2026-11-03T15:00:00Z");
    const forwarder = "buyer-accounts@example.co.za";

    for (let i = 0; i < MATCHES_PER_HOUR; i++) {
      const targetOrg = i % 2 === 0 ? fynbosOrgId : hadedaOrgId;
      const targetName = i % 2 === 0 ? "Fynbos Freight" : "Hadeda Couriers";
      const cpCaseId = ulid();
      await db
        .prepare(
          "INSERT INTO cases (id, org_id, channel, status, forwarded_by, origin, created_at, updated_at) VALUES (?, ?, 'email', 'running', ?, 'counterparty', ?, ?)",
        )
        .bind(cpCaseId, targetOrg, forwarder, fixedHour.toISOString(), fixedHour.toISOString())
        .run();
      const cpView = buildView({
        caseId: cpCaseId,
        orgId: targetOrg,
        protectedCandidates: bothCandidates,
        headers: [{ name: "From", value: `"${targetName}" <spoof@gmail.com>` }],
        text: `Invoice from ${targetName}`,
      });
      await prepareRegistryComparison({ db, keys, now: fixedHour }, cpCaseId, cpView, undefined, [
        { number: "9112233445", branchCode: "250655", supplierName: targetName, role: "payee" },
      ]);
    }

    const overCaseId = ulid();
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, forwarded_by, origin, created_at, updated_at) VALUES (?, ?, 'email', 'running', ?, 'counterparty', ?, ?)",
      )
      .bind(overCaseId, hadedaOrgId, forwarder, fixedHour.toISOString(), fixedHour.toISOString())
      .run();
    const overView = buildView({
      caseId: overCaseId,
      orgId: hadedaOrgId,
      protectedCandidates: bothCandidates,
      headers: [{ name: "From", value: '"Hadeda Couriers" <spoof@gmail.com>' }],
      text: "Invoice from Hadeda Couriers",
    });
    const overCmp = await prepareRegistryComparison({ db, keys, now: fixedHour }, overCaseId, overView, undefined, [
      { number: "9112233445", branchCode: "198765", supplierName: "Hadeda Couriers", role: "payee" },
    ]);
    expect(comparisonEvidence(overCmp).filter((i) => i.check === "trust.bank_mismatch")).toEqual([]);
    expect(overCmp.businesses[0]?.bankUnavailable).toContain("too many checks this hour");
  });

  it("fails the leak detector immediately when a registered domain, address, finance contact, or account fragment is planted", () => {
    const baseItem: EvidenceDraft = {
      check: "trust.bank_mismatch",
      severity: "critical",
      summary: "These bank details are not the ones Fynbos Freight registered with IsItLegit.",
      detail: { checked: true, business: "Fynbos Freight", matched: false },
      artefacts: ["raw/case-1/message.eml"],
    };
    const baseOutcome: CheckOutcome = {
      check: "trust.bank_mismatch",
      outcome: "ran",
      reason: null,
      findings: 1,
      summary: "These bank details are not the ones Fynbos Freight registered with IsItLegit.",
    };
    const cleanItems: EvidenceDraft[] = [baseItem];
    const cleanOutcomes: CheckOutcome[] = [baseOutcome];
    const secrets: ForbiddenSecrets = {
      registeredDomainsNotInMail: ["fynbosfreight.co.za", FYNBOS_EXTRA_DOMAIN],
      registeredAddressesNotInMail: [FYNBOS_EXTRA_ADDRESS],
      financeContacts: [FYNBOS_FINANCE_CONTACT],
      accountFragments: [FYNBOS_REGISTERED_ACCOUNT, "1223", "223"],
    };

    expect(() => assertNoRegistryLeak(cleanItems, cleanOutcomes, secrets)).not.toThrow();

    // Planted registered domain list in detail:
    expect(() =>
      assertNoRegistryLeak(
        [
          {
            ...baseItem,
            detail: { registeredDomains: ["fynbosfreight.co.za", FYNBOS_EXTRA_DOMAIN] },
          },
        ],
        cleanOutcomes,
        secrets,
      ),
    ).toThrow(/registered domain/);

    // Planted registered address in summary:
    expect(() =>
      assertNoRegistryLeak(
        [{ ...baseItem, summary: `Expected mail from ${FYNBOS_EXTRA_ADDRESS}` }],
        cleanOutcomes,
        secrets,
      ),
    ).toThrow(/registered address/);

    // Planted finance contact in check outcome summary:
    expect(() =>
      assertNoRegistryLeak(cleanItems, [{ ...baseOutcome, summary: `Contact ${FYNBOS_FINANCE_CONTACT}` }], secrets),
    ).toThrow(/finance contact/);

    // Planted account fragment ("ends 223") in summary:
    expect(() =>
      assertNoRegistryLeak([{ ...baseItem, summary: "Fynbos Freight's account ends 223" }], cleanOutcomes, secrets),
    ).toThrow(/account fragment/);
  });
});
