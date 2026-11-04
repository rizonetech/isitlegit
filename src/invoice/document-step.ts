// The standalone document step (D06 T02 §3; spec 4.5a): a document case's PDFs and images run
// forensics (§1), extraction and layout comparison (§2) and beneficiary matching, persisted as
// `document.*` evidence through the `document` producer (`saveDocumentEvidence`). It never fails a
// case on a model or document problem: what could not be read or checked (including plan refusal
// and incomplete PDF forensic coverage) is stated as `document.not_checked` (`checked: false`) so
// the verdict path produces a partial report rather than a clean bill, and a storage failure throws
// so the case ends partial instead of concealing it.
import { z } from "zod";
import { fixedActionsFor } from "../agent/loop.ts";
import { ruleVerdict } from "../agent/rule-verdict.ts";
import { hasFeature } from "../auth/plans.ts";
import {
  type Evidence,
  type EvidenceDraft,
  EvidenceRefused,
  evidenceProducers,
  readEvidence,
  StoredEvidence,
} from "../checks/evidence.ts";
import { pdfText } from "../checks/pdf-text.ts";
import { saveVerdict, type VerdictView } from "../db/verdicts.ts";
import { artefactsOf, parsedKey, readArtefact, type Store } from "../intake/store.ts";
import type { MetaContext } from "../meta/client.ts";
import type { BankKeys } from "../trust/bank.ts";
import { bankChangeAction } from "./fixed-actions.ts";
import { analysePdf, FORENSIC_CHECKS, forensicsCoverage, forensicsEvidence, type PdfForensics } from "./forensics.ts";
import {
  analysePaymentDocument,
  beneficiaryEvidence,
  notCheckedDocument,
  type PaymentDocument,
  type ReferencePort,
} from "./payment-doc.ts";

export const DOCUMENT_LIMIT =
  "This check can show a document is likely altered. It cannot prove that a payment was made.";

export const DOCUMENT_CHECKS: ReadonlySet<string> = new Set([
  ...FORENSIC_CHECKS,
  "document.type",
  "document.layout_mismatch",
  "document.beneficiary_match",
  "document.beneficiary_mismatch",
  "document.comparison_unavailable",
  "document.not_checked",
  "document.limit",
  "document.proof_of_payment",
]);

export type DocumentDeps = {
  db: D1Database;
  store: Store;
  meta: Omit<MetaContext, "owner">;
  keys: () => Promise<BankKeys>;
  referenceOf?: ReferencePort;
  write?: (items: EvidenceDraft[]) => Promise<unknown>;
  now?: () => Date;
};

export type DocumentResult = { outcome: "refused" } | { outcome: "none" } | { outcome: "read"; documents: number };

const MAX_DOCUMENTS = 3;
const CURRENT_RUN_OF = "(SELECT COALESCE(run_id, id) FROM cases WHERE id = ?)";
const CURRENT_RUN_ROW = "(SELECT COALESCE(run_id, id) AS run FROM cases WHERE id = ?)";

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

const isDocumentMediaType = (mediaType: string) => mediaType === "application/pdf" || mediaType.startsWith("image/");

const MAX_EMPTY_HTML_CHARS = 4_096;
const EMPTY_WRAPPER_TAGS = new Set(["html", "head", "body", "div", "p", "span", "br", "hr", "style"]);

