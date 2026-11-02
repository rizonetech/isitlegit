// The fixture adapter (D06 T01 §5): a synthetic invoice PDF decoded with the production text reader
// (pdfText, the same text the invoice step sends with the file) and parsed into the §1 schema's
// InvoiceFields, so a printed change in the PDF changes what the rules judge. A missing field fails.
import { pdfText } from "../../src/checks/pdf-text";
import type { Reading } from "../../src/invoice/rules";
import { InvoiceFields } from "../../src/invoice/schema";

const need = (text: string, label: string): string => {
  const line = text.split("\n").find((l) => l.trim().startsWith(`${label}:`));
  const value = line?.slice(line.indexOf(":") + 1).trim();
  if (!value) throw new Error(`fixture is missing ${label}`);
  return value;
};

export async function readingOf(bytes: Uint8Array, artefactKey: string): Promise<Reading> {
  const { text } = await pdfText(bytes);
  if (!text.includes("SYNTHETIC TEST DOCUMENT")) throw new Error("fixture is not stamped synthetic");
  const amount = need(text, "Amount due").replace(/^R\s*/, "").replace(/\s/g, "");
  const fields = InvoiceFields.parse({
    is_invoice: true,
    supplier_name: need(text, "Supplier"),
    supplier_domain: need(text, "Domain").toLowerCase(),
    bank_name: need(text, "Bank"),
    account_holder: need(text, "Account holder"),
    account_number: need(text, "Account number"),
    branch_code: need(text, "Branch code"),
    amount_cents: Math.round(Number(amount) * 100),
    currency: need(text, "Currency"),
    reference: need(text, "Reference"),
    due_date: need(text, "Due date"),
  });
  return {
    artefactKey,
    fields,
    account:
      fields.account_number && fields.branch_code
        ? { number: fields.account_number, branchCode: fields.branch_code }
        : null,
  };
}
