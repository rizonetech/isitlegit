// Registered bank accounts, match-only (D05 T01 §2; spec 2a; AGENTS.md): numbers encrypted at rest and proven so,
// matching that answers only match or no match for a protected business, typed refusals that never read as a
// mismatch (no account, another key), limits per caller and per business counted with their audit in one batch, the
// owner's masked view, re-keying, and no number or key in any event, error or log.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTECTED_ORGANISATIONS } from "../../src/auth/protected";
import { addSupplier, addSupplierAccount, listSuppliers } from "../../src/invoice/ledger";
import {
  abandonLostKeys,
  addAccount,
  bankKeys,
  canonicalAccount,
  decryptForOwner,
  MATCHES_PER_HOUR,
  maskedAccounts,
  matchBankAccount,
  rekeyAccounts,
  removeAccount,
} from "../../src/trust/bank";
import {
  AccountRefused,
  BankKeysMissing,
  IdentityRefused,
  KeyMismatch,
  MatchLimited,
  NoBaseline,
} from "../../src/trust/errors";
import { eventStatement, setIdentity } from "../../src/trust/identity";
import { addAddress, addDomain, events, makeOrg, protectableOrg } from "./helpers";

const db = env.DB;
const NUMBER = "06200441773";
const account = (over: Record<string, unknown> = {}) => ({
  number: "0620 0441-773",
  branchCode: "250 655",
  bankName: "Kestrel Bank (fictional)",
  holder: "Hadeda Couriers (Pty) Ltd",
  ...over,
});
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const otherKeys = (seed: number) =>
  bankKeys({
    BANK_KEY: b64(Array.from({ length: 32 }, (_, i) => (i + seed) & 255)),
    BANK_MATCH_KEY: b64(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 255)),
  });

async function protectedBusiness(name = "hadeda") {
  const orgId = await protectableOrg(`${name}.example`, `money@${name}.example`);
  await setIdentity(db, orgId, "owner", {
    displayNames: [name],
    financeContact: `money@${name}.example`,
    protected: true,
  });
  return orgId;
}

let logs: string[] = [];
beforeEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS fail_events");
  await db.batch(
    [
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

describe("keys", () => {
  it("imports both keys, and refuses each missing or malformed one without naming its value", async () => {
    const keys = await bankKeys(env);
    expect(keys.id).toMatch(/^[0-9a-f]{16}$/);
    expect(keys.matchId).not.toBe(keys.id);
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ BANK_MATCH_KEY: env.BANK_MATCH_KEY }, /BANK_KEY is not set/],
      [{ BANK_KEY: "not-base64!", BANK_MATCH_KEY: env.BANK_MATCH_KEY }, /BANK_KEY is not 32 bytes/],
      [{ BANK_KEY: btoa("short"), BANK_MATCH_KEY: env.BANK_MATCH_KEY }, /BANK_KEY is not 32 bytes/],
      [{ BANK_KEY: env.BANK_KEY }, /BANK_MATCH_KEY is not set/],
      [{ BANK_KEY: env.BANK_KEY, BANK_MATCH_KEY: b64(Array(31).fill(1)) }, /BANK_MATCH_KEY is not 32 bytes/],
    ];
    for (const [e, message] of cases) {
      const p = bankKeys(e);
      await expect(p).rejects.toBeInstanceOf(BankKeysMissing);
      await expect(p).rejects.toThrow(message);
      await p.catch((error: Error) => {
        for (const v of Object.values(e)) if (v) expect(error.message).not.toContain(v);
      });
    }
  });
});

describe("canonicalAccount", () => {
  it("gives formatted and plain numbers one form, keeps leading zeroes, and refuses malformed ones", () => {
    expect(canonicalAccount({ number: "0620 0441-773", branchCode: "250-655" })).toEqual({
      number: NUMBER,
      branchCode: "250655",
    });
    expect(canonicalAccount({ number: NUMBER, branchCode: "250655" })).toEqual({
      number: NUMBER,
      branchCode: "250655",
    });
    for (const input of [
      { number: "0620O441773", branchCode: "250655" },
      { number: "123456", branchCode: "250655" },
      { number: "123456789012", branchCode: "250655" },
      { number: NUMBER, branchCode: "25065" },
      { number: 6200441773, branchCode: "250655" },
    ])
      expect(() => canonicalAccount(input)).toThrow(AccountRefused);
  });
});

