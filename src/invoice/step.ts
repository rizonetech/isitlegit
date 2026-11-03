// The invoice step (D06 T01 §1; spec 4.5): between vision and the verdict, a case's PDF attachments are
// read by Muse Spark and the payee account of each invoice is sealed for §6. It never fails the case on a
// model or document problem: what could not be read is stated as `invoice.not_checked` with its reason
// kind, creates no account, and the verdict goes on with what it has. A storage failure is the opposite:
// when even the failure statement cannot be written, the step throws, so the case ends partial instead of
// reaching a verdict with its missing coverage concealed. An infrastructure failure (the budget store
// down, a retryable transport fault) also throws, for the Workflow's own retry: a second attempt pays for
// the call again, recorded like the first. A replay replaces the producer's items and each document's
// account row, never accumulating either.
import { addEvidence, type EvidenceDraft, evidenceProducers, readEvidence } from "../checks/evidence";
import { pdfText } from "../checks/pdf-text";
import { artefactsOf, readArtefact, type Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { type BankKeys, claimKeys, sealNumber } from "../trust/bank";
import { BankKeysMissing } from "../trust/errors";
import { caseInvoiceAccountStatement, readCaseInvoiceAccount } from "./case-accounts";
import {
  documentStep,
  isForensicsIncomplete,
  isStandaloneCase,
  limitItem,
  notCheckedForensics,
  saveDocumentEvidence,
} from "./document-step";
import {
  detectedItem,
  extractInvoiceFields,
  notCheckedItem,
  type PdfDocument,
  payeeAccount,
  selectDocuments,
} from "./extract";
import { analysePdf, forensicsEvidence } from "./forensics";
import { notCheckedDocument } from "./payment-doc";
import { readPdf } from "./pdf";
import { pageList } from "./pdf-content";
import { invoiceRules, visibleTextOf } from "./rules";
import type { InvoiceFields } from "./schema";

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
  const attachments = await artefactsOf(deps.store, caseId, "attachment");
  if (await isStandaloneCase(deps.store, caseId, attachments)) {
    const doc = await documentStep(deps, caseId, orgId);
    if (doc.outcome === "refused") return { outcome: "not_checked", reason: "plan-required" };
    if (doc.outcome === "none") return { outcome: "none" };
    return { outcome: "read", invoices: doc.documents };
  }
  const pdfs = attachments.filter((a) => a.mediaType === "application/pdf");
  if (pdfs.length === 0) return { outcome: "none" };
  // Each document is read once, here: its page count (the page tree of src/invoice/pdf-content.ts) feeds
  // the bounds, and its bytes feed the call, so nothing is fetched twice. A document that cannot be read
  // or parsed is stated unreadable, never silently dropped.
  type Loaded = PdfDocument & { body: Uint8Array | null };
  const loaded: Loaded[] = [];
  const items: EvidenceDraft[] = [];
  for (const a of pdfs) {
    const base = {
      artefactKey: a.key,
      filename: a.key.split(`${a.sha256}-`)[1] ?? "attachment.pdf",
      bytes: a.bytes,
    };
    const read = await readArtefact(deps.store, caseId, a.key);
    if (!read || "missing" in read) {
      loaded.push({ ...base, body: null });
      continue;
    }
    let pages: number | undefined;
    try {
      pages = pageList(await readPdf(read.body)).length;
    } catch {
      pages = undefined;
    }
    if (pages === undefined) {
      loaded.push({ ...base, body: null });
      continue;
    }
    loaded.push({ ...base, pages, body: read.body });
  }
  const readable = loaded.filter((d) => d.body !== null);
  for (const d of loaded) if (d.body === null) items.push(notCheckedItem("unreadable", d.artefactKey));
  const { call, stated } = selectDocuments(readable);
  for (const s of stated) items.push(notCheckedItem(s.reason, s.doc.artefactKey));
  const statedFailure = loaded.some((d) => d.body === null) ? "unreadable" : (stated[0]?.reason ?? null);
  const bodyOf = new Map(readable.map((d) => [d.artefactKey, d.body as Uint8Array]));
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
  const readings: {
    artefactKey: string;
    fields: InvoiceFields;
    account: { number: string; branchCode: string } | null;
  }[] = [];
  let invoices = 0;
  let firstFailure: string | null = statedFailure;
  // The whole state of this run, written together: the producer's items, then the accounts in one batch,
  // first deleting the rows of any document this run did not seal (a replay whose new reading is a
  // refusal, a non-invoice or an account-less invoice removes the account the old reading sealed, so §6
  // can never read a stale account). Evidence first: an interruption leaves an invoice stated with no
  // account rather than an account a verdict never saw.
  const allKeys = pdfs.map((a) => a.key);
  const existingProducers = await evidenceProducers(deps.db, caseId).catch(() => []);
  const hadDocumentRows = existingProducers.some((p) => p.producer === "document");
  const otherProducerIds = new Set(existingProducers.filter((p) => p.producer !== "document").map((p) => p.id));
  const checksForensics = new Set(
    (await readEvidence(deps.db, caseId).catch(() => []))
      .filter((e) => otherProducerIds.has(e.id) && e.check.startsWith("document.forensics."))
      .flatMap((e) => e.artefacts.map((k) => `${k}:${e.check}`)),
  );
  const forensicItems: EvidenceDraft[] = [];
  for (const doc of call) {
    const body = bodyOf.get(doc.artefactKey) as Uint8Array;
    const report = await analysePdf(body).catch(() => null);
    if (report) {
      forensicItems.push(
        ...forensicsEvidence(report, { key: doc.artefactKey, filename: doc.filename }).filter(
          (d) => !checksForensics.has(`${doc.artefactKey}:${d.check}`),
        ),
      );
      if (isForensicsIncomplete(report, null)) {
        forensicItems.push(notCheckedForensics(report, doc.artefactKey));
      }
    } else {
      forensicItems.push(notCheckedDocument("forensics-failed", doc.artefactKey));
    }
  }
  const writeAll = async () => {
    await addEvidence(deps.db, caseId, "invoice", items, deps.now);
    if (forensicItems.length > 0 || hadDocumentRows) {
      await saveDocumentEvidence(deps.db, caseId, forensicItems, deps.now);
    }
    const keep = new Set(pending.map((p) => p.artefactKey));
    const stale = allKeys.filter((k) => !keep.has(k));
    const statements: D1PreparedStatement[] = [];
    if (stale.length > 0)
      statements.push(
        deps.db
          .prepare(
            `DELETE FROM case_invoice_accounts WHERE case_id = ? AND artefact_key IN (${stale.map(() => "?").join(", ")})`,
          )
          .bind(caseId, ...stale),
      );
    if (pending.length > 0) {
      statements.push(claimKeys(deps.db, keys));
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
    }
    if (statements.length > 0) await deps.db.batch(statements);
  };
  // What an earlier attempt of this step already settled, by document: a retry (the Workflow's, after an
  // infrastructure failure committed what was read) resumes from it instead of paying for the same
  // document again and risking a worse second reading replacing a good one. An artefact key names the
  // document's own bytes, so a settled reading is the reading of this document, never of another.
  const priorByArtefact = new Map(
    (await readEvidence(deps.db, caseId))
      .filter((e) => e.check === "invoice.detected" && typeof e.detail.attachment === "string")
      .map((e) => [e.detail.attachment as string, e]),
  );
  for (const doc of call) {
    const prior = priorByArtefact.get(doc.artefactKey);
    if (prior?.check === "invoice.detected") {
      const sealed = await readCaseInvoiceAccount(deps.db, keys, orgId, caseId, doc.artefactKey).catch(() => null);
      // A detected item whose account should be sealed but is not (an interruption between the two
      // writes) is read again; every other settled detection is reused as it stands.
      if (prior.detail.account_last3 === null || sealed !== null) {
        items.push({
          check: prior.check,
          severity: prior.severity,
          summary: prior.summary,
          detail: prior.detail,
          artefacts: prior.artefacts,
        });
        invoices++;
        readings.push({
          artefactKey: doc.artefactKey,
          fields: {
            is_invoice: true,
            supplier_name: (prior.detail.supplier_name as string | null) ?? null,
            supplier_domain: (prior.detail.supplier_domain as string | null) ?? null,
            bank_name: (prior.detail.bank_name as string | null) ?? null,
            account_holder: (prior.detail.account_holder as string | null) ?? null,
            account_number: sealed?.number ?? null,
            branch_code: (prior.detail.branch_code as string | null) ?? null,
            amount_cents: (prior.detail.amount_cents as number | null) ?? null,
            currency: (prior.detail.currency as string | null) ?? null,
            reference: (prior.detail.reference as string | null) ?? null,
            due_date: (prior.detail.due_date as string | null) ?? null,
          },
          account: sealed ? { number: sealed.number, branchCode: sealed.branchCode } : null,
        });
        if (sealed)
          pending.push({
            artefactKey: doc.artefactKey,
            bankName: sealed.bankName,
            holder: sealed.holder,
            number: sealed.number,
            branchCode: sealed.branchCode,
          });
        continue;
      }
    }
    const body = bodyOf.get(doc.artefactKey) as Uint8Array;
    // The document's own text layer goes with the file, inside its untrusted block: the production path
    // holds the same boundary the request test proves, not only the warning in the instructions.
    const text = await pdfText(body).catch(() => null);
    const got = await extractInvoiceFields(
      {
        pdfBase64: toBase64(body),
        filename: doc.filename,
        ...(text && text.text.trim() !== "" ? { documentText: text.text } : {}),
      },
      { ...deps.meta, owner: { kind: "case", caseId, step: "invoice" }, waitUntil: deps.waitUntil },
    );
    if (!got.ok) {
      if (got.infra) {
        // A retry may cure it: the documents already read are committed first, so the retry's cost is
        // only the documents it still owes, and no half-stated attempt survives beside its statement.
        await writeAll();
        throw new Error(`invoice extraction infrastructure failure: ${got.reason}`);
      }
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
    readings.push({ artefactKey: doc.artefactKey, fields: got.fields, account });
    if (account)
      pending.push({
        artefactKey: doc.artefactKey,
        bankName: got.fields.bank_name,
        holder: got.fields.account_holder,
        number: account.number,
        branchCode: account.branchCode,
      });
  }
  // The bank-change rules (§3) judge what was read, in the same producer write: their items join this
  // run's list before the write, so extraction and rule evidence land together and replace together.
  if (readings.length > 0) {
    try {
      const ruled = await invoiceRules(
        { db: deps.db, keys },
        { caseId, orgId, readings, visibleText: await visibleTextOf(deps.store, caseId) },
      );
      items.push(...ruled);
    } catch (error) {
      await writeAll();
      throw error;
    }
  }
  await writeAll();
  if (invoices > 0) return { outcome: "read", invoices };
  if (firstFailure !== null) return { outcome: "not_checked", reason: firstFailure };
  return { outcome: "read", invoices: 0 };
}

// The Workflow's own failure stated after the fact: the step threw past this helper (a storage failure,
// a step timeout), so the case gets the same not-checked statement the step would have written, and any
// account a partly-completed attempt sealed goes with it: the terminal state never pairs a not-checked
// statement with a readable account. Its own failure propagates: the caller ends the case partial rather
// than proceed without the statement.
export async function recordInvoiceNotRun(store: Store, caseId: string, reason: string): Promise<void> {
  const attachments = await artefactsOf(store, caseId, "attachment");
  if (await isStandaloneCase(store, caseId, attachments)) {
    const docAtts = attachments.filter((a) => a.mediaType === "application/pdf" || a.mediaType.startsWith("image/"));
    const docItems =
      docAtts.length > 0
        ? docAtts.flatMap((a) => [notCheckedDocument(reason, a.key), limitItem(a.key)])
        : [notCheckedDocument(reason, "case"), limitItem("case")];
    await saveDocumentEvidence(store.db, caseId, docItems);
    return;
  }
  const items = attachments.filter((a) => a.mediaType === "application/pdf").map((a) => notCheckedItem(reason, a.key));
  await addEvidence(store.db, caseId, "invoice", items.length > 0 ? items : [notCheckedItem(reason, "case")]);
  await store.db.prepare("DELETE FROM case_invoice_accounts WHERE case_id = ?").bind(caseId).run();
}
