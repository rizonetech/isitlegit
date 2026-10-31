// The supplier ledger (D06 T01 §2; design spec 4.5): the suppliers an organisation really pays, their registrable
// domains, phone number and bank accounts. Account numbers are kept as the bank registry keeps them
// (src/trust/bank.ts): canonical form, encrypted under BANK_KEY, compared by HMAC, under the current keys only, and
// shown as their last three digits. The ledger is the organisation's own record, matched only by its own cases, so a
// match has no hourly limit and writes no event; every change writes its `ledger_events` row in the same batch.
// Every read and change selects by organisation as well as id.
import { z } from "zod";
import { registrable } from "../auth/senders";
import { asciiDomain } from "../checks/auth";
import { ulid } from "../db/ulid";
import {
  type BankKeys,
  canonicalAccount,
  claimKeys,
  currentKeys,
  hmacOf,
  NOT_CURRENT,
  refuseOtherKeys,
  sealNumber,
} from "../trust/bank";
import { AccountRefused, KeyMismatch, NoBaseline } from "../trust/errors";
import { SupplierAmbiguous, SupplierRefused } from "./errors";
import { ledgerEventStatement } from "./ledger-events";

export const MAX_SUPPLIER_DOMAINS = 20;

// One supplier per spelling: lower case, runs of whitespace as one space, trimmed.
export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

// A domain as `domain.lookalike` compares it (D02 T03 §2): ASCII, then its registrable domain, or null.
const siteOf = (domain: string) => {
  const ascii = asciiDomain(domain);
  return ascii ? registrable(ascii) : null;
};

const PHONE = /^\+?[0-9 ()-]+$/;
const phoneOf = (phone: string | null | undefined): string | null => {
  if (phone === undefined || phone === null || phone.trim() === "") return null;
  const value = phone.trim().replace(/\s+/g, " ");
  const digits = value.replace(/\D/g, "").length;
  if (!PHONE.test(value) || value.indexOf("+") > 0 || digits < 7 || digits > 15)
    throw new SupplierRefused("a phone number is 7 to 15 digits, with an optional leading +");
  return value;
};

const SupplierInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  domains: z.array(z.string().max(253)).max(MAX_SUPPLIER_DOMAINS).default([]),
  phone: z.string().max(30).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
// Its own schema, every field optional and none defaulted: a field the patch leaves out is left as it is (deriving it
// from `SupplierInput` would carry `domains`' default of [] and erase a supplier's domains on any other edit).
const SupplierPatch = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  domains: z.array(z.string().max(253)).max(MAX_SUPPLIER_DOMAINS).optional(),
  phone: z.string().max(30).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

// The reason a supplier's details were refused, naming the field (never echoing what was typed), so the ledger page
// (§4) can say which field to fix.
const FIELD_REASONS: Record<string, string> = {
  name: "a supplier needs a name of 1 to 120 characters",
  domains: `a supplier has up to ${MAX_SUPPLIER_DOMAINS} domains, each up to 253 characters`,
  phone: "a phone number is 7 to 15 digits, with an optional leading +",
  notes: "notes are up to 1,000 characters",
};
function refusalOf(error: z.ZodError): SupplierRefused {
  const issue = error.issues[0];
  const field = issue?.code === "unrecognized_keys" ? null : String(issue?.path[0] ?? "");
  return new SupplierRefused(
    field && FIELD_REASONS[field] ? FIELD_REASONS[field] : "a supplier has a name, domains, a phone and notes only",
  );
}

function domainsOf(domains: string[]): string[] {
  const out: string[] = [];
  for (const d of domains) {
    const site = siteOf(d);
    if (!site) throw new SupplierRefused("each domain needs a registrable domain, such as example.co.za");
    if (!out.includes(site)) out.push(site);
  }
  return out;
}

export type Supplier = { id: string; name: string; domains: string[]; phone: string | null; notes: string | null };
type SupplierRow = {
  id: string;
  name: string;
  name_key: string;
  domains_json: string;
  phone: string | null;
  notes: string | null;
};
const SUPPLIER_COLUMNS = "id, name, name_key, domains_json, phone, notes";
const supplierOf = (r: SupplierRow): Supplier => ({
  id: r.id,
  name: r.name,
  domains: JSON.parse(r.domains_json) as string[],
  phone: r.phone,
  notes: r.notes,
});

