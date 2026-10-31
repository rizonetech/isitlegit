// The supplier ledger (D06 T01 §2; spec 4.5): suppliers with registrable domains and a phone number, their accounts
// kept as the bank registry keeps numbers (encrypted, matched by HMAC, under the current keys only), `findSupplier`
// that never guesses, every change audited with an allowlisted payload and scoped by organisation, re-keying and the
// lost-key recovery across both account tables, and the ledger's domains reaching `domain.lookalike`.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { listSupplierDomains } from "../../src/checks/suppliers";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, putRaw, rawKey, type Store } from "../../src/intake/store";
import { SupplierAmbiguous, SupplierRefused } from "../../src/invoice/errors";
import {
  addSupplier,
  addSupplierAccount,
  findSupplier,
  listSuppliers,
  matchSupplierAccount,
  removeSupplier,
  removeSupplierAccount,
  updateSupplier,
} from "../../src/invoice/ledger";
import { checks } from "../../src/pipeline/analysis-workflow";
import { abandonLostKeys, addAccount, bankKeys, matchBankAccount, rekeyAccounts } from "../../src/trust/bank";
import { AccountRefused, KeyMismatch, NoBaseline } from "../../src/trust/errors";
import { setIdentity } from "../../src/trust/identity";
import { makeOrg, protectableOrg } from "../trust/helpers";

const db = env.DB;
const NUMBER = "06200441773";
const account = (over: Record<string, unknown> = {}) => ({
  number: "0620 0441-773",
  branchCode: "250 655",
  bankName: "Kestrel Bank (fictional)",
  holder: "Karoo Parts (Pty) Ltd",
  ...over,
});
const claim = { number: NUMBER, branchCode: "250655" };
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const otherKeys = (seed: number) =>
  bankKeys({
    BANK_KEY: b64(Array.from({ length: 32 }, (_, i) => (i + seed) & 255)),
    BANK_MATCH_KEY: b64(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 255)),
  });

type Event = { org_id: string; actor: string; kind: string; detail: Record<string, unknown> };
const ledgerEvents = async (orgId?: string): Promise<Event[]> =>
  (
    await db
      .prepare(
        `SELECT org_id, actor, kind, detail_json FROM ledger_events ${orgId ? "WHERE org_id = ?" : ""} ORDER BY created_at, id`,
      )
      .bind(...(orgId ? [orgId] : []))
      .all<{ org_id: string; actor: string; kind: string; detail_json: string }>()
  ).results.map((r) => ({ org_id: r.org_id, actor: r.actor, kind: r.kind, detail: JSON.parse(r.detail_json) }));

const karoo = (over: Record<string, unknown> = {}) => ({
  name: "Karoo Parts",
  domains: ["billing.karooparts.co.za", "KarooParts.co.za"],
  phone: "+27 21 555 0100",
  notes: "Pays on the 25th",
  ...over,
});

