// A case's extracted payee accounts (D06 T01 §1; spec 4.5): one sealed account per invoice document of a
// case, stored as the bank registry stores numbers (encrypted, HMAC, current keys only) and deleted with
// the case. §6 reads a case's account back for its own organisation only; another organisation's case, or
// a case with no extraction, has none. The full number exists only here, sealed: evidence and summaries
// carry its last three digits.
import { ulid } from "../db/ulid";
import { type BankKeys, claimKeys, sealNumber } from "../trust/bank";
import { KeyMismatch } from "../trust/errors";

export type CaseInvoiceAccount = {
  artefactKey: string;
  bankName: string | null;
  holder: string | null;
  number: string;
  branchCode: string;
  last3: string;
};

type Row = {
  artefact_key: string;
  bank_name: string | null;
  holder: string | null;
  branch_code: string;
  number_ciphertext: ArrayBuffer;
  number_iv: ArrayBuffer;
  number_hmac: string;
  key_id: string;
  match_key_id: string;
  last3: string;
};

const decrypt = async (keys: BankKeys, row: Pick<Row, "number_ciphertext" | "number_iv">) =>
  new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(row.number_iv) },
      keys.encrypt,
      new Uint8Array(row.number_ciphertext),
    ),
  );

// Stores one document's account, replacing any row that document already has (a replayed step stores its
// extraction once). The epoch claim and the insert are one batch.
export async function storeCaseInvoiceAccount(
  db: D1Database,
  keys: BankKeys,
  input: {
    caseId: string;
    orgId: string;
    artefactKey: string;
    bankName: string | null;
    holder: string | null;
    account: { number: string; branchCode: string };
  },
  now = new Date(),
): Promise<void> {
  const sealed = await sealNumber(keys, input.account.number);
  await db.batch([
    claimKeys(db, keys),
    db
      .prepare(
        `INSERT INTO case_invoice_accounts (id, case_id, org_id, artefact_key, bank_name, branch_code, holder,
           number_ciphertext, number_iv, number_hmac, key_id, match_key_id, last3, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (case_id, artefact_key) DO UPDATE SET
           bank_name = excluded.bank_name, branch_code = excluded.branch_code, holder = excluded.holder,
           number_ciphertext = excluded.number_ciphertext, number_iv = excluded.number_iv,
           number_hmac = excluded.number_hmac, key_id = excluded.key_id, match_key_id = excluded.match_key_id,
           last3 = excluded.last3, created_at = excluded.created_at`,
      )
      .bind(
        ulid(now.getTime()),
        input.caseId,
        input.orgId,
        input.artefactKey,
        input.bankName,
        input.account.branchCode,
        input.holder,
        sealed.ciphertext,
        sealed.iv,
        sealed.hmac,
        keys.id,
        keys.matchId,
        sealed.last3,
        now.toISOString(),
      ),
  ]);
}

// The one statement that stores an account without claiming the epoch again, for a caller batching several
// documents' accounts with their evidence (the step's one write): the caller claims the epoch first.
export function caseInvoiceAccountStatement(
  db: D1Database,
  keys: BankKeys,
  sealed: { ciphertext: ArrayBuffer; iv: Uint8Array<ArrayBuffer>; hmac: string; last3: string },
  input: {
    caseId: string;
    orgId: string;
    artefactKey: string;
    bankName: string | null;
    holder: string | null;
    branchCode: string;
  },
  now = new Date(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO case_invoice_accounts (id, case_id, org_id, artefact_key, bank_name, branch_code, holder,
         number_ciphertext, number_iv, number_hmac, key_id, match_key_id, last3, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (case_id, artefact_key) DO UPDATE SET
         bank_name = excluded.bank_name, branch_code = excluded.branch_code, holder = excluded.holder,
         number_ciphertext = excluded.number_ciphertext, number_iv = excluded.number_iv,
         number_hmac = excluded.number_hmac, key_id = excluded.key_id, match_key_id = excluded.match_key_id,
         last3 = excluded.last3, created_at = excluded.created_at`,
    )
    .bind(
      ulid(now.getTime()),
      input.caseId,
      input.orgId,
      input.artefactKey,
      input.bankName,
      input.branchCode,
      input.holder,
      sealed.ciphertext,
      sealed.iv,
      sealed.hmac,
      keys.id,
      keys.matchId,
      sealed.last3,
      now.toISOString(),
    );
}

// A case's account for one document, read back only for the organisation that owns the case: null when the
// case, the document or the organisation does not match, or no extraction stored one. A row under other
// keys refuses with KeyMismatch, as the registry's reads do, never a silent number.
export async function readCaseInvoiceAccount(
  db: D1Database,
  keys: BankKeys,
  orgId: string,
  caseId: string,
  artefactKey: string,
): Promise<CaseInvoiceAccount | null> {
  const row = await db
    .prepare(
      `SELECT artefact_key, bank_name, holder, branch_code, number_ciphertext, number_iv, number_hmac,
              key_id, match_key_id, last3
       FROM case_invoice_accounts WHERE org_id = ? AND case_id = ? AND artefact_key = ?`,
    )
    .bind(orgId, caseId, artefactKey)
    .first<Row>();
  if (!row) return null;
  if (row.key_id !== keys.id || row.match_key_id !== keys.matchId)
    throw new KeyMismatch("a case's extracted account is under another key; re-key first");
  return {
    artefactKey: row.artefact_key,
    bankName: row.bank_name,
    holder: row.holder,
    number: await decrypt(keys, row),
    branchCode: row.branch_code,
    last3: row.last3,
  };
}
