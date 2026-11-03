// Registry comparison evidence tests (D05 T02 §3; spec 2a and 4.5):
// - Demo Fynbos Freight impersonation fixture yields critical `trust.impersonation`,
//   `trust.sender_not_registered`, and `trust.bank_mismatch`.
// - Negative controls: genuine DMARC-aligned mail from a registered domain yields `trust.verified_sender`
//   and no impersonation/mismatch; unauthenticated spoof on a registered domain does not yield
//   `trust.verified_sender`; non-claiming third-party mail and negative-only logo judgements do not yield
//   `trust.sender_not_registered` or `trust.impersonation`.
// - Multi-business bank account attribution and ambiguity handling.
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
import { claimEvidence, claimInputFromView, registerClaimCheck } from "../../src/trust/claim";
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
    if (combined.includes(fragment.toLowerCase())) {
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

  it("handles negative controls: genuine DMARC-aligned mail yields trust.verified_sender, unauthenticated spoof on registered domain does not, and non-claiming third-party mail yields no findings", async () => {
    const { keys, checkerOrgId, fynbosOrgId, candidates } = await seedFynbosAndChecker();

    // 1. Genuine DMARC-aligned mail from registered domain with matching bank account.
    const genuineCaseId = ulid();
    const genuineView = buildView({
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
    expect(genuineItems[0]?.summary.toLowerCase()).not.toContain("verified by");
    expect(genuineItems[0]?.summary.toLowerCase()).not.toContain("bank confirmed");
    expect(genuineItems[0]?.summary.toLowerCase()).not.toContain("account holder confirmed");

    // 2. Unauthenticated spoof on a registered domain (DMARC fail): yields neither verified_sender nor sender_not_registered.
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

    // 3. Non-claiming third-party mail (and negative-only logo judgement without textual claim): zero findings.
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

  it("attributes bank accounts to the matching business when multiple businesses are claimed and marks ambiguous accounts unavailable without emitting trust.bank_mismatch", async () => {
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

  it("fails the leak detector immediately when a registered domain, address, finance contact, or account fragment is planted", () => {
    const cleanItems: EvidenceDraft[] = [
      {
        check: "trust.bank_mismatch",
        severity: "critical",
        summary: "These bank details are not the ones Fynbos Freight registered with IsItLegit.",
        detail: { checked: true, business: "Fynbos Freight", matched: false },
        artefacts: ["raw/case-1/message.eml"],
      },
    ];
    const cleanOutcomes: CheckOutcome[] = [
      {
        check: "trust.bank_mismatch",
        outcome: "ran",
        reason: null,
        findings: 1,
        summary: "These bank details are not the ones Fynbos Freight registered with IsItLegit.",
      },
    ];
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
            ...cleanItems[0]!,
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
        [{ ...cleanItems[0]!, summary: `Expected mail from ${FYNBOS_EXTRA_ADDRESS}` }],
        cleanOutcomes,
        secrets,
      ),
    ).toThrow(/registered address/);

    // Planted finance contact in check outcome summary:
    expect(() =>
      assertNoRegistryLeak(
        cleanItems,
        [{ ...cleanOutcomes[0]!, summary: `Contact ${FYNBOS_FINANCE_CONTACT}` }],
        secrets,
      ),
    ).toThrow(/finance contact/);

    // Planted account fragment ("ends 223") in summary:
    expect(() =>
      assertNoRegistryLeak(
        [{ ...cleanItems[0]!, summary: "Fynbos Freight's account ends 223" }],
        cleanOutcomes,
        secrets,
      ),
    ).toThrow(/account fragment/);
  });
});
