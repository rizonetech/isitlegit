// The bank-change rules (D06 T01 §3; spec 4.5): the genuine and tampered pair against the ledger and the
// registry, every finding critical and correlated to its document and supplier, a comparison that cannot
// run stated as its own outcome, and no full account number anywhere in the evidence.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fixedActionsFor } from "../../src/agent/loop";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import type { Evidence } from "../../src/checks/evidence";
import { ulid } from "../../src/db/ulid";
import { putVisible, type Store, visibleKey } from "../../src/intake/store";
import { bankChangeAction, fixedActionOf } from "../../src/invoice/fixed-actions";
import { addSupplier, addSupplierAccount } from "../../src/invoice/ledger";
import { invoiceRules, type Reading, visibleTextOf } from "../../src/invoice/rules";
import { InvoiceFields } from "../../src/invoice/schema";
import { buildReply } from "../../src/mail/reply";
import { addAccount, bankKeys, MATCHES_PER_HOUR, matchBankAccount } from "../../src/trust/bank";
import { setIdentity } from "../../src/trust/identity";
import LABELS from "../fixtures/invoices/labels.json";
import { invoicePdfs } from "../fixtures/invoices/load";
import { makeOrg, protectableOrg } from "../trust/helpers";
import { readingOf } from "./invoice-fixture";

const db = env.DB;
const keys = () => bankKeys(env);
const NUMBER = "06200441773";
const TAMPERED = "06200441774";

const fields = (over: Partial<InvoiceFields> = {}): InvoiceFields =>
  InvoiceFields.parse({
    is_invoice: true,
    supplier_name: "Karoo Parts",
    supplier_domain: "karooparts.co.za",
    bank_name: "Kestrel Bank (fictional)",
    account_holder: "Karoo Parts (Pty) Ltd",
    account_number: NUMBER,
    branch_code: "250655",
    amount_cents: 123456,
    currency: "ZAR",
    reference: "INV-1042",
    due_date: "2026-11-30",
    ...over,
  });
const reading = (over: Partial<InvoiceFields> = {}, artefactKey = "cases/c/invoice.pdf"): Reading => {
  const f = fields(over);
  return {
    artefactKey,
    fields: f,
    account: f.account_number && f.branch_code ? { number: f.account_number, branchCode: f.branch_code } : null,
  };
};

