// InvoiceFields (D06 T01 §1; spec 4.5): the shape Muse Spark's extraction must fit before anything uses it.
// Strict formats, honest missing values, and numbers kept as strings so leading zeros survive.
import { describe, expect, it } from "vitest";
import { InvoiceFields } from "../../src/invoice/schema";

const invoice = {
  is_invoice: true,
  supplier_name: "Karoo Parts (Pty) Ltd",
  supplier_domain: "karooparts.co.za",
  bank_name: "Kestrel Bank (fictional)",
  account_holder: "Karoo Parts (Pty) Ltd",
  account_number: "06200441773",
  branch_code: "250655",
  amount_cents: 123456,
  currency: "ZAR",
  reference: "INV-1042",
  due_date: "2026-11-30",
};

describe("InvoiceFields", () => {
  it("accepts a full invoice and preserves leading zeros", () => {
    const parsed = InvoiceFields.parse(invoice);
    expect(parsed.account_number).toBe("06200441773");
    expect(parsed.branch_code).toBe("250655");
    expect(parsed.amount_cents).toBe(123456);
  });

  it("accepts honest missing fields as null", () => {
    const parsed = InvoiceFields.parse({
      ...invoice,
      supplier_domain: null,
      reference: null,
      due_date: null,
    });
    expect(parsed.supplier_domain).toBeNull();
    expect(parsed.reference).toBeNull();
    expect(parsed.due_date).toBeNull();
  });

  it("accepts a document that is not an invoice", () => {
    const parsed = InvoiceFields.parse({
      is_invoice: false,
      supplier_name: null,
      supplier_domain: null,
      bank_name: null,
      account_holder: null,
      account_number: null,
      branch_code: null,
      amount_cents: null,
      currency: null,
      reference: null,
      due_date: null,
    });
    expect(parsed.is_invoice).toBe(false);
  });

  it.each([
    ["account number too short", { account_number: "123456" }],
    ["account number with letters", { account_number: "0620ABC1773" }],
    ["branch code not six digits", { branch_code: "25065" }],
    ["amount not integer cents", { amount_cents: 123.45 }],
    ["amount negative", { amount_cents: -1 }],
    ["currency not a three-letter code", { currency: "rand" }],
    ["currency not an ISO code", { currency: "ZZZ" }],
    ["due date not ISO", { due_date: "30 Nov 2026" }],
    ["due date that does not exist", { due_date: "2026-99-99" }],
    ["due date on a day the month lacks", { due_date: "2026-02-30" }],
    ["domain without a suffix", { supplier_domain: "." }],
    ["domain with an empty label", { supplier_domain: "karoo..co.za" }],
    ["an unnamed property", { edited: true }],
  ])("refuses %s", (_name, over) => {
    expect(() => InvoiceFields.parse({ ...invoice, ...over })).toThrow();
  });
});
