// Payment document extraction and layout comparison (D06 T02 §2; spec 4.5a): Muse Spark reads a
// proof of payment, bank letter or invoice on its own, and for a POP compares its layout and wording
// with a genuine sample from the same fictional bank. The model reads fields and layout only: a
// layout difference is worded as a difference for the member to confirm, never as an edit or
// tampering (D08 T03 §1); tamper evidence is the deterministic forensics of §1. The beneficiary is
// matched against the ledger and, for a protected supplier, the registry (match or no match only).
import { z } from "zod";
import type { EvidenceDraft } from "../checks/evidence.ts";
import { type StructuredContext, structured } from "../meta/structured.ts";
import { untrusted, untrustedInstructions } from "../meta/untrusted.ts";
import { type BankKeys, matchBankAccount } from "../trust/bank.ts";
import { IdentityRefused, KeyMismatch, MatchLimited, NoBaseline } from "../trust/errors.ts";
import { getIdentity } from "../trust/identity.ts";
import { SupplierAmbiguous } from "./errors.ts";
import { failureOf, INVOICE_CALL_MS, INVOICE_MODEL } from "./extract.ts";
import { findSupplier, matchSupplierAccount, type Supplier, siteOf } from "./ledger.ts";

const digits = (min: number, max: number) =>
  z
    .string()
    .max(max * 2 + 1)
    .regex(/^[\d -]+$/, "digits, spaces and dashes only")
    .refine((v) => {
      const n = v.replace(/[\s-]+/g, "").length;
      return n >= min && n <= max;
    }, `must hold ${min} to ${max} digits`);

const realDate = (v: string) => {
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (days[m - 1] ?? 0);
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "an ISO date")
  .refine(realDate, "a date that exists")
  .nullable();

export const PaymentDocument = z.strictObject({
  type: z.enum(["invoice", "pop", "bank_letter", "other"]),
  issuer: z.string().min(1).max(120).nullable(),
  amount_cents: z.number().int().nonnegative().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "an ISO 4217 alphabetic code")
    .nullable(),
  paid_at: isoDate,
  issued_at: isoDate,
  reference: z.string().min(1).max(120).nullable(),
  beneficiary: z.strictObject({
    name: z.string().min(1).max(120).nullable(),
    account_number: digits(7, 11).nullable(),
    branch_code: digits(6, 6).nullable(),
  }),
  layout_differences: z
    .array(z.enum(["logo", "layout", "wording", "amounts", "dates", "bank_details", "other"]))
    .max(20),
});
export type PaymentDocument = z.infer<typeof PaymentDocument>;

// Layout differences are structured aspects only, worded by code: model prose never reaches the
// evidence, so no difference can assert an edit, tampering or any other claim (D08 T03 §1).
export const LayoutAspect = z.enum(["logo", "layout", "wording", "amounts", "dates", "bank_details", "other"]);
export type LayoutAspect = z.infer<typeof LayoutAspect>;

export const ASPECT_WORDING: Record<LayoutAspect, string> = {
  logo: "The bank logo or its position differs from the genuine sample.",
  layout: "The document layout differs from the genuine sample.",
  wording: "The document wording differs from the genuine sample.",
  amounts: "The amounts are presented differently from the genuine sample.",
  dates: "The dates are presented differently from the genuine sample.",
  bank_details: "The bank details are presented differently from the genuine sample.",
  other: "Another part of the document differs from the genuine sample.",
};

export const LayoutComparison = z.strictObject({
  layout_differences: z.array(LayoutAspect).max(20),
});
export type LayoutComparison = z.infer<typeof LayoutComparison>;

export type DocInput =
  | { kind: "pdf"; pdfBase64: string; filename: string; documentText?: string }
  | { kind: "image"; imageDataUrl: string; filename: string; documentText?: string };

export type ExtractedDoc = { ok: true; fields: PaymentDocument } | { ok: false; reason: string; infra: boolean };

const TASK = [
  "You read one payment document (an invoice, a proof of payment, a bank confirmation letter, or another document) and return its fields as JSON.",
  "Report only what the document states. An absent or unreadable field is null. Never invent a value.",
  "layout_differences names only the aspects that differ from a genuine reference document (logo, layout, wording, amounts, dates, bank_details, other); it is empty unless a reference is given. Never claim the document was edited or tampered with.",
].join("\n");

type Content =
  | { type: "input_file"; filename: string; file_data: string }
  | { type: "input_image"; image_url: string; detail: "auto" }
  | { type: "input_text"; text: string };