describe("the schema", () => {
  it("refuses a malformed branch code, HMAC, IV and a duplicate account", async () => {
    const orgId = await makeOrg();
    const row = (over: Record<string, unknown>) => {
      const r = {
        id: crypto.randomUUID(),
        branch: "250655",
        hmac: "a".repeat(64),
        iv: new Uint8Array(12),
        key: undefined as string | undefined,
        ...over,
      };
      return db
        .prepare(
          `INSERT INTO bank_accounts (id, org_id, bank_name, branch_code, holder, number_ciphertext, number_iv, number_hmac,
             key_id, match_key_id, last3, added_by, added_at) VALUES (?, ?, 'B', ?, 'H', ?, ?, ?, ?, ?, '773', 'o', 'now')`,
        )
        .bind(r.id, orgId, r.branch, new Uint8Array(27), r.iv, r.hmac, r.key ?? "k".repeat(16), "m".repeat(16))
        .run();
    };
    // No current keys yet: the schema refuses any account until the first add (or a re-key) names them.
    await expect(row({})).rejects.toThrow(/not under the current keys/);
    await db
      .prepare("INSERT INTO bank_key_epoch (id, key_id, match_key_id) VALUES (1, ?, ?)")
      .bind("k".repeat(16), "m".repeat(16))
      .run();
    await row({});
    await expect(row({ hmac: "c".repeat(64), key: "x".repeat(16) })).rejects.toThrow(/not under the current keys/);
    await expect(
      db.prepare("UPDATE bank_accounts SET key_id = ? WHERE org_id = ?").bind("x".repeat(16), orgId).run(),
    ).rejects.toThrow(/not under the current keys/);
    await expect(
      db
        .prepare("INSERT INTO bank_key_epoch (id, key_id, match_key_id) VALUES (2, ?, ?)")
        .bind("k".repeat(16), "m".repeat(16))
        .run(),
    ).rejects.toThrow();
    await expect(row({ branch: "2506551" })).rejects.toThrow();
    await expect(row({ hmac: "z".repeat(64) })).rejects.toThrow();
    await expect(row({ iv: new Uint8Array(11), hmac: "b".repeat(64) })).rejects.toThrow();
    await expect(row({})).rejects.toThrow(/UNIQUE/);
  });
});

describe("adding and encryption at rest", () => {
  it("stores the number encrypted under a fresh IV, decryptable independently, and refuses it twice", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    const { id } = await addAccount(db, keys, orgId, "owner", account());
    await addAccount(db, keys, orgId, "owner", account({ number: "12345678" }));
    const rows = (await db.prepare("SELECT * FROM bank_accounts WHERE org_id = ? ORDER BY id").bind(orgId).all())
      .results as Record<string, ArrayBuffer | string>[];
    const stored = rows.find((r) => r.id === id) as Record<string, ArrayBuffer | string>;
    const raw = new Uint8Array(stored.number_ciphertext as ArrayBuffer);
    expect(String.fromCharCode(...raw)).not.toContain("0441");
    expect(JSON.stringify(stored)).not.toContain(NUMBER);
    // Independent decryption with the test key, outside the module.
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(env.BANK_KEY as string), (c) => c.charCodeAt(0)),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(stored.number_iv as ArrayBuffer) },
      key,
      raw,
    );
    expect(new TextDecoder().decode(plain)).toBe(NUMBER);
    expect(Buffer.from(rows[0]?.number_iv as ArrayBuffer).equals(Buffer.from(rows[1]?.number_iv as ArrayBuffer))).toBe(
      false,
    );
    expect(await decryptForOwner(db, keys, orgId, id)).toBe(NUMBER);
    await expect(addAccount(db, keys, orgId, "owner", account({ number: NUMBER }))).rejects.toThrow(
      /already registered/,
    );
  });

  it("refuses a stored number whose ciphertext or tag was altered", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    const { id } = await addAccount(db, keys, orgId, "owner", account());
    for (const at of [0, 20]) {
      const row = await db
        .prepare("SELECT number_ciphertext FROM bank_accounts WHERE id = ?")
        .bind(id)
        .first<{ number_ciphertext: ArrayBuffer }>();
      const bytes = new Uint8Array(row?.number_ciphertext as ArrayBuffer);
      bytes[at] = (bytes[at] as number) ^ 1;
      await db.prepare("UPDATE bank_accounts SET number_ciphertext = ? WHERE id = ?").bind(bytes, id).run();
      await expect(decryptForOwner(db, keys, orgId, id)).rejects.toThrow(/cannot be read/);
      bytes[at] = (bytes[at] as number) ^ 1;
      await db.prepare("UPDATE bank_accounts SET number_ciphertext = ? WHERE id = ?").bind(bytes, id).run();
    }
    expect(await decryptForOwner(db, keys, orgId, id)).toBe(NUMBER);
  });

  it("refuses malformed details and rolls the account back when its event cannot be written", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    await expect(addAccount(db, keys, orgId, "owner", account({ holder: "" }))).rejects.toThrow(AccountRefused);
    await expect(addAccount(db, keys, orgId, "owner", account({ extra: 1 }))).rejects.toThrow(AccountRefused);
    await db.exec(
      "CREATE TRIGGER fail_events BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    await expect(addAccount(db, keys, orgId, "owner", account())).rejects.toThrow(/audit down/);
    expect(await maskedAccounts(db, orgId)).toEqual([]);
  });
});