let logs: string[] = [];
beforeEach(async () => {
  for (const trigger of ["fail_events", "fail_ledger", "fail_rekey", "fail_trust"])
    await db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  await db.batch(
    [
      "ledger_events",
      "supplier_accounts",
      "suppliers",
      "bank_match_counts",
      "bank_accounts",
      "bank_key_epoch",
      "trust_events",
      "identities",
      "org_domains",
      "org_addresses",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  logs = [];
  for (const level of ["log", "error", "warn", "info"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const failLedgerEvents = () =>
  db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_events BEGIN SELECT RAISE(ABORT, 'audit down'); END");

async function caseOf(orgId: string) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

describe("the schema", () => {
  it("stores a supplier and an account, and refuses a duplicate name, a non-array domains value and other keys", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    await addSupplierAccount(db, keys, org, "owner", id, account());
    const insert = (name: string, domains: string) =>
      db
        .prepare(
          `INSERT INTO suppliers (id, org_id, name, name_key, domains_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'o', 'now', 'now')`,
        )
        .bind(crypto.randomUUID(), org, name, name.toLowerCase().replace(/\s+/g, " ").trim(), domains)
        .run();
    await expect(insert("KAROO   parts", "[]")).rejects.toThrow(/UNIQUE/);
    await expect(insert("Fynbos Freight", '{"a":1}')).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO supplier_accounts (id, org_id, supplier_id, bank_name, branch_code, holder, number_ciphertext,
             number_iv, number_hmac, key_id, match_key_id, last3, added_by, added_at)
           VALUES (?, ?, ?, 'B', '250655', 'H', ?, ?, ?, ?, ?, '773', 'o', 'now')`,
        )
        .bind(
          crypto.randomUUID(),
          org,
          id,
          new Uint8Array(27),
          new Uint8Array(12),
          "a".repeat(64),
          "x".repeat(16),
          keys.matchId,
        )
        .run(),
    ).rejects.toThrow(/supplier_accounts: not under the current keys/);
  });
});

describe("suppliers", () => {
  it("adds, edits and removes a supplier, its domains stored as registrable domains, each with its event", async () => {
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    expect(await listSuppliers(db, org)).toEqual([
      {
        id,
        name: "Karoo Parts",
        domains: ["karooparts.co.za"],
        phone: "+27 21 555 0100",
        notes: "Pays on the 25th",
        accounts: [],
      },
    ]);
    const edited = await updateSupplier(db, org, "admin", id, {
      name: "Karoo Parts Wholesale",
      domains: ["karooparts.co.za", "mail.karoo-wholesale.com"],
      phone: null,
    });
    expect(edited).toEqual({
      id,
      name: "Karoo Parts Wholesale",
      domains: ["karooparts.co.za", "karoo-wholesale.com"],
      phone: null,
      notes: "Pays on the 25th",
    });
    expect((await listSuppliers(db, org))[0]).toMatchObject({ name: "Karoo Parts Wholesale", phone: null });
    await removeSupplier(db, org, "owner", id);
    expect(await listSuppliers(db, org)).toEqual([]);
    expect(await ledgerEvents(org)).toEqual([
      { org_id: org, actor: "owner", kind: "supplier.added", detail: { supplierId: id, name: "Karoo Parts" } },
      {
        org_id: org,
        actor: "admin",
        kind: "supplier.updated",
        detail: { supplierId: id, name: "Karoo Parts Wholesale" },
      },
      {
        org_id: org,
        actor: "owner",
        kind: "supplier.removed",
        detail: { supplierId: id, name: "Karoo Parts Wholesale" },
      },
    ]);
  });

  it("refuses a bad domain, phone or name and a duplicate in another case or spacing, with no event", async () => {
    const org = await makeOrg();
    await addSupplier(db, org, "owner", karoo());
    for (const bad of [
      karoo({ name: "A", domains: ["not a domain"] }),
      karoo({ name: "B", domains: ["co.za"] }),
      karoo({ name: "C", domains: ["127.0.0.1"] }),
      karoo({ name: "D", phone: "call me" }),
      karoo({ name: "E", phone: "12345" }),
      karoo({ name: "F", phone: "27+215550100" }),
      karoo({ name: "" }),
      karoo({ name: "G", domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.com`) }),
      karoo({ name: "H", extra: 1 }),
      karoo({ name: "  karoo   PARTS " }),
    ])
      await expect(addSupplier(db, org, "owner", bad)).rejects.toThrow(SupplierRefused);
    expect(await ledgerEvents(org)).toHaveLength(1);
    expect(await listSuppliers(db, org)).toHaveLength(1);
  });

  it("names the field a refusal is about, never echoing what was typed", async () => {
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: "" }, /name of 1 to 120/],
      [{ notes: "n".repeat(1001) }, /notes are up to 1,000/],
      [{ domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.com`) }, /up to 20 domains/],
      [{ phone: "0".repeat(31) }, /phone number is 7 to 15 digits/],
      [{ phone: "secret-0620044177" }, /phone number is 7 to 15 digits/],
      [{ ledger: "0620044177" }, /a name, domains, a phone and notes only/],
    ];
    for (const [over, reason] of cases) {
      for (const attempt of [
        () => addSupplier(db, org, "owner", karoo({ name: "Other", ...over })),
        () => updateSupplier(db, org, "owner", id, over),
      ]) {
        const error = await attempt().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SupplierRefused);
        expect(String(error)).toMatch(reason);
        expect(String(error)).not.toContain("0620044177");
      }
    }
  });

  it("leaves every field the patch does not name as it was", async () => {
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    let expected = (await listSuppliers(db, org))[0];
    for (const patch of [{ phone: "+27 21 555 0199" }, { notes: "New terms" }, {}]) {
      await updateSupplier(db, org, "owner", id, patch);
      expected = { ...expected, ...patch } as typeof expected;
      expect((await listSuppliers(db, org))[0]).toEqual(expected);
    }
    expect(await listSupplierDomains(db, org)).toEqual(["karooparts.co.za"]);
    expect(await findSupplier(db, org, { domain: "karooparts.co.za" })).toMatchObject({ id });
  });

  it("keeps both of two concurrent edits to different fields", async () => {
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    // The phone edit reaches its write only after the notes edit has committed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedWrite!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      reachedWrite = resolve;
    });
    const paused = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return async (statements: D1PreparedStatement[]) => {
          reachedWrite();
          await gate;
          return target.batch(statements);
        };
      },
    });
    const phone = updateSupplier(paused, org, "a", id, { phone: "+27 21 555 0199" });
    await atWrite;
    await updateSupplier(db, org, "b", id, { notes: "Pays on the 1st" });
    release();
    expect(await phone).toMatchObject({ phone: "+27 21 555 0199", notes: "Pays on the 1st" });
    expect((await listSuppliers(db, org))[0]).toMatchObject({
      phone: "+27 21 555 0199",
      notes: "Pays on the 1st",
      domains: ["karooparts.co.za"],
    });
    expect(
      (await ledgerEvents(org))
        .filter((e) => e.kind === "supplier.updated")
        .map((e) => e.actor)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("refuses editing or removing another organisation's supplier, both tenants unchanged", async () => {
    const mine = await makeOrg("Mine");
    const theirs = await makeOrg("Theirs");
    const { id } = await addSupplier(db, theirs, "owner", karoo());
    const before = [await listSuppliers(db, theirs), await ledgerEvents()];
    await expect(updateSupplier(db, mine, "owner", id, { name: "Taken" })).rejects.toThrow(SupplierRefused);
    await expect(removeSupplier(db, mine, "owner", id)).rejects.toThrow(SupplierRefused);
    expect([await listSuppliers(db, theirs), await ledgerEvents()]).toEqual(before);
    expect(await listSuppliers(db, mine)).toEqual([]);
  });

  it("leaves the ledger as it was when a change's event cannot be written", async () => {
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    const before = await listSuppliers(db, org);
    await failLedgerEvents();
    await expect(addSupplier(db, org, "owner", karoo({ name: "Fynbos Freight" }))).rejects.toThrow(/audit down/);
    await expect(updateSupplier(db, org, "owner", id, { name: "Renamed" })).rejects.toThrow(/audit down/);
    await expect(removeSupplier(db, org, "owner", id)).rejects.toThrow(/audit down/);
    expect(await listSuppliers(db, org)).toEqual(before);
  });
});

describe("supplier accounts", () => {
  it("stores an account encrypted, refuses it twice, and removes it with its event", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const { id: supplierId } = await addSupplier(db, org, "owner", karoo());
    const caseId = await caseOf(org);
    const { id } = await addSupplierAccount(db, keys, org, "owner", supplierId, account(), {
      verifiedFromCaseId: caseId,
    });
    const row = await db
      .prepare("SELECT number_ciphertext, number_iv, last3 FROM supplier_accounts WHERE id = ?")
      .bind(id)
      .first<{ number_ciphertext: ArrayBuffer; number_iv: ArrayBuffer; last3: string }>();
    const stored = new TextDecoder("latin1").decode(new Uint8Array(row?.number_ciphertext as ArrayBuffer));
    expect(stored).not.toContain("0441");
    const raw = Uint8Array.from(atob(env.BANK_KEY as string), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(row?.number_iv as ArrayBuffer) },
      key,
      new Uint8Array(row?.number_ciphertext as ArrayBuffer),
    );
    expect(new TextDecoder().decode(plain)).toBe(NUMBER);
    await expect(
      addSupplierAccount(db, keys, org, "owner", supplierId, account({ number: "06200441773" })),
    ).rejects.toThrow(AccountRefused);
    expect((await listSuppliers(db, org))[0]?.accounts).toEqual([
      {
        id,
        bankName: "Kestrel Bank (fictional)",
        branchCode: "250655",
        holder: "Karoo Parts (Pty) Ltd",
        masked: "***773",
        verifiedFromCaseId: caseId,
      },
    ]);
    await removeSupplierAccount(db, org, "admin", id);
    await expect(removeSupplierAccount(db, org, "admin", id)).rejects.toThrow(AccountRefused);
    expect((await listSuppliers(db, org))[0]?.accounts).toEqual([]);
    const detail = {
      supplierId,
      accountId: id,
      bankName: "Kestrel Bank (fictional)",
      last3: "773",
      verifiedFromCaseId: caseId,
    };
    expect((await ledgerEvents(org)).slice(1)).toEqual([
      { org_id: org, actor: "owner", kind: "account.added", detail },
      { org_id: org, actor: "admin", kind: "account.removed", detail },
    ]);
  });

  it("refuses another organisation's supplier, case or account, and keys other than the current ones", async () => {
    const keys = await bankKeys(env);
    const mine = await makeOrg("Mine");
    const theirs = await makeOrg("Theirs");
    const { id: own } = await addSupplier(db, mine, "owner", karoo());
    const { id: foreign } = await addSupplier(db, theirs, "owner", karoo());
    const theirAccount = await addSupplierAccount(db, keys, theirs, "owner", foreign, account());
    const before = [await listSuppliers(db, theirs), await ledgerEvents()];
    await expect(addSupplierAccount(db, keys, mine, "owner", foreign, account())).rejects.toThrow(SupplierRefused);
    await expect(
      addSupplierAccount(db, keys, mine, "owner", own, account(), { verifiedFromCaseId: await caseOf(theirs) }),
    ).rejects.toThrow(SupplierRefused);
    await expect(removeSupplierAccount(db, mine, "owner", theirAccount.id)).rejects.toThrow(AccountRefused);
    await expect(addSupplierAccount(db, await otherKeys(9), mine, "owner", own, account())).rejects.toThrow(
      KeyMismatch,
    );
    expect([await listSuppliers(db, theirs), await ledgerEvents()]).toEqual(before);
    expect((await listSuppliers(db, mine))[0]?.accounts).toEqual([]);
  });

  it("rolls an account back when its event cannot be written", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const { id: supplierId } = await addSupplier(db, org, "owner", karoo());
    const kept = await addSupplierAccount(db, keys, org, "owner", supplierId, account({ number: "12345678" }));
    await failLedgerEvents();
    await expect(addSupplierAccount(db, keys, org, "owner", supplierId, account())).rejects.toThrow(/audit down/);
    await expect(removeSupplierAccount(db, org, "owner", kept.id)).rejects.toThrow(/audit down/);
    expect((await listSuppliers(db, org))[0]?.accounts.map((a) => a.id)).toEqual([kept.id]);
  });
});

describe("findSupplier", () => {
  it("finds by a subdomain and by a differently spaced name, never another organisation's", async () => {
    const org = await makeOrg();
    const other = await makeOrg("Other");
    const { id } = await addSupplier(db, org, "owner", karoo());
    await addSupplier(db, other, "owner", karoo({ name: "Fynbos Freight", domains: ["fynbosfreight.co.za"] }));
    expect(await findSupplier(db, org, { domain: "invoices.karooparts.co.za" })).toMatchObject({ id });
    expect(await findSupplier(db, org, { name: "  KAROO   parts " })).toMatchObject({ id, phone: "+27 21 555 0100" });
    expect(await findSupplier(db, org, { name: "Fynbos Freight", domain: "fynbosfreight.co.za" })).toBeNull();
    expect(await findSupplier(db, org, { domain: "not a domain" })).toBeNull();
  });

  it("narrows a shared domain by name, and refuses rather than guesses", async () => {
    const org = await makeOrg();
    const a = await addSupplier(db, org, "owner", karoo({ name: "Thandi Cleaning", domains: ["gmail.com"] }));
    const b = await addSupplier(db, org, "owner", karoo({ name: "Sipho Plumbing", domains: ["gmail.com"] }));
    const c = await addSupplier(db, org, "owner", karoo({ name: "Karoo Parts", domains: ["karooparts.co.za"] }));
    expect(await findSupplier(db, org, { name: "thandi cleaning", domain: "gmail.com" })).toMatchObject({ id: a.id });
    expect(await findSupplier(db, org, { name: "Sipho Plumbing", domain: "gmail.com" })).toMatchObject({ id: b.id });
    await expect(findSupplier(db, org, { domain: "gmail.com" })).rejects.toThrow(SupplierAmbiguous);
    // The domain and the name point at different suppliers.
    await expect(findSupplier(db, org, { name: "Karoo Parts", domain: "gmail.com" })).rejects.toThrow(
      SupplierAmbiguous,
    );
    // A name that narrows the domain's suppliers to none is not one of them.
    expect(await findSupplier(db, org, { name: "Someone Else", domain: "gmail.com" })).toBeNull();
    expect(await findSupplier(db, org, { name: "Someone Else", domain: "karooparts.co.za" })).toBeNull();
    expect(await findSupplier(db, org, { domain: "karooparts.co.za" })).toMatchObject({ id: c.id });
  });
});

describe("matchSupplierAccount", () => {
  it("answers match or no match and nothing else, on the canonical number and the branch", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    await addSupplierAccount(db, keys, org, "owner", id, account());
    const answer = await matchSupplierAccount(db, keys, org, id, { number: "0620-0441 773", branchCode: "250655" });
    expect(answer).toEqual({ match: true });
    expect(Object.keys(answer)).toEqual(["match"]);
    expect(await matchSupplierAccount(db, keys, org, id, { number: "06200441774", branchCode: "250655" })).toEqual({
      match: false,
    });
    expect(await matchSupplierAccount(db, keys, org, id, { number: NUMBER, branchCode: "632005" })).toEqual({
      match: false,
    });
  });

  it("refuses a supplier without an account, another organisation's, and keys other than the current ones", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const other = await makeOrg("Other");
    const { id } = await addSupplier(db, org, "owner", karoo());
    await expect(matchSupplierAccount(db, keys, org, id, claim)).rejects.toThrow(NoBaseline);
    await addSupplierAccount(db, keys, org, "owner", id, account());
    await expect(matchSupplierAccount(db, keys, other, id, claim)).rejects.toThrow(SupplierRefused);
    await expect(matchSupplierAccount(db, await otherKeys(9), org, id, claim)).rejects.toThrow(KeyMismatch);
  });
});

describe("one epoch across the registry and the ledger", () => {
  async function both() {
    const keys = await bankKeys(env);
    const registered = await protectableOrg("hadeda.example", "money@hadeda.example");
    await setIdentity(db, registered, "owner", {
      displayNames: ["Hadeda"],
      financeContact: "money@hadeda.example",
      protected: true,
    });
    await addAccount(db, keys, registered, "owner", {
      ...account(),
      holder: "Hadeda Couriers (Pty) Ltd",
    });
    const org = await makeOrg("Ledger owner");
    const { id: supplierId } = await addSupplier(db, org, "owner", karoo());
    const supplierAccount = await addSupplierAccount(db, keys, org, "owner", supplierId, account());
    const checker = await makeOrg("Checker");
    return { keys, registered, org, supplierId, supplierAccount, checker };
  }

  it("finishes a re-key interrupted between the tables on a retry, both matching under the new keys", async () => {
    const { keys, registered, org, supplierId, checker } = await both();
    const next = await otherKeys(5);
    await db.exec(
      "CREATE TRIGGER fail_rekey BEFORE UPDATE ON supplier_accounts BEGIN SELECT RAISE(ABORT, 'database down'); END",
    );
    await expect(rekeyAccounts(db, keys, next)).rejects.toThrow(/database down/);
    await db.exec("DROP TRIGGER fail_rekey");
    // The registry moved, the ledger did not: the ledger refuses under either key rather than answer.
    for (const k of [keys, next])
      await expect(matchSupplierAccount(db, k, org, supplierId, claim)).rejects.toThrow(KeyMismatch);
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 1, unreadable: 0 });
    expect(await matchSupplierAccount(db, next, org, supplierId, claim)).toEqual({ match: true });
    expect(await matchBankAccount(db, next, { orgId: checker }, registered, claim)).toEqual({ match: true });
    // The old keys can add to neither table once the epoch has moved.
    await expect(
      addSupplierAccount(db, keys, org, "owner", supplierId, account({ number: "12345678" })),
    ).rejects.toThrow(KeyMismatch);
  });

  it("counts an unreadable supplier ciphertext and leaves it refused", async () => {
    const { keys, org, supplierId, supplierAccount } = await both();
    const next = await otherKeys(5);
    await db
      .prepare("UPDATE supplier_accounts SET number_ciphertext = ? WHERE id = ?")
      .bind(new Uint8Array(27), supplierAccount.id)
      .run();
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 1, unreadable: 1 });
    await expect(matchSupplierAccount(db, next, org, supplierId, claim)).rejects.toThrow(KeyMismatch);
  });

  it("refuses an old-key supplier insert that lands after the epoch moved", async () => {
    const { keys, org, supplierId } = await both();
    const next = await otherKeys(5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedWrite!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      reachedWrite = resolve;
    });
    const paused = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return async (statements: D1PreparedStatement[]) => {
          reachedWrite();
          await gate;
          return target.batch(statements);
        };
      },
    });
    const late = addSupplierAccount(paused, keys, org, "owner", supplierId, account({ number: "12345678" }));
    await atWrite;
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 2, unreadable: 0 });
    release();
    await expect(late).rejects.toThrow(KeyMismatch);
    const left = await db.prepare("SELECT key_id FROM supplier_accounts").all<{ key_id: string }>();
    expect(left.results).toEqual([{ key_id: next.id }]);
  });

  it("deletes and audits both kinds under a lost key, and rolls a deletion back when its audit fails", async () => {
    const { registered, org, supplierId, supplierAccount, checker } = await both();
    const next = await otherKeys(5);
    await failLedgerEvents();
    await expect(abandonLostKeys(db, next, "operator")).rejects.toThrow(/audit down/);
    await db.exec("DROP TRIGGER fail_ledger");
    expect((await listSuppliers(db, org))[0]?.accounts.map((a) => a.id)).toEqual([supplierAccount.id]);
    expect(await abandonLostKeys(db, next, "operator")).toEqual({ deleted: 1 });
    expect((await listSuppliers(db, org))[0]?.accounts).toEqual([]);
    expect((await ledgerEvents(org)).at(-1)).toEqual({
      org_id: org,
      actor: "operator",
      kind: "account.removed",
      detail: {
        supplierId,
        accountId: supplierAccount.id,
        bankName: "Kestrel Bank (fictional)",
        last3: "773",
        verifiedFromCaseId: null,
      },
    });
    const removed = await db
      .prepare("SELECT count(*) AS n FROM trust_events WHERE org_id = ? AND kind = 'bank.removed'")
      .bind(registered)
      .first<{ n: number }>();
    expect(removed?.n).toBe(1);
    // Both owners register again under the new keys, and both match.
    await addAccount(db, next, registered, "owner", account());
    await addSupplierAccount(db, next, org, "owner", supplierId, account());
    expect(await matchSupplierAccount(db, next, org, supplierId, claim)).toEqual({ match: true });
    expect(await matchBankAccount(db, next, { orgId: checker }, registered, claim)).toEqual({ match: true });
  });
});

describe("no number or key in any event, error or log", () => {
  it("keeps every number and key out of the ledger's events, errors and logs", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const { id } = await addSupplier(db, org, "owner", karoo());
    const errors: string[] = [];
    await addSupplierAccount(db, keys, org, "owner", id, account());
    for (const attempt of [
      () => addSupplierAccount(db, keys, org, "owner", id, account()),
      () => addSupplierAccount(db, keys, org, "owner", id, account({ number: "0620 0441 77a" })),
      () => matchSupplierAccount(db, keys, org, "missing", claim),
    ])
      await attempt().catch((e: unknown) => errors.push(String(e)));
    const haystack = JSON.stringify(await ledgerEvents()) + errors.join("\n") + logs.join("\n");
    expect(errors).toHaveLength(3);
    for (const secret of [NUMBER, "0620 0441-773", "0441", env.BANK_KEY as string, env.BANK_MATCH_KEY as string])
      expect(haystack).not.toContain(secret);
  });
});

describe("listSupplierDomains and domain.lookalike", () => {
  it("lists each registrable domain once, only this organisation's", async () => {
    const org = await makeOrg();
    const other = await makeOrg("Other");
    await addSupplier(db, org, "owner", karoo());
    await addSupplier(
      db,
      org,
      "owner",
      karoo({ name: "Karoo Parts East", domains: ["karooparts.co.za", "east.fynbos.org.za"] }),
    );
    await addSupplier(db, other, "owner", karoo({ name: "Elsewhere", domains: ["elsewhere.example.com"] }));
    expect(await listSupplierDomains(db, org)).toEqual(["fynbos.org.za", "karooparts.co.za"]);
    expect(await listSupplierDomains(db, await makeOrg("Empty"))).toEqual([]);
  });

  it("stores a lookalike of a ledger supplier's domain as high through the checks step", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db };
    const org = await makeOrg();
    await addSupplier(db, org, "owner", karoo({ domains: ["karooparts.co.za"] }));
    const id = await caseOf(org);
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
    await putParsed(store, id, {
      headers: [{ name: "From", value: "Accounts <billing@karooparts.com>" }],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => []);
    const items = (await readEvidence(db, id)).filter((e) => e.check === "domain.lookalike");
    expect(items).toMatchObject([
      {
        severity: "high",
        artefacts: [rawKey(id)],
        detail: {
          domain: "karooparts.com",
          target: "karooparts.co.za",
          targetKind: "supplier",
          technique: "different-tld",
        },
      },
    ]);
  });
});