function docContent(input: DocInput): Content[] {
  const out: Content[] =
    input.kind === "pdf"
      ? [
          {
            type: "input_file",
            filename: input.filename.slice(0, 200),
            file_data: `data:application/pdf;base64,${input.pdfBase64}`,
          },
        ]
      : [{ type: "input_image", image_url: input.imageDataUrl, detail: "auto" }];
  if (input.documentText !== undefined) out.push(untrusted("document-text", input.documentText, { limit: 20_000 }));
  return out;
}

export function paymentRequest(input: DocInput) {
  return {
    name: "payment_document",
    model: INVOICE_MODEL,
    instructions: TASK,
    max_output_tokens: 2_000,
    reasoning: { effort: "low" as const },
    input: [untrustedInstructions(), { role: "user" as const, content: docContent(input) }],
  };
}

export function comparisonRequest(input: DocInput, reference: DocInput) {
  return {
    name: "payment_layout",
    model: INVOICE_MODEL,
    instructions: TASK,
    max_output_tokens: 2_000,
    reasoning: { effort: "low" as const },
    input: [
      untrustedInstructions(),
      {
        role: "user" as const,
        content: [
          ...docContent(input),
          ...docContent(reference),
          {
            type: "input_text" as const,
            text: "The second document is the genuine reference. Name the aspects in which the first differs from it.",
          },
        ],
      },
    ],
  };
}

export async function extractPaymentDocument(
  input: DocInput,
  ctx: Omit<StructuredContext, "deadlineMs">,
): Promise<ExtractedDoc> {
  try {
    const answer = await structured(PaymentDocument, paymentRequest(input), {
      ...ctx,
      deadlineMs: INVOICE_CALL_MS,
    });
    return { ok: true, fields: answer.value };
  } catch (error) {
    return { ok: false, ...failureOf(error) };
  }
}

export async function compareLayout(
  input: DocInput,
  reference: DocInput,
  ctx: Omit<StructuredContext, "deadlineMs">,
): Promise<{ ok: true; differences: LayoutAspect[] } | { ok: false; reason: string; infra: boolean }> {
  try {
    const answer = await structured(LayoutComparison, comparisonRequest(input, reference), {
      ...ctx,
      deadlineMs: INVOICE_CALL_MS,
    });
    return { ok: true, differences: answer.value.layout_differences };
  } catch (error) {
    return { ok: false, ...failureOf(error) };
  }
}

// The genuine reference for an issuer, or null when none is held. The production R2 read under
// `ref/pop/<issuer slug>.pdf` is wired in §3; the port keeps this section testable without a bucket.
export type ReferencePort = (issuer: string | null) => Promise<Uint8Array | null>;

export const issuerSlug = (issuer: string | null): string | null =>
  issuer
    ? issuer
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || null
    : null;

export type LayoutState = { checked: true; differences: LayoutAspect[] } | { checked: false; reason: string };

const LIMIT =
  "A layout comparison can show a difference from the bank's genuine sample; it cannot prove the document was edited.";

