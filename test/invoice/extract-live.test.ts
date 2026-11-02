import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { extractInvoiceFields } from "../../src/invoice/extract";
import { generated } from "../fixtures/pdf-forensics/load";
import { allowance, RESULT } from "../walkthrough/allowance";

// D06 T01 §1 live: the extraction on the synthetic invoice documents already in the tree, against the
// values recorded in advance (docs/phase-runs/2026-10-31-trust-phase-6.md). Runs only with
// INVOICE_LIVE=1 and the keys scripts/invoice-live.ts passes, under the allowance it reserved.
const live = env as unknown as Record<string, string | undefined>;
const LIVE = live.INVOICE_LIVE === "1";

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

describe.skipIf(!LIVE)("invoice extraction live", () => {
  it("extracts the synthetic invoice and refuses the proofs of payment", { timeout: 300_000 }, async ({ task }) => {
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
    const run = async (name: string) => {
      const bytes = generated[name as keyof typeof generated];
      if (!bytes) throw new Error(`no fixture ${name}`);
      const at = Date.now();
      const got = await extractInvoiceFields({ pdfBase64: toBase64(bytes), filename: name }, ctx);
      docs.push({ name, fields: got.ok ? got.fields : { error: got.reason }, ms: Date.now() - at });
      return got;
    };
    const invoice = await run("chromium-invoice.pdf");
    const popA = await run("chromium-pop.pdf");
    const popB = await run("gs-genuine-pop.pdf");
    (task.meta as Record<string, unknown>)[RESULT] = { outcome: "invoice-live", attempts: budget.attempts(), docs };
    if (!invoice.ok) throw new Error(`invoice extraction failed: ${invoice.reason}`);
    expect(invoice.fields.is_invoice).toBe(true);
    expect(invoice.fields.supplier_name).toContain("Hadeda Couriers");
    expect(invoice.fields.account_number?.replace(/[\s-]+/g, "")).toBe("62004417731");
    expect(invoice.fields.branch_code?.replace(/[\s-]+/g, "")).toBe("250655");
    expect(invoice.fields.amount_cents).toBe(410000);
    expect(invoice.fields.currency).toBe("ZAR");
    expect(invoice.fields.reference).toBeNull();
    expect(invoice.fields.due_date).toBeNull();
    if (!popA.ok || !popB.ok) throw new Error("a proof of payment extraction failed outright");
    expect(popA.fields.is_invoice).toBe(false);
    expect(popB.fields.is_invoice).toBe(false);
  });
});
