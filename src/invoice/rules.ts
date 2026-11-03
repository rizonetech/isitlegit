// The bank-change rules (D06 T01 §3; spec 4.5): deterministic comparisons of what §1 extracted against
// the tenant's supplier ledger and, for a protected supplier, the bank registry. Three findings are
// critical evidence (spec 4.5 line 168), so the deterministic floor caps the verdict whatever the model
// says: the account differs from the recorded one, the supplier's domain differs from the ledger, or the
// message says the bank has changed. A comparison that cannot run states itself
// `invoice.comparison_unavailable` with its reason kind: never a match, never a mismatch. The registry
// answers match or no match only, under its rate limit; no registered detail is ever read out. Each rule
// is gated on its own inputs, so an invoice with no usable account still gets its domain and language
// findings, and a sibling attachment's failure suppresses nothing here.
import { hasFeature } from "../auth/plans";
import type { EvidenceDraft } from "../checks/evidence";
import { readArtefact, type Store, visibleKey } from "../intake/store";
import { type BankKeys, matchBankAccount } from "../trust/bank";
import { IdentityRefused, KeyMismatch, MatchLimited, NoBaseline } from "../trust/errors";
import { getIdentity } from "../trust/identity";
import { SupplierAmbiguous } from "./errors";
import { scrub } from "./extract";
import { findSupplier, matchSupplierAccount, type Supplier, siteOf } from "./ledger";
import type { InvoiceFields } from "./schema";

export type Reading = {
  artefactKey: string;
  fields: InvoiceFields;
  account: { number: string; branchCode: string } | null;
};

export type RulesDeps = { db: D1Database; keys: BankKeys };

const CHANGE_PHRASES = [
  "new banking details",
  "new bank details",
  "changed banks",
  "changed bank",
  "change of bank",
  "new bank account",
  "updated bank account",
  "updated banking details",
  "updated bank details",
  "bank details have changed",
  "banking details have changed",
  "nuwe bankbesonderhede",
  "bankbesonderhede het verander",
  "nuwe bankrekening",
];

const NEGATED_OR_WARNING_PREFIX =
  /\b(?:not|never|no|haven't|hasn't|don't|cannot|can't|ignore|beware|scam|fraud|phishing|warning|caution|unchanged|nie|nooit|moenie|geen|bedrog|waarskuwing|onveranderd)\b/u;

const NEGATED_PREDICATE_SUFFIX =
  /^\s+(?:are|is|were|was|will|would|should|can|could|must|may|het|sal|moet)\s+(?:not|never|no|unchanged|nie|nooit|onveranderd)\b/u;

export function hasBankChangeLanguage(visibleText: string | null): boolean {
  if (!visibleText) return false;
  const subclauses = visibleText.toLowerCase().split(/[.!?;:,\r\n]+|\b(?:and|but|so|while|or|en|maar|of)\b/u);
  return subclauses.some((sub) =>
    CHANGE_PHRASES.some((phrase) => {
      const idx = sub.indexOf(phrase);
      if (idx === -1) return false;
      const before = sub.slice(0, idx);
      const after = sub.slice(idx + phrase.length);
      return !NEGATED_OR_WARNING_PREFIX.test(before) && !NEGATED_PREDICATE_SUFFIX.test(after);
    }),
  );
}

function unavailableSummary(reason: string, comparison: string): string {
  const source = comparison === "registry" ? "registered-account" : "supplier-ledger";
  if (reason === "no-baseline") {
    return `The ${source} bank comparison could not run because no recorded account is on file yet; confirm payment details by phoning the supplier on a known number.`;
  }
  if (reason === "supplier-ambiguous") {
    return `The ${source} bank comparison could not run because more than one supplier record fits; confirm payment details by phoning the supplier on a known number.`;
  }
  if (reason === "rate-limited") {
    return `The ${source} bank comparison is temporarily at its hourly limit and could not run; confirm payment details by phoning the supplier on a known number.`;
  }
  return `The ${source} bank comparison could not be read right now; confirm payment details by phoning the supplier on a known number.`;
}

const unavailable = (reason: string, comparison: string, artefactKey: string): EvidenceDraft => ({
  check: "invoice.comparison_unavailable",
  severity: "info",
  summary: unavailableSummary(reason, comparison).slice(0, 200),
  detail: { checked: false, reason, comparison, attachment: artefactKey },
  artefacts: [artefactKey],
});

const reasonOf = (error: unknown): string | null => {
  if (error instanceof NoBaseline) return "no-baseline";
  if (error instanceof KeyMismatch) return "keys";
  if (error instanceof MatchLimited) return "rate-limited";
  if (error instanceof SupplierAmbiguous) return "supplier-ambiguous";
  return null;
};

// The organisation protecting the supplier's domain, if any: a verified domain whose protected identity
// is on. The case's own organisation is not its own supplier.
async function protectedOrgOf(db: D1Database, caseOrgId: string, domain: string | null): Promise<string | null> {
  if (!domain) return null;
  const site = siteOf(domain);
  const rows = await db
    .prepare("SELECT DISTINCT org_id FROM org_domains WHERE state = 'verified' AND (domain = ? OR domain = ?)")
    .bind(domain, site)
    .all<{ org_id: string }>();
  for (const r of rows.results) {
    if (r.org_id === caseOrgId) continue;
    const identity = await getIdentity(db, r.org_id);
    if (identity?.effective.on) return r.org_id;
  }
  return null;
}

