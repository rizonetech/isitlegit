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
import { readVisible, type Store } from "../intake/store";
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
  "changed banks",
  "changed bank",
  "change of bank",
  "new bank account",
  "updated account",
  "bank details have changed",
  "banking details have changed",
  "nuwe bankbesonderhede",
  "bankbesonderhede het verander",
  "nuwe bankrekening",
];

const unavailable = (reason: string, comparison: string, artefactKey: string): EvidenceDraft => ({
  check: "invoice.comparison_unavailable",
  severity: "info",
  summary: `A bank comparison could not run (${reason})`.slice(0, 200),
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
    const identity = await getIdentity(db, r.org_id).catch(() => null);
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
  const visible = input.visibleText?.toLowerCase() ?? null;
  const languageHit = visible !== null && CHANGE_PHRASES.some((p) => visible.includes(p));
  let firstSupplier: Supplier | null = null;
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
    if (supplier && !firstSupplier) firstSupplier = supplier;
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
  if (languageHit && input.readings.length > 0) {
    const first = input.readings[0] as Reading;
    items.push({
      check: "invoice.change_language",
      severity: "critical",
      summary:
        "This message says the supplier's bank details have changed. Confirm by phoning the supplier on the number in your records, never one from this email.".slice(
          0,
          200,
        ),
      detail: {
        attachment: first.artefactKey,
        amount_cents: first.fields.amount_cents,
        currency: first.fields.currency,
        account_last3: first.account ? first.account.number.slice(-3) : null,
        supplier_id: firstSupplier?.id ?? null,
        phone: firstSupplier?.phone ?? null,
      },
      artefacts: [first.artefactKey],
    });
  }
  return items;
}

// The case's visible text, for the language rule: what the member read, never a model's summary.
export async function visibleTextOf(store: Store, caseId: string): Promise<string | null> {
  return readVisible(store, caseId).catch(() => null);
}
