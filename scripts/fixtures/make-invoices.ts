// The synthetic invoice set (D06 T01 §5): three fictional suppliers, each with a genuine invoice and
// three tampered twins (changed account, changed domain, change-of-bank letter), generated as PDFs so
// tests and the demo never use real documents. Reuses the small PDF writer of D06 T02 §1
// (test/invoice/pdf-writer.ts); every document stamps SYNTHETIC TEST DOCUMENT. No network.
//
//   node scripts/fixtures/make-invoices.ts
//
// Writes test/fixtures/invoices/*.pdf and labels.json (temp file in the destination, then rename).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPdf, contentOf, type TextLine } from "../../test/invoice/pdf-writer.ts";

const OUT = join(import.meta.dirname, "../../test/fixtures/invoices");

type Supplier = {
  slug: string;
  name: string;
  domain: string;
  tamperedDomain: string;
  phone: string;
  bank: string;
  holder: string;
  account: string;
  tamperedAccount: string;
  branch: string;
  amount: string;
  amountCents: number;
  reference: string;
};

export const SUPPLIERS: Supplier[] = [
  {
    slug: "hadeda-couriers",
    name: "Hadeda Couriers (Pty) Ltd",
    domain: "hadedacouriers.co.za",
    tamperedDomain: "hadeda-couriers.co.za",
    phone: "+27 11 555 0199",
    bank: "Kestrel Bank (fictional)",
    holder: "Hadeda Couriers (Pty) Ltd",
    account: "62004417731",
    tamperedAccount: "62004417739",
    branch: "250655",
    amount: "R 4 100.00",
    amountCents: 410000,
    reference: "INV-1042",
  },
  {
    slug: "karoo-stationery",
    name: "Karoo Stationery (Pty) Ltd",
    domain: "karoostationery.co.za",
    tamperedDomain: "karoo-stationery.co.za",
    phone: "+27 21 555 0142",
    bank: "Kestrel Bank (fictional)",
    holder: "Karoo Stationery (Pty) Ltd",
    account: "10442238901",
    tamperedAccount: "10442238908",
    branch: "250655",
    amount: "R 12 345.67",
    amountCents: 1234567,
    reference: "INV-2207",
  },
  {
    slug: "fynbos-cleaning",
    name: "Fynbos Cleaning (Pty) Ltd",
    domain: "fynboscleaning.co.za",
    tamperedDomain: "fynbos-cleaning.co.za",
    phone: "+27 21 555 0177",
    bank: "Kestrel Bank (fictional)",
    holder: "Fynbos Cleaning (Pty) Ltd",
    account: "40881123567",
    tamperedAccount: "40881123561",
    branch: "250655",
    amount: "R 890.50",
    amountCents: 89050,
    reference: "INV-3310",
  },
];

const LETTER_MESSAGE = "Good day, please note we have new banking details from this month. The invoice is attached.";

function lines(s: Supplier, kind: "genuine" | "account" | "domain" | "letter"): string[] {
  const account = kind === "account" ? s.tamperedAccount : s.account;
  const domain = kind === "domain" ? s.tamperedDomain : s.domain;
  const out = [
    "SYNTHETIC TEST DOCUMENT",
    "Tax Invoice",
    `Supplier: ${s.name}`,
    `Domain: ${domain}`,
    `Bank: ${s.bank}`,
    `Account holder: ${s.holder}`,
    `Account number: ${account}`,
    `Branch code: ${s.branch}`,
    `Amount due: ${s.amount}`,
    "Currency: ZAR",
    `Reference: ${s.reference}`,
    "Due date: 2026-11-30",
  ];
  if (kind === "letter") out.push("Please see the accompanying message about our banking details.");
  return out;
}

async function pdfOf(textLines: string[]): Promise<Uint8Array> {
  const text: TextLine[] = textLines.map((text, i) => ({
    font: "F1",
    size: 11,
    x: 72,
    y: 740 - i * 22,
    text,
  }));
  return buildPdf({
    root: 1,
    size: 6,
    objects: {
      1: "<</Type /Catalog /Pages 2 0 R>>",
      2: "<</Type /Pages /Kids [3 0 R] /Count 1>>",
      3: "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>",
      4: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
      5: { dict: "<</Length 0>>", stream: contentOf(text), compress: true },
    },
  });
}

function save(name: string, bytes: Uint8Array | string) {
  const tmp = join(OUT, `.${name}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(OUT, name));
}

const KINDS = [
  { kind: "genuine", expected: [] as string[] },
  { kind: "account", expected: ["invoice.bank_changed"] },
  { kind: "domain", expected: ["invoice.supplier_domain_changed"] },
  { kind: "letter", expected: ["invoice.change_language"] },
] as const;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const labels: unknown[] = [];
  for (const s of SUPPLIERS) {
    for (const { kind, expected } of KINDS) {
      const file = `${s.slug}-${kind}.pdf`;
      save(file, await pdfOf(lines(s, kind)));
      labels.push({
        file,
        kind,
        supplier: {
          name: s.name,
          domain: s.domain,
          phone: s.phone,
          bank: s.bank,
          holder: s.holder,
          account: s.account,
          branch: s.branch,
        },
        expected: [...expected],
        message: kind === "letter" ? LETTER_MESSAGE : "Invoice attached, please pay.",
        fields: {
          is_invoice: true,
          supplier_name: s.name,
          supplier_domain: kind === "domain" ? s.tamperedDomain : s.domain,
          bank_name: s.bank,
          account_holder: s.holder,
          account_number: kind === "account" ? s.tamperedAccount : s.account,
          branch_code: s.branch,
          amount_cents: s.amountCents,
          currency: "ZAR",
          reference: s.reference,
          due_date: "2026-11-30",
        },
      });
    }
  }
  save("labels.json", `${JSON.stringify({ suppliers: SUPPLIERS.map((s) => s.slug), files: labels }, null, 2)}\n`);
  console.log(`wrote 12 PDFs and labels.json to ${OUT}`);
}

if (import.meta.main) await main();
