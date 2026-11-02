// A case's extracted payee accounts (D06 T01 §1; spec 4.5): sealed under the bank keys, one per document,
// read back only by the owning organisation, deleted with the case, and moved by a re-key like every other
// account under those keys.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { readCaseInvoiceAccount, storeCaseInvoiceAccount } from "../../src/invoice/case-accounts";
import { abandonLostKeys, bankKeys, rekeyAccounts } from "../../src/trust/bank";
import { KeyMismatch } from "../../src/trust/errors";
import { makeOrg } from "../trust/helpers";

const db = env.DB;
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const otherKeys = (seed: number) =>
  bankKeys({
    BANK_KEY: b64(Array.from({ length: 32 }, (_, i) => (i + seed) & 255)),
    BANK_MATCH_KEY: b64(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 255)),
  });

beforeEach(async () => {
  await db.batch(
    ["case_invoice_accounts", "bank_accounts", "supplier_accounts", "bank_key_epoch", "trust_events", "cases"].map(
      (t) => db.prepare(`DELETE FROM ${t}`),
    ),
  );
});

async function caseOf(orgId: string) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

const store = async (org: string, caseId: string, artefact = "cases/c/invoice.pdf", number = "06200441773") =>
  storeCaseInvoiceAccount(db, await bankKeys(env), {
    caseId,
    orgId: org,
    artefactKey: artefact,
    bankName: "Kestrel Bank (fictional)",
    holder: "Karoo Parts (Pty) Ltd",
    account: { number, branchCode: "250655" },
  });

describe("case invoice accounts", () => {
  it("stores sealed and reads back for its own organisation only", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const other = await makeOrg();
    const caseId = await caseOf(org);
    await store(org, caseId);
    const raw = await db
      .prepare("SELECT number_ciphertext, last3 FROM case_invoice_accounts WHERE case_id = ?")
      .bind(caseId)
      .first<{ number_ciphertext: ArrayBuffer; last3: string }>();
    expect(new TextDecoder().decode(new Uint8Array(raw?.number_ciphertext as unknown as ArrayBuffer))).not.toContain(
      "06200441773",
    );
    expect(raw?.last3).toBe("773");
    const read = await readCaseInvoiceAccount(db, keys, org, caseId, "cases/c/invoice.pdf");
    expect(read?.number).toBe("06200441773");
    expect(read?.branchCode).toBe("250655");
    expect(await readCaseInvoiceAccount(db, keys, other, caseId, "cases/c/invoice.pdf")).toBeNull();
    expect(await readCaseInvoiceAccount(db, keys, org, caseId, "cases/c/other.pdf")).toBeNull();
    const empty = await caseOf(org);
    expect(await readCaseInvoiceAccount(db, keys, org, empty, "cases/c/invoice.pdf")).toBeNull();
  });

  it("a replay replaces the document's row, and two documents stay apart", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await store(org, caseId);
    await store(org, caseId, "cases/c/invoice.pdf", "06200441774");
    await store(org, caseId, "cases/c/second.pdf", "06200441775");
    expect((await readCaseInvoiceAccount(db, keys, org, caseId, "cases/c/invoice.pdf"))?.number).toBe("06200441774");
    expect((await readCaseInvoiceAccount(db, keys, org, caseId, "cases/c/second.pdf"))?.number).toBe("06200441775");
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts WHERE case_id = ?")
      .bind(caseId)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("is deleted with its case", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await store(org, caseId);
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(caseId).run();
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts WHERE case_id = ?")
      .bind(caseId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("refuses a store under other keys once the epoch is claimed", async () => {
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await store(org, caseId);
    await expect(
      storeCaseInvoiceAccount(db, await otherKeys(3), {
        caseId,
        orgId: org,
        artefactKey: "cases/c/other.pdf",
        bankName: null,
        holder: null,
        account: { number: "06200441776", branchCode: "250655" },
      }),
    ).rejects.toThrow(/not under the current keys/);
  });

  it("moves with a re-key and is deleted by the lost-key recovery", async () => {
    const from = await bankKeys(env);
    const to = await otherKeys(9);
    const org = await makeOrg();
    const caseId = await caseOf(org);
    await store(org, caseId);
    await expect(readCaseInvoiceAccount(db, to, org, caseId, "cases/c/invoice.pdf")).rejects.toBeInstanceOf(
      KeyMismatch,
    );
    const moved = await rekeyAccounts(db, from, to, "admin");
    expect(moved.moved).toBeGreaterThanOrEqual(1);
    expect((await readCaseInvoiceAccount(db, to, org, caseId, "cases/c/invoice.pdf"))?.number).toBe("06200441773");
    const third = await otherKeys(21);
    const gone = await abandonLostKeys(db, third, "admin");
    expect(gone.deleted).toBeGreaterThanOrEqual(1);
    expect(await readCaseInvoiceAccount(db, third, org, caseId, "cases/c/invoice.pdf")).toBeNull();
  });
});
