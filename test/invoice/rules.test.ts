// The bank-change rules (D06 T01 §3; spec 4.5): the genuine and tampered pair against the ledger and the
// registry, every finding critical and correlated to its document and supplier, a comparison that cannot
// run stated as its own outcome, and no full account number anywhere in the evidence.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fixedActionsFor } from "../../src/agent/loop";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import type { Evidence } from "../../src/checks/evidence";
import { bankChangeAction, fixedActionOf } from "../../src/invoice/fixed-actions";
import { addSupplier, addSupplierAccount } from "../../src/invoice/ledger";
import { invoiceRules, type Reading } from "../../src/invoice/rules";
import { InvoiceFields } from "../../src/invoice/schema";
import { buildReply } from "../../src/mail/reply";
import { addAccount, bankKeys } from "../../src/trust/bank";
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

  it("states a comparison that cannot run, never as a mismatch", async () => {
    const org = await makeOrg();
    await ledgerSupplier(org, false);
    const items = await run(org, [reading()]);
    expect(items.map((i) => [i.check, i.detail.reason, i.detail.comparison])).toEqual([
      ["invoice.comparison_unavailable", "no-baseline", "ledger"],
    ]);
  });

  it("compares against the registry for a protected supplier and carries the closed-loop trigger", async () => {
    const org = await makeOrg();
    const supplierId = await ledgerSupplier(org);
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
    // The ledger holds the tampered number too, so only the registry can disagree.
    const items = await invoiceRules(
      { db, keys: await keys() },
      {
        caseId: "01HZRULESCASE00000000000A",
        orgId: org,
        readings: [
          {
            artefactKey: "cases/c/invoice.pdf",
            fields: fields({ account_number: TAMPERED }),
            account: { number: TAMPERED, branchCode: "250655" },
          },
        ],
        visibleText: "Invoice attached.",
      },
    );
    const registry = items.filter((i) => i.detail.against === "registry");
    expect(registry.map((i) => i.check)).toEqual(["invoice.bank_changed"]);
    expect(registry[0]?.detail).toMatchObject({
      protected_org_id: protectedOrg,
      registry_match: false,
      supplier_id: supplierId,
    });
    expect(JSON.stringify(items)).not.toContain(TAMPERED);
    // The genuine number matches both baselines: no finding at all.
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
