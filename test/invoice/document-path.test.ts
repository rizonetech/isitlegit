// The standalone document step (D06 T02 §3): a document case's POP runs forensics, extraction,
// layout comparison and matching, and every document case carries the limit statement. The
// Workflow routing is the checks lane's; this proves the step it will call, with its writer
// injected until `document` joins LATER_PRODUCERS.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { EvidenceDraft } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment, type Store } from "../../src/intake/store";
import { documentStep } from "../../src/invoice/document-step";
import { d1Budget } from "../../src/meta/budget";
import { bankKeys } from "../../src/trust/bank";
import { makeOrg } from "../trust/helpers";

const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const POP = {
  type: "pop",
  issuer: "Kestrel Bank (fictional)",
  amount_cents: 410000,
  currency: "ZAR",
  paid_at: "2026-10-20",
  issued_at: null,
  reference: "PAY-9",
  beneficiary: { name: "Hadeda Couriers", account_number: "62004417731", branch_code: "250655" },
  layout_differences: [],
};

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

beforeEach(async () => {
  await db.batch(
    ["supplier_accounts", "suppliers", "bank_key_epoch", "model_spend", "evidence", "cases", "artefacts"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
});

function harness(script: (() => Response)[]) {
  let i = 0;
  const written: EvidenceDraft[][] = [];
  const deps = {
    db,
    store,
    meta: {
      env: META,
      budget: d1Budget(db, { caller: "document-step-test" }),
      random: () => 0.5,
      sleep: async () => {},
      fetch: (async () => script[Math.min(i++, script.length - 1)]?.() ?? answer(POP)) as typeof fetch,
    },
    keys: () => bankKeys(env),
    referenceOf: async () => new TextEncoder().encode("%PDF-genuine"),
    write: async (items: EvidenceDraft[]) => {
      written.push(items);
    },
  };
  return { deps, written };
}

async function caseWithPdf(orgId: string) {
  const made = await createCase(db, {
    orgId,
    channel: "upload",
    headersAvailable: false,
    uploadedBy: "user-document",
    sourceKind: "document",
    uploadName: "pop.pdf",
    uploadMediaType: "application/pdf",
  });
  if (!made.ok) throw new Error(made.error.message);
  await putAttachment(
    store,
    made.value.id,
    "pop.pdf",
    new TextEncoder().encode("%PDF-1.4 synthetic"),
    "application/pdf",
  );
  return made.value.id;
}

describe("the standalone document step", () => {
  it("runs a POP through extraction and carries the fixed action trigger and the limit", async () => {
    const org = await makeOrg();
    const caseId = await caseWithPdf(org);
    const { deps, written } = harness([() => answer(POP), () => answer({ layout_differences: [] })]);
    const result = await documentStep(deps, caseId, org);
    expect(result).toEqual({ outcome: "read", documents: 1 });
    const checks = written[0]?.map((i) => i.check) ?? [];
    expect(checks).toContain("document.type");
    expect(checks).toContain("document.proof_of_payment");
    expect(checks).toContain("document.limit");
    const limit = written[0]?.find((i) => i.check === "document.limit");
    expect(limit?.summary).toContain("cannot prove that a payment was made");
  });

  it("refuses an organisation without the payment-document feature, with nothing written", async () => {
    const org = await makeOrg();
    const aged = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await db.prepare('UPDATE "organization" SET "createdAt" = ? WHERE id = ?').bind(aged, org).run();
    const caseId = await caseWithPdf(org);
    const { deps, written } = harness([() => answer(POP)]);
    expect(await documentStep(deps, caseId, org)).toEqual({ outcome: "refused" });
    expect(written).toEqual([]);
  });
});
