// The standalone document step (D06 T02 §3; spec 4.5a): a document case's PDFs and images run
// forensics (§1), extraction and layout comparison (§2) and beneficiary matching, stated as
// `document.*` evidence through the `document` producer. The Workflow routing that calls it for
// document cases is the checks lane's, with the coordinator's agreement; this step is the work it
// will call. It never fails a case on a model or document problem: what could not be read is
// stated, and a storage failure throws so the case ends partial instead of concealing it.
import { hasFeature } from "../auth/plans.ts";
import { addEvidence, type EvidenceDraft } from "../checks/evidence.ts";
import { pdfText } from "../checks/pdf-text.ts";
import { artefactsOf, readArtefact, type Store } from "../intake/store.ts";
import type { MetaContext } from "../meta/client.ts";
import type { BankKeys } from "../trust/bank.ts";
import { analysePdf, forensicsEvidence } from "./forensics.ts";
import { analysePaymentDocument, beneficiaryEvidence, notCheckedDocument, type ReferencePort } from "./payment-doc.ts";

export const DOCUMENT_LIMIT =
  "This check can show a document is likely altered. It cannot prove that a payment was made.";

export type DocumentDeps = {
  db: D1Database;
  store: Store;
  meta: Omit<MetaContext, "owner">;
  keys: () => Promise<BankKeys>;
  referenceOf: ReferencePort;
  write?: (items: EvidenceDraft[]) => Promise<unknown>;
  now?: () => Date;
};

export type DocumentResult = { outcome: "refused" } | { outcome: "none" } | { outcome: "read"; documents: number };

const MAX_DOCUMENTS = 3;

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const limitItem = (artefactKey: string): EvidenceDraft => ({
  check: "document.limit",
  severity: "info",
  summary: DOCUMENT_LIMIT.slice(0, 200),
  detail: { attachment: artefactKey, limit: DOCUMENT_LIMIT },
  artefacts: [artefactKey],
});

const popItem = (artefactKey: string): EvidenceDraft => ({
  check: "document.proof_of_payment",
  severity: "info",
  summary:
    "This document states it is a proof of payment. Confirm the money has cleared in your own banking app before releasing goods.".slice(
      0,
      200,
    ),
  detail: { attachment: artefactKey, limit: DOCUMENT_LIMIT },
  artefacts: [artefactKey],
});

export async function documentStep(deps: DocumentDeps, caseId: string, orgId: string): Promise<DocumentResult> {
  if (!(await hasFeature(deps.db, orgId, "payment-document"))) return { outcome: "refused" };
  const artefacts = (await artefactsOf(deps.store, caseId, "attachment")).filter(
    (a) => a.mediaType === "application/pdf" || a.mediaType.startsWith("image/"),
  );
  if (artefacts.length === 0) return { outcome: "none" };
  const items: EvidenceDraft[] = [];
  let documents = 0;
  for (const artefact of artefacts.slice(0, MAX_DOCUMENTS)) {
    documents++;
    const read = await readArtefact(deps.store, caseId, artefact.key).catch(() => null);
    const body = read && "body" in read ? read.body : null;
    if (!body) {
      items.push(notCheckedDocument("unreadable", artefact.key), limitItem(artefact.key));
      continue;
    }
    if (artefact.mediaType === "application/pdf") {
      const report = await analysePdf(body).catch(() => null);
      if (report)
        items.push(
          ...forensicsEvidence(report, { key: artefact.key, filename: artefact.key.split("/").pop() ?? "document" }),
        );
    }
    const text = artefact.mediaType === "application/pdf" ? await pdfText(body).catch(() => null) : null;
    const analysed = await analysePaymentDocument(
      artefact.mediaType === "application/pdf"
        ? {
            kind: "pdf",
            pdfBase64: toBase64(body),
            filename: artefact.key.split("/").pop() ?? "document",
            ...(text && text.text.trim() !== "" ? { documentText: text.text } : {}),
          }
        : {
            kind: "image",
            imageDataUrl: `data:${artefact.mediaType};base64,${toBase64(body)}`,
            filename: artefact.key.split("/").pop() ?? "document",
          },
      { ...deps.meta, owner: { kind: "case", caseId, step: "invoice" }, waitUntil: () => {} },
      { referenceOf: deps.referenceOf, artefactKey: artefact.key },
    );
    items.push(...analysed.items);
    if (analysed.fields?.type === "pop") items.push(popItem(artefact.key));
    if (analysed.fields)
      items.push(
        ...(await beneficiaryEvidence(
          { db: deps.db, keys: await deps.keys() },
          { orgId, fields: analysed.fields, artefactKey: artefact.key },
        )),
      );
    items.push(limitItem(artefact.key));
  }
  for (const artefact of artefacts.slice(MAX_DOCUMENTS))
    items.push(notCheckedDocument("too-many-documents", artefact.key), limitItem(artefact.key));
  const write =
    deps.write ??
    (async (drafts: EvidenceDraft[]) => addEvidence(deps.db, caseId, "document" as never, drafts, deps.now));
  await write(items);
  return { outcome: "read", documents };
}
