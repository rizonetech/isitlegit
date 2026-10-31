import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";

// D06 T01 §4: migration 0061 adds `supplier_accounts.source` (correction 4) and backfills it from the case link each
// existing account still holds: proven on rows loaded into the schema as it was before 0061, every row kept.
const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0061_"));
const apply = async () => {
  if (!migration) throw new Error("migration 0061 is missing");
  for (const query of migration.queries) await db.prepare(query).run();
};

const ORG = "org-0061";
const KEY = "k".repeat(16);
const MATCH = "m".repeat(16);
let caseId: string;

// An account row as the schema before 0061 held it, under the current keys.
const account = (id: string, hmacDigit: string, caseLink: string | null) =>
  db
    .prepare(
      `INSERT INTO supplier_accounts (id, org_id, supplier_id, bank_name, branch_code, holder, number_ciphertext,
         number_iv, number_hmac, key_id, match_key_id, last3, verified_from_case_id, added_by, added_at)
       VALUES (?, ?, 'sup-0061', 'Kestrel Bank (fictional)', '250655', 'Karoo Parts', ?, ?, ?, ?, ?, '773', ?, 'owner', ?)`,
    )
    .bind(
      id,
      ORG,
      new Uint8Array(20),
      new Uint8Array(12),
      hmacDigit.repeat(64),
      KEY,
      MATCH,
      caseLink,
      new Date().toISOString(),
    )
    .run();

beforeEach(async () => {
  await db.prepare("ALTER TABLE supplier_accounts DROP COLUMN source").run();
  await db
    .prepare("INSERT OR REPLACE INTO bank_key_epoch (id, key_id, match_key_id) VALUES (1, ?, ?)")
    .bind(KEY, MATCH)
    .run();
  await db
    .prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Karoo Parts', ?, ?)`)
    .bind(ORG, ORG, new Date().toISOString())
    .run();
  const made = await createCase(db, { orgId: ORG, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  caseId = made.value.id;
  await db
    .prepare(
      `INSERT INTO suppliers (id, org_id, name, name_key, created_by, created_at, updated_at)
       VALUES ('sup-0061', ?, 'Karoo Parts', 'karoo parts', 'owner', ?, ?)`,
    )
    .bind(ORG, new Date().toISOString(), new Date().toISOString())
    .run();
  await account("acc-hand", "a", null);
  await account("acc-case", "b", caseId);
});

describe("migration 0061", () => {
  it("marks an account linked to a case `case`, every other `hand`, keeping every row and refusing other values", async () => {
    const columns = "id, verified_from_case_id, number_hmac, added_by";
    const before = (await db.prepare(`SELECT ${columns} FROM supplier_accounts ORDER BY id`).all()).results;
    await apply();
    const after = await db
      .prepare(`SELECT ${columns}, source FROM supplier_accounts ORDER BY id`)
      .all<Record<string, unknown>>();
    expect(after.results.map(({ source, ...rest }) => rest)).toEqual(before);
    expect(Object.fromEntries(after.results.map((r) => [r.id, r.source]))).toEqual({
      "acc-case": "case",
      "acc-hand": "hand",
    });
    await expect(
      db.prepare("UPDATE supplier_accounts SET source = 'typed' WHERE id = 'acc-hand'").run(),
    ).rejects.toThrow();
  });
});