describe("removing", () => {
  it("removes one of two accounts, refuses missing or foreign ones with no event, and rolls back on audit failure", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    const other = await protectedBusiness("ibis");
    const a = await addAccount(db, keys, orgId, "owner", account());
    await addAccount(db, keys, orgId, "owner", account({ number: "12345678" }));
    const foreign = await addAccount(db, keys, other, "owner", account());
    await removeAccount(db, orgId, "owner", a.id);
    expect((await maskedAccounts(db, orgId)).map((m) => m.masked)).toEqual(["***678"]);
    expect(await matchBankAccount(db, keys, { orgId: other }, orgId, { number: NUMBER, branchCode: "250655" })).toEqual(
      { match: false },
    );
    expect(
      await matchBankAccount(db, keys, { orgId: other }, orgId, { number: "12345678", branchCode: "250655" }),
    ).toEqual({ match: true });
    const before = (await events(orgId)).length;
    await expect(removeAccount(db, orgId, "owner", a.id)).rejects.toThrow(/no such account/);
    await expect(removeAccount(db, orgId, "owner", foreign.id)).rejects.toThrow(/no such account/);
    expect((await events(orgId)).length).toBe(before);
    const last = (await maskedAccounts(db, orgId))[0]?.id as string;
    await db.exec(
      "CREATE TRIGGER fail_events BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    await expect(removeAccount(db, orgId, "owner", last)).rejects.toThrow(/audit down/);
    expect(await maskedAccounts(db, orgId)).toHaveLength(1);
  });
});

describe("matching", () => {
  it("answers match or no match and nothing else, on the canonical number and the branch", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    const checker = await makeOrg("Checker");
    await addAccount(db, keys, orgId, "owner", account());
    const m = (input: { number: string; branchCode: string }) =>
      matchBankAccount(db, keys, { orgId: checker }, orgId, input);
    const yes = await m({ number: NUMBER, branchCode: "250655" });
    expect(yes).toEqual({ match: true });
    expect(Object.keys(yes)).toEqual(["match"]);
    expect(await m({ number: "0620-0441 773", branchCode: "250 655" })).toEqual({ match: true });
    expect(await m({ number: "06200441774", branchCode: "250655" })).toEqual({ match: false });
    expect(await m({ number: NUMBER, branchCode: "632005" })).toEqual({ match: false });
  });

  it("refuses an unprotected business, one without an account (before the first and after the last), and one under another key", async () => {
    const keys = await bankKeys(env);
    const checker = await makeOrg("Checker");
    const draft = await protectableOrg("draft.example", "x@draft.example");
    await setIdentity(db, draft, "o", { displayNames: ["Draft"], financeContact: "x@draft.example", protected: false });
    const input = { number: NUMBER, branchCode: "250655" };
    await expect(matchBankAccount(db, keys, { orgId: checker }, draft, input)).rejects.toThrow(IdentityRefused);
    const orgId = await protectedBusiness();
    await expect(matchBankAccount(db, keys, { orgId: checker }, orgId, input)).rejects.toThrow(NoBaseline);
    const { id } = await addAccount(db, keys, orgId, "owner", account());
    await removeAccount(db, orgId, "owner", id);
    await expect(matchBankAccount(db, keys, { orgId: checker }, orgId, input)).rejects.toThrow(NoBaseline);
    await addAccount(db, keys, orgId, "owner", account());
    for (const replaced of [
      await otherKeys(9),
      { ...keys, match: (await otherKeys(9)).match, matchId: (await otherKeys(9)).matchId },
    ])
      await expect(matchBankAccount(db, replaced, { orgId: checker }, orgId, input)).rejects.toThrow(KeyMismatch);
    await expect(addAccount(db, await otherKeys(9), orgId, "owner", account({ number: "12345678" }))).rejects.toThrow(
      KeyMismatch,
    );
  });
});

