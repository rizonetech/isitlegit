import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  hashCode,
  insertStatement,
  makeInviteCode,
  newCode,
  parseArgs,
  updateInviteLimit,
} from "../../scripts/invite-code.ts";

// D07 T02 §4: the operator's invite-code script stores a code's hash only, and the row it writes is one signup reads.
const MIGRATION = join(import.meta.dirname, "../../src/db/migrations/0013_invite_codes.sql");

describe("scripts/invite-code.ts", () => {
  it("makes readable codes from an unambiguous alphabet", () => {
    const code = newCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(newCode()).not.toBe(code);
  });

  it("runs wrangler with the hash only: the code is in no argument and no SQL", () => {
    const calls: string[][] = [];
    const code = makeInviteCode(parseArgs(["--label", "Pilot staff", "--max-uses", "3"]), (_file, args) =>
      calls.push(args),
    );
    expect(calls).toHaveLength(1);
    const args = calls[0] as string[];
    expect(args.slice(0, 6)).toEqual(["exec", "wrangler", "d1", "execute", "DB", "--local"]);
    expect(args.join(" ")).not.toContain(code);
    expect(args.join(" ")).toContain(hashCode(code));
    const remote: string[][] = [];
    makeInviteCode(parseArgs(["--label", "x", "--remote"]), (_f, a) => remote.push(a));
    expect(remote[0]).toContain("--remote");
  });

  it("writes a row the migration accepts, with the use limit and expiry asked for", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(MIGRATION, "utf-8"));
    const now = new Date("2026-10-28T08:00:00Z");
    db.exec(
      insertStatement(
        hashCode("ABCD-EFGH-JKMN-PQRS"),
        parseArgs(["--label", "Pilot", "--max-uses", "5", "--days", "7"]),
        now,
        "code-1",
      ),
    );
    const row = db.prepare("SELECT code_hash, label, max_uses, uses, expires_at FROM invite_codes").get() as Record<
      string,
      unknown
    >;
    expect(row).toEqual({
      code_hash: hashCode("ABCD-EFGH-JKMN-PQRS"),
      label: "Pilot",
      max_uses: 5,
      uses: 0,
      expires_at: "2026-11-04T08:00:00.000Z",
    });
    // The table refuses more uses than the limit.
    expect(() => db.exec("UPDATE invite_codes SET uses = 6")).toThrow(/CHECK/);
  });

  it("refuses a label that could break the SQL, and limits out of range", () => {
    for (const label of ["", "x'; DROP TABLE invite_codes; --", "a".repeat(201)])
      expect(() => parseArgs(["--label", label]), label).toThrow(/--label/);
    expect(() => parseArgs(["--label", "ok", "--max-uses", "0"])).toThrow(/--max-uses/);
    expect(() => parseArgs(["--label", "ok", "--days", "400"])).toThrow(/--days/);
  });
});

describe("existing invite use-limit management", () => {
  function fixture() {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(MIGRATION, "utf-8"));
    db.exec(
      insertStatement(
        hashCode("fixture-only"),
        parseArgs(["--label", "Judge", "--max-uses", "50"]),
        new Date("2026-11-04"),
        "judge-1",
      ),
    );
    db.exec("UPDATE invite_codes SET uses = 6");
    const query = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    return { db, query };
  }
  it("changes only max_uses and returns verified metadata without the code hash", () => {
    const { db, query } = fixture();
    try {
      const before = query("SELECT * FROM invite_codes")[0];
      const result = updateInviteLimit("judge-1", 100, query);
      expect(query("SELECT * FROM invite_codes")[0]).toEqual({ ...before, max_uses: 100 });
      expect(result.before.max_uses).toBe(50);
      expect(result.after.max_uses).toBe(100);
      expect(result.after.uses).toBe(6);
      expect(JSON.stringify(result)).not.toContain("code_hash");
      expect(JSON.stringify(result)).not.toContain(hashCode("fixture-only"));
    } finally {
      db.close();
    }
  });
  it("refuses a concurrent redemption without changing the limit", () => {
    const { db, query } = fixture();
    try {
      let reads = 0;
      const racing = (sql: string) => {
        if (++reads === 2) db.exec("UPDATE invite_codes SET uses = 7");
        return query(sql);
      };
      expect(() => updateInviteLimit("judge-1", 100, racing)).toThrow(/concurrently/);
      expect(query("SELECT uses,max_uses FROM invite_codes")[0]).toEqual({ uses: 7, max_uses: 50 });
    } finally {
      db.close();
    }
  });
  it("refuses wrong id, invalid input and a limit below usage without modifying any row", () => {
    const { db, query } = fixture();
    try {
      const before = query("SELECT * FROM invite_codes");
      expect(() => updateInviteLimit("missing", 100, query)).toThrow(/exactly one/);
      expect(() => updateInviteLimit("judge-1", 5, query)).toThrow(/usage/);
      expect(() => updateInviteLimit("x'", 100, query)).toThrow(/id/);
      expect(() => updateInviteLimit("judge-1", NaN, query)).toThrow(/limit/);
      expect(query("SELECT * FROM invite_codes")).toEqual(before);
    } finally {
      db.close();
    }
  });
});