export async function invoiceRules(
  deps: RulesDeps,
  input: { caseId: string; orgId: string; readings: Reading[]; visibleText: string | null },
): Promise<EvidenceDraft[]> {
  const { db, keys } = deps;
  if (!(await hasFeature(db, input.orgId, "bank-change"))) return [];
  const items: EvidenceDraft[] = [];
  const languageHit = hasBankChangeLanguage(input.visibleText);
  const invoiceReadings: { reading: Reading; supplier: Supplier | null }[] = [];
  for (const reading of input.readings) {
    const { fields, account, artefactKey } = reading;
    if (!fields.is_invoice) continue;
    const base = {
      attachment: artefactKey,
      amount_cents: fields.amount_cents,
      currency: fields.currency,
      account_last3: account ? account.number.slice(-3) : null,
    };
    let supplier: Supplier | null = null;
    try {
      supplier = await findSupplier(db, input.orgId, { name: fields.supplier_name, domain: fields.supplier_domain });
      // The printed name ("Karoo Parts (Pty) Ltd") routinely differs from the ledger's ("Karoo Parts"),
      // and findSupplier will not guess past that: the domain is the stronger key, so it decides alone
      // when the name narrowed the domain's suppliers to none.
      if (!supplier && fields.supplier_domain)
        supplier = await findSupplier(db, input.orgId, { domain: fields.supplier_domain });
    } catch (error) {
      const reason = reasonOf(error);
      if (reason === null) throw error;
      items.push(unavailable(reason, "ledger", artefactKey));
    }
    invoiceReadings.push({ reading, supplier });
    if (supplier && account) {
      try {
        const { match } = await matchSupplierAccount(db, keys, input.orgId, supplier.id, account);
        if (!match)
          items.push({
            check: "invoice.bank_changed",
            severity: "critical",
            summary:
              "Invoice bank details differ from the supplier's recorded account. Confirm by phoning the supplier on the number in your records, never one from this email.".slice(
                0,
                200,
              ),
            detail: { ...base, against: "ledger", supplier_id: supplier.id, phone: supplier.phone },
            artefacts: [artefactKey],
          });
      } catch (error) {
        const reason = reasonOf(error);
        if (reason === null) throw error;
        items.push(unavailable(reason, "ledger", artefactKey));
      }
    }
    if (supplier && fields.supplier_domain) {
      const sites = supplier.domains.map((d) => siteOf(d));
      if (!sites.includes(siteOf(fields.supplier_domain)))
        items.push({
          check: "invoice.supplier_domain_changed",
          severity: "critical",
          summary:
            "The invoice comes from a domain the supplier has not used before. Confirm by phoning the supplier on the number in your records, never one from this email.".slice(
              0,
              200,
            ),
          detail: {
            ...base,
            supplier_id: supplier.id,
            domain: scrub(fields.supplier_domain, fields),
            phone: supplier.phone,
          },
          artefacts: [artefactKey],
        });
    }
    if (account) {
      const protectedOrgId = await protectedOrgOf(db, input.orgId, fields.supplier_domain);
      if (protectedOrgId) {
        try {
          const { match } = await matchBankAccount(db, keys, { orgId: input.orgId }, protectedOrgId, account);
          if (!match)
            items.push({
              check: "invoice.bank_changed",
              severity: "critical",
              summary:
                "Invoice bank details do not match the supplier's registered account. Confirm by phoning the supplier on the number in your records, never one from this email.".slice(
                  0,
                  200,
                ),
              detail: {
                ...base,
                against: "registry",
                supplier_id: supplier?.id ?? null,
                phone: supplier?.phone ?? null,
                protected_org_id: protectedOrgId,
                registry_match: false,
              },
              artefacts: [artefactKey],
            });
        } catch (error) {
          if (error instanceof IdentityRefused) {
            // The identity went off between the lookup and the comparison: not a protected supplier.
          } else {
            const reason = reasonOf(error);
            if (reason === null) throw error;
            items.push(unavailable(reason, "registry", artefactKey));
          }
        }
      }
    }
  }
  if (languageHit) {
    for (const { reading, supplier } of invoiceReadings) {
      items.push({
        check: "invoice.change_language",
        severity: "critical",
        summary:
          "This message says the supplier's bank details have changed. Confirm by phoning the supplier on the number in your records, never one from this email.".slice(
            0,
            200,
          ),
        detail: {
          attachment: reading.artefactKey,
          amount_cents: reading.fields.amount_cents,
          currency: reading.fields.currency,
          account_last3: reading.account ? reading.account.number.slice(-3) : null,
          supplier_id: supplier?.id ?? null,
          phone: supplier?.phone ?? null,
        },
        artefacts: [reading.artefactKey],
      });
    }
  }
  return items;
}

// The case's visible text, for the language rule: what the member read, never a model's summary.
export async function visibleTextOf(store: Store, caseId: string): Promise<string | null> {
  const read = await readArtefact(store, caseId, visibleKey(caseId));
  if (!read) return null;
  if ("missing" in read) throw new Error(`visible text artefact ${visibleKey(caseId)} is missing from storage`);
  return new TextDecoder().decode(read.body);
}