const rowOf = (db: D1Database, orgId: string, supplierId: string) =>
  db
    .prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE id = ? AND org_id = ?`)
    .bind(supplierId, orgId)
    .first<SupplierRow>();

const duplicateName = (error: unknown) => /UNIQUE constraint failed: suppliers/.test(String(error));

export async function addSupplier(
  db: D1Database,
  orgId: string,
  actor: string,
  input: unknown,
  now = new Date(),
): Promise<{ id: string }> {
  const parsed = SupplierInput.safeParse(input);
  if (!parsed.success) throw refusalOf(parsed.error);
  const v = parsed.data;
  const domains = domainsOf(v.domains);
  const phone = phoneOf(v.phone);
  const id = ulid(now.getTime());
  const at = now.toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO suppliers (id, org_id, name, name_key, domains_json, phone, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, orgId, v.name, nameKey(v.name), JSON.stringify(domains), phone, v.notes ?? null, actor, at, at),
      ledgerEventStatement(db, orgId, actor, "supplier.added", { supplierId: id, name: v.name }, at),
    ]);
  } catch (error) {
    if (duplicateName(error)) throw new SupplierRefused("a supplier of that name is already in the ledger");
    throw error;
  }
  return { id };
}

// Changes only the fields the patch names, so two members editing different fields at once both keep their change
// (a field both change ends with the later write). The event names the supplier as it is after the change.
export async function updateSupplier(
  db: D1Database,
  orgId: string,
  actor: string,
  supplierId: string,
  patch: unknown,
  now = new Date(),
): Promise<Supplier> {
  const parsed = SupplierPatch.safeParse(patch);
  if (!parsed.success) throw refusalOf(parsed.error);
  const v = parsed.data;
  const sets: string[] = [];
  const values: (string | null)[] = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (v.name !== undefined) {
    set("name", v.name);
    set("name_key", nameKey(v.name));
  }
  if (v.domains !== undefined) set("domains_json", JSON.stringify(domainsOf(v.domains)));
  if (v.phone !== undefined) set("phone", phoneOf(v.phone));
  if (v.notes !== undefined) set("notes", v.notes);
  const at = now.toISOString();
  set("updated_at", at);
  let updated: D1Result<SupplierRow> | undefined;
  try {
    [updated] = await db.batch<SupplierRow>([
      db
        .prepare(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = ? AND org_id = ? RETURNING ${SUPPLIER_COLUMNS}`)
        .bind(...values, supplierId, orgId),
      db
        .prepare(
          `INSERT INTO ledger_events (id, org_id, actor, kind, detail_json, created_at)
           SELECT ?, org_id, ?, 'supplier.updated', json_object('supplierId', id, 'name', name), ?
           FROM suppliers WHERE id = ? AND org_id = ? AND changes() = 1`,
        )
        .bind(ulid(), actor, at, supplierId, orgId),
    ]);
  } catch (error) {
    if (duplicateName(error)) throw new SupplierRefused("a supplier of that name is already in the ledger");
    throw error;
  }
  const row = updated?.results[0];
  if (!row) throw new SupplierRefused("no such supplier");
  return supplierOf(row);
}

// Removes the supplier and, with it, its accounts (the foreign key cascades).
export async function removeSupplier(
  db: D1Database,
  orgId: string,
  actor: string,
  supplierId: string,
  now = new Date(),
): Promise<void> {
  const before = await rowOf(db, orgId, supplierId);
  if (!before) throw new SupplierRefused("no such supplier");
  const at = now.toISOString();
  // D1's `meta.changes` counts the accounts the cascade deletes too, so the supplier's own row is read back through
  // RETURNING; SQLite's `changes()`, which the event's condition reads, leaves foreign-key actions out.
  const [deleted] = await db.batch<{ id: string }>([
    db.prepare("DELETE FROM suppliers WHERE id = ? AND org_id = ? RETURNING id").bind(supplierId, orgId),
    ledgerEventStatement(db, orgId, actor, "supplier.removed", { supplierId, name: before.name }, at, true),
  ]);
  if (deleted?.results.length !== 1) throw new SupplierRefused("no such supplier");
}

const AccountInput = z.strictObject({
  number: z.string(),
  branchCode: z.string(),
  bankName: z.string().trim().min(1).max(120),
  holder: z.string().trim().min(1).max(120),
});

// Where an account came from (D06 T01 §4, migration 0061): typed on the ledger page, imported from a CSV, or verified
// from an invoice case (always `case` when a case is named).
export type AccountSource = "hand" | "csv" | "case";

