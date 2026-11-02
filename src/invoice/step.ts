// The invoice step (D06 T01 §1; spec 4.5): between vision and the verdict, a case's PDF attachments are
// read by Muse Spark and the payee account of each invoice is sealed for §6. It never fails the case on a
// model or document problem: what could not be read is stated as `invoice.not_checked` with its reason
// kind, creates no account, and the verdict goes on with what it has. A storage failure is the opposite:
// when even the failure statement cannot be written, the step throws, so the case ends partial instead of
// reaching a verdict with its missing coverage concealed. An infrastructure failure (the budget store
// down, a retryable transport fault) also throws, for the Workflow's own retry: a second attempt pays for
// the call again, recorded like the first. A replay replaces the producer's items and each document's
// account row, never accumulating either.
import { addEvidence, type EvidenceDraft } from "../checks/evidence";
import { artefactsOf, readArtefact, type Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { type BankKeys, claimKeys, sealNumber } from "../trust/bank";
import { BankKeysMissing } from "../trust/errors";
import { caseInvoiceAccountStatement } from "./case-accounts";
import {
  detectedItem,
  extractInvoiceFields,
  notCheckedItem,
  type PdfDocument,
  payeeAccount,
  selectDocuments,
} from "./extract";

export type InvoiceDeps = {
  db: D1Database;
  store: Store;
  // The Meta context without its owner: the step owns the call for this case.
  meta: Omit<MetaContext, "owner">;
  // The bank keys, resolved by the caller: resolving them here would hide a missing secret inside a step
  // that could then neither seal an account nor say why.
  keys: () => Promise<BankKeys>;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => Date;
};

export type InvoiceResult =
  | { outcome: "none" }
  | { outcome: "read"; invoices: number }
  | { outcome: "not_checked"; reason: string };

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

export async function invoiceStep(deps: InvoiceDeps, caseId: string, orgId: string): Promise<InvoiceResult> {
  const pdfs = (await artefactsOf(deps.store, caseId, "attachment")).filter((a) => a.mediaType === "application/pdf");
  if (pdfs.length === 0) return { outcome: "none" };
  const docs: PdfDocument[] = pdfs.map((a) => ({
    artefactKey: a.key,
    filename: a.key.split(`${a.sha256}-`)[1] ?? "attachment.pdf",
    bytes: a.bytes,
  }));
  const { call, stated } = selectDocuments(docs);
  const items: EvidenceDraft[] = stated.map((s) => notCheckedItem(s.reason, s.doc.artefactKey));
  let keys: BankKeys;
  try {
    keys = await deps.keys();
  } catch (error) {
    if (!(error instanceof BankKeysMissing)) throw error;
    // No secret, no sealing, and no paid call whose account could only be stranded: state it per document.
    for (const doc of call) items.push(notCheckedItem("keys-missing", doc.artefactKey));
    await addEvidence(deps.db, caseId, "invoice", items, deps.now);
    return { outcome: "not_checked", reason: "keys-missing" };
  }
  type Pending = {
    artefactKey: string;
    bankName: string | null;
    holder: string | null;
    number: string;
    branchCode: string;
  };
  const pending: Pending[] = [];
  let invoices = 0;
  let firstFailure: string | null = null;
  for (const doc of call) {
    const read = await readArtefact(deps.store, caseId, doc.artefactKey);
    if (!read || "missing" in read) {
      items.push(notCheckedItem("unreadable", doc.artefactKey));
      firstFailure ??= "unreadable";
      continue;
    }
    const got = await extractInvoiceFields(
      { pdfBase64: toBase64(read.body), filename: doc.filename },
      { ...deps.meta, owner: { kind: "case", caseId, step: "invoice" }, waitUntil: deps.waitUntil },
    );
    if (!got.ok) {
      // A retry may cure an infrastructure fault: the step throws and writes nothing, so no half-stated
      // attempt survives beside the retry's own statement.
      if (got.infra) throw new Error(`invoice extraction infrastructure failure: ${got.reason}`);
      items.push(notCheckedItem(got.reason, doc.artefactKey));
      firstFailure ??= got.reason;
      continue;
    }
    const item = detectedItem(got.fields, doc.artefactKey);
    if (item) {
      items.push(item);
      invoices++;
    }
    const account = payeeAccount(got.fields);
    if (account)
      pending.push({
        artefactKey: doc.artefactKey,
        bankName: got.fields.bank_name,
        holder: got.fields.account_holder,
        number: account.number,
        branchCode: account.branchCode,
      });
  }
  // Evidence first, then the accounts: an interruption leaves an invoice stated with no account (§6 then
  // offers no mark, and says why) rather than an account a verdict never saw. The retry replaces both.
  await addEvidence(deps.db, caseId, "invoice", items, deps.now);
  if (pending.length > 0) {
    const statements: D1PreparedStatement[] = [claimKeys(deps.db, keys)];
    for (const p of pending) {
      const sealed = await sealNumber(keys, p.number);
      statements.push(
        caseInvoiceAccountStatement(
          deps.db,
          keys,
          sealed,
          {
            caseId,
            orgId,
            artefactKey: p.artefactKey,
            bankName: p.bankName,
            holder: p.holder,
            branchCode: p.branchCode,
          },
          deps.now?.() ?? new Date(),
        ),
      );
    }
    await deps.db.batch(statements);
  }
  if (invoices > 0) return { outcome: "read", invoices };
  if (firstFailure !== null) return { outcome: "not_checked", reason: firstFailure };
  return { outcome: "read", invoices: 0 };
}

// The Workflow's own failure stated after the fact: the step threw past this helper (a storage failure,
// a step timeout), so the case gets the same not-checked statement the step would have written. Its own
// failure propagates: the caller ends the case partial rather than proceed without the statement.
export async function recordInvoiceNotRun(store: Store, caseId: string, reason: string): Promise<void> {
  const pdfs = await artefactsOf(store, caseId, "attachment");
  const items = pdfs.filter((a) => a.mediaType === "application/pdf").map((a) => notCheckedItem(reason, a.key));
  await addEvidence(store.db, caseId, "invoice", items.length > 0 ? items : [notCheckedItem(reason, "case")]);
}
