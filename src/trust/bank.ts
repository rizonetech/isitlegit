// Registered bank accounts, match-only (D05 T01 §2; design spec 2a; AGENTS.md: registered bank details are never
// revealed to a checker, match or no match only, rate-limited per sender and per protected business).
//
// A number is encrypted with AES-GCM under BANK_KEY (a fresh 96-bit IV each time) and stored with its HMAC-SHA256
// under BANK_MATCH_KEY, so a match compares HMACs and decrypts nothing. Only the owner's console sees anything of a
// number, and that is its last three digits. Every row names the fingerprints of the two keys it was made under, and a
// registry with any row under another key refuses to add or match until `rekeyAccounts` has moved it, so a replaced or
// lost key is a refusal, never a false "bank changed". A business with no account is `NoBaseline`, not a mismatch.
// The schema holds the current keys in `bank_key_epoch` and refuses any row written under others, so a re-key and a
// concurrent add cannot leave an account behind under the old keys.

import { z } from "zod";
import { PROTECTED_ACCOUNTS, PROTECTED_ORGANISATIONS } from "../auth/protected";
import { ulid } from "../db/ulid";
import { ledgerEventStatement } from "../invoice/ledger-events";
import { AccountRefused, BankKeysMissing, IdentityRefused, KeyMismatch, MatchLimited, NoBaseline } from "./errors";
import { eventStatement, getIdentity } from "./identity";

export const MATCHES_PER_HOUR = 20;

export type BankKeys = { encrypt: CryptoKey; id: string; match: CryptoKey; matchId: string };

const toBytes = (b64: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fingerprint = async (raw: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>)).slice(0, 16);

// The two keys from the Worker's secrets: each base64 of exactly 32 bytes, or a typed refusal naming which is wrong,
// never its value and never a fallback.
export async function bankKeys(env: { BANK_KEY?: string; BANK_MATCH_KEY?: string }): Promise<BankKeys> {
  const enc = env.BANK_KEY ? toBytes(env.BANK_KEY) : null;
  const mac = env.BANK_MATCH_KEY ? toBytes(env.BANK_MATCH_KEY) : null;
  if (!env.BANK_KEY) throw new BankKeysMissing("BANK_KEY is not set");
  if (enc?.length !== 32) throw new BankKeysMissing("BANK_KEY is not 32 bytes as base64");
  if (!env.BANK_MATCH_KEY) throw new BankKeysMissing("BANK_MATCH_KEY is not set");
  if (mac?.length !== 32) throw new BankKeysMissing("BANK_MATCH_KEY is not 32 bytes as base64");
  const [encrypt, match] = await Promise.all([
    crypto.subtle.importKey("raw", enc as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]),
    crypto.subtle.importKey("raw", mac as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  return { encrypt, id: await fingerprint(enc), match, matchId: await fingerprint(mac) };
}

// One canonical form for adding and matching: spaces and dashes removed, digits only, a number of 7 to 11 digits kept
// as a string (so leading zeroes stay) and a branch code of exactly 6.
export function canonicalAccount(input: { number: unknown; branchCode: unknown }): {
  number: string;
  branchCode: string;
} {
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\s-]+/g, "") : "");
  const number = clean(input.number);
  const branchCode = clean(input.branchCode);
  if (!/^\d{7,11}$/.test(number)) throw new AccountRefused("an account number is 7 to 11 digits");
  if (!/^\d{6}$/.test(branchCode)) throw new AccountRefused("a branch code is 6 digits");
  return { number, branchCode };
}

export const hmacOf = async (keys: BankKeys, number: string) =>
  hex(await crypto.subtle.sign("HMAC", keys.match, new TextEncoder().encode(number)));

// A canonical number as stored: encrypted under a fresh 96-bit IV, its HMAC, and its last three digits. Shared by the
// registry and the supplier ledger (D06 T01 §2), so both keep numbers the same way.
export async function sealNumber(
  keys: BankKeys,
  number: string,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array<ArrayBuffer>; hmac: string; last3: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keys.encrypt,
    new TextEncoder().encode(number),
  );
  return { ciphertext, iv, hmac: await hmacOf(keys, number), last3: number.slice(-3) };
}

