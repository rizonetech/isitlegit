// What Muse Spark reads out of an invoice or payment request (D06 T01 §1; spec 4.5): whether the document is
// one, and the supplier, bank and payment fields. Written as `structured()` needs it (every property required,
// an absence a null), so Meta's strict schema subset takes it. Formats are strict and numbers stay strings, so
// leading zeros in an account number or branch code survive; the amount is integer cents, never a float.
// Extraction reports fields only: whether a field was edited is the deterministic forensics of D06 T02 §1,
// never the model's word (corrected 2026-10-31, D08 T03 §1).
import { z } from "zod";

const digits = (min: number, max: number) =>
  z
    .string()
    .regex(/^[\d -]+$/, "digits, spaces and dashes only")
    .refine((v) => {
      const n = v.replace(/[\s-]+/g, "").length;
      return n >= min && n <= max;
    }, `must hold ${min} to ${max} digits`);

export const InvoiceFields = z.strictObject({
  is_invoice: z.boolean(),
  supplier_name: z.string().min(1).max(120).nullable(),
  supplier_domain: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+$/, "a lowercase domain")
    .nullable(),
  bank_name: z.string().min(1).max(120).nullable(),
  account_holder: z.string().min(1).max(120).nullable(),
  // South African account numbers are 7 to 11 digits; branch codes exactly 6 (spec 4.5).
  account_number: digits(7, 11).nullable(),
  branch_code: digits(6, 6).nullable(),
  amount_cents: z.number().int().nonnegative().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "a three-letter currency code")
    .nullable(),
  reference: z.string().min(1).max(120).nullable(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "an ISO date")
    .nullable(),
});
export type InvoiceFields = z.infer<typeof InvoiceFields>;