describe("limits and their audit", () => {
  const input = { number: NUMBER, branchCode: "250655" };
  it("refuses the 21st match an hour from one organisation, from one sender, and against one business", async () => {
    const keys = await bankKeys(env);
    const a = await protectedBusiness("hadeda");
    const b = await protectedBusiness("ibis");
    for (const id of [a, b]) await addAccount(db, keys, id, "owner", account());
    const checker = await makeOrg("Checker");
    const t0 = new Date("2026-10-31T10:05:00Z");
    for (let i = 0; i < MATCHES_PER_HOUR; i++)
      await matchBankAccount(db, keys, { orgId: checker }, i % 2 ? a : b, input, t0);
    await expect(matchBankAccount(db, keys, { orgId: checker }, a, input, t0)).rejects.toThrow(MatchLimited);
    // A new hour opens a new window.
    expect(await matchBankAccount(db, keys, { orgId: checker }, a, input, new Date("2026-10-31T11:00:01Z"))).toEqual({
      match: true,
    });
    // One sender, against two businesses: counted as one caller.
    await db.prepare("DELETE FROM bank_match_counts").run();
    for (let i = 0; i < MATCHES_PER_HOUR; i++)
      await matchBankAccount(db, keys, { sender: "X@scam.example" }, i % 2 ? a : b, input, t0);
    await expect(matchBankAccount(db, keys, { sender: "x@scam.example" }, a, input, t0)).rejects.toThrow(MatchLimited);
    // Many senders against one business: the business's own bucket.
    await db.prepare("DELETE FROM bank_match_counts").run();
    for (let i = 0; i < MATCHES_PER_HOUR; i++)
      await matchBankAccount(db, keys, { sender: `s${i}@scam.example` }, a, input, t0);
    await expect(matchBankAccount(db, keys, { sender: "fresh@scam.example" }, a, input, t0)).rejects.toThrow(
      MatchLimited,
    );
    expect(await matchBankAccount(db, keys, { sender: "fresh@scam.example" }, b, input, t0)).toEqual({ match: true });
  });

  it("counts a check delayed from the previous hour against the current window, never moving it back", async () => {
    const keys = await bankKeys(env);
    const a = await protectedBusiness();
    await addAccount(db, keys, a, "owner", account());
    const late = new Date("2026-10-31T10:59:59Z");
    const now = new Date("2026-10-31T11:05:00Z");
    for (let i = 0; i < MATCHES_PER_HOUR - 1; i++)
      await matchBankAccount(db, keys, { sender: `n${i}@scam.example` }, a, input, now);
    // A check that started before 11:00 and reached the database after the current hour's checks.
    expect(await matchBankAccount(db, keys, { sender: "slow@scam.example" }, a, input, late)).toEqual({ match: true });
    await expect(matchBankAccount(db, keys, { sender: "next@scam.example" }, a, input, now)).rejects.toThrow(
      MatchLimited,
    );
    const windows = await db
      .prepare("SELECT window_start FROM bank_match_counts WHERE bucket = ?")
      .bind(`protected:${a}`)
      .first();
    expect(windows).toEqual({ window_start: "2026-10-31T11:00:00Z" });
  });

  it("answers nothing and counts nothing when the match's audit cannot be written", async () => {
    const keys = await bankKeys(env);
    const a = await protectedBusiness();
    await addAccount(db, keys, a, "owner", account());
    const before = await events(a);
    await db.exec(
      "CREATE TRIGGER fail_events BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    await expect(matchBankAccount(db, keys, { sender: "p@scam.example" }, a, input)).rejects.toThrow(/audit down/);
    await db.exec("DROP TRIGGER fail_events");
    expect(await db.prepare("SELECT * FROM bank_match_counts").all()).toMatchObject({ results: [] });
    expect(await events(a)).toEqual(before);
  });

  it("admits exactly 20 of 30 concurrent matches, and audits each attempt with its result", async () => {
    const keys = await bankKeys(env);
    const a = await protectedBusiness();
    await addAccount(db, keys, a, "owner", account());
    const t0 = new Date("2026-10-31T10:05:00Z");
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => matchBankAccount(db, keys, { sender: `p${i}@scam.example` }, a, input, t0)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof MatchLimited)).toHaveLength(10);
    const matched = (await events(a)).filter((e) => e.kind === "bank.matched");
    expect(matched.map((e) => e.detail.result).sort()).toEqual(
      [...Array(10).fill("limited"), ...Array(20).fill("match")].sort(),
    );
  });
});