const hasHtmlContent = (html: string): boolean => {
  if (html.length > MAX_EMPTY_HTML_CHARS) return true;
  const lower = html.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const ch = lower[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (lower.startsWith("&nbsp;", i) || lower.startsWith("&#160;", i) || lower.startsWith("&#xa0;", i)) {
      i += 6;
      continue;
    }
    if (ch === "<") {
      if (lower.startsWith("<!--", i)) {
        const endComment = lower.indexOf("-->", i + 4);
        if (endComment === -1) return true;
        i = endComment + 3;
        continue;
      }
      const close = lower.indexOf(">", i + 1);
      if (close === -1) return true;
      const rawTag = lower.slice(i + 1, close).trim();
      const isClosing = rawTag.startsWith("/");
      const tagBody = (isClosing ? rawTag.slice(1) : rawTag).replace(/\/$/, "").trim();
      if (!EMPTY_WRAPPER_TAGS.has(tagBody)) return true;
      if (tagBody === "style" && !isClosing) {
        const closeStyle = lower.indexOf("</style>", close + 1);
        if (closeStyle === -1) return true;
        const styleInner = lower.slice(close + 1, closeStyle);
        if (/['"()\\@]|\b(url|content|attr|counter|counters)\b/.test(styleInner)) {
          return true;
        }
        i = closeStyle + 8;
        continue;
      }
      i = close + 1;
      continue;
    }
    return true;
  }
  return false;
};

// Classifies whether a case takes the standalone payment-document route (D06 T02 §3 item 1):
// an uploaded document or image (`sourceKind = "document"` or `"image"`), or an email whose
// body is empty and which carries only a PDF or image attachment (1 to MAX_DOCUMENTS).
export function isStandaloneDocumentCase(input: {
  sourceKind?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  attachments: readonly { mediaType: string }[];
}): boolean {
  if (input.sourceKind === "document" || input.sourceKind === "image") {
    return input.attachments.length > 0 && input.attachments.every((a) => isDocumentMediaType(a.mediaType));
  }
  const hasText = Boolean(input.textBody && input.textBody.trim() !== "");
  const hasHtml = Boolean(input.htmlBody && hasHtmlContent(input.htmlBody));
  if (hasText || hasHtml) return false;
  return input.attachments.length === 1 && isDocumentMediaType(input.attachments[0]?.mediaType ?? "");
}

// Reads the case row and parsed message summary from `store` to determine whether `caseId` is a
// standalone payment-document case (`source_kind = "document"` or `"image"`, or a parsed `"mail"`
// case whose body is empty and which carries a single PDF or image attachment).
export async function isStandaloneCase(
  store: Store,
  caseId: string,
  attachments?: readonly { mediaType: string }[],
): Promise<boolean> {
  const row = await store.db
    .prepare("SELECT source_kind FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ source_kind: string | null }>()
    .catch(() => null);
  if (!row) return false;
  const list = attachments ?? (await artefactsOf(store, caseId, "attachment"));
  if (row.source_kind === "document" || row.source_kind === "image") {
    return isStandaloneDocumentCase({ sourceKind: row.source_kind, attachments: list });
  }
  if (row.source_kind !== "mail") return false;
  const parsedRaw = await readArtefact(store, caseId, parsedKey(caseId)).catch(() => null);
  if (!parsedRaw || !("body" in parsedRaw)) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(parsedRaw.body)) as {
      text?: string | null;
      html?: string | null;
    };
    return isStandaloneDocumentCase({
      sourceKind: "mail",
      textBody: typeof parsed.text === "string" ? parsed.text : null,
      htmlBody: typeof parsed.html === "string" ? parsed.html : null,
      attachments: list,
    });
  } catch {
    return false;
  }
}

// Normalises an issuer name to candidate R2 slugs under `ref/pop/<slug>.pdf` (D06 T02 §2 and §3):
// strips parenthetical qualifiers such as "(fictional)" first, then falls back to the full slug.
export function issuerSlugs(issuer: string | null): string[] {
  if (!issuer) return [];
  const toSlug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const stripped = toSlug(issuer.replace(/\([^)]*\)/g, " "));
  const full = toSlug(issuer);
  return [...new Set([stripped, full].filter((s) => s.length > 0))];
}

// Production R2 reference reader (D06 T02 §2 correction 1, §3 plan review gap 2): reads
// `ref/pop/<issuer slug>.pdf` from the artefacts bucket.
export function r2ReferenceOf(bucket: R2Bucket): ReferencePort {
  return async (issuer: string | null) => {
    for (const slug of issuerSlugs(issuer)) {
      const obj = await bucket.get(`ref/pop/${slug}.pdf`);
      if (obj) return new Uint8Array(await obj.arrayBuffer());
    }
    return null;
  };
}