// Records a supplier's account, optionally from the invoice case a member marked verified (D06 T01 §4). The row is
// inserted only while the supplier is this organisation's and the case (when named) is too, in the same statement, so
// neither can change between the check and the write.
export async function addSupplierAccount(
  db: D1Database,
  keys: BankKeys,
  orgId: string,
  actor: string,
  supplierId: string,
  input: unknown,
  options: { verifiedFromCaseId?: string; source?: "hand" | "csv" } = {},
  now = new Date(),
): Promise<{ id: string }> {
  const parsed = AccountInput.safeParse(input);
  if (!parsed.success) throw new AccountRefused("an account needs a number, a branch code, a bank and a holder");
  const { number, branchCode } = canonicalAccount(parsed.data);
  const supplier = await rowOf(db, orgId, supplierId);
  if (!supplier) throw new SupplierRefused("no such supplier");
  const caseId = options.verifiedFromCaseId ?? null;
  const source: AccountSource = caseId !== null ? "case" : (options.source ?? "hand");
  if (caseId !== null) {
    const known = await db.prepare("SELECT 1 FROM cases WHERE id = ? AND org_id = ?").bind(caseId, orgId).first();
    if (!known) throw new SupplierRefused("no such case");
  }
  const epoch = await currentKeys(db);
  if (epoch) refuseOtherKeys([epoch], keys);
  const sealed = await sealNumber(keys, number);
  const id = ulid(now.getTime());
  const at = now.toISOString();
  let inserted: D1Result | undefined;
  try {
    [, inserted] = await db.batch([
      claimKeys(db, keys),
      db
        .prepare(
          `INSERT INTO supplier_accounts (id, org_id, supplier_id, bank_name, branch_code, holder, number_ciphertext,
             number_iv, number_hmac, key_id, match_key_id, last3, verified_from_case_id, source, added_by, added_at)
           SELECT ?, s.org_id, s.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM suppliers s
           WHERE s.id = ? AND s.org_id = ?
             AND (? IS NULL OR EXISTS (SELECT 1 FROM cases c WHERE c.id = ? AND c.org_id = s.org_id))`,
        )
        .bind(
          id,
          parsed.data.bankName,
          branchCode,
          parsed.data.holder,
          sealed.ciphertext,
          sealed.iv,
          sealed.hmac,
          keys.id,
          keys.matchId,
          sealed.last3,
          caseId,
          source,
          actor,
          at,
          supplierId,
          orgId,
          caseId,
          caseId,
        ),
      ledgerEventStatement(
        db,
        orgId,
        actor,
        "account.added",
        {
          supplierId,
          accountId: id,
          bankName: parsed.data.bankName,
          last3: sealed.last3,
          verifiedFromCaseId: caseId,
        },
        at,
        true,
      ),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: supplier_accounts/.test(String(error)))
      throw new AccountRefused("this account is already recorded for the supplier");
    if (NOT_CURRENT.test(String(error)))
      throw new KeyMismatch("the ledger is being moved to other keys; try again once the re-key is done");
    throw error;
  }
  if ((inserted?.meta.changes ?? 0) !== 1) throw new SupplierRefused("no such supplier or case");
  return { id };
}

export async function removeSupplierAccount(
  db: D1Database,
  orgId: string,
  actor: string,
  accountId: string,
  now = new Date(),
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT supplier_id, bank_name, last3, verified_from_case_id FROM supplier_accounts WHERE id = ? AND org_id = ?",
    )
    .bind(accountId, orgId)
    .first<{ supplier_id: string; bank_name: string; last3: string; verified_from_case_id: string | null }>();
  if (!row) throw new AccountRefused("no such account");
  const at = now.toISOString();
  const [deleted] = await db.batch([
    db.prepare("DELETE FROM supplier_accounts WHERE id = ? AND org_id = ?").bind(accountId, orgId),
    ledgerEventStatement(
      db,
      orgId,
      actor,
      "account.removed",
      {
        supplierId: row.supplier_id,
        accountId,
        bankName: row.bank_name,
        last3: row.last3,
        verifiedFromCaseId: row.verified_from_case_id,
      },
      at,
      true,
    ),
  ]);
  if ((deleted?.meta.changes ?? 0) !== 1) throw new AccountRefused("no such account");
}