// Model-derived text is data, never a claim the evidence makes: the extracted account number is
// masked wherever it repeats in a name, reference or issuer, and layout differences are structured
// aspects worded by code above, so no model prose reaches the evidence at all.
const cleanText = (value: string | null, account: string | null): string | null => {
  if (value === null) return null;
  let out = value
    .replace(/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (account) {
    const digitsOnly = account.replace(/\D+/g, "");
    if (digitsOnly.length >= 7) {
      const asPrinted = new RegExp(digitsOnly.split("").join("[^0-9A-Za-z]*"), "g");
      out = out.replace(asPrinted, `***${digitsOnly.slice(-3)}`);
    }
  }
  return out.slice(0, 200);
};

export function paymentEvidence(
  fields: PaymentDocument,
  input: { artefactKey: string; layout: LayoutState },
): EvidenceDraft[] {
  const { artefactKey, layout } = input;
  const account = fields.beneficiary.account_number;
  const last3 = account ? account.replace(/[\s-]+/g, "").slice(-3) : null;
  const issuer = cleanText(fields.issuer, account);
  const aspects = layout.checked ? [...new Set(layout.differences)] : [];
  const differences = aspects.map((a) => ASPECT_WORDING[a]);
  const items: EvidenceDraft[] = [
    {
      check: "document.type",
      severity: "info",
      summary: `Payment document: ${fields.type} from ${issuer ?? "an unnamed issuer"}`.slice(0, 200),
      detail: {
        attachment: artefactKey,
        type: fields.type,
        issuer,
        amount_cents: fields.amount_cents,
        currency: fields.currency,
        paid_at: fields.paid_at,
        issued_at: fields.issued_at,
        reference: cleanText(fields.reference, account),
        beneficiary_name: cleanText(fields.beneficiary.name, account),
        account_last3: last3,
        beneficiary_masked: last3 ? `***${last3}` : null,
        branch_code: fields.beneficiary.branch_code,
        layout_checked: layout.checked,
        ...(layout.checked ? {} : { layout_reason: layout.reason }),
        ...(fields.type === "pop" ? { limit: LIMIT } : {}),
      },
      artefacts: [artefactKey],
    },
  ];
  if (layout.checked && differences.length > 0)
    items.push({
      check: "document.layout_mismatch",
      severity: "medium",
      summary:
        `This document differs from the bank's genuine sample. Confirm it with the bank. It cannot prove the document was edited.`.slice(
          0,
          200,
        ),
      detail: {
        attachment: artefactKey,
        type: fields.type,
        issuer,
        account_last3: last3,
        beneficiary_masked: last3 ? `***${last3}` : null,
        aspects,
        differences,
        limit: LIMIT,
      },
      artefacts: [artefactKey],
    });
  return items;
}

// The section's orchestration (plan review gap 1, completion gaps 2 and 4): extract first, then a
// POP-only reference lookup and comparison, with every failure stated as its own draft. The
// beneficiary match is the caller's next step (§3 wires both into the Workflow).
export async function analysePaymentDocument(
  input: DocInput,
  ctx: Omit<StructuredContext, "deadlineMs">,
  deps: { referenceOf: ReferencePort; artefactKey: string },
): Promise<{ fields: PaymentDocument | null; items: EvidenceDraft[] }> {
  const extracted = await extractPaymentDocument(input, ctx);
  if (!extracted.ok) return { fields: null, items: [notCheckedDocument(extracted.reason, deps.artefactKey)] };
  const fields = extracted.fields;
  if (fields.type !== "pop")
    return {
      fields,
      items: paymentEvidence(fields, {
        artefactKey: deps.artefactKey,
        layout: { checked: false, reason: "not-a-pop" },
      }),
    };
  let reference: Uint8Array | null;
  try {
    reference = await deps.referenceOf(fields.issuer);
  } catch {
    return {
      fields,
      items: [
        ...paymentEvidence(fields, {
          artefactKey: deps.artefactKey,
          layout: { checked: false, reason: "reference-unavailable" },
        }),
        comparisonUnavailableDocument("reference-unavailable", deps.artefactKey),
      ],
    };
  }
  if (!reference)
    return {
      fields,
      items: paymentEvidence(fields, {
        artefactKey: deps.artefactKey,
        layout: { checked: false, reason: "no-reference" },
      }),
    };
  const toBase64 = (bytes: Uint8Array) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
  };
  const compared = await compareLayout(
    input,
    { kind: "pdf", pdfBase64: toBase64(reference), filename: "genuine-reference.pdf" },
    ctx,
  );
  if (!compared.ok)
    return {
      fields,
      items: [
        ...paymentEvidence(fields, {
          artefactKey: deps.artefactKey,
          layout: { checked: false, reason: compared.reason },
        }),
        comparisonUnavailableDocument(compared.reason, deps.artefactKey),
      ],
    };
  return {
    fields,
    items: paymentEvidence(fields, {
      artefactKey: deps.artefactKey,
      layout: { checked: true, differences: compared.differences },
    }),
  };
}

export function comparisonUnavailableDocument(reason: string, artefactKey: string): EvidenceDraft {
  return {
    check: "document.comparison_unavailable",
    severity: "info",
    summary: `A payment document comparison could not run (${reason})`.slice(0, 200),
    detail: { checked: false, reason, attachment: artefactKey },
    artefacts: [artefactKey],
  };
}

export function notCheckedDocument(reason: string, artefactKey: string): EvidenceDraft {
  return {
    check: "document.not_checked",
    severity: "info",
    summary: `A payment document could not be read (${reason})`.slice(0, 200),
    detail: { checked: false, reason, attachment: artefactKey },
    artefacts: [artefactKey],
  };
}

const unavailable = (reason: string, artefactKey: string): EvidenceDraft => ({
  check: "document.comparison_unavailable",
  severity: "info",
  summary: `A beneficiary comparison could not run (${reason})`.slice(0, 200),
  detail: { checked: false, reason, attachment: artefactKey },
  artefacts: [artefactKey],
});

const reasonOf = (error: unknown): string | null => {
  if (error instanceof SupplierAmbiguous) return "supplier-ambiguous";
  if (error instanceof NoBaseline) return "no-baseline";
  if (error instanceof KeyMismatch) return "keys";
  if (error instanceof MatchLimited) return "rate-limited";
  return null;
};