// Persists `document.*` items to the case's current run under `producer = 'document'`, using the
// same atomic sequence-reuse and replacement batch as `addEvidence` (`src/checks/evidence.ts`).
// Coexists with `saveEvidence` (`producer = 'checks'`, which lifts and preserves any row whose
// `producer <> 'checks'`) and replaces only `producer = 'document'` rows when the step retries.
export async function saveDocumentEvidence(
  db: D1Database,
  caseId: string,
  items: EvidenceDraft[],
  now: () => Date = () => new Date(),
): Promise<Evidence[]> {
  const list = items.map((item, i) => {
    const parsed = StoredEvidence.safeParse({ ...item, id: `E${i + 1}` });
    if (!parsed.success)
      throw new EvidenceRefused(`evidence item ${i + 1} is malformed: ${z.prettifyError(parsed.error)}`);
    if (!DOCUMENT_CHECKS.has(parsed.data.check))
      throw new EvidenceRefused(`evidence item ${i + 1} is not in document's family: ${parsed.data.check}`);
    return parsed.data;
  });
  const at = now().toISOString();
  const held = (
    await db
      .prepare(
        `SELECT seq FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF} AND producer = 'document' ORDER BY seq`,
      )
      .bind(caseId, caseId)
      .all<{ seq: number }>()
  ).results.map((r) => r.seq);
  const inserts = list.map((e, i) => {
    const seq = held[i];
    if (seq !== undefined)
      return db
        .prepare(
          `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer)
           SELECT ?, r.run, ?, ?, ?, ?, ?, ?, ?, ?, 'document'
           FROM ${CURRENT_RUN_ROW} r`,
        )
        .bind(
          caseId,
          `E${seq}`,
          seq,
          e.check,
          e.severity,
          e.summary,
          JSON.stringify(e.detail),
          JSON.stringify(e.artefacts),
          at,
          caseId,
        );
    return db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer)
         SELECT ?, r.run, 'E' || (n.top + 1), n.top + 1, ?, ?, ?, ?, ?, ?, 'document'
         FROM ${CURRENT_RUN_ROW} r, (SELECT COALESCE(MAX(seq), 0) AS top FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF}) n`,
      )
      .bind(
        caseId,
        e.check,
        e.severity,
        e.summary,
        JSON.stringify(e.detail),
        JSON.stringify(e.artefacts),
        at,
        caseId,
        caseId,
        caseId,
      );
  });
  await db.batch([
    db
      .prepare(`DELETE FROM evidence WHERE case_id = ? AND run_id = ${CURRENT_RUN_OF} AND producer = 'document'`)
      .bind(caseId, caseId),
    ...inserts,
  ]);
  const ids = (await evidenceProducers(db, caseId)).filter((p) => p.producer === "document").map((p) => p.id);
  return list.map((e, i) => ({ ...e, id: ids[i] ?? e.id }));
}

export const limitItem = (artefactKey?: string): EvidenceDraft => ({
  check: "document.limit",
  severity: "info",
  summary: DOCUMENT_LIMIT.slice(0, 200),
  detail: { ...(artefactKey ? { attachment: artefactKey } : {}), limit: DOCUMENT_LIMIT },
  artefacts: artefactKey ? [artefactKey] : [],
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

const planRefusedItem = (artefactKeys: string[]): EvidenceDraft => ({
  check: "document.not_checked",
  severity: "info",
  summary:
    "Payment document checks require the Protect plan. Upgrade in your organisation settings and retry this case to check the document.".slice(
      0,
      200,
    ),
  detail: {
    checked: false,
    reason: "plan-required",
    feature: "payment-document",
    required_plan: "protect",
    recovery: "Upgrade to Protect in your organisation settings and retry this case.",
    ...(artefactKeys[0] ? { attachment: artefactKeys[0] } : {}),
  },
  artefacts: artefactKeys.slice(0, MAX_DOCUMENTS),
});

export function isForensicsIncomplete(report: PdfForensics, docType: PaymentDocument["type"] | null): boolean {
  if (report.unread.length > 0) return true;
  if (Object.values(report.coverage).some((c) => c.status === "partial")) return true;
  if (
    report.coverage.revisions.status !== "ran" ||
    report.coverage.fonts.status !== "ran" ||
    report.coverage.overlay.status !== "ran" ||
    report.coverage.producer.status !== "ran"
  ) {
    return true;
  }
  if ((docType === "pop" || report.issuer === "bank") && report.coverage.dates.status !== "ran") {
    return true;
  }
  return false;
}

export const notCheckedForensics = (report: PdfForensics, artefactKey: string): EvidenceDraft => {
  const firstReason =
    report.unread[0] ??
    Object.values(report.coverage).find((c) => c.status !== "ran" && c.reason)?.reason ??
    "some PDF forensic checks could not run";
  return {
    check: "document.not_checked",
    severity: "info",
    summary: `A payment document's file forensics could not run in full (${firstReason})`.slice(0, 200),
    detail: {
      checked: false,
      reason: "forensics-unavailable",
      unread: report.unread,
      coverage: forensicsCoverage(report),
      attachment: artefactKey,
    },
    artefacts: [artefactKey],
  };
};

