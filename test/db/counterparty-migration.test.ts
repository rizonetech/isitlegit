import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";

// D05 T02 §1: migration 0054 only adds `cases.origin` and two indexes. `cases` is the parent of evidence, check
// outcomes, case events and intake messages on delete cascade, so it is never rebuilt: proven here on rows loaded into
// the schema as it was before 0054, every row and value kept.
const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0054_"));
const apply = async () => {
  if (!migration) throw new Error("migration 0054 is missing");
  for (const query of migration.queries) await db.prepare(query).run();
};

// `cases` as it was before 0054.
const BEFORE = [
  "DROP INDEX IF EXISTS cases_counterparty_sender",
  "DROP INDEX IF EXISTS cases_counterparty_org",
  "ALTER TABLE cases DROP COLUMN origin",
];

const counts = async () => {
  const one = async (table: string) =>
    ((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1) as number;
  return {
    cases: await one("cases"),
    evidence: await one("evidence"),
    outcomes: await one("check_outcomes"),
    events: await one("case_events"),
  };
};

let made: string[];
beforeEach(async () => {
  for (const sql of BEFORE) await db.prepare(sql).run();
  const created = await Promise.all(
    [0, 1, 2].map(() => createCase(db, { orgId: "org-0054", channel: "email", headersAvailable: true })),
  );
  made = created.map((c) => {
    if (!c.ok) throw new Error(c.error.message);
    return c.value.id;
  });
  for (const caseId of made) {
    await db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at)
         SELECT ?, COALESCE(run_id, id), 'E1', 1, 'auth.spf', 'high', 'SPF failed', '{}', '[]', created_at FROM cases WHERE id = ?`,
      )
      .bind(caseId, caseId)
      .run();
  }
});

describe("migration 0054", () => {
  it("adds origin to every existing case as null, keeping every case and what hangs off it", async () => {
    const before = await counts();
    const rows = (await db.prepare("SELECT * FROM cases WHERE org_id = 'org-0054' ORDER BY id").all()).results;
    await apply();
    expect(await counts()).toEqual(before);
    const after = (await db.prepare("SELECT * FROM cases WHERE org_id = 'org-0054' ORDER BY id").all()).results;
    expect(after).toEqual(rows.map((r) => ({ ...r, origin: null })));
    // The column refuses anything but a counterparty marker.
    await expect(
      db
        .prepare("UPDATE cases SET origin = 'other' WHERE id = ?")
        .bind(made[0] as string)
        .run(),
    ).rejects.toThrow();
    await db
      .prepare("UPDATE cases SET origin = 'counterparty' WHERE id = ?")
      .bind(made[0] as string)
      .run();
  });
});