beforeEach(async () => {
  await db.batch(
    [
      "case_invoice_accounts",
      "supplier_accounts",
      "suppliers",
      "bank_accounts",
      "bank_key_epoch",
      "trust_events",
      "identities",
      "org_domains",
      "org_addresses",
      "bank_match_counts",
      "cases",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

async function ledgerSupplier(org: string, withAccount = true) {
  const { id } = await addSupplier(db, org, "owner", {
    name: "Karoo Parts",
    domains: ["karooparts.co.za"],
    phone: "+27 21 555 0100",
    notes: null,
  });
  if (withAccount)
    await addSupplierAccount(db, await keys(), org, "owner", id, {
      number: NUMBER,
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
  return id;
}

const run = async (org: string, readings: Reading[], visibleText: string | null = "Invoice attached, please pay.") =>
  invoiceRules({ db, keys: await keys() }, { caseId: "01HZRULESCASE00000000000A", orgId: org, readings, visibleText });

describe("the bank-change rules", () => {
  it("finds nothing on the genuine invoice and the change on its tampered twin", async () => {
    const org = await makeOrg();
    const supplierId = await ledgerSupplier(org);
    expect(await run(org, [reading()])).toEqual([]);
    const items = await run(org, [reading({ account_number: TAMPERED })]);
    expect(items.map((i) => [i.check, i.severity])).toEqual([["invoice.bank_changed", "critical"]]);
    expect(items[0]?.detail).toMatchObject({
      against: "ledger",
      supplier_id: supplierId,
      phone: "+27 21 555 0100",
      attachment: "cases/c/invoice.pdf",
      amount_cents: 123456,
      account_last3: "774",
    });
    expect(JSON.stringify(items)).not.toContain(TAMPERED);
    expect(items[0]?.summary).toContain("phoning the supplier");
    const evidence: Evidence[] = items.map((item, idx) => ({ id: `E${idx + 1}`, ...item }));
    const actions = fixedActionsFor(evidence);
    expect(actions).toEqual([bankChangeAction("+27 21 555 0100")]);
    expect(fixedActionOf(actions[0] ?? "")).toBe("bank-change");
    const rules = ruleVerdict(evidence, { headersAvailable: true });
    const reply = buildReply({
      parentSubject: "Fwd: Invoice INV-1042",
      headersAvailable: true,
      otherOriginals: 0,
      reportUrl: "https://isitlegit.test/r/01HZRULESCASE00000000000A?o=org&e=1&s=sig",
      design: { appUrl: "https://isitlegit.test", evidence },
      report: {
        status: "ready",
        view: {
          ...rules,
          actions: [...actions, ...rules.actions.filter((a) => !actions.includes(a))],
          meaning: null,
          source: "rules",
          floorApplied: null,
          ablated: null,
        },
      },
    });
    expect(reply.text).toContain(bankChangeAction("+27 21 555 0100"));
    expect(reply.html).toContain("+27 21 555 0100");
  });

  it("resolves the supplier by domain when the printed name differs from the ledger's", async () => {
    const org = await makeOrg();
    await ledgerSupplier(org);
    const items = await run(org, [reading({ supplier_name: "Karoo Parts (Pty) Ltd", account_number: TAMPERED })]);
    expect(items.map((i) => i.check)).toEqual(["invoice.bank_changed"]);
  });

  it("states a changed domain and change language as critical, each on its own inputs", async () => {
    const org = await makeOrg();
    await ledgerSupplier(org);
    const domain = await run(org, [reading({ supplier_domain: "karoo-parts.example" })]);
    expect(domain.map((i) => i.check)).toEqual(["invoice.supplier_domain_changed"]);
    expect(domain[0]?.severity).toBe("critical");
    const language = await run(org, [reading()], "Please note we have new banking details from this month.");
    expect(language.map((i) => i.check)).toEqual(["invoice.change_language"]);
    const afrikaans = await run(org, [reading()], "Neem kennis: nuwe bankbesonderhede volg.");
    expect(afrikaans.map((i) => i.check)).toEqual(["invoice.change_language"]);
    // Negated statements, fraud-warning footers, and non-banking account updates do not trigger change-language.
    expect(await run(org, [reading()], "Please note we have not changed banks this year.")).toEqual([]);
    expect(
      await run(org, [reading()], "Warning: never accept new banking details by email without calling us."),
    ).toEqual([]);
    expect(await run(org, [reading()], "Ons het nie nuwe bankbesonderhede nie.")).toEqual([]);
    expect(await run(org, [reading()], "We have updated account contact information.")).toEqual([]);
    // An affirmative bank-change request paired with a negation of the old account, "change of bank", or fraud context still triggers.
    const withOldAccountNegation = await run(
      org,
      [reading()],
      "Please use our new banking details and do not use the old account.",
    );
    expect(withOldAccountNegation.map((i) => i.check)).toEqual(["invoice.change_language"]);
    const changeOfBank = await run(org, [reading()], "Please note our change of bank effective today.");
    expect(changeOfBank.map((i) => i.check)).toEqual(["invoice.change_language"]);
    const preventFraud = await run(org, [reading()], "To prevent fraud please use our new banking details.");
    expect(preventFraud.map((i) => i.check)).toEqual(["invoice.change_language"]);
    // Linear-time boundary check over large body text with repeated negated phrases.
    const t0 = performance.now();
    expect(await run(org, [reading()], `${"a".repeat(100_000)}. never accept new banking details`)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("binds change-language findings to invoice attachments and each invoice's own supplier", async () => {
    const org = await makeOrg();
    const karoo = await ledgerSupplier(org);
    const { id: hadeda } = await addSupplier(db, org, "owner", {
      name: "Hadeda Couriers",
      domains: ["hadeda.example"],
      phone: "+27 11 555 0199",
      notes: null,
    });
    await addSupplierAccount(db, await keys(), org, "owner", hadeda, {
      number: "62004417731",
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Hadeda Couriers (Pty) Ltd",
    });
    // Non-invoice-only mail receives no invoice change-language finding.
    const nonInvoice = reading({ is_invoice: false }, "cases/c/brochure.pdf");
    expect(await run(org, [nonInvoice], "Please note we have new banking details.")).toEqual([]);
    // Non-invoice first attachment followed by an invoice attributes the finding to the invoice and its supplier.
    const mixed = await run(
      org,
      [nonInvoice, reading({}, "cases/c/karoo.pdf")],
      "Please note we have new banking details.",
    );
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({
      check: "invoice.change_language",
      artefacts: ["cases/c/karoo.pdf"],
      detail: { attachment: "cases/c/karoo.pdf", supplier_id: karoo, phone: "+27 21 555 0100" },
    });
    // Two invoice attachments from different suppliers bind each finding to its own document, supplier and phone.
    const twoInvoices = await run(
      org,
      [
        reading({}, "cases/c/karoo.pdf"),
        reading(
          {
            supplier_name: "Hadeda Couriers",
            supplier_domain: "hadeda.example",
            account_number: "62004417731",
          },
          "cases/c/hadeda.pdf",
        ),
      ],
      "Please note we have new banking details.",
    );
    expect(twoInvoices.map((i) => [i.detail.attachment, i.detail.supplier_id, i.detail.phone])).toEqual([
      ["cases/c/karoo.pdf", karoo, "+27 21 555 0100"],
      ["cases/c/hadeda.pdf", hadeda, "+27 11 555 0199"],
    ]);
  });

  it("runs the domain and language rules for an invoice with no usable account", async () => {
    const org = await makeOrg();
    await ledgerSupplier(org);
    const items = await run(
      org,
      [reading({ account_number: null, branch_code: null, supplier_domain: "karoo-parts.example" })],
      "Our bank details have changed.",
    );
    expect(items.map((i) => i.check).sort()).toEqual(["invoice.change_language", "invoice.supplier_domain_changed"]);
  });

  it("states a comparison that cannot run across all refusal kinds with plain member-facing summaries", async () => {
    const org = await makeOrg();
    await ledgerSupplier(org, false);
    const noBaseline = await run(org, [reading()]);
    expect(noBaseline.map((i) => [i.check, i.detail.reason, i.detail.comparison])).toEqual([
      ["invoice.comparison_unavailable", "no-baseline", "ledger"],
    ]);
    expect(noBaseline[0]?.summary).toContain("no recorded account is on file");
    expect(noBaseline[0]?.summary).not.toContain("no-baseline");

    // Ambiguous supplier in the ledger: two suppliers share the same domain.
    const orgAmbiguous = await makeOrg();
    await addSupplier(db, orgAmbiguous, "owner", {
      name: "Karoo North",
      domains: ["karooparts.co.za"],
      phone: null,
      notes: null,
    });
    await addSupplier(db, orgAmbiguous, "owner", {
      name: "Karoo South",
      domains: ["karooparts.co.za"],
      phone: null,
      notes: null,
    });
    const ambiguous = await run(orgAmbiguous, [reading({ supplier_name: "Karoo Group" })]);
    expect(ambiguous.map((i) => [i.check, i.detail.reason, i.detail.comparison])).toEqual([
      ["invoice.comparison_unavailable", "supplier-ambiguous", "ledger"],
    ]);
    expect(ambiguous[0]?.summary).toContain("more than one supplier record fits");
    expect(ambiguous[0]?.summary).not.toContain("supplier-ambiguous");

    // Key mismatch on ledger and registry comparisons, plus registry rate-limiting.
    const orgKeys = await makeOrg();
    await ledgerSupplier(orgKeys, true);
    const protectedOrg = await protectableOrg("karooparts.co.za", "money@karooparts.co.za");
    await setIdentity(db, protectedOrg, "owner", {
      displayNames: ["Karoo Parts"],
      financeContact: "money@karooparts.co.za",
      protected: true,
    });
    await addAccount(db, await keys(), protectedOrg, "owner", {
      number: NUMBER,
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
    const otherKeys = await bankKeys({
      BANK_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      BANK_MATCH_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(8))),
    });
    const keyRefused = await invoiceRules(
      { db, keys: otherKeys },
      {
        caseId: "01HZRULESCASE00000000000B",
        orgId: orgKeys,
        readings: [reading()],
        visibleText: "Invoice attached.",
      },
    );
    expect(keyRefused.map((i) => [i.check, i.detail.reason, i.detail.comparison])).toEqual([
      ["invoice.comparison_unavailable", "keys", "ledger"],
      ["invoice.comparison_unavailable", "keys", "registry"],
    ]);
    expect(keyRefused[0]?.summary).not.toContain("(keys)");

    // Exhaust the hourly registry rate limit for orgKeys and verify rate-limited is stated on the registry comparison.
    for (let i = 0; i < MATCHES_PER_HOUR; i++) {
      await matchBankAccount(db, await keys(), { orgId: orgKeys }, protectedOrg, {
        number: NUMBER,
        branchCode: "250655",
      });
    }
    const rateLimited = await run(orgKeys, [reading()]);
    expect(rateLimited.map((i) => [i.check, i.detail.reason, i.detail.comparison])).toEqual([
      ["invoice.comparison_unavailable", "rate-limited", "registry"],
    ]);
    expect(rateLimited[0]?.summary).toContain("hourly limit");
    expect(rateLimited[0]?.summary).not.toContain("rate-limited");
  });

  it("propagates identity and visible-text storage failures instead of silently dropping coverage", async () => {
    const org = await makeOrg();
    const protectedOrg = await protectableOrg("karooparts.co.za", "money@karooparts.co.za");
    await setIdentity(db, protectedOrg, "owner", {
      displayNames: ["Karoo Parts"],
      financeContact: "money@karooparts.co.za",
      protected: true,
    });
    const failingIdentityDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM identities")) {
              throw new Error("identities table unavailable");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      invoiceRules(
        { db: failingIdentityDb, keys: await keys() },
        {
          caseId: "01HZRULESCASE00000000000I",
          orgId: org,
          readings: [reading({ account_number: TAMPERED })],
          visibleText: "Invoice attached.",
        },
      ),
    ).rejects.toThrow(/identities table unavailable/);

    const store: Store = { db, bucket: env.ARTEFACTS };
    const caseId = ulid();
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, created_at, updated_at) VALUES (?, ?, 'email', 'running', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')",
      )
      .bind(caseId, org)
      .run();
    await putVisible(store, caseId, "Please note we have new banking details.");
    await env.ARTEFACTS.delete(visibleKey(caseId));
    await expect(visibleTextOf(store, caseId)).rejects.toThrow(/missing from storage/);
  });

  it("compares against the registry and ledger independently in both mismatch directions and carries the closed-loop trigger", async () => {
    const org = await makeOrg();
    const supplierId = await ledgerSupplier(org, false);
    // Seed the ledger with TAMPERED so when the invoice carries TAMPERED, the ledger matches while the registry mismatches.
    await addSupplierAccount(db, await keys(), org, "owner", supplierId, {
      number: TAMPERED,
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
    const protectedOrg = await protectableOrg("karooparts.co.za", "money@karooparts.co.za");
    await setIdentity(db, protectedOrg, "owner", {
      displayNames: ["Karoo Parts"],
      financeContact: "money@karooparts.co.za",
      protected: true,
    });
    await addAccount(db, await keys(), protectedOrg, "owner", {
      number: NUMBER,
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
    const registryOnly = await run(org, [reading({ account_number: TAMPERED })]);
    expect(registryOnly.map((i) => [i.check, i.detail.against])).toEqual([["invoice.bank_changed", "registry"]]);
    expect(registryOnly[0]?.detail).toMatchObject({
      protected_org_id: protectedOrg,
      registry_match: false,
      supplier_id: supplierId,
    });
    expect(JSON.stringify(registryOnly)).not.toContain(TAMPERED);

    // Opposite direction: invoice carries NUMBER (matches registry, mismatches ledger's TAMPERED).
    const ledgerOnly = await run(org, [reading({ account_number: NUMBER })]);
    expect(ledgerOnly.map((i) => [i.check, i.detail.against])).toEqual([["invoice.bank_changed", "ledger"]]);

    // When the ledger also has NUMBER, the genuine number matches both baselines: no finding at all.
    await addSupplierAccount(db, await keys(), org, "owner", supplierId, {
      number: NUMBER,
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
    expect(await run(org, [reading()])).toEqual([]);
  });

  it("applies the rules only for an organisation entitled to bank-change", async () => {
    const org = await makeOrg();
    await ledgerSupplier(org);
    expect((await run(org, [reading({ account_number: TAMPERED })])).map((i) => i.check)).toEqual([
      "invoice.bank_changed",
    ]);
    const aged = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await db.prepare('UPDATE "organization" SET "createdAt" = ? WHERE id = ?').bind(aged, org).run();
    expect(await run(org, [reading({ account_number: TAMPERED })])).toEqual([]);
  });

  it("keeps two suppliers' findings apart", async () => {
    const org = await makeOrg();
    const karoo = await ledgerSupplier(org);
    const { id: hadeda } = await addSupplier(db, org, "owner", {
      name: "Hadeda Couriers",
      domains: ["hadeda.example"],
      phone: "+27 11 555 0199",
      notes: null,
    });
    await addSupplierAccount(db, await keys(), org, "owner", hadeda, {
      number: "62004417731",
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Hadeda Couriers (Pty) Ltd",
    });
    const items = await run(org, [
      reading({ account_number: TAMPERED }, "cases/c/a.pdf"),
      {
        artefactKey: "cases/c/b.pdf",
        fields: fields({
          supplier_name: "Hadeda Couriers",
          supplier_domain: "hadeda.example",
          account_number: "62004417739",
          reference: "INV-9",
        }),
        account: { number: "62004417739", branchCode: "250655" },
      },
    ]);
    const bySupplier = new Map(items.map((i) => [i.detail.attachment, i.detail.supplier_id]));
    expect(bySupplier.get("cases/c/a.pdf")).toBe(karoo);
    expect(bySupplier.get("cases/c/b.pdf")).toBe(hadeda);
    expect(items.every((i) => i.check === "invoice.bank_changed")).toBe(true);
  });

  it("judges the labelled synthetic set (§5) exactly as its labels say", async () => {
    const org = await makeOrg();
    for (const f of LABELS.files.filter((x) => x.kind === "genuine")) {
      const { id } = await addSupplier(db, org, "owner", {
        name: f.supplier.name,
        domains: [f.supplier.domain],
        phone: f.supplier.phone,
        notes: null,
      });
      await addSupplierAccount(db, await keys(), org, "owner", id, {
        number: f.supplier.account,
        branchCode: f.supplier.branch,
        bankName: f.supplier.bank,
        holder: f.supplier.holder,
      });
    }
    for (const f of LABELS.files) {
      const reading = await readingOf(invoicePdfs[f.file] as Uint8Array, `cases/c/${f.file}`);
      const items = await run(org, [reading], f.message);
      expect(
        items.map((i) => i.check),
        f.file,
      ).toEqual(f.expected);
      expect(JSON.stringify(items)).not.toContain(f.supplier.account);
    }
    // The letter PDF alone, with a neutral message, yields no change-language finding: the rule
    // reads the case's visible text, as the invoice step passes it, not the PDF.
    const letter = LABELS.files.find((x) => x.kind === "letter") as (typeof LABELS.files)[number];
    const reading = await readingOf(invoicePdfs[letter.file] as Uint8Array, "cases/c/letter.pdf");
    expect((await run(org, [reading], "Invoice attached, please pay.")).map((i) => i.check)).toEqual([]);
  });
});
