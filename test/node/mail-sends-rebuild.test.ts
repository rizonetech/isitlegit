import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// D07 T02 §5: migration 0015 rebuilds mail_sends to allow the `claim` kind; every row, column and index survives.
const MIGRATIONS = join(import.meta.dirname, "../../src/db/migrations");
const files = readdirSync(MIGRATIONS)
  .filter((n) => /^\d{4}_.*\.sql$/.test(n))
  .sort();

describe("migration 0015", () => {
  it("keeps every mail_sends row and column, and the case index, and allows the claim kind", () => {
    const db = new DatabaseSync(":memory:");
    for (const name of files.filter((n) => n < "0015")) db.exec(readFileSync(join(MIGRATIONS, name), "utf-8"));
    const now = "2026-10-28T05:00:00.000Z";
    db.exec(
      `INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES ('01JCASE00000000000000000000', 'o', 'email', '${now}', '${now}')`,
    );
    db.exec(
      `INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, provider_id, attempts, error, created_at, updated_at, claimed_at, search_cursor, searched_at) VALUES ('m1', 'reply:1', '01JCASE00000000000000000000', 'reply', '${"a".repeat(64)}', 'uncertain', 'p1', 2, 'no answer', '${now}', '${now}', '${now}', 'cursor-1', '${now}')`,
    );
    const before = db.prepare("SELECT * FROM mail_sends").all();
    db.exec(readFileSync(join(MIGRATIONS, files.find((n) => n.startsWith("0015")) as string), "utf-8"));
    expect(db.prepare("SELECT * FROM mail_sends").all()).toEqual(before);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mail_sends'").all();
    expect(indexes.map((i) => (i as { name: string }).name)).toContain("mail_sends_case");
    db.exec(
      `INSERT INTO mail_sends (id, send_key, kind, to_hash, status, created_at, updated_at) VALUES ('m2', 'claim:1', 'claim', '${"b".repeat(64)}', 'pending', '${now}', '${now}')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO mail_sends (id, send_key, kind, to_hash, status, created_at, updated_at) VALUES ('m3', 'x:1', 'other', '${"c".repeat(64)}', 'pending', '${now}', '${now}')`,
      ),
    ).toThrow(/CHECK/);
    // The case delete still cascades.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("DELETE FROM cases WHERE id = '01JCASE00000000000000000000'");
    expect(db.prepare("SELECT id FROM mail_sends WHERE id = 'm1'").get()).toBeUndefined();
  });
});

describe("migration 0016", () => {
  it("adds the intake claims, one per organisation and message, and the forwarder columns to cases", () => {
    const db = new DatabaseSync(":memory:");
    for (const name of files.filter((n) => n < "0017")) db.exec(readFileSync(join(MIGRATIONS, name), "utf-8"));
    const now = "2026-10-28T05:00:00.000Z";
    db.exec(
      `INSERT INTO cases (id, org_id, channel, forwarded_by, message_id, created_at, updated_at) VALUES ('01JCASE00000000000000000001', 'o', 'email', 'boss@member.co.za', '<m@member.co.za>', '${now}', '${now}')`,
    );
    expect(db.prepare("SELECT forwarded_by, message_id FROM cases").get()).toEqual({
      forwarded_by: "boss@member.co.za",
      message_id: "<m@member.co.za>",
    });
    db.exec(
      `INSERT INTO intake_messages (org_id, message_key, state, claimed_at) VALUES ('o', '<m@member.co.za>', 'pending', '${now}')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO intake_messages (org_id, message_key, state, claimed_at) VALUES ('o', '<m@member.co.za>', 'done', '${now}')`,
      ),
    ).toThrow(/UNIQUE/);
    db.exec(
      `INSERT INTO intake_messages (org_id, message_key, state, claimed_at) VALUES ('other', '<m@member.co.za>', 'done', '${now}')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO intake_messages (org_id, message_key, state, claimed_at) VALUES ('o', 'k2', 'started', '${now}')`,
      ),
    ).toThrow(/CHECK/);
  });
});
