// The supplier ledger's CSV import (D06 T01 §4, corrections 3, 5 and 11): a file is checked in full before anything is
// written, every problem named by row and column, and a checked file lands in one batch, whole or not at all, so the
// same file imported twice changes nothing.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSupplier, importSuppliers, listSuppliers, matchSupplierAccount, siteOf } from "../../src/invoice/ledger";
import { checkImport, IMPORT_TEMPLATE, MAX_IMPORT_BYTES, parseCsv } from "../../src/invoice/ledger-csv";
import { bankKeys } from "../../src/trust/bank";
import { makeOrg } from "../trust/helpers";

const db = env.DB;
const HEADER = "name,domain,bank,branch_code,account_number,phone";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");
const check = (text: string) => checkImport(new TextEncoder().encode(text).length, text, siteOf);
const THREE = csv(
  "Fynbos Freight (Pty) Ltd,fynbosfreight.example,Kestrel Bank,250655,62004417731,044 873 0192",
  '"Outeniqua Paper, Wholesale",outeniquapaper.example,Protea Mutual,198765,1234567890,044 382 5521',
  "Garden Route Tyres,grtyres.example,Kestrel Bank,250655,0620 0441-773,",
);

beforeEach(async () => {
  for (const trigger of ["fail_ledger"]) await db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  await db.batch(["ledger_events", "supplier_accounts", "suppliers"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

describe("reading a file", () => {
  it("reads quoted fields with commas and doubled quotes, a byte order mark, CRLF or LF, and a trailing blank line", () => {
    expect(parseCsv('﻿a,"b, c","d ""e"""\nf,g,h\r\n\r\n')).toEqual({
      records: [
        ["a", "b, c", 'd "e"'],
        ["f", "g", "h"],
      ],
    });
    expect(parseCsv('a,"never closes\nb,c')).toEqual({ error: "the file has a quoted field that never closes" });
    // Characters after a closing quote are refused, never read on as part of the field (completion review).
    expect(parseCsv('h\n"62004"417731,x')).toEqual({ error: "row 1 has characters after a closing quote" });
    expect(parseCsv('h\n"a" ,b')).toEqual({ error: "row 1 has characters after a closing quote" });
  });

  it("checks three good suppliers, the domain read as its registrable domain and the number canonical", () => {
    const result = check(THREE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => [r.row, r.name, r.domain, r.branchCode, r.number, r.phone])).toEqual([
      [1, "Fynbos Freight (Pty) Ltd", "fynbosfreight.example", "250655", "62004417731", "044 873 0192"],
      [2, "Outeniqua Paper, Wholesale", "outeniquapaper.example", "198765", "1234567890", "044 382 5521"],
      [3, "Garden Route Tyres", "grtyres.example", "250655", "06200441773", null],
    ]);
  });

  it("names every bad row by number and column, never echoing an account number", () => {
    const result = check(
      csv(
        "Good Supplier,good.example,Kestrel Bank,250655,62004417731,",
        "Short Number,short.example,Kestrel Bank,250655,123456,",
        "No Branch,nobranch.example,Kestrel Bank,,62004417731,",
        "Free Mail,gmail.com,Kestrel Bank,250655,62004417731,",
        ",noname.example,Kestrel Bank,250655,62004417731,",
        "Too Few,few.example,Kestrel Bank,250655",
        "Bad Phone,phone.example,Kestrel Bank,250655,62004417731,call me",
        "Bad Domain,not a domain,Kestrel Bank,250655,62004417731,",
        "Long Phone,longphone.example,Kestrel Bank,250655,62004417731,0448730192------------------------",
      ),
    );
    expect(result).toEqual({
      ok: false,
      file: null,
      problems: [
        { row: 2, problem: "account_number has 6 digits; an account number has 7 to 11 digits" },
        { row: 3, problem: "branch_code is empty" },
        { row: 4, problem: 'domain "gmail.com" is a free mail service, not a supplier domain' },
        { row: 5, problem: "name is empty" },
        { row: 6, problem: "has 4 fields; a row has 6" },
        { row: 7, problem: "phone is not 7 to 15 digits with an optional leading +" },
        { row: 8, problem: 'domain "not a domain" is not a domain, such as example.co.za' },
        // The stored limit of 30 characters (round 1), named here rather than failing the write.
        { row: 9, problem: "phone is longer than 30 characters" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("refuses a whole file for its size, its header, its quoting, no rows and too many, before reading rows", () => {
    expect(checkImport(MAX_IMPORT_BYTES + 1, THREE, siteOf)).toEqual({
      ok: false,
      file: "the file is larger than 1 MiB",
      problems: [],
    });
    expect(check("supplier,domain\nA,a.example")).toMatchObject({ file: expect.stringMatching(/first row must be/) });
    expect(check(`${HEADER}\n"A,a.example`)).toMatchObject({ file: "the file has a quoted field that never closes" });
    const many = csv(...Array.from({ length: 1001 }, (_, i) => `S${i},s${i}.example,Kestrel Bank,250655,62004417731,`));
    expect(check(many)).toMatchObject({ file: "the file has more than 1,000 suppliers" });
  });

  it("offers a template that is a valid empty import, so it never creates a supplier (completion review)", async () => {
    const result = check(IMPORT_TEMPLATE);
    expect(result).toEqual({ ok: true, rows: [] });
    const keys = await bankKeys(env);
    const org = await makeOrg();
    expect(await importSuppliers(db, keys, org, "owner", [])).toEqual({
      suppliersAdded: 0,
      suppliersUpdated: 0,
      accountsAdded: 0,
      alreadyThere: 0,
    });
    expect(await listSuppliers(db, org)).toEqual([]);
  });
});

describe("writing a checked file", () => {
  const rowsOf = (text: string) => {
    const result = check(text);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.rows;
  };

  it("adds three suppliers with source csv and the supplier as holder, and changes nothing the second time", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    expect(await importSuppliers(db, keys, org, "owner", rowsOf(THREE))).toEqual({
      suppliersAdded: 3,
      suppliersUpdated: 0,
      accountsAdded: 3,
      alreadyThere: 0,
    });
    const ledger = await listSuppliers(db, org);
    expect(ledger.map((s) => [s.name, s.domains, s.accounts.map((a) => [a.source, a.holder, a.last3])])).toEqual([
      ["Fynbos Freight (Pty) Ltd", ["fynbosfreight.example"], [["csv", "Fynbos Freight (Pty) Ltd", "731"]]],
      ["Garden Route Tyres", ["grtyres.example"], [["csv", "Garden Route Tyres", "773"]]],
      ["Outeniqua Paper, Wholesale", ["outeniquapaper.example"], [["csv", "Outeniqua Paper, Wholesale", "890"]]],
    ]);
    const fynbos = ledger[0]?.id as string;
    expect(await matchSupplierAccount(db, keys, org, fynbos, { number: "62004417731", branchCode: "250655" })).toEqual({
      match: true,
    });
    expect(await importSuppliers(db, keys, org, "owner", rowsOf(THREE))).toEqual({
      suppliersAdded: 0,
      suppliersUpdated: 0,
      accountsAdded: 0,
      alreadyThere: 3,
    });
    expect((await listSuppliers(db, org)).flatMap((s) => s.accounts)).toHaveLength(3);
  });

  it("adds a file's domain and account to a supplier already in the ledger, by its name in any case", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    await importSuppliers(db, keys, org, "owner", rowsOf(THREE));
    const more = csv("fynbos freight (pty) ltd,fynbos-logistics.example,Protea Mutual,198765,9876543210,");
    expect(await importSuppliers(db, keys, org, "owner", rowsOf(more))).toMatchObject({
      suppliersAdded: 0,
      suppliersUpdated: 1,
      accountsAdded: 1,
    });
    const fynbos = (await listSuppliers(db, org))[0];
    expect(fynbos?.domains).toEqual(["fynbosfreight.example", "fynbos-logistics.example"]);
    expect(fynbos?.accounts.map((a) => a.last3)).toEqual(["731", "210"]);
  });

  it("keeps a member's edit made while the import runs: domains appended to the stored ones, the phone kept", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    await importSuppliers(
      db,
      keys,
      org,
      "owner",
      rowsOf(csv("Karoo Parts,karooparts.example,Kestrel Bank,250655,11111111,")),
    );
    const [karoo] = await listSuppliers(db, org);
    // Between the import's read and its write, a member adds a domain and the trusted phone.
    let batches = 0;
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (++batches === 1)
              await target
                .prepare("UPDATE suppliers SET phone = ?, domains_json = ? WHERE id = ?")
                .bind("+27 21 555 0199", JSON.stringify(["karooparts.example", "edited.example"]), karoo?.id)
                .run();
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await importSuppliers(
      racing,
      keys,
      org,
      "owner",
      rowsOf(csv("Karoo Parts,karoo-billing.example,Kestrel Bank,250655,22222222,044 111 2222")),
    );
    const [after] = await listSuppliers(db, org);
    expect(after?.phone).toBe("+27 21 555 0199");
    expect(after?.domains).toEqual(["karooparts.example", "edited.example", "karoo-billing.example"]);
    expect(after?.accounts.map((a) => a.last3)).toEqual(["111", "222"]);
  });

  it("refuses an account number recorded under another branch code, in the file or the ledger, writing nothing (round 2)", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const twice = csv(
      "Karoo Parts,karooparts.example,Kestrel Bank,250655,1234567890,",
      "Karoo Parts,karooparts.example,Protea Mutual,198765,1234567890,",
    );
    await expect(importSuppliers(db, keys, org, "owner", rowsOf(twice))).rejects.toThrow(
      "row 2: this account number is already recorded for Karoo Parts with another branch code",
    );
    expect(await listSuppliers(db, org)).toEqual([]);
    await importSuppliers(
      db,
      keys,
      org,
      "owner",
      rowsOf(csv("Karoo Parts,karooparts.example,Kestrel Bank,250655,1234567890,")),
    );
    const before = await listSuppliers(db, org);
    await expect(
      importSuppliers(
        db,
        keys,
        org,
        "owner",
        rowsOf(csv("Karoo Parts,karooparts.example,Protea Mutual,198765,1234567890,")),
      ),
    ).rejects.toThrow(/another branch code/);
    expect(await listSuppliers(db, org)).toEqual(before);
  });

  it("refuses the whole import when a domain saved meanwhile would take a supplier past 20 (round 1)", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const nineteen = Array.from({ length: 19 }, (_, i) => `d${i}.example`);
    const { id } = await addSupplier(db, org, "owner", { name: "Karoo Parts", domains: nineteen });
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === "batch") {
          let first = true;
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (first) {
              first = false;
              await target
                .prepare("UPDATE suppliers SET domains_json = ? WHERE id = ?")
                .bind(JSON.stringify([...nineteen, "twentieth.example"]), id)
                .run();
            }
            return result;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await listSuppliers(db, org);
    await expect(
      importSuppliers(
        racing,
        keys,
        org,
        "owner",
        rowsOf(csv("Karoo Parts,another.example,Kestrel Bank,250655,22222222,")),
      ),
    ).rejects.toThrow(/more than 20 domains/);
    const [after] = await listSuppliers(db, org);
    expect(after?.domains).toHaveLength(20);
    expect(after?.accounts).toEqual(before[0]?.accounts);
    // The limit holds for any write, a direct one included.
    await expect(
      db
        .prepare("UPDATE suppliers SET domains_json = ? WHERE id = ?")
        .bind(JSON.stringify([...nineteen, "a.example", "b.example"]), id)
        .run(),
    ).rejects.toThrow(/more than 20 domains/);
  });

  it("imports the largest file the page takes, 1,000 suppliers, in one batch", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const rows = rowsOf(
      csv(
        ...Array.from(
          { length: 1000 },
          (_, i) => `Supplier ${i},s${i}.example,Kestrel Bank,250655,${String(10000000 + i)},`,
        ),
      ),
    );
    expect(await importSuppliers(db, keys, org, "owner", rows)).toEqual({
      suppliersAdded: 1000,
      suppliersUpdated: 0,
      accountsAdded: 1000,
      alreadyThere: 0,
    });
    const ledger = await listSuppliers(db, org);
    expect(ledger).toHaveLength(1000);
    expect(ledger.every((s) => s.accounts.length === 1 && s.accounts[0]?.source === "csv")).toBe(true);
  }, 120_000);

  it("writes nothing when any statement fails, and keeps other organisations apart", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const other = await makeOrg();
    await db.exec(
      "CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    await expect(importSuppliers(db, keys, org, "owner", rowsOf(THREE))).rejects.toThrow(/audit down/);
    await db.exec("DROP TRIGGER fail_ledger");
    expect(await listSuppliers(db, org)).toEqual([]);
    await importSuppliers(db, keys, org, "owner", rowsOf(THREE));
    expect(await listSuppliers(db, other)).toEqual([]);
  });
});