// The beneficiary match (correction 3): ledger first, then the registry for a protected supplier.
// Match or no match only; a comparison that cannot run states itself, never a mismatch.
export async function beneficiaryEvidence(
  deps: { db: D1Database; keys: BankKeys },
  input: { orgId: string; fields: PaymentDocument; artefactKey: string },
): Promise<EvidenceDraft[]> {
  const { db, keys } = deps;
  const { fields, artefactKey } = input;
  const account =
    fields.beneficiary.account_number && fields.beneficiary.branch_code
      ? { number: fields.beneficiary.account_number, branchCode: fields.beneficiary.branch_code }
      : null;
  if (!account) return [unavailable("no-account", artefactKey)];
  let supplier: Supplier | null = null;
  try {
    supplier = await findSupplier(db, input.orgId, { name: fields.beneficiary.name, domain: null });
  } catch (error) {
    const reason = reasonOf(error);
    if (reason === null) throw error;
    return [unavailable(reason, artefactKey)];
  }
  const items: EvidenceDraft[] = [];
  const mismatch = (against: string, extra: Record<string, unknown> = {}): EvidenceDraft => ({
    check: "document.beneficiary_mismatch",
    severity: "critical",
    summary:
      "The document's beneficiary does not match the recorded account. Confirm by phoning the supplier on the number in your records, never one from this document.".slice(
        0,
        200,
      ),
    detail: {
      attachment: artefactKey,
      type: fields.type,
      issuer: cleanText(fields.issuer, account.number),
      against,
      supplier_id: supplier?.id ?? null,
      account_last3: account.number.replace(/[\s-]+/g, "").slice(-3),
      beneficiary_masked: `***${account.number.replace(/[\s-]+/g, "").slice(-3)}`,
      ...extra,
    },
    artefacts: [artefactKey],
  });
  const matched = (against: string, extra: Record<string, unknown> = {}): EvidenceDraft => ({
    check: "document.beneficiary_match",
    severity: "info",
    summary: "The document's beneficiary matches the recorded account.".slice(0, 200),
    detail: {
      attachment: artefactKey,
      type: fields.type,
      against,
      supplier_id: supplier?.id ?? null,
      account_last3: account.number.replace(/[\s-]+/g, "").slice(-3),
      beneficiary_masked: `***${account.number.replace(/[\s-]+/g, "").slice(-3)}`,
      match: true,
      ...extra,
    },
    artefacts: [artefactKey],
  });
  if (supplier) {
    try {
      const { match } = await matchSupplierAccount(db, keys, input.orgId, supplier.id, account);
      items.push(match ? matched("ledger") : mismatch("ledger"));
    } catch (error) {
      const reason = reasonOf(error);
      if (reason === null) throw error;
      items.push(unavailable(reason, artefactKey));
    }
  } else {
    items.push(unavailable("no-supplier", artefactKey));
  }
  // Registry side: a protected identity whose verified domain is the issuer's stated domain is not
  // derivable from a payment document, so the registry runs only when the supplier's ledger domains
  // name a protected organisation, as in the invoice rules.
  if (supplier) {
    // One registry comparison per protected organisation per document, however many of the
    // supplier's domains name it (the registry comparison is rate-limited per protected business).
    const protectedOrgs = new Set<string>();
    for (const domain of supplier.domains) {
      const site = siteOf(domain);
      const rows = await db
        .prepare("SELECT DISTINCT org_id FROM org_domains WHERE state = 'verified' AND (domain = ? OR domain = ?)")
        .bind(domain, site)
        .all<{ org_id: string }>();
      for (const r of rows.results) if (r.org_id !== input.orgId) protectedOrgs.add(r.org_id);
    }
    for (const orgId of protectedOrgs) {
      const r = { org_id: orgId };
      {
        let identity: Awaited<ReturnType<typeof getIdentity>>;
        try {
          identity = await getIdentity(db, r.org_id);
        } catch {
          items.push(unavailable("registry", artefactKey));
          continue;
        }
        if (!identity?.effective.on) continue;
        try {
          const { match } = await matchBankAccount(db, keys, { orgId: input.orgId }, r.org_id, account);
          items.push(
            match
              ? matched("registry", { protected_org_id: r.org_id, registry_match: true })
              : mismatch("registry", { protected_org_id: r.org_id, registry_match: false }),
          );
        } catch (error) {
          if (error instanceof IdentityRefused) continue;
          const reason = reasonOf(error);
          if (reason === null) throw error;
          items.push(unavailable(reason, artefactKey));
        }
      }
    }
  }
  return items;
}
