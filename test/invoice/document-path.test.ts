// The standalone document step (D06 T02 §3): a document case's POP, invoice or bank letter runs
// forensics, extraction, R2 reference layout comparison and ledger/registry beneficiary matching,
// persists `document.*` evidence in D1 under `producer = 'document'` (`saveDocumentEvidence`),
// coexists with `saveEvidence` (`FORENSIC_CHECKS`), replaces stale items on retry, states every
// failure and plan refusal as a partial report (`checked: false`), and renders `POP_ACTION` and
// `DOCUMENT_LIMIT` on the report.
import { env } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { beforeEach, describe, expect, it } from "vitest";
import { floorFor } from "../../src/agent/floor";
import { createToolExecutor, runAgent } from "../../src/agent/loop";
import { PARTIAL_HEADLINE, PARTIAL_MEANING } from "../../src/agent/rule-verdict";
import { evidenceProducers, readCheckOutcomes, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { createCase } from "../../src/db/cases";
import { getVerdict } from "../../src/db/verdicts";
import { parsedKey, putAttachment, putParsed, type Store } from "../../src/intake/store";
import {
  DOCUMENT_LIMIT,
  documentStep,
  evaluateDocumentCase,
  isStandaloneDocumentCase,
  r2ReferenceOf,
} from "../../src/invoice/document-step";
import { bankChangeAction, POP_ACTION } from "../../src/invoice/fixed-actions";
import { analysePdf, FORENSIC_CHECKS, forensicsEvidence } from "../../src/invoice/forensics";
import { addSupplier, addSupplierAccount } from "../../src/invoice/ledger";
import { invoiceStep, recordInvoiceNotRun } from "../../src/invoice/step";
import { d1Budget } from "../../src/meta/budget";
import { checks, parse } from "../../src/pipeline/analysis-workflow";
import { addAccount, bankKeys } from "../../src/trust/bank";
import { setIdentity } from "../../src/trust/identity";
import { EvidenceCards } from "../../src/web/components/evidence/cards";
import { call, signIn, stubSmtp2go } from "../auth/helpers";
import { addInviteCode } from "../fixtures/auth/members";
import { generated } from "../fixtures/pdf-forensics/load";
import { makeOrg, protectableOrg } from "../trust/helpers";

const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const POP = {
  type: "pop" as const,
  issuer: "Kestrel Bank (fictional)",
  amount_cents: 410000,
  currency: "ZAR",
  paid_at: "2026-10-20",
  issued_at: null,
  reference: "PAY-9",
  beneficiary: { name: "Hadeda Couriers", account_number: "62004417731", branch_code: "250655" },
  layout_differences: [],
};

const INVOICE_DOC = {
  type: "invoice" as const,
  issuer: "Hadeda Couriers",
  amount_cents: 250000,
  currency: "ZAR",
  paid_at: null,
  issued_at: "2026-10-19",
  reference: "INV-204",
  beneficiary: { name: "Hadeda Couriers", account_number: "62004417731", branch_code: "250655" },
  layout_differences: [],
};

const BANK_LETTER = {
  type: "bank_letter" as const,
  issuer: "Kestrel Bank (fictional)",
  amount_cents: null,
  currency: "ZAR",
  paid_at: null,
  issued_at: "2026-10-18",
  reference: "CONF-77",
  beneficiary: { name: "Hadeda Couriers", account_number: "62004417731", branch_code: "250655" },
  layout_differences: [],
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

const answer = (body: unknown) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

const refusalAnswer = () =>
  new Response(
    JSON.stringify({
      id: "r-refused",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "policy refusal" }] }],
      usage: { input_tokens: 50, output_tokens: 5 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

const renderCards = (items: Awaited<ReturnType<typeof readEvidence>>, cited: string[] = []) =>
  String(jsx(EvidenceCards, { items, cited, file: (key: string) => `/a/case/${encodeURIComponent(key)}` }));

const storedVerdictOf = async (caseId: string) => {
  const res = await getVerdict(db, caseId);
  return res?.ok ? res.value : null;
};

beforeEach(async () => {
  await db.batch(
    [
      "supplier_accounts",
      "suppliers",
      "org_domains",
      "identities",
      "bank_accounts",
      "bank_key_epoch",
      "model_spend",
      "case_verdicts",
      "check_outcomes",
      "evidence",
      "cases",
      "artefacts",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  await env.ARTEFACTS.delete("ref/pop/kestrel-bank.pdf");
});

function harness(script: ((req?: RequestInit) => Response)[]) {
  let i = 0;
  const requests: string[] = [];
  const deps = {
    db,
    store,
    meta: {
      env: META,
      budget: d1Budget(db, { caller: "document-step-test" }),
      random: () => 0.5,
      sleep: async () => {},
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        const step = script[Math.min(i++, script.length - 1)];
        return step ? step(init) : answer(POP);
      }) as typeof fetch,
    },
    keys: () => bankKeys(env),
  };
  return { deps, requests, callCount: () => i };
}

async function seedSupplier(
  orgId: string,
  opts: { name?: string; domain?: string; number?: string; branchCode?: string } = {},
) {
  const keys = await bankKeys(env as unknown as Env);
  const sup = await addSupplier(db, orgId, "owner", {
    name: opts.name ?? "Hadeda Couriers",
    domains: [opts.domain ?? "hadedacouriers.co.za"],
    phone: null,
    notes: null,
  });
  await addSupplierAccount(db, keys, orgId, "owner", sup.id, {
    number: opts.number ?? "62004417731",
    branchCode: opts.branchCode ?? "250655",
    bankName: "Kestrel Bank (fictional)",
    holder: opts.name ?? "Hadeda Couriers",
  });
  return sup;
}

async function caseWithDocument(
  orgId: string,
  opts: {
    filename?: string;
    bytes?: Uint8Array;
    mediaType?: string;
    channel?: "upload" | "email";
    sourceKind?: "document" | "image" | "mail";
  } = {},
) {
  const mediaType = opts.mediaType ?? "application/pdf";
  const filename = opts.filename ?? (mediaType === "application/pdf" ? "pop.pdf" : "pop.png");
  const bytes = opts.bytes ?? generated["gs-genuine-pop.pdf"];
  const channel = opts.channel ?? "upload";
  const sourceKind =
    opts.sourceKind ?? (channel === "email" ? "mail" : mediaType.startsWith("image/") ? "image" : "document");
  const made = await createCase(
    db,
    channel === "upload"
      ? {
          orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "user-document",
          sourceKind,
          uploadName: filename,
          uploadMediaType: mediaType,
        }
      : {
          orgId,
          channel: "email",
          headersAvailable: true,
          sourceKind: "mail",
        },
  );
  if (!made.ok) throw new Error(made.error.message);
  const att = await putAttachment(store, made.value.id, filename, bytes, mediaType);
  return { caseId: made.value.id, artefactKey: att.key };
}

function nopExecutor(caseId = "01HZ0000000000000000000000") {
  return createToolExecutor(
    { db, caseId, urls: [] },
    {
      expand: async () => [],
      screenshot: async () => [],
      lookupDomain: async () => [],
      ledger: async () => [],
      walk: async () => [],
    },
  );
}

describe("the standalone document step (D06 T02 §3)", () => {
  it("classifies document/image uploads and empty-body single-PDF/image emails as standalone document cases", () => {
    expect(
      isStandaloneDocumentCase({
        sourceKind: "document",
        attachments: [{ mediaType: "application/pdf" }],
      }),
    ).toBe(true);
    for (const mediaType of ["image/png", "image/jpeg", "image/webp"]) {
      expect(
        isStandaloneDocumentCase({
          sourceKind: "image",
          attachments: [{ mediaType }],
        }),
      ).toBe(true);
      expect(
        isStandaloneDocumentCase({
          sourceKind: "email",
          textBody: "   ",
          htmlBody: "<div><style>body{}</style> &nbsp; </div>",
          attachments: [{ mediaType }],
        }),
      ).toBe(true);
    }
    expect(
      isStandaloneDocumentCase({
        sourceKind: "email",
        textBody: "",
        htmlBody: null,
        attachments: [{ mediaType: "application/pdf" }],
      }),
    ).toBe(true);
    expect(
      isStandaloneDocumentCase({
        sourceKind: "email",
        textBody: "Please see attached POP",
        htmlBody: null,
        attachments: [{ mediaType: "application/pdf" }],
      }),
    ).toBe(false);
    expect(
      isStandaloneDocumentCase({
        sourceKind: "email",
        textBody: "",
        htmlBody: null,
        attachments: [{ mediaType: "application/zip" }],
      }),
    ).toBe(false);
  });

  it("persists document.* evidence to D1, coexists with registered FORENSIC_CHECKS in saveEvidence, and replaces only document items on retry", async () => {
    const org = await makeOrg();
    await seedSupplier(org);
    const { caseId, artefactKey } = await caseWithDocument(org, {
      bytes: generated["gs-edited-pop.pdf"],
      filename: "edited-pop.pdf",
    });
    await env.ARTEFACTS.put("ref/pop/kestrel-bank.pdf", generated["gs-genuine-pop.pdf"]);

    // Register FORENSIC_CHECKS in a CheckRegistry and run saveEvidence (`producer = 'checks'`) first.
    const reg = new CheckRegistry();
    for (const name of FORENSIC_CHECKS) {
      reg.register({ name, timeoutMs: 1000, needs: ["attachments"], run: () => [] });
    }
    const pdfReport = await analysePdf(generated["gs-edited-pop.pdf"]);
    const checksForensics = forensicsEvidence(pdfReport, { key: artefactKey, filename: "edited-pop.pdf" });
    expect(checksForensics.map((f) => f.check)).toEqual(["document.forensics.revisions"]);
    await saveEvidence(db, caseId, checksForensics, reg);

    // Run documentStep (`producer = 'document'`): it coexists with `checks` and does not duplicate
    // `document.forensics.revisions` already recorded by `saveEvidence`.
    const first = harness([() => answer(POP), () => answer({ layout_differences: ["amounts"] })]);
    const res1 = await documentStep(first.deps, caseId, org);
    expect(res1).toEqual({ outcome: "read", documents: 1 });

    const stored1 = await readEvidence(db, caseId);
    const producers1 = await evidenceProducers(db, caseId);
    expect(producers1[0]?.producer).toBe("checks");
    expect(producers1.slice(1).every((p) => p.producer === "document")).toBe(true);
    expect(stored1.filter((e) => e.check === "document.forensics.revisions")).toHaveLength(1);
    expect(stored1.map((e) => e.check)).toContain("document.layout_mismatch");
    expect(stored1.map((e) => e.check)).toContain("document.beneficiary_match");
    expect(stored1.map((e) => e.check)).toContain("document.proof_of_payment");
    expect(stored1.map((e) => e.check)).toContain("document.limit");

    // Re-running saveEvidence lifts and preserves the `document` producer's rows.
    await saveEvidence(db, caseId, checksForensics, reg);
    const afterChecksRewrite = await readEvidence(db, caseId);
    expect(afterChecksRewrite.map((e) => e.check)).toEqual(stored1.map((e) => e.check));

    // Retrying documentStep replaces only `producer = 'document'` rows in D1.
    const second = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
    await documentStep(second.deps, caseId, org);
    const stored2 = await readEvidence(db, caseId);
    expect(stored2.filter((e) => e.check === "document.forensics.revisions")).toHaveLength(1);
    expect(stored2.map((e) => e.check)).not.toContain("document.layout_mismatch");
  });

  it("stores forensic findings in D1 for a doctored POP standalone and none on the genuine twin, and wires R2 reference bytes into layout comparison", async () => {
    const org = await makeOrg();
    await seedSupplier(org);
    const refBytes = generated["gs-genuine-pop.pdf"];
    await env.ARTEFACTS.put("ref/pop/kestrel-bank.pdf", refBytes);

    // Genuine POP: R2 reference bytes reach the second call, zero forensic findings, clean safe verdict with POP_ACTION and DOCUMENT_LIMIT.
    const genuineCase = await caseWithDocument(org, {
      bytes: generated["gs-genuine-pop.pdf"],
      filename: "genuine-pop.pdf",
    });
    const genuineHarness = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
    expect(await r2ReferenceOf(env.ARTEFACTS)("Kestrel Bank (fictional)")).toEqual(refBytes);
    const genuineEval = await evaluateDocumentCase(genuineHarness.deps, genuineCase.caseId, org);
    expect(genuineEval.step).toEqual({ outcome: "read", documents: 1 });
    expect(genuineHarness.callCount()).toBe(2);
    expect(genuineHarness.requests[1]).toContain("genuine-reference.pdf");
    expect(genuineEval.evidence.filter((e) => e.check.startsWith("document.forensics."))).toEqual([]);
    expect(genuineEval.evidence.map((e) => e.check)).not.toContain("document.not_checked");
    expect(genuineEval.verdict.verdict).toBe("safe");
    expect(genuineEval.verdict.headline).not.toBe(PARTIAL_HEADLINE);
    expect(genuineEval.verdict.actions[0]).toBe(POP_ACTION);
    const genuineHtml = renderCards(
      genuineEval.evidence,
      genuineEval.verdict.reasons.flatMap((r) => r.evidenceIds),
    );
    expect(genuineHtml).toContain("Confirm the money has cleared in your own banking app before releasing goods.");
    expect(genuineHtml).toContain(DOCUMENT_LIMIT);

    // Doctored POP (`gs-substituted-font.pdf`): stores `document.forensics.fonts` in D1.
    const doctoredCase = await caseWithDocument(org, {
      bytes: generated["gs-substituted-font.pdf"],
      filename: "doctored-pop.pdf",
    });
    const doctoredHarness = harness([() => answer(POP), () => answer({ layout_differences: ["amounts"] })]);
    const doctoredEval = await evaluateDocumentCase(doctoredHarness.deps, doctoredCase.caseId, org);
    expect(doctoredEval.evidence.map((e) => e.check)).toContain("document.forensics.fonts");
    expect(doctoredEval.evidence.map((e) => e.check)).toContain("document.layout_mismatch");
  });

  it("evaluates POPs, invoices and bank letters across PDF, PNG, JPEG and WebP, persists ledger and registry matches, constrains beneficiary mismatches to malicious, and renders DOCUMENT_LIMIT on the report", async () => {
    const org = await makeOrg();
    await seedSupplier(org, { domain: "hadedacouriers.co.za", number: "62004417731", branchCode: "250655" });
    const protectedOrg = await protectableOrg("hadedacouriers.co.za", "money@hadedacouriers.co.za");
    await setIdentity(db, protectedOrg, "owner", {
      displayNames: ["Hadeda Couriers"],
      financeContact: "money@hadedacouriers.co.za",
      protected: true,
    });
    const keys = await bankKeys(env as unknown as Env);
    await addAccount(db, keys, protectedOrg, "owner", {
      number: "62004417731",
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Hadeda Couriers",
    });
    await env.ARTEFACTS.put("ref/pop/kestrel-bank.pdf", generated["gs-genuine-pop.pdf"]);

    // 1. Image POPs across PNG, JPEG and WebP, plus an empty-body emailed POP:
    for (const [mediaType, bytes, channel] of [
      ["image/png", PNG_BYTES, "upload"],
      ["image/jpeg", JPEG_BYTES, "upload"],
      ["image/webp", WEBP_BYTES, "upload"],
      ["application/pdf", generated["gs-genuine-pop.pdf"], "email"],
    ] as const) {
      const { caseId } = await caseWithDocument(org, {
        mediaType,
        bytes,
        channel,
        filename: mediaType === "application/pdf" ? "emailed.pdf" : `pop.${mediaType.split("/")[1]}`,
      });
      const h = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
      const out = await evaluateDocumentCase(h.deps, caseId, org, { headersAvailable: channel === "email" });
      const checks = out.evidence.map((e) => e.check);
      expect(checks).toContain("document.type");
      expect(checks).toContain("document.proof_of_payment");
      expect(checks).toContain("document.limit");
      expect(out.evidence.filter((e) => e.check === "document.beneficiary_match")).toHaveLength(2); // ledger + registry
      expect(out.verdict.actions).toContain(POP_ACTION);
      const html = renderCards(out.evidence);
      expect(html).toContain(DOCUMENT_LIMIT);
      expect(html).toContain("Confirm the money has cleared in your own banking app before releasing goods.");
    }

    // 2. Invoice and bank letter documents: persist and render DOCUMENT_LIMIT on the report without POP_ACTION.
    for (const doc of [INVOICE_DOC, BANK_LETTER]) {
      const { caseId } = await caseWithDocument(org, {
        mediaType: "image/png",
        bytes: PNG_BYTES,
        filename: `${doc.type}.png`,
      });
      const h = harness([() => answer(doc)]);
      const out = await evaluateDocumentCase(h.deps, caseId, org);
      expect(out.evidence.map((e) => e.check)).toContain("document.type");
      expect(out.evidence.map((e) => e.check)).toContain("document.limit");
      expect(out.evidence.map((e) => e.check)).not.toContain("document.proof_of_payment");
      expect(out.verdict.actions).not.toContain(POP_ACTION);
      const html = renderCards(out.evidence);
      expect(html).toContain(DOCUMENT_LIMIT);
      expect(html).toContain("What this check cannot show");
    }

    // 3. Beneficiary mismatch (critical): constrains floorFor, evaluateDocumentCase, and runAgent (even when the model
    // attempts to return "safe") to "malicious", and keeps POP_ACTION and bankChangeAction on both agent and rule fallback.
    const mismatchedPop = {
      ...POP,
      beneficiary: { name: "Hadeda Couriers", account_number: "99999999999", branch_code: "250655" },
    };
    const mismatchCase = await caseWithDocument(org, {
      bytes: generated["gs-genuine-pop.pdf"],
      filename: "mismatch-pop.pdf",
    });
    const mh = harness([() => answer(mismatchedPop), () => answer({ layout_differences: [] })]);
    const mismatchEval = await evaluateDocumentCase(mh.deps, mismatchCase.caseId, org);
    expect(mismatchEval.evidence.filter((e) => e.check === "document.beneficiary_mismatch")).toHaveLength(2);
    expect(floorFor(mismatchEval.evidence).verdict).toBe("malicious");
    expect(mismatchEval.verdict.verdict).toBe("malicious");
    expect(mismatchEval.verdict.actions).toContain(bankChangeAction());
    expect(mismatchEval.verdict.actions).toContain(POP_ACTION);

    // Agent attempts to return "safe", but floor enforces "malicious" and preserves POP_ACTION; rule fallback also preserves POP_ACTION.
    await db.prepare("DELETE FROM case_verdicts WHERE case_id = ?").bind(mismatchCase.caseId).run();
    const mismatchItem = mismatchEval.evidence.find((e) => e.check === "document.beneficiary_mismatch");
    if (!mismatchItem) throw new Error("expected document.beneficiary_mismatch");
    const agentView = await runAgent(
      {
        db,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "agent-test" }),
          fetch: (async () =>
            answer({
              verdict: "safe",
              confidence: 0.9,
              headline: "Looks fine",
              explanation: `Checked [${mismatchItem.id}].`,
              cited_evidence_ids: [mismatchItem.id],
              recommended_actions: ["Release the goods."],
              meaning: "Nothing looked wrong.",
            })) as typeof fetch,
        },
        summary: "Uploaded POP",
        headersAvailable: false,
        executor: nopExecutor(),
      },
      mismatchCase.caseId,
    );
    expect(agentView.verdict).toBe("malicious");
    expect(agentView.floorApplied?.to).toBe("malicious");
    expect(agentView.actions).toContain(POP_ACTION);
    expect((await storedVerdictOf(mismatchCase.caseId))?.verdict).toBe("malicious");

    // Rule-based fallback in runAgent when model fails on a POP case: keeps POP_ACTION and DOCUMENT_LIMIT.
    const fallbackCaseId = await genuineCaseIdForFallback(org);
    const fallbackView = await runAgent(
      {
        db,
        meta: {
          env: META,
          budget: d1Budget(db, { caller: "agent-fallback-test" }),
          fetch: (async () => new Response("server error", { status: 500 })) as typeof fetch,
        },
        summary: "Uploaded POP",
        headersAvailable: false,
        executor: nopExecutor(),
      },
      fallbackCaseId,
    );
    async function genuineCaseIdForFallback(orgId: string) {
      const c = await caseWithDocument(orgId, {
        bytes: generated["gs-genuine-pop.pdf"],
        filename: "fallback-pop.pdf",
      });
      const fh = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
      await documentStep(fh.deps, c.caseId, orgId);
      return c.caseId;
    }
    expect(fallbackView.source).toBe("rules");
    expect(fallbackView.actions).toContain(POP_ACTION);
  });

  it("turns extraction refusal, invalid output, provider failure, unreadable files and unavailable forensic coverage into partial reports, and replaces stale failure evidence on a successful retry", async () => {
    const org = await makeOrg();
    await seedSupplier(org);
    await env.ARTEFACTS.put("ref/pop/kestrel-bank.pdf", generated["gs-genuine-pop.pdf"]);

    const scenarios: {
      name: string;
      setup: () => Promise<{ caseId: string; artefactKey: string; script: (() => Response)[] }>;
      repair?: (caseId: string, artefactKey: string) => Promise<void>;
    }[] = [
      {
        name: "extraction refusal",
        setup: async () => {
          const c = await caseWithDocument(org, { bytes: generated["gs-genuine-pop.pdf"] });
          return { ...c, script: [() => refusalAnswer()] };
        },
      },
      {
        name: "invalid structured output",
        setup: async () => {
          const c = await caseWithDocument(org, { bytes: generated["gs-genuine-pop.pdf"] });
          return { ...c, script: [() => answer({ type: "not-a-valid-type" })] };
        },
      },
      {
        name: "provider failure",
        setup: async () => {
          const c = await caseWithDocument(org, { bytes: generated["gs-genuine-pop.pdf"] });
          return { ...c, script: [() => new Response("upstream error", { status: 502 })] };
        },
      },
      {
        name: "unreadable file in R2",
        setup: async () => {
          const c = await caseWithDocument(org, { bytes: generated["gs-genuine-pop.pdf"] });
          await env.ARTEFACTS.delete(c.artefactKey);
          return { ...c, script: [() => answer(POP)] };
        },
        repair: async (_caseId, artefactKey) => {
          await env.ARTEFACTS.put(artefactKey, generated["gs-genuine-pop.pdf"]);
        },
      },
      {
        name: "unavailable PDF forensic coverage",
        setup: async () => {
          // A damaged/minimal PDF with no xref chain has `unavailable` forensic coverage even when model extraction succeeds.
          const c = await caseWithDocument(org, {
            bytes: new TextEncoder().encode("%PDF-1.4 damaged"),
            filename: "damaged.pdf",
          });
          return { ...c, script: [() => answer(POP), () => answer({ layout_differences: [] })] };
        },
        repair: async (_caseId, artefactKey) => {
          await env.ARTEFACTS.put(artefactKey, generated["gs-genuine-pop.pdf"]);
        },
      },
    ];

    for (const scenario of scenarios) {
      const { caseId, artefactKey, script } = await scenario.setup();
      const failedHarness = harness(script);
      const failedEval = await evaluateDocumentCase(failedHarness.deps, caseId, org);

      const notChecked = failedEval.evidence.find((e) => e.check === "document.not_checked");
      expect(notChecked, `${scenario.name}: expected document.not_checked`).toBeDefined();
      expect(notChecked?.detail.checked).toBe(false);
      expect(failedEval.evidence.map((e) => e.check)).toContain("document.limit");

      // Missing analysis cannot become an ordinary clean result: verdict is partial with capped confidence and cites the failure.
      const storedVerdict = await storedVerdictOf(caseId);
      expect(storedVerdict?.verdict).toBe("safe");
      expect(storedVerdict?.headline).toBe(PARTIAL_HEADLINE);
      expect(storedVerdict?.meaning).toBe(PARTIAL_MEANING);
      expect(storedVerdict?.confidence).toBeLessThanOrEqual(0.5);
      expect(storedVerdict?.reasons.flatMap((r) => r.evidenceIds)).toContain(notChecked?.id);
      const failedHtml = renderCards(
        failedEval.evidence,
        failedEval.verdict.reasons.flatMap((r) => r.evidenceIds),
      );
      expect(failedHtml).toContain("A payment document that could not be read");
      expect(failedHtml).toContain(DOCUMENT_LIMIT);

      // A successful retry on the same case replaces the stale failure evidence and produces a non-partial report.
      if (scenario.repair) await scenario.repair(caseId, artefactKey);
      const retryHarness = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
      const retried = await evaluateDocumentCase(retryHarness.deps, caseId, org, { replaceVerdict: true });
      expect(retried.evidence.map((e) => e.check)).not.toContain("document.not_checked");
      expect(retried.verdict.headline).not.toBe(PARTIAL_HEADLINE);
      expect(retried.verdict.actions[0]).toBe(POP_ACTION);
    }
  });

  it("refuses an unentitled organisation with zero model calls, persists the plan-required explanation and recovery action on the report, and replaces it on retry after upgrade", async () => {
    const org = await makeOrg();
    await seedSupplier(org);
    await env.ARTEFACTS.put("ref/pop/kestrel-bank.pdf", generated["gs-genuine-pop.pdf"]);
    const aged = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await db.prepare('UPDATE "organization" SET "createdAt" = ? WHERE id = ?').bind(aged, org).run();

    const { caseId } = await caseWithDocument(org, {
      channel: "email",
      bytes: generated["gs-genuine-pop.pdf"],
      filename: "emailed-pop.pdf",
    });
    const refusedHarness = harness([() => answer(POP)]);
    const refused = await evaluateDocumentCase(refusedHarness.deps, caseId, org, { headersAvailable: true });
    expect(refused.step).toEqual({ outcome: "refused" });
    expect(refusedHarness.callCount()).toBe(0);

    // Persisted refusal state gives the member the plan requirement, recovery action, and mandatory document limit.
    expect(refused.evidence.map((e) => e.check)).toEqual(["document.not_checked", "document.limit"]);
    expect(refused.evidence[0]?.detail).toMatchObject({
      checked: false,
      reason: "plan-required",
      feature: "payment-document",
      required_plan: "protect",
      recovery: "Upgrade to Protect in your organisation settings and retry this case.",
    });
    expect(renderCards(refused.evidence)).toContain(DOCUMENT_LIMIT);
    const storedVerdict = await storedVerdictOf(caseId);
    expect(storedVerdict?.headline).toBe(PARTIAL_HEADLINE);
    expect(storedVerdict?.reasons[0]?.text).toContain("Payment document checks require the Protect plan");
    expect(storedVerdict?.reasons[0]?.text).toContain("Upgrade in your organisation settings and retry this case");

    // Once the organisation is entitled and retries the case, the refusal item is replaced by the full document check.
    const freshNow = new Date().toISOString();
    await db.prepare('UPDATE "organization" SET "createdAt" = ? WHERE id = ?').bind(freshNow, org).run();
    const retryHarness = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
    const retried = await evaluateDocumentCase(retryHarness.deps, caseId, org, {
      headersAvailable: true,
      replaceVerdict: true,
    });
    expect(retried.step).toEqual({ outcome: "read", documents: 1 });
    expect(retried.evidence.map((e) => e.check)).not.toContain("document.not_checked");
    expect(retried.verdict.actions).toContain(POP_ACTION);

    // Upload route admission gate (`requireFeature("payment-document")`): an unentitled organisation is refused at POST /api/upload with 403 before creating a case.
    const email = `doc-upload-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const code = `code-${crypto.randomUUID()}`;
    await addInviteCode(db, code);
    const smtp = stubSmtp2go();
    try {
      const made = await call("/api/auth/sign-up/invite-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, organizationName: "Doc Upload Org", consent: true }),
      });
      expect(made.status).toBe(201);
    } finally {
      smtp.restore();
    }
    const { cookie } = await signIn(email);
    const memberOrg = await db
      .prepare('SELECT id FROM "organization" WHERE name = ?')
      .bind("Doc Upload Org")
      .first<{ id: string }>();
    await db.prepare('UPDATE "organization" SET "createdAt" = ? WHERE id = ?').bind(aged, memberOrg?.id).run();
    const form = new FormData();
    form.append("file", new Blob([generated["gs-genuine-pop.pdf"]], { type: "application/pdf" }), "pop.pdf");
    const uploadRefused = await call("/api/upload", {
      method: "POST",
      body: form,
      headers: { accept: "application/json", cookie },
    });
    expect(uploadRefused.status).toBe(403);
    expect(await uploadRefused.json()).toMatchObject({
      code: "plan",
      feature: "payment-document",
      plans: ["protect", "msp"],
    });
  });

  it("routes uploaded documents/images and empty-body emails through the production Workflow's parse and invoiceStep, and runs PDF forensics on non-standalone mail attachments", async () => {
    const org = await makeOrg();
    await seedSupplier(org);
    await env.ARTEFACTS.put("ref/pop/kestrel-bank.pdf", generated["gs-genuine-pop.pdf"]);

    // 1. Uploaded PDF POP through production `parse` -> `invoiceStep` -> `runAgent`:
    const uploadedPdf = await caseWithDocument(org, {
      channel: "upload",
      sourceKind: "document",
      bytes: generated["gs-edited-pop.pdf"],
      filename: "uploaded-pop.pdf",
    });
    await parse(store, uploadedPdf.caseId, { channel: "upload", sourceKind: "document", headersAvailable: false });
    const hUpload = harness([() => answer(POP), () => answer({ layout_differences: ["amounts"] })]);
    const stepRes1 = await invoiceStep({ ...hUpload.deps, waitUntil: () => {} }, uploadedPdf.caseId, org);
    expect(stepRes1).toEqual({ outcome: "read", invoices: 1 });
    const ev1 = await readEvidence(db, uploadedPdf.caseId);
    expect(ev1.map((e) => e.check)).toContain("document.forensics.revisions");
    expect(ev1.map((e) => e.check)).toContain("document.type");
    expect(ev1.map((e) => e.check)).toContain("document.layout_mismatch");
    expect(ev1.map((e) => e.check)).toContain("document.beneficiary_match");
    expect(ev1.map((e) => e.check)).toContain("document.proof_of_payment");
    expect(ev1.map((e) => e.check)).toContain("document.limit");

    // 2. Empty-body emailed PNG POP through `parsed.json` -> `checks` -> `invoiceStep` skips mail checks:
    const emailedImg = await caseWithDocument(org, {
      channel: "email",
      sourceKind: "mail",
      mediaType: "image/png",
      bytes: PNG_BYTES,
      filename: "emailed-pop.png",
    });
    await putParsed(store, emailedImg.caseId, {
      headers: [
        { name: "Received", value: "from mail.evil.example by mx.google.com; Mon, 02 Nov 2026 10:00:00 +0000" },
        { name: "Authentication-Results", value: "mx.google.com; spf=fail smtp.mailfrom=evil.example" },
        { name: "From", value: "Fynbos Bank <alerts@evil.example>" },
        { name: "Reply-To", value: "attacker@other.example" },
        { name: "Subject", value: "POP" },
      ],
      text: "   ",
      html: "<div></div>",
      attachments: [
        {
          key: emailedImg.artefactKey,
          filename: "emailed-pop.png",
          mediaType: "image/png",
          contentId: null,
          disposition: "attachment",
          bytes: PNG_BYTES.length,
        },
      ],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, emailedImg.caseId, parsedKey(emailedImg.caseId), { orgId: org, channel: "email" }, async () => [
      "mx.google.com",
    ]);
    const hEmail = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
    const stepRes2 = await invoiceStep({ ...hEmail.deps, waitUntil: () => {} }, emailedImg.caseId, org);
    expect(stepRes2).toEqual({ outcome: "read", invoices: 1 });
    const ev2 = await readEvidence(db, emailedImg.caseId);
    expect(ev2.some((e) => e.check.startsWith("auth.") || e.check.startsWith("sender."))).toBe(false);
    const outcomes2 = await readCheckOutcomes(db, emailedImg.caseId);
    expect((outcomes2 ?? []).some((o) => o.check.startsWith("auth.") || o.check.startsWith("sender."))).toBe(false);
    expect(ev2.map((e) => e.check)).toContain("document.type");
    expect(ev2.map((e) => e.check)).toContain("document.proof_of_payment");
    expect(ev2.map((e) => e.check)).toContain("document.limit");

    // 3. `recordInvoiceNotRun` on a standalone document case writes `document.not_checked` + `document.limit`:
    await recordInvoiceNotRun(store, emailedImg.caseId, "error");
    const evAfterFail = await readEvidence(db, emailedImg.caseId);
    expect(evAfterFail.filter((e) => e.check.startsWith("document.")).map((e) => e.check)).toEqual([
      "document.not_checked",
      "document.limit",
    ]);

    // 4. Non-standalone mail case with a doctored PDF attachment runs PDF forensics alongside invoice extraction, retains them on retry, and deduplicates checks-owned forensics:
    const regularMail = await caseWithDocument(org, {
      channel: "email",
      sourceKind: "mail",
      bytes: generated["gs-edited-pop.pdf"],
      filename: "attached-invoice.pdf",
    });
    await putParsed(store, regularMail.caseId, {
      source: { kind: "message" },
      forward: { headersAvailable: true },
      headers: [{ name: "Subject", value: "Invoice" }],
      text: "Please pay the attached invoice today.",
      html: null,
      attachments: [{ key: regularMail.artefactKey, filename: "attached-invoice.pdf", mediaType: "application/pdf" }],
    });
    const invoiceReply = () =>
      answer({
        is_invoice: true,
        supplier_name: "Hadeda Couriers",
        supplier_domain: "hadedacouriers.co.za",
        bank_name: "Kestrel Bank (fictional)",
        account_holder: "Hadeda Couriers",
        account_number: "62004417731",
        branch_code: "250655",
        amount_cents: 410000,
        currency: "ZAR",
        reference: "INV-9",
        due_date: "2026-11-30",
      });
    const hRegular = harness([invoiceReply, invoiceReply, invoiceReply]);
    await invoiceStep({ ...hRegular.deps, waitUntil: () => {} }, regularMail.caseId, org);
    await invoiceStep({ ...hRegular.deps, waitUntil: () => {} }, regularMail.caseId, org);
    const evRegular = await readEvidence(db, regularMail.caseId);
    expect(evRegular.map((e) => e.check)).toContain("invoice.detected");
    expect(evRegular.filter((e) => e.check === "document.forensics.revisions")).toHaveLength(1);
    const prodBeforeChecks = await evidenceProducers(db, regularMail.caseId);
    expect(prodBeforeChecks.some((p) => p.producer === "document")).toBe(true);

    // When `checks` already owns `document.forensics.revisions`, `invoiceStep` deduplicates it instead of emitting a second copy:
    const checksReg = new CheckRegistry();
    for (const c of FORENSIC_CHECKS)
      checksReg.register({ name: c, timeoutMs: 1000, needs: ["attachments"], run: () => [] });
    await saveEvidence(
      db,
      regularMail.caseId,
      [
        {
          check: "document.forensics.revisions",
          severity: "high",
          summary: "The PDF was saved again after its first version.",
          detail: { revisions: 2 },
          artefacts: [regularMail.artefactKey],
        },
      ],
      checksReg,
    );
    await invoiceStep({ ...hRegular.deps, waitUntil: () => {} }, regularMail.caseId, org);
    const evCoexisting = await readEvidence(db, regularMail.caseId);
    expect(evCoexisting.filter((e) => e.check === "document.forensics.revisions")).toHaveLength(1);

    // 5. Ordinary-mail attachment with incomplete PDF forensic coverage persists `document.not_checked` (`forensics-unavailable`) and replaces it on retry with a complete PDF:
    const incompletePdfBytes = (() => {
      const objs = [
        "",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        "<< /Length 4 >>\nstream\nBT\nendstream",
      ];
      let out = "%PDF-1.4\n";
      const offs = [0];
      for (let n = 1; n < objs.length; n++) {
        offs[n] = out.length;
        out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
      }
      const xref = out.length;
      out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
      for (let n = 1; n < objs.length; n++) out += `${String(offs[n]).padStart(10, "0")} 00000 n \n`;
      out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return new TextEncoder().encode(out);
    })();
    const incompleteMail = await caseWithDocument(org, {
      channel: "email",
      sourceKind: "mail",
      bytes: incompletePdfBytes,
      filename: "incomplete-invoice.pdf",
    });
    await putParsed(store, incompleteMail.caseId, {
      source: { kind: "message" },
      forward: { headersAvailable: true },
      headers: [{ name: "Subject", value: "Invoice" }],
      text: "Please pay the attached invoice.",
      html: null,
      attachments: [
        { key: incompleteMail.artefactKey, filename: "incomplete-invoice.pdf", mediaType: "application/pdf" },
      ],
    });
    await invoiceStep({ ...harness([invoiceReply]).deps, waitUntil: () => {} }, incompleteMail.caseId, org);
    const evIncomplete = await readEvidence(db, incompleteMail.caseId);
    expect(evIncomplete.map((e) => e.check)).toContain("document.not_checked");
    expect(evIncomplete.find((e) => e.check === "document.not_checked")?.detail).toMatchObject({
      checked: false,
      reason: "forensics-unavailable",
    });
    // Replace the attachment in R2 with a complete PDF and re-run on a fresh case or replace the object:
    await env.ARTEFACTS.put(incompleteMail.artefactKey, generated["gs-genuine-pop.pdf"], {
      httpMetadata: { contentType: "application/pdf" },
    });
    await db
      .prepare("DELETE FROM evidence WHERE case_id = ? AND producer = 'invoice'")
      .bind(incompleteMail.caseId)
      .run();
    await invoiceStep({ ...harness([invoiceReply]).deps, waitUntil: () => {} }, incompleteMail.caseId, org);
    const evRecovered = await readEvidence(db, incompleteMail.caseId);
    expect(evRecovered.map((e) => e.check)).not.toContain("document.not_checked");
  });
});