// The keys every account must be under (migration 0048's `bank_key_epoch`), or null before the first account.
export const currentKeys = (db: D1Database) =>
  db
    .prepare("SELECT key_id, match_key_id FROM bank_key_epoch WHERE id = 1")
    .first<{ key_id: string; match_key_id: string }>();

// The statement that names the current keys when none are named yet: the first account ever added, in the registry
// or the ledger, claims the epoch; after that the schema refuses an account under other keys.
export const claimKeys = (db: D1Database, keys: BankKeys) =>
  db
    .prepare("INSERT INTO bank_key_epoch (id, key_id, match_key_id) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING")
    .bind(keys.id, keys.matchId);

const AccountInput = z.strictObject({
  number: z.string(),
  branchCode: z.string(),
  bankName: z.string().trim().min(1).max(120),
  holder: z.string().trim().min(1).max(120),
});

type Row = {
  id: string;
  org_id: string;
  bank_name: string;
  branch_code: string;
  holder: string;
  number_ciphertext: ArrayBuffer;
  number_iv: ArrayBuffer;
  number_hmac: string;
  key_id: string;
  match_key_id: string;
  last3: string;
};

// Only the columns each caller needs: matching and the key check never load a ciphertext.
const rowsOf = async <C extends keyof Row>(db: D1Database, orgId: string, columns: readonly C[]) =>
  (
    await db
      .prepare(`SELECT ${columns.join(", ")} FROM bank_accounts WHERE org_id = ? ORDER BY added_at, id`)
      .bind(orgId)
      .all<Pick<Row, C>>()
  ).results;
const KEY_COLUMNS = ["key_id", "match_key_id"] as const;
const MATCH_COLUMNS = ["number_hmac", "branch_code", ...KEY_COLUMNS] as const;
const MASKED_COLUMNS = ["id", "bank_name", "branch_code", "holder", "last3"] as const;

// The trigger message of migrations 0048 and 0049 when a row is written under keys that are not the current ones.
export const NOT_CURRENT = /(bank|supplier|case_invoice)_accounts: not under the current keys/;

// The tables whose numbers are kept under the bank keys, which a re-key and the lost-key recovery move together.
const ACCOUNT_TABLES = ["bank_accounts", "supplier_accounts", "case_invoice_accounts"] as const;

export function refuseOtherKeys(rows: Pick<Row, "key_id" | "match_key_id">[], keys: BankKeys) {
  if (rows.some((r) => r.key_id !== keys.id || r.match_key_id !== keys.matchId))
    throw new KeyMismatch("a registered account is under another key; re-key the registry first");
}

