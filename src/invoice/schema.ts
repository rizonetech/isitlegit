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

// The ISO 4217 alphabetic codes: a currency the list does not hold is not validated evidence, however
// well-formed its three letters look.
const CURRENCIES = new Set(
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLL SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL".split(
    " ",
  ),
);

const realDate = (v: string) => {
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (days[m - 1] ?? 0);
};

export const InvoiceFields = z.strictObject({
  is_invoice: z.boolean(),
  supplier_name: z.string().min(1).max(120).nullable(),
  supplier_domain: z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "a lowercase domain with a suffix")
    .nullable(),
  bank_name: z.string().min(1).max(120).nullable(),
  account_holder: z.string().min(1).max(120).nullable(),
  // South African account numbers are 7 to 11 digits; branch codes exactly 6 (spec 4.5).
  account_number: digits(7, 11).nullable(),
  branch_code: digits(6, 6).nullable(),
  amount_cents: z.number().int().nonnegative().nullable(),
  currency: z
    .string()
    .refine((v) => CURRENCIES.has(v), "an ISO 4217 currency code")
    .nullable(),
  reference: z.string().min(1).max(120).nullable(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "an ISO date")
    .refine(realDate, "a date that exists")
    .nullable(),
});
export type InvoiceFields = z.infer<typeof InvoiceFields>;