export async function documentStep(deps: DocumentDeps, caseId: string, orgId: string): Promise<DocumentResult> {
  const artefacts = (await artefactsOf(deps.store, caseId, "attachment")).filter((a) =>
    isDocumentMediaType(a.mediaType),
  );
  const write =
    deps.write ?? (async (drafts: EvidenceDraft[]) => saveDocumentEvidence(deps.db, caseId, drafts, deps.now));
  if (!(await hasFeature(deps.db, orgId, "payment-document"))) {
    const keys = artefacts.map((a) => a.key);
    await write([
      planRefusedItem(keys),
      ...(keys.length > 0 ? keys.slice(0, MAX_DOCUMENTS).map((k) => limitItem(k)) : [limitItem(undefined)]),
    ]);
    return { outcome: "refused" };
  }
  if (artefacts.length === 0) return { outcome: "none" };
  const referenceOf = deps.referenceOf ?? r2ReferenceOf(deps.store.bucket);
  // Coexist with registered `document.forensics.*` checks from `saveEvidence` (`producer = 'checks'`):
  // if the `checks` producer already recorded forensic findings for an attachment in this run, do not
  // emit duplicate forensic items for that attachment under `producer = 'document'`.
  const existingProducers = new Set(
    (await evidenceProducers(deps.db, caseId).catch(() => []))
      .filter((p) => p.producer !== "document")
      .map((p) => p.id),
  );
  const existingChecksForensics = new Set(
    (await readEvidence(deps.db, caseId).catch(() => []))
      .filter((e) => existingProducers.has(e.id) && e.check.startsWith("document.forensics."))
      .flatMap((e) => e.artefacts.map((k) => `${k}:${e.check}`)),
  );
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
    let pdfReport: PdfForensics | null = null;
    if (artefact.mediaType === "application/pdf") {
      pdfReport = await analysePdf(body).catch(() => null);
      if (pdfReport) {
        const drafts = forensicsEvidence(pdfReport, {
          key: artefact.key,
          filename: artefact.key.split("/").pop() ?? "document",
        }).filter((d) => !existingChecksForensics.has(`${artefact.key}:${d.check}`));
        items.push(...drafts);
      } else {
        items.push(notCheckedDocument("forensics-failed", artefact.key));
      }
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
      { referenceOf, artefactKey: artefact.key },
    );
    if (pdfReport && isForensicsIncomplete(pdfReport, analysed.fields?.type ?? null)) {
      items.push(notCheckedForensics(pdfReport, artefact.key));
    }
    items.push(...analysed.items);
    if (analysed.fields?.type === "pop") items.push(popItem(artefact.key));
    await write([...items, limitItem(artefact.key)]).catch(() => undefined);
    if (analysed.fields) {
      try {
        items.push(
          ...(await beneficiaryEvidence(
            { db: deps.db, keys: await deps.keys() },
            { orgId, fields: analysed.fields, artefactKey: artefact.key },
          )),
        );
      } catch {
        items.push({
          check: "document.comparison_unavailable",
          severity: "info",
          summary: "A payment document beneficiary comparison could not run (error).",
          detail: { checked: false, reason: "error", comparison: "ledger", attachment: artefact.key },
          artefacts: [artefact.key],
        });
      }
    }
    items.push(limitItem(artefact.key));
  }
  for (const artefact of artefacts.slice(MAX_DOCUMENTS))
    items.push(notCheckedDocument("too-many-documents", artefact.key), limitItem(artefact.key));
  await write(items);
  return { outcome: "read", documents };
}

// Builds the rule-based verdict for a standalone document case, combining `ruleVerdict` (which
// enforces the deterministic floor and marks any safe verdict with `checked === false` items as
// partial) with `fixedActionsFor` (`POP_ACTION` for a POP) and `bankChangeAction` for a critical
// `document.beneficiary_mismatch`.
export function documentRuleVerdict(
  evidence: readonly Evidence[],
  options: { headersAvailable?: boolean } = {},
): VerdictView {
  const rules = ruleVerdict(evidence, { headersAvailable: options.headersAvailable ?? false });
  const fixed = [...fixedActionsFor(evidence)];
  if (evidence.some((e) => e.check === "document.beneficiary_mismatch") && !fixed.includes(bankChangeAction())) {
    fixed.unshift(bankChangeAction());
  }
  return {
    ...rules,
    actions: [...fixed, ...rules.actions.filter((a) => !fixed.includes(a))].slice(0, 10),
  };
}

// End-to-end standalone document evaluation: runs `documentStep`, reads back the stored evidence
// from D1, computes and stores the document verdict via `saveVerdict`, and returns the stored
// outcome, evidence and verdict.
export async function evaluateDocumentCase(
  deps: DocumentDeps,
  caseId: string,
  orgId: string,
  options: { headersAvailable?: boolean; replaceVerdict?: boolean } = {},
): Promise<{ step: DocumentResult; evidence: Evidence[]; verdict: VerdictView }> {
  const step = await documentStep(deps, caseId, orgId);
  const evidence = await readEvidence(deps.db, caseId);
  const verdict = documentRuleVerdict(evidence, options);
  if (options.replaceVerdict) {
    await deps.db.prepare("DELETE FROM case_verdicts WHERE case_id = ?").bind(caseId).run();
  }
  const saved = await saveVerdict(deps.db, caseId, verdict);
  if (!saved.ok) throw new Error(`storing the verdict: ${saved.error.code}`);
  return { step, evidence, verdict };
}