export async function addAccount(
  db: D1Database,
  keys: BankKeys,
  orgId: string,
  actor: string,
  input: unknown,
  now = new Date(),
): Promise<{ id: string }> {
  const parsed = AccountInput.safeParse(input);
  if (!parsed.success) throw new AccountRefused("an account needs a number, a branch code, a bank and a holder");
  const { number, branchCode } = canonicalAccount(parsed.data);
  refuseOtherKeys(await rowsOf(db, orgId, KEY_COLUMNS), keys);
  const { ciphertext, iv, hmac, last3 } = await sealNumber(keys, number);
  const id = ulid(now.getTime());
  const at = now.toISOString();
  try {
    await db.batch([
      claimKeys(db, keys),
      db
        .prepare(
          `INSERT INTO bank_accounts (id, org_id, bank_name, branch_code, holder, number_ciphertext, number_iv,
             number_hmac, key_id, match_key_id, last3, added_by, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          orgId,
          parsed.data.bankName,
          branchCode,
          parsed.data.holder,
          ciphertext,
          iv,
          hmac,
          keys.id,
          keys.matchId,
          last3,
          actor,
          at,
        ),
      eventStatement(db, orgId, actor, "bank.added", { accountId: id, bankName: parsed.data.bankName, last3 }, at),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: bank_accounts/.test(String(error)))
      throw new AccountRefused("this account is already registered");
    if (NOT_CURRENT.test(String(error)))
      throw new KeyMismatch("the registry is being moved to other keys; try again once the re-key is done");
    throw error;
  }
  return { id };
}

export async function removeAccount(
  db: D1Database,
  orgId: string,
  actor: string,
  accountId: string,
  now = new Date(),
): Promise<void> {
  const row = await db
    .prepare("SELECT id, bank_name, last3 FROM bank_accounts WHERE id = ? AND org_id = ?")
    .bind(accountId, orgId)
    .first<{ id: string; bank_name: string; last3: string }>();
  if (!row) throw new AccountRefused("no such account");
  const at = now.toISOString();
  const [deleted] = await db.batch([
    db.prepare("DELETE FROM bank_accounts WHERE id = ? AND org_id = ?").bind(accountId, orgId),
    eventStatement(
      db,
      orgId,
      actor,
      "bank.removed",
      { accountId, bankName: row.bank_name, last3: row.last3 },
      at,
      true,
    ),
  ]);
  if ((deleted?.meta.changes ?? 0) !== 1) throw new AccountRefused("no such account");
}

export type MatchCaller = { orgId: string } | { sender: string };

const hourOf = (now: Date) => `${now.toISOString().slice(0, 13)}:00:00Z`;
const callerBucket = (c: MatchCaller) =>
  "orgId" in c ? `caller:org:${c.orgId}` : `caller:sender:${c.sender.trim().toLowerCase()}`;
const callerDetail = (c: MatchCaller) =>
  "orgId" in c
    ? { callerOrgId: c.orgId }
    : { senderDomain: c.sender.slice(c.sender.lastIndexOf("@") + 1).toLowerCase() };

// Whether a claimed account is one the protected business registered: `{ match }` and nothing else. The attempt is
// counted against the caller and against the business, and audited with its result, in one batch.
export async function matchBankAccount(
  db: D1Database,
  keys: BankKeys,
  caller: MatchCaller,
  protectedOrgId: string,
  input: { number: unknown; branchCode: unknown },
  now = new Date(),
): Promise<{ match: boolean }> {
  const { number, branchCode } = canonicalAccount(input);
  const identity = await getIdentity(db, protectedOrgId);
  if (!identity?.effective.on) throw new IdentityRefused("not a protected identity");
  const [rows, epoch] = await Promise.all([rowsOf(db, protectedOrgId, MATCH_COLUMNS), currentKeys(db)]);
  if (rows.length === 0) throw new NoBaseline("the business has no registered account to compare with");
  // Rows still under these keys do not make them current: once a re-key has moved the epoch, the old keys refuse,
  // even before (or without) any row having moved.
  refuseOtherKeys(epoch ? [...rows, epoch] : rows, keys);
  const hmac = await hmacOf(keys, number);
  const match = rows.some((r) => r.number_hmac === hmac && r.branch_code === branchCode);
  const window = hourOf(now);
  const own = callerBucket(caller);
  const target = `protected:${protectedOrgId}`;
  const bump = (bucket: string) =>
    db
      .prepare(
        // The window only moves forward: a check that started in an earlier hour and reached the database late is
        // counted against the current window, never resetting it (ISO times compare as text).
        `INSERT INTO bank_match_counts (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (bucket) DO UPDATE SET
           count = CASE WHEN excluded.window_start > bank_match_counts.window_start THEN 1
                        ELSE bank_match_counts.count + 1 END,
           window_start = max(bank_match_counts.window_start, excluded.window_start)
         RETURNING count`,
      )
      .bind(bucket, window);
  const result = match ? "match" : "no_match";
  const [a, b] = await db.batch<{ count: number }>([
    bump(own),
    bump(target),
    db
      .prepare(
        `INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at)
         SELECT ?, ?, ?, 'bank.matched', json_set(?, '$.result',
           CASE WHEN (SELECT count FROM bank_match_counts WHERE bucket = ?) <= ?
                 AND (SELECT count FROM bank_match_counts WHERE bucket = ?) <= ? THEN ? ELSE 'limited' END), ?`,
      )
      .bind(
        ulid(now.getTime()),
        protectedOrgId,
        "orgId" in caller ? caller.orgId : "sender",
        JSON.stringify(callerDetail(caller)),
        own,
        MATCHES_PER_HOUR,
        target,
        MATCHES_PER_HOUR,
        result,
        now.toISOString(),
      ),
  ]);
  const over = (r: typeof a) => (r?.results[0]?.count ?? Number.POSITIVE_INFINITY) > MATCHES_PER_HOUR;
  if (over(a) || over(b)) throw new MatchLimited("too many account checks this hour; try again later");
  return { match };
}

export type MaskedAccount = { id: string; bankName: string; branchCode: string; holder: string; masked: string };

// What the owner's console shows of each account: never more of the number than its last three digits.
export async function maskedAccounts(db: D1Database, orgId: string): Promise<MaskedAccount[]> {
  return (await rowsOf(db, orgId, MASKED_COLUMNS)).map((r) => ({
    id: r.id,
    bankName: r.bank_name,
    branchCode: r.branch_code,
    holder: r.holder,
    masked: `***${r.last3}`,
  }));
}

async function decryptRow(
  keys: Pick<BankKeys, "encrypt">,
  row: Pick<Row, "number_iv" | "number_ciphertext">,
): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(row.number_iv) },
      keys.encrypt,
      new Uint8Array(row.number_ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new AccountRefused("the stored account number cannot be read");
  }
}

// The only function that returns a full number: for re-keying and the owner's own export, never the console.
export async function decryptForOwner(
  db: D1Database,
  keys: BankKeys,
  orgId: string,
  accountId: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT * FROM bank_accounts WHERE id = ? AND org_id = ?")
    .bind(accountId, orgId)
    .first<Row>();
  if (!row) throw new AccountRefused("no such account");
  if (row.key_id !== keys.id) throw new KeyMismatch("the account is under another key");
  return decryptRow(keys, row);
}

// Moves every account made under `from` to `to`, in the registry and the supplier ledger (docs/operations.md, Bank
// keys). It first makes `to` the current keys, so from then on the schema refuses an account added under `from`, and
// only then reads the rows to move: an add that raced it either committed before (and is moved) or is refused. Each row
// is decrypted, re-encrypted with a fresh IV and re-hashed, then replaced by an update conditional on `from`'s
// fingerprints, so a second run, or a run after an interruption, changes only what is left. A row that cannot be
// decrypted is left as it is (and keeps refusing matches) and counted. A registry under neither key is refused.
export async function rekeyAccounts(
  db: D1Database,
  from: BankKeys,
  to: BankKeys,
  actor?: string,
): Promise<{ moved: number; unreadable: number; byOrg: { orgId: string; moved: number }[] }> {
  if (from.id === to.id && from.matchId === to.matchId)
    throw new KeyMismatch("the previous and current keys are the same pair");
  await db
    .prepare(
      `INSERT INTO bank_key_epoch (id, key_id, match_key_id) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET key_id = excluded.key_id, match_key_id = excluded.match_key_id
       WHERE bank_key_epoch.key_id = ? AND bank_key_epoch.match_key_id = ?`,
    )
    .bind(to.id, to.matchId, from.id, from.matchId)
    .run();
  const epoch = await currentKeys(db);
  if (epoch?.key_id !== to.id || epoch.match_key_id !== to.matchId)
    throw new KeyMismatch("the registry is under neither the old nor the new keys");
  let moved = 0;
  let unreadable = 0;
  // Rows are moved organisation by organisation, each organisation's updates in one batch with its
  // `bank.rekeyed` audit event when an actor is named (D05 T01 §4, correction 4), so a moved row is never
  // left without its event: a failure leaves that organisation untouched, and a retry moves only what is
  // left and audits only that. Rows that cannot be decrypted are left as they are and counted.
  type Ready = { table: string; row: Pick<Row, "id" | "org_id">; number: string; iv?: Uint8Array };
  const byOrgRows = new Map<string, Ready[]>();
  for (const table of ACCOUNT_TABLES) {
    const rows = (
      await db
        .prepare(`SELECT id, org_id, number_iv, number_ciphertext FROM ${table} WHERE key_id = ? AND match_key_id = ?`)
        .bind(from.id, from.matchId)
        .all<Pick<Row, "id" | "org_id" | "number_iv" | "number_ciphertext">>()
    ).results;
    for (const row of rows) {
      let number: string;
      try {
        number = await decryptRow(from, row);
      } catch {
        unreadable++;
        continue;
      }
      const list = byOrgRows.get(row.org_id) ?? [];
      list.push({ table, row, number });
      byOrgRows.set(row.org_id, list);
    }
  }
  const perOrg: { orgId: string; moved: number }[] = [];
  const at = new Date().toISOString();
  for (const orgId of [...byOrgRows.keys()].sort((a, b) => a.localeCompare(b))) {
    const ready = byOrgRows.get(orgId) as Ready[];
    const statements: D1PreparedStatement[] = [];
    for (const item of ready) {
      const sealed = await sealNumber(to, item.number);
      item.iv = sealed.iv;
      statements.push(
        db
          .prepare(
            `UPDATE ${item.table} SET number_ciphertext = ?, number_iv = ?, number_hmac = ?, key_id = ?, match_key_id = ?
             WHERE id = ? AND key_id = ? AND match_key_id = ?`,
          )
          .bind(sealed.ciphertext, sealed.iv, sealed.hmac, to.id, to.matchId, item.row.id, from.id, from.matchId),
      );
    }
    if (actor) {
      // The event counts, inside the same batch, the rows carrying this run's fresh IVs, and is inserted only
      // when that count is not zero: an overlapping run whose conditional updates changed nothing (the rows
      // were already moved, under the other run's IVs) records no event and claims no moved rows. The IVs ride
      // as one delimited hex parameter per table, so the statement stays within D1's parameter limit however
      // many accounts the organisation holds.
      const ivHex = ready
        .map((item) => [...(item.iv as Uint8Array)].map((b) => b.toString(16).padStart(2, "0")).join(""))
        .join(",")
        .toUpperCase();
      const counted = `(SELECT COUNT(*) FROM bank_accounts WHERE org_id = ? AND instr(',' || ? || ',', ',' || hex(number_iv) || ',') > 0)
        + (SELECT COUNT(*) FROM supplier_accounts WHERE org_id = ? AND instr(',' || ? || ',', ',' || hex(number_iv) || ',') > 0)
        + (SELECT COUNT(*) FROM case_invoice_accounts WHERE org_id = ? AND instr(',' || ? || ',', ',' || hex(number_iv) || ',') > 0)`;
      statements.push(
        db
          .prepare(
            `INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at)
             SELECT ?, ?, ?, 'bank.rekeyed', json_object('moved', ${counted}), ?
             WHERE ${counted} > 0`,
          )
          .bind(
            crypto.randomUUID(),
            orgId,
            actor,
            orgId,
            ivHex,
            orgId,
            ivHex,
            orgId,
            ivHex,
            at,
            orgId,
            ivHex,
            orgId,
            ivHex,
            orgId,
            ivHex,
          ),
      );
    }
    const results = await db.batch(statements);
    const changed = results.slice(0, ready.length).reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    moved += changed;
    if (changed > 0) perOrg.push({ orgId, moved: changed });
  }
  return { moved, unreadable, byOrg: perOrg };
}

// The recovery when a key is lost for good (docs/operations.md, Bank keys): makes `to` the current keys first, so no
// account can be added under the lost ones from then on, then deletes every account under other keys, in the registry
// (each with its `bank.removed` event) and the supplier ledger (each with its `account.removed` ledger event), the
// event in the same batch as its deletion, so the owners can register them again under `to`. An account moved to `to`
// meanwhile is kept. It reports how many it deleted.
// The protected live accounts' organisations (D05 T01 §5; src/auth/protected.ts, D07 T02 §21): one listed by id, and
// every one a protected account belongs to, read in the same SQL as the rows it guards, so no copy of the list exists.
const PROTECTED_SQL = `(org_id IN (${PROTECTED_ORGANISATIONS.map(() => "?").join(", ")})
  OR org_id IN (SELECT m."organizationId" FROM "member" m JOIN "user" u ON u.id = m."userId"
    WHERE lower(u.email) IN (${PROTECTED_ACCOUNTS.map(() => "?").join(", ")})))`;
const PROTECTED_BINDS = [...PROTECTED_ORGANISATIONS, ...PROTECTED_ACCOUNTS];

export async function abandonLostKeys(
  db: D1Database,
  to: BankKeys,
  actor: string,
  now = new Date(),
): Promise<{ deleted: number; kept: number }> {
  await db
    .prepare(
      `INSERT INTO bank_key_epoch (id, key_id, match_key_id) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET key_id = excluded.key_id, match_key_id = excluded.match_key_id`,
    )
    .bind(to.id, to.matchId)
    .run();
  const at = now.toISOString();
  let deleted = 0;
  type Lost = Pick<Row, "id" | "org_id" | "bank_name" | "last3"> & {
    supplier_id?: string;
    verified_from_case_id?: string | null;
  };
  // A case's extracted accounts go with no event of their own: no one registered them, and their case
  // still states what it found; they are deleted so nothing sealed stays under a lost key.
  {
    const r = await db
      .prepare(`DELETE FROM case_invoice_accounts WHERE (key_id != ? OR match_key_id != ?) AND NOT ${PROTECTED_SQL}`)
      .bind(to.id, to.matchId, ...PROTECTED_BINDS)
      .run();
    deleted += r.meta.changes ?? 0;
  }
  for (const table of ACCOUNT_TABLES) {
    if (table === "case_invoice_accounts") continue;
    const extra = table === "supplier_accounts" ? ", supplier_id, verified_from_case_id" : "";
    // A second pass catches an add under the lost keys that committed between the epoch move and the first read; none
    // can commit after the move, so the loop ends.
    for (;;) {
      const rows = (
        await db
          .prepare(
            `SELECT id, org_id, bank_name, last3${extra} FROM ${table}
             WHERE (key_id != ? OR match_key_id != ?) AND NOT ${PROTECTED_SQL} ORDER BY id`,
          )
          .bind(to.id, to.matchId, ...PROTECTED_BINDS)
          .all<Lost>()
      ).results;
      if (rows.length === 0) break;
      const results = await db.batch(
        rows.flatMap((r) => [
          db
            .prepare(
              `DELETE FROM ${table} WHERE id = ? AND (key_id != ? OR match_key_id != ?) AND NOT ${PROTECTED_SQL}`,
            )
            .bind(r.id, to.id, to.matchId, ...PROTECTED_BINDS),
          r.supplier_id === undefined
            ? eventStatement(
                db,
                r.org_id,
                actor,
                "bank.removed",
                { accountId: r.id, bankName: r.bank_name, last3: r.last3 },
                at,
                true,
              )
            : ledgerEventStatement(
                db,
                r.org_id,
                actor,
                "account.removed",
                {
                  supplierId: r.supplier_id,
                  accountId: r.id,
                  bankName: r.bank_name,
                  last3: r.last3,
                  verifiedFromCaseId: r.verified_from_case_id ?? null,
                },
                at,
                true,
              ),
        ]),
      );
      deleted += results.filter((_, i) => i % 2 === 0).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }
  }
  // The protected organisations' accounts under the lost keys stay, still refusing matches with KeyMismatch, and are
  // reported so the operator knows their owners must remove and register them again (D05 T01 §5).
  let kept = 0;
  for (const table of ACCOUNT_TABLES)
    kept +=
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE (key_id != ? OR match_key_id != ?) AND ${PROTECTED_SQL}`)
          .bind(to.id, to.matchId, ...PROTECTED_BINDS)
          .first<{ n: number }>()
      )?.n ?? 0;
  return { deleted, kept };
}