describe("the owner's view, re-keying and what never leaks", () => {
  it("shows each account's complete masked record and no other organisation's", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    const other = await protectedBusiness("ibis");
    const first = await addAccount(db, keys, orgId, "owner", account());
    const second = await addAccount(
      db,
      keys,
      orgId,
      "owner",
      account({
        number: "12345678",
        branchCode: "632005",
        bankName: "Ibis Mutual (fictional)",
        holder: "Hadeda Payroll",
      }),
    );
    await addAccount(db, keys, other, "owner", account());
    expect(await maskedAccounts(db, orgId)).toEqual([
      {
        id: first.id,
        bankName: "Kestrel Bank (fictional)",
        branchCode: "250655",
        holder: "Hadeda Couriers (Pty) Ltd",
        masked: "***773",
      },
      {
        id: second.id,
        bankName: "Ibis Mutual (fictional)",
        branchCode: "632005",
        holder: "Hadeda Payroll",
        masked: "***678",
      },
    ]);
    await expect(decryptForOwner(db, keys, other, first.id)).rejects.toThrow(/no such account/);
    await expect(decryptForOwner(db, await otherKeys(3), orgId, first.id)).rejects.toThrow(KeyMismatch);
  });

  it("re-keys every row, matches under the new keys, is a no-op the second time, and leaves an unreadable row refused", async () => {
    const keys = await bankKeys(env);
    const next = await otherKeys(5);
    const a = await protectedBusiness("hadeda");
    const b = await protectedBusiness("ibis");
    await addAccount(db, keys, a, "owner", account());
    await addAccount(db, keys, b, "owner", account({ number: "12345678" }));
    const broken = await addAccount(db, keys, b, "owner", account({ number: "87654321" }));
    await db
      .prepare("UPDATE bank_accounts SET number_ciphertext = ? WHERE id = ?")
      .bind(new Uint8Array(27), broken.id)
      .run();
    expect(await rekeyAccounts(db, keys, next)).toEqual({
      moved: 2,
      unreadable: 1,
      byOrg: [
        { orgId: a, moved: 1 },
        { orgId: b, moved: 1 },
      ].sort((x, y) => x.orgId.localeCompare(y.orgId)),
    });
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 0, unreadable: 1, byOrg: [] });
    const checker = await makeOrg("Checker");
    expect(await matchBankAccount(db, next, { orgId: checker }, a, { number: NUMBER, branchCode: "250655" })).toEqual({
      match: true,
    });
    await expect(
      matchBankAccount(db, next, { orgId: checker }, b, { number: "12345678", branchCode: "250655" }),
    ).rejects.toThrow(KeyMismatch);
  });

  it("refuses an add that checked the old keys before a re-key and lands after it, and leaves nothing behind", async () => {
    const keys = await bankKeys(env);
    const next = await otherKeys(5);
    const a = await protectedBusiness();
    await addAccount(db, keys, a, "owner", account());
    // The add passes its key check and encrypts under the old keys, then waits at its write while the re-key runs.
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
    const late = addAccount(paused, keys, a, "owner", account({ number: "12345678" }));
    await atWrite;
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 1, unreadable: 0, byOrg: [{ orgId: a, moved: 1 }] });
    release();
    await expect(late).rejects.toThrow(KeyMismatch);
    const rows = await db.prepare("SELECT key_id FROM bank_accounts").all<{ key_id: string }>();
    expect(rows.results).toEqual([{ key_id: next.id }]);
    expect((await events(a)).filter((e) => e.kind === "bank.added")).toHaveLength(1);
    const checker = await makeOrg("Checker");
    expect(await matchBankAccount(db, next, { orgId: checker }, a, { number: NUMBER, branchCode: "250655" })).toEqual({
      match: true,
    });
    // Once moved, the old keys can neither add nor match, and a registry under neither key cannot be re-keyed.
    await expect(addAccount(db, keys, a, "owner", account({ number: "12345678" }))).rejects.toThrow(KeyMismatch);
    await expect(rekeyAccounts(db, await otherKeys(8), await otherKeys(9))).rejects.toThrow(KeyMismatch);
  });

  it("finishes the move on a second run after a write fails halfway through the first", async () => {
    const keys = await bankKeys(env);
    const next = await otherKeys(5);
    const a = await protectedBusiness();
    const first = await addAccount(db, keys, a, "owner", account());
    const second = await addAccount(db, keys, a, "owner", account({ number: "12345678" }));
    await db.exec(
      `CREATE TRIGGER fail_rekey BEFORE UPDATE ON bank_accounts WHEN NEW.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'database down'); END`,
    );
    await expect(rekeyAccounts(db, keys, next)).rejects.toThrow(/database down/);
    await db.exec("DROP TRIGGER fail_rekey");
    const keyOf = async (id: string) =>
      (await db.prepare("SELECT key_id FROM bank_accounts WHERE id = ?").bind(id).first<{ key_id: string }>())?.key_id;
    // The organisation's rows move in one batch with its audit event, so the failed run moved none of them.
    expect([await keyOf(first.id), await keyOf(second.id)]).toEqual([keys.id, keys.id]);
    // Unmoved: matching refuses under either key rather than answering from half the registry.
    const checker = await makeOrg("Checker");
    const input = { number: NUMBER, branchCode: "250655" };
    for (const k of [keys, next])
      await expect(matchBankAccount(db, k, { orgId: checker }, a, input)).rejects.toThrow(KeyMismatch);
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 2, unreadable: 0, byOrg: [{ orgId: a, moved: 2 }] });
    expect(await matchBankAccount(db, next, { orgId: checker }, a, input)).toEqual({ match: true });
    expect(await decryptForOwner(db, next, a, second.id)).toBe("12345678");
  });

  it("refuses matching under the old keys once a re-key has started, even before any row moved", async () => {
    const keys = await bankKeys(env);
    const next = await otherKeys(5);
    const a = await protectedBusiness();
    await addAccount(db, keys, a, "owner", account());
    await db.exec(
      "CREATE TRIGGER fail_rekey BEFORE UPDATE ON bank_accounts BEGIN SELECT RAISE(ABORT, 'database down'); END",
    );
    await expect(rekeyAccounts(db, keys, next)).rejects.toThrow(/database down/);
    await db.exec("DROP TRIGGER fail_rekey");
    const checker = await makeOrg("Checker");
    const input = { number: NUMBER, branchCode: "250655" };
    for (const k of [keys, next])
      await expect(matchBankAccount(db, k, { orgId: checker }, a, input)).rejects.toThrow(KeyMismatch);
    expect(await rekeyAccounts(db, keys, next)).toEqual({ moved: 1, unreadable: 0, byOrg: [{ orgId: a, moved: 1 }] });
    expect(await matchBankAccount(db, next, { orgId: checker }, a, input)).toEqual({ match: true });
  });

  it("recovers from a key lost for good: deletes the accounts under it, audited, and lets the owners register again", async () => {
    const lost = await bankKeys(env);
    const next = await otherKeys(5);
    const a = await protectedBusiness("hadeda");
    const b = await protectedBusiness("ibis");
    const gone = await addAccount(db, lost, a, "owner", account());
    await addAccount(db, lost, b, "owner", account({ number: "12345678" }));
    // Without the recovery, deleting the accounts leaves the lost keys current and every new registration refused.
    await removeAccount(db, b, "owner", (await maskedAccounts(db, b))[0]?.id as string);
    await expect(addAccount(db, next, b, "owner", account())).rejects.toThrow(KeyMismatch);
    expect(await abandonLostKeys(db, next, "operator")).toEqual({ deleted: 1, kept: 0 });
    expect(await maskedAccounts(db, a)).toEqual([]);
    const removed = (await events(a)).filter((e) => e.kind === "bank.removed");
    expect(removed).toMatchObject([
      { actor: "operator", detail: { accountId: gone.id, bankName: "Kestrel Bank (fictional)", last3: "773" } },
    ]);
    await addAccount(db, next, a, "owner", account());
    await addAccount(db, next, b, "owner", account());
    const checker = await makeOrg("Checker");
    const input = { number: NUMBER, branchCode: "250655" };
    expect(await matchBankAccount(db, next, { orgId: checker }, a, input)).toEqual({ match: true });
    await expect(addAccount(db, lost, a, "owner", account({ number: "12345678" }))).rejects.toThrow(KeyMismatch);
    // A second run has nothing left to delete.
    expect(await abandonLostKeys(db, next, "operator")).toEqual({ deleted: 0, kept: 0 });
  });

  it("keeps the protected live accounts' organisations out of the lost-key removal, counting them (D05 T01 §5)", async () => {
    const lost = await bankKeys(env);
    const next = await otherKeys(9);
    const ordinary = await protectedBusiness("hadeda");
    // Fynbos Freight, listed by its id, and an organisation the operator's own account belongs to.
    const listed = PROTECTED_ORGANISATIONS[0] as string;
    await db
      .prepare(
        `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos Freight', 'fynbos-protected', ?)`,
      )
      .bind(listed, new Date().toISOString())
      .run();
    await addDomain(listed, "fynbos.example");
    await addAddress(listed, "money@fynbos.example");
    await setIdentity(db, listed, "owner", {
      displayNames: ["Fynbos Freight"],
      financeContact: "money@fynbos.example",
      protected: true,
    });
    const operators = await protectedBusiness("operator-own");
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u-operator', 'Operator', 'derick@rizonetech.com', 1, ?, ?)`,
      )
      .bind(at, at)
      .run();
    await db
      .prepare(
        `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('m-operator', ?, 'u-operator', 'owner', ?)`,
      )
      .bind(operators, at)
      .run();
    // Each with a bank account and a supplier account under the keys about to be lost.
    const supplierAccount = async (orgId: string) => {
      const { id } = await addSupplier(db, orgId, "owner", { name: "Karoo Parts", domains: ["karooparts.example"] });
      return addSupplierAccount(db, lost, orgId, "owner", id, {
        number: "11111111",
        branchCode: "250655",
        bankName: "Kestrel Bank",
        holder: "Karoo Parts",
      });
    };
    const kept: Record<string, string> = {};
    for (const orgId of [ordinary, listed, operators]) {
      kept[orgId] = (await addAccount(db, lost, orgId, "owner", account())).id;
      await supplierAccount(orgId);
    }
    // Both audit trails, the registry's and the supplier ledger's, as they stood before the recovery (completion review).
    const ledgerEvents = async (orgId: string) =>
      (
        await db
          .prepare("SELECT kind, detail_json FROM ledger_events WHERE org_id = ? ORDER BY rowid")
          .bind(orgId)
          .all<{ kind: string; detail_json: string }>()
      ).results;
    const eventsBefore = {
      listed: await events(listed),
      operators: await events(operators),
      listedLedger: await ledgerEvents(listed),
      operatorsLedger: await ledgerEvents(operators),
    };
    const unchanged = async () => {
      expect(await events(listed)).toEqual(eventsBefore.listed);
      expect(await events(operators)).toEqual(eventsBefore.operators);
      expect(await ledgerEvents(listed)).toEqual(eventsBefore.listedLedger);
      expect(await ledgerEvents(operators)).toEqual(eventsBefore.operatorsLedger);
    };
    expect(await abandonLostKeys(db, next, "operator")).toEqual({ deleted: 2, kept: 4 });
    expect(await maskedAccounts(db, ordinary)).toEqual([]);
    expect((await listSuppliers(db, ordinary))[0]?.accounts).toEqual([]);
    for (const orgId of [listed, operators]) {
      expect((await maskedAccounts(db, orgId)).map((a) => a.id)).toEqual([kept[orgId]]);
      expect((await listSuppliers(db, orgId))[0]?.accounts).toHaveLength(1);
    }
    await unchanged();
    // A retry writes nothing for them either.
    expect(await abandonLostKeys(db, next, "operator")).toEqual({ deleted: 0, kept: 4 });
    await unchanged();
    // A kept account still refuses a match until its owner registers it again under the new keys.
    const checker = await makeOrg("Checker");
    const input = { number: NUMBER, branchCode: "250655" };
    await expect(matchBankAccount(db, next, { orgId: checker }, listed, input)).rejects.toThrow(KeyMismatch);
    await removeAccount(db, listed, "owner", kept[listed] as string);
    await addAccount(db, next, listed, "owner", account());
    expect(await matchBankAccount(db, next, { orgId: checker }, listed, input)).toEqual({ match: true });
    // A second run deletes nothing more and still counts what the protected organisations keep.
    expect(await abandonLostKeys(db, next, "operator")).toEqual({ deleted: 0, kept: 3 });
  });

  it("reads events back in the order they were written, even within one millisecond", async () => {
    // Ids from one millisecond sort at random (src/db/ulid.ts), so the history is read in insertion order (rowid).
    const orgId = await protectedBusiness();
    const at = "2026-10-31T10:00:00.000Z";
    await db.batch([
      eventStatement(db, orgId, "first", "bank.added", { n: 1 }, at, false, `01M6ZZZZZZZZZZZZZZZZZZZZZZ`),
      eventStatement(db, orgId, "second", "bank.removed", { n: 2 }, at, false, `01M6AAAAAAAAAAAAAAAAAAAAAA`),
    ]);
    expect((await events(orgId)).slice(-2).map((e) => e.actor)).toEqual(["first", "second"]);
  });

  it("writes exactly the allowlisted payload, and no number or key reaches an event, error or log", async () => {
    const keys = await bankKeys(env);
    const orgId = await protectedBusiness();
    const checker = await makeOrg("Checker");
    const { id } = await addAccount(db, keys, orgId, "owner", account());
    await matchBankAccount(db, keys, { orgId: checker }, orgId, { number: NUMBER, branchCode: "250655" });
    await matchBankAccount(db, keys, { sender: "pay@scam.example" }, orgId, {
      number: "11112222",
      branchCode: "250655",
    });
    await removeAccount(db, orgId, "owner", id);
    const bank = (await events(orgId)).filter((e) => e.kind.startsWith("bank."));
    expect(bank).toEqual([
      {
        kind: "bank.added",
        actor: "owner",
        detail: { accountId: id, bankName: "Kestrel Bank (fictional)", last3: "773" },
      },
      { kind: "bank.matched", actor: checker, detail: { callerOrgId: checker, result: "match" } },
      { kind: "bank.matched", actor: "sender", detail: { senderDomain: "scam.example", result: "no_match" } },
      {
        kind: "bank.removed",
        actor: "owner",
        detail: { accountId: id, bankName: "Kestrel Bank (fictional)", last3: "773" },
      },
    ]);
    const errors: string[] = [];
    for (const attempt of [
      () => addAccount(db, keys, orgId, "owner", account({ number: "0620-0441-773X" })),
      () => matchBankAccount(db, keys, { orgId: checker }, orgId, { number: "0620 0441 773", branchCode: "2506" }),
      () => bankKeys({ BANK_KEY: `${env.BANK_KEY}x`, BANK_MATCH_KEY: env.BANK_MATCH_KEY }),
    ])
      await attempt().catch((e: Error) => errors.push(`${e.name} ${e.message}`));
    const secrets = [
      NUMBER,
      "0620 0441-773",
      "0620-0441-773",
      "0620 0441 773",
      env.BANK_KEY as string,
      env.BANK_MATCH_KEY as string,
    ];
    const everything = [JSON.stringify(await events(orgId)), ...errors, ...logs].join("\n");
    for (const s of secrets) expect(everything).not.toContain(s);
    expect(errors).toHaveLength(3);
  });
});
