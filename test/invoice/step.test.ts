// The invoice step (D06 T01 §1; spec 4.5): a case's PDF attachments read by Muse Spark over a stubbed
// transport, the detected evidence masked, the payee account sealed for §6, failures stated and never
// creating an account, and a replay replacing rather than accumulating.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment, type Store } from "../../src/intake/store";
import { readCaseInvoiceAccount } from "../../src/invoice/case-accounts";
import { addSupplier, addSupplierAccount } from "../../src/invoice/ledger";
import { invoiceStep, recordInvoiceNotRun } from "../../src/invoice/step";
import { d1Budget } from "../../src/meta/budget";
import { bankKeys } from "../../src/trust/bank";
import { makeOrg } from "../trust/helpers";

const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const FIELDS = {
  is_invoice: true,
  supplier_name: "Karoo Parts (Pty) Ltd",
  supplier_domain: "karooparts.co.za",
  bank_name: "Kestrel Bank (fictional)",
  account_holder: "Karoo Parts (Pty) Ltd",
  account_number: "06200441773",
  branch_code: "250655",
  amount_cents: 123456,
  currency: "ZAR",
  reference: "INV-1042",
  due_date: "2026-11-30",
};

beforeEach(async () => {
  await db.batch(
    [
      "case_invoice_accounts",
      "supplier_accounts",
      "suppliers",
      "bank_key_epoch",
      "model_spend",
      "evidence",
      "cases",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

async function caseOf(orgId: string) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

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
const refusal = () =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

function deps(script: (() => Response)[]) {
  let i = 0;
  return {
    db,
    store,
    meta: {
      env: META,
      budget: d1Budget(db, { caller: "invoice-step-test" }),
      random: () => 0.5,
      sleep: async () => {},
      fetch: (async () => script[Math.min(i++, script.length - 1)]?.() ?? refusal()) as typeof fetch,
    },
    keys: () => bankKeys(env),
    waitUntil: () => {},
  };
}

const pdf = new TextEncoder().encode("%PDF-1.4 synthetic");

function makePdf(pages: number): Uint8Array {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < pages; i++) {
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const stream = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe("the invoice step", () => {
  it("reads an attached invoice, states it masked and seals its account", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    const got = await invoiceStep(deps([() => answer(FIELDS)]), caseId, org);
    expect(got).toEqual({ outcome: "read", invoices: 1 });
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.detected"]);
    expect(JSON.stringify(items)).not.toContain("06200441773");
    const artefact = items[0]?.artefacts[0] as string;
    const account = await readCaseInvoiceAccount(db, await bankKeys(env), org, caseId, artefact);
    expect(account?.number).toBe("06200441773");
    // A replay replaces, never accumulates.
    await invoiceStep(deps([() => answer(FIELDS)]), caseId, org);
    const again = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(again.map((e) => e.check)).toEqual(["invoice.detected"]);
  });

  it("writes the bank-change rule beside the extraction it judged, in one producer write", async () => {
    const org = await makeOrg();
    const { id: supplierId } = await addSupplier(db, org, "owner", {
      name: "Karoo Parts",
      domains: ["karooparts.co.za"],
      phone: "+27 21 555 0100",
      notes: null,
    });
    await addSupplierAccount(db, await bankKeys(env), org, "owner", supplierId, {
      number: "06200441773",
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    await invoiceStep(deps([() => answer({ ...FIELDS, account_number: "06200441774" })]), caseId, org);
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.detected", "invoice.bank_changed"]);
    expect(items[1]?.severity).toBe("critical");
    expect(items[1]?.detail).toMatchObject({ supplier_id: supplierId, against: "ledger" });
    // A replay on a flagged invoice reuses the settled detection and sealed account without calling the model again.
    const replayed = await invoiceStep(deps([]), caseId, org);
    expect(replayed).toEqual({ outcome: "read", invoices: 1 });
    const afterReplay = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(afterReplay.map((e) => e.check)).toEqual(["invoice.detected", "invoice.bank_changed"]);
    expect(afterReplay[1]?.detail).toMatchObject({ supplier_id: supplierId, against: "ledger" });
  });

  it("a non-invoice states nothing and seals nothing", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "letter.pdf", pdf, "application/pdf");
    await invoiceStep(deps([() => answer({ ...FIELDS, is_invoice: false })]), caseId, org);
    expect((await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."))).toEqual([]);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("an invoice with no stated account is detected and seals nothing", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    await invoiceStep(deps([() => answer({ ...FIELDS, account_number: null, branch_code: null })]), caseId, org);
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.detected"]);
    expect(items[0]?.summary).toContain("no account stated");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("a failed reading is stated not_checked and seals nothing", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    const got = await invoiceStep(deps([() => refusal()]), caseId, org);
    expect(got.outcome).toBe("not_checked");
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.not_checked"]);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("a case with no PDF runs no call", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    const got = await invoiceStep(deps([]), caseId, org);
    expect(got).toEqual({ outcome: "none" });
  });

  it("an interruption between the evidence and the account leaves a stated invoice and no account, and a replay seals it", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    await db.exec(
      "CREATE TRIGGER fail_case_accounts BEFORE INSERT ON case_invoice_accounts BEGIN SELECT RAISE(ABORT, 'accounts down'); END",
    );
    try {
      await expect(invoiceStep(deps([() => answer(FIELDS)]), caseId, org)).rejects.toThrow();
    } finally {
      await db.exec("DROP TRIGGER IF EXISTS fail_case_accounts");
    }
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.detected"]);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts").first<{ n: number }>();
    expect(n?.n).toBe(0);
    await invoiceStep(deps([() => answer(FIELDS)]), caseId, org);
    const keys = await bankKeys(env);
    const artefact = items[0]?.artefacts[0] as string;
    expect((await readCaseInvoiceAccount(db, keys, org, caseId, artefact))?.number).toBe("06200441773");
  });

  it("a retry resumes a settled document instead of paying for it again or discarding it", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    await invoiceStep(deps([() => answer(FIELDS)]), caseId, org);
    const keys = await bankKeys(env);
    const artefact = (await readEvidence(db, caseId))[0]?.artefacts[0] as string;
    expect((await readCaseInvoiceAccount(db, keys, org, caseId, artefact))?.number).toBe("06200441773");
    // A later attempt of the same run, whose transport now refuses everything, reuses the settled
    // reading: the evidence and the sealed account stand exactly as the first attempt left them.
    await invoiceStep(deps([() => refusal()]), caseId, org);
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.detected"]);
    expect((await readCaseInvoiceAccount(db, keys, org, caseId, artefact))?.number).toBe("06200441773");
  });

  it("states a document past the page bound instead of calling it", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "big.pdf", makePdf(51), "application/pdf");
    const got = await invoiceStep(deps([]), caseId, org);
    expect(got.outcome).toBe("not_checked");
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.not_checked"]);
    expect(items[0]?.detail).toMatchObject({ checked: false, reason: "too-many-pages" });
  });

  it("the terminal not-run statement removes any account a partly-completed attempt sealed", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    await invoiceStep(deps([() => answer(FIELDS)]), caseId, org);
    const keys = await bankKeys(env);
    const artefact = (await readEvidence(db, caseId))[0]?.artefacts[0] as string;
    expect((await readCaseInvoiceAccount(db, keys, org, caseId, artefact))?.number).toBe("06200441773");
    await recordInvoiceNotRun(store, caseId, "error");
    const items = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("invoice."));
    expect(items.map((e) => e.check)).toEqual(["invoice.not_checked"]);
    expect(await readCaseInvoiceAccount(db, keys, org, caseId, artefact)).toBeNull();
  });

  it("two invoice documents keep two accounts apart", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await putAttachment(store, caseId, "a.pdf", pdf, "application/pdf");
    await putAttachment(store, caseId, "b.pdf", pdf, "application/pdf");
    await invoiceStep(
      deps([() => answer(FIELDS), () => answer({ ...FIELDS, account_number: "06200441774" })]),
      caseId,
      org,
    );
    const rows = await db
      .prepare("SELECT artefact_key FROM case_invoice_accounts WHERE case_id = ? ORDER BY artefact_key")
      .bind(caseId)
      .all<{ artefact_key: string }>();
    expect(rows.results).toHaveLength(2);
    const keys = await bankKeys(env);
    const numbers = await Promise.all(
      rows.results.map(async (r) => (await readCaseInvoiceAccount(db, keys, org, caseId, r.artefact_key))?.number),
    );
    expect(numbers.sort()).toEqual(["06200441773", "06200441774"]);
  });
});