// Changes one of a supplier's accounts for another in a single batch (D06 T01 §4, correction 9): the account chosen on
// the row is deleted, scoped to the organisation and the supplier, and the new one is inserted only when that delete
// changed exactly one row, with an event for each; the removal's event is written only once the new account exists.
// So the change happens whole or not at all: a missing old account, a number already recorded for the supplier, or
// any failing statement leaves the old account in place, and the supplier's other accounts are never touched.
export async function replaceSupplierAccount(
  db: D1Database,
  keys: BankKeys,
  orgId: string,
  actor: string,
  supplierId: string,
  oldAccountId: string,
  input: unknown,
  now = new Date(),
): Promise<{ id: string }> {
  const parsed = AccountInput.safeParse(input);
  if (!parsed.success) throw new AccountRefused("an account needs a number, a branch code, a bank and a holder");
  const { number, branchCode } = canonicalAccount(parsed.data);
  const old = await db
    .prepare(
      `SELECT bank_name, last3, verified_from_case_id FROM supplier_accounts
       WHERE id = ? AND org_id = ? AND supplier_id = ?`,
    )
    .bind(oldAccountId, orgId, supplierId)
    .first<{ bank_name: string; last3: string; verified_from_case_id: string | null }>();
  if (!old) throw new AccountRefused("no such account");
  const epoch = await currentKeys(db);
  if (epoch) refuseOtherKeys([epoch], keys);
  const sealed = await sealNumber(keys, number);
  const id = ulid(now.getTime());
  const at = now.toISOString();
  let inserted: D1Result | undefined;
  try {
    [, , inserted] = await db.batch([
      claimKeys(db, keys),
      db
        .prepare("DELETE FROM supplier_accounts WHERE id = ? AND org_id = ? AND supplier_id = ?")
        .bind(oldAccountId, orgId, supplierId),
      db
        .prepare(
          `INSERT INTO supplier_accounts (id, org_id, supplier_id, bank_name, branch_code, holder, number_ciphertext,
             number_iv, number_hmac, key_id, match_key_id, last3, verified_from_case_id, source, added_by, added_at)
           SELECT ?, s.org_id, s.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'hand', ?, ?
           FROM suppliers s WHERE s.id = ? AND s.org_id = ? AND changes() = 1`,
        )
        .bind(
          id,
          parsed.data.bankName,
          branchCode,
          parsed.data.holder,
          sealed.ciphertext,
          sealed.iv,
          sealed.hmac,
          keys.id,
          keys.matchId,
          sealed.last3,
          actor,
          at,
          supplierId,
          orgId,
        ),
      ledgerEventStatement(
        db,
        orgId,
        actor,
        "account.added",
        { supplierId, accountId: id, bankName: parsed.data.bankName, last3: sealed.last3, verifiedFromCaseId: null },
        at,
        true,
      ),
      db
        .prepare(
          `INSERT INTO ledger_events (id, org_id, actor, kind, detail_json, created_at)
           SELECT ?, ?, ?, 'account.removed', ?, ? WHERE EXISTS (SELECT 1 FROM supplier_accounts WHERE id = ?)`,
        )
        .bind(
          ulid(),
          orgId,
          actor,
          JSON.stringify({
            supplierId,
            accountId: oldAccountId,
            bankName: old.bank_name,
            last3: old.last3,
            verifiedFromCaseId: old.verified_from_case_id,
          }),
          at,
          id,
        ),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: supplier_accounts/.test(String(error)))
      throw new AccountRefused("this account is already recorded for the supplier");
    if (NOT_CURRENT.test(String(error)))
      throw new KeyMismatch("the ledger is being moved to other keys; try again once the re-key is done");
    throw error;
  }
  if ((inserted?.meta.changes ?? 0) !== 1) throw new AccountRefused("no such account");
  return { id };
}

// The supplier an invoice names, or null; never a guess. The suppliers holding the registrable domain of `domain`,
// narrowed by the name when one is given; failing those, the supplier of that name. Several, or a domain and a name
// that point at different suppliers, refuse with `SupplierAmbiguous`. A name that narrows the domain's suppliers to
// none is null rather than the domain's supplier, since a shared mailbox domain (gmail.com) does not tell suppliers
// apart.
export async function findSupplier(
  db: D1Database,
  orgId: string,
  query: { name?: string | null; domain?: string | null },
): Promise<Supplier | null> {
  const site = query.domain ? siteOf(query.domain) : null;
  const key = query.name ? nameKey(query.name) : null;
  const byDomain = site
    ? (
        await db
          .prepare(
            `SELECT ${SUPPLIER_COLUMNS} FROM suppliers s
             WHERE s.org_id = ? AND EXISTS (SELECT 1 FROM json_each(s.domains_json) WHERE value = ?)
             ORDER BY s.id`,
          )
          .bind(orgId, site)
          .all<SupplierRow>()
      ).results
    : [];
  const narrowed = key ? byDomain.filter((s) => s.name_key === key) : byDomain;
  if (narrowed.length > 1) throw new SupplierAmbiguous("more than one supplier fits; name the supplier");
  if (narrowed.length === 1) return supplierOf(narrowed[0] as SupplierRow);
  if (!key) return null;
  const byName = await db
    .prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE org_id = ? AND name_key = ?`)
    .bind(orgId, key)
    .first<SupplierRow>();
  if (byName && byDomain.length > 0)
    throw new SupplierAmbiguous("the domain and the name point at different suppliers");
  if (byName) return supplierOf(byName);
  return null;
}

// Whether a claimed account is one recorded for this supplier: `{ match }` and nothing else. Refuses `NoBaseline` for
// a supplier with no account and `KeyMismatch` for keys that are not the current ones, so neither reads as a change of
// bank.
export async function matchSupplierAccount(
  db: D1Database,
  keys: BankKeys,
  orgId: string,
  supplierId: string,
  input: { number: unknown; branchCode: unknown },
): Promise<{ match: boolean }> {
  const { number, branchCode } = canonicalAccount(input);
  const supplier = await rowOf(db, orgId, supplierId);
  if (!supplier) throw new SupplierRefused("no such supplier");
  const [rows, epoch] = await Promise.all([
    db
      .prepare(
        "SELECT number_hmac, branch_code, key_id, match_key_id FROM supplier_accounts WHERE supplier_id = ? AND org_id = ?",
      )
      .bind(supplierId, orgId)
      .all<{ number_hmac: string; branch_code: string; key_id: string; match_key_id: string }>(),
    currentKeys(db),
  ]);
  if (rows.results.length === 0) throw new NoBaseline("the supplier has no recorded account to compare with");
  refuseOtherKeys(epoch ? [...rows.results, epoch] : rows.results, keys);
  const hmac = await hmacOf(keys, number);
  return { match: rows.results.some((r) => r.number_hmac === hmac && r.branch_code === branchCode) };
}

export type MaskedSupplierAccount = {
  id: string;
  bankName: string;
  branchCode: string;
  holder: string;
  masked: string;
  last3: string;
  verifiedFromCaseId: string | null;
  // Provenance (D06 T01 §4): where it came from, who recorded it (their name, else their address, else null when they
  // are no longer a user) and when. A `case` account whose case was deleted keeps its source with no case id.
  source: AccountSource;
  addedBy: string | null;
  addedAt: string;
};
export type LedgerEntry = Supplier & { accounts: MaskedSupplierAccount[] };

// The ledger page's view (D06 T01 §4): every supplier, its accounts never more than their last three digits.
export async function listSuppliers(db: D1Database, orgId: string): Promise<LedgerEntry[]> {
  const [suppliers, accounts] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE org_id = ? ORDER BY name_key, id`).bind(orgId),
    db
      .prepare(
        `SELECT a.id, a.supplier_id, a.bank_name, a.branch_code, a.holder, a.last3, a.verified_from_case_id, a.source,
           a.added_at, (SELECT COALESCE(NULLIF(trim(u.name), ''), u.email) FROM "user" u WHERE u.id = a.added_by) AS added_by
         FROM supplier_accounts a WHERE a.org_id = ? ORDER BY a.added_at, a.id`,
      )
      .bind(orgId),
  ]);
  const bySupplier = new Map<string, MaskedSupplierAccount[]>();
  for (const a of (accounts?.results ?? []) as {
    id: string;
    supplier_id: string;
    bank_name: string;
    branch_code: string;
    holder: string;
    last3: string;
    verified_from_case_id: string | null;
    source: AccountSource;
    added_at: string;
    added_by: string | null;
  }[]) {
    const list = bySupplier.get(a.supplier_id) ?? [];
    list.push({
      id: a.id,
      bankName: a.bank_name,
      branchCode: a.branch_code,
      holder: a.holder,
      masked: `***${a.last3}`,
      last3: a.last3,
      verifiedFromCaseId: a.verified_from_case_id,
      source: a.source,
      addedBy: a.added_by,
      addedAt: a.added_at,
    });
    bySupplier.set(a.supplier_id, list);
  }
  return ((suppliers?.results ?? []) as SupplierRow[]).map((r) => ({
    ...supplierOf(r),
    accounts: bySupplier.get(r.id) ?? [],
  }));
}
