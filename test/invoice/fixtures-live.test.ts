import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { extractInvoiceFields } from "../../src/invoice/extract";
import LABELS from "../fixtures/invoices/labels.json";
import { invoicePdfs } from "../fixtures/invoices/load";
import { allowance, RESULT } from "../walkthrough/allowance";

// D06 T01 §5 live: Muse Spark extraction over the 12 synthetic invoices, against the fields
// labels.json recorded when the set was generated. Runs only with INVOICE_LIVE=1 and the keys
// scripts/invoice-live.ts --fixtures passes, under the allowance it reserved. Cap stated before
// the run in the lane run file: US$1.25 for this set, inside the coordinator's US$10.00 envelope
// for the lane's live invoice work (D06 T01 §1 counted US$0.7077 of it).
const live = env as unknown as Record<string, string | undefined>;
const LIVE = live.INVOICE_LIVE === "1";

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const FIELDS = [
  "supplier_name",
  "supplier_domain",
  "bank_name",
  "account_holder",
  "account_number",
  "branch_code",
  "amount_cents",
  "currency",
  "reference",
  "due_date",
] as const;

describe.skipIf(!LIVE)("synthetic invoice extraction live (§5)", () => {
  it("extracts all 12 against their labels", { timeout: 300_000 }, async ({ task }) => {
    const budget = allowance(Number(live.INVOICE_ALLOWANCE_USD ?? "0"));
    const ctx = {
      env: {
        ...(live.INVOICE_META_API_KEY ? { META_API_KEY: live.INVOICE_META_API_KEY } : {}),
        ...(live.INVOICE_CF_AIG_TOKEN ? { CF_AIG_TOKEN: live.INVOICE_CF_AIG_TOKEN } : {}),
        ...(live.INVOICE_GATEWAY_URL ? { META_GATEWAY_URL: live.INVOICE_GATEWAY_URL } : {}),
      },
      budget,
      owner: { kind: "script" as const, name: "invoice-live" },
      waitUntil: () => {},
    };
    const docs: { name: string; fields: unknown; ms: number }[] = [];
    const exact: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    // The measurement is retained after every document, so a late failure keeps the completed
    // documents' results and the attempts spent (completion review, D06 T01 §5).
    const retain = () => {
      (task.meta as Record<string, unknown>)[RESULT] = {
        outcome: "invoice-fixtures-live",
        attempts: budget.attempts(),
        docs,
        exact,
        total: LABELS.files.length,
      };
      console.log(`fixtures-live exact of ${LABELS.files.length}: ${JSON.stringify(exact)}`);
    };
    const failures: string[] = [];
    for (const label of LABELS.files) {
      const bytes = invoicePdfs[label.file] as Uint8Array;
      const at = Date.now();
      const got = await extractInvoiceFields({ pdfBase64: toBase64(bytes), filename: label.file }, ctx);
      docs.push({ name: label.file, fields: got.ok ? got.fields : { error: got.reason }, ms: Date.now() - at });
      retain();
      if (!got.ok) {
        failures.push(`${label.file}: ${got.reason}`);
        continue;
      }
      if (!got.fields.is_invoice) failures.push(`${label.file}: not an invoice`);
      for (const f of FIELDS) {
        const want = label.fields[f];
        const have: unknown = got.fields[f];
        // A missing or truncated supplier name scores nothing: only the full printed name, or
        // that name without its " (Pty) Ltd" suffix, counts.
        const nameOk = have === want || (typeof have === "string" && have.length > 0 && want === `${have} (Pty) Ltd`);
        const same =
          f === "account_number" || f === "branch_code"
            ? String(have ?? "").replace(/[\s-]+/g, "") === String(want ?? "")
            : f === "supplier_name"
              ? nameOk
              : have === want;
        if (same) exact[f] = (exact[f] ?? 0) + 1;
      }
      // Threshold fields are exact or the set does not prove extraction.
      expect(got.fields.account_number?.replace(/[\s-]+/g, ""), label.file).toBe(label.fields.account_number);
      expect(got.fields.branch_code?.replace(/[\s-]+/g, ""), label.file).toBe(label.fields.branch_code);
      expect(got.fields.amount_cents, label.file).toBe(label.fields.amount_cents);
      retain();
    }
    expect(failures).toEqual([]);
  });
});
