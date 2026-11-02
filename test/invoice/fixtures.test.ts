// The synthetic invoice set (D06 T01 §5): exact corpus coverage, every PDF opens through the
// production reader, genuine readings equal their labels, and each tampered twin differs from its
// genuine twin in exactly the labelled field (the letter twin in its accompanying message only).
import { describe, expect, it } from "vitest";
import LABELS from "../fixtures/invoices/labels.json";
import { invoicePdfs } from "../fixtures/invoices/load";
import { readingOf } from "./invoice-fixture";

type Label = (typeof LABELS.files)[number];

const byFile = new Map<string, Label>(LABELS.files.map((f) => [f.file, f]));

describe("the synthetic invoice set", () => {
  it("holds exactly 3 genuine and 9 tampered PDFs from 3 distinct suppliers", () => {
    expect(Object.keys(invoicePdfs)).toHaveLength(12);
    expect(LABELS.files).toHaveLength(12);
    expect(new Set(LABELS.files.map((f) => f.supplier.name)).size).toBe(3);
    expect(LABELS.files.filter((f) => f.kind === "genuine")).toHaveLength(3);
    for (const kind of ["account", "domain", "letter"] as const)
      expect(LABELS.files.filter((f) => f.kind === kind)).toHaveLength(3);
    for (const f of LABELS.files) expect(invoicePdfs[f.file], f.file).toBeDefined();
    for (const name of Object.keys(invoicePdfs)) expect(byFile.has(name), name).toBe(true);
  });

  it("reads every PDF and matches its labelled fields", async () => {
    for (const f of LABELS.files) {
      const bytes = invoicePdfs[f.file] as Uint8Array;
      expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
      const reading = await readingOf(bytes, `cases/c/${f.file}`);
      expect(reading.fields, f.file).toEqual(f.fields);
    }
  });

  it("differs from the genuine twin in exactly the labelled field", async () => {
    for (const s of LABELS.suppliers) {
      const genuine = byFile.get(`${s}-genuine.pdf`) as Label;
      const genuineReading = await readingOf(invoicePdfs[genuine.file] as Uint8Array, "g");
      for (const kind of ["account", "domain", "letter"] as const) {
        const twin = byFile.get(`${s}-${kind}.pdf`) as Label;
        const twinReading = await readingOf(invoicePdfs[twin.file] as Uint8Array, "t");
        const diff = Object.keys(genuineReading.fields).filter(
          (k) =>
            JSON.stringify(genuineReading.fields[k as keyof typeof genuineReading.fields]) !==
            JSON.stringify(twinReading.fields[k as keyof typeof twinReading.fields]),
        );
        if (kind === "account") expect(diff, twin.file).toEqual(["account_number"]);
        else if (kind === "domain") expect(diff, twin.file).toEqual(["supplier_domain"]);
        else {
          expect(diff, twin.file).toEqual([]);
          expect(twin.message).not.toBe(genuine.message);
          expect(twin.expected).toEqual(["invoice.change_language"]);
        }
      }
    }
  });
});
