import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readCheckOutcomes, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";

// D01 T01 §19: migration 0051 rebuilds `evidence` and `check_outcomes` with each row's run in the key, every existing
// row given its case's current run, nothing lost (plan review: proven on rows loaded into the schema before it).
const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0051_"));
const apply = async () => {
  if (!migration) throw new Error("migration 0051 is missing");
  for (const query of migration.queries) await db.prepare(query).run();
};
// The migrations after 0051 that change these two tables (0053's `check_outcomes.revision`, D02 T01 §4; 0057's
// `evidence.producer`, D02 T01 §5): the readers are today's code, so a read through them needs the schema as it now
// stands, not as 0051 left it. A migration is one of them by a statement altering or creating either table, never by a
// comment naming one (0054 names `evidence` in its comment and alters `cases`).
const later = env.TEST_MIGRATIONS.filter(
  (m) =>
    m.name > "0051" && m.queries.some((q) => /\b(?:ALTER|CREATE)\s+TABLE\s+(?:evidence|check_outcomes)\b/i.test(q)),
);
const applyLater = async () => {
  for (const m of later) for (const query of m.queries) await db.prepare(query).run();
};

// The two tables as 0002 and 0042 left them.
const OLD_SCHEMA = [
  "DROP TABLE evidence",
  "DROP TABLE check_outcomes",
  `CREATE TABLE evidence (
    case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    "check" TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
    artefact_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artefact_keys_json) AND json_type(artefact_keys_json) = 'array'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (case_id, id),
    UNIQUE (case_id, seq),
    CHECK (id = 'E' || seq)
  )`,
  `CREATE TABLE check_outcomes (
    case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    check_name TEXT NOT NULL CHECK (length(check_name) BETWEEN 1 AND 100),
    seq INTEGER NOT NULL CHECK (seq >= 1),
    outcome TEXT NOT NULL CHECK (outcome IN ('ran', 'partial', 'skipped', 'failed')),
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
    findings INTEGER NOT NULL CHECK (findings >= 0),
    PRIMARY KEY (case_id, check_name)
  )`,
];

let never: string;
let retried: string;
beforeEach(async () => {
  for (const sql of OLD_SCHEMA) await db.prepare(sql).run();
  const made = await Promise.all(
    [0, 1].map(() => createCase(db, { orgId: "org-run-findings", channel: "email", headersAvailable: true })),
  );
  [never, retried] = made.map((m) => {
    if (!m.ok) throw new Error(m.error.message);
    return m.value.id;
  }) as [string, string];
  await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(`${retried}R1`, retried).run();
  const evidence = db.prepare(
    `INSERT INTO evidence (case_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const outcome = db.prepare(
    "INSERT INTO check_outcomes (case_id, check_name, seq, outcome, reason, findings) VALUES (?, ?, ?, ?, ?, ?)",
  );
  await db.batch([
    evidence.bind(
      never,
      "E1",
      1,
      "intake.forward",
      "info",
      "Forwarded.",
      '{"path":"eml"}',
      "[]",
      "2026-10-31T10:00:00Z",
    ),
    evidence.bind(
      never,
      "E2",
      2,
      "auth.spf",
      "high",
      "SPF failed.",
      '{"result":"fail"}',
      '["raw/a"]',
      "2026-10-31T10:00:01Z",
    ),
    evidence.bind(retried, "E1", 1, "not_checked", "info", "Not checked.", "{}", "[]", "2026-10-31T11:00:00Z"),
    outcome.bind(never, "auth.spf", 1, "ran", null, 1),
    outcome.bind(never, "domain.age", 2, "skipped", "no domain", 0),
    outcome.bind(retried, "auth.spf", 1, "failed", "Error", 0),
  ]);
});

const all = async (table: string) => (await db.prepare(`SELECT * FROM ${table} ORDER BY case_id, seq`).all()).results;

describe("migration 0051", () => {
  it("keeps every row and column, giving each its case's current run", async () => {
    const before = { evidence: await all("evidence"), outcomes: await all("check_outcomes") };
    await apply();
    const runOf = (row: Record<string, unknown>) => (row.case_id === retried ? `${retried}R1` : row.case_id);
    expect(await all("evidence")).toEqual(
      expect.arrayContaining(before.evidence.map((row) => ({ ...row, run_id: runOf(row) }))),
    );
    expect(await all("evidence")).toHaveLength(3);
    expect(await all("check_outcomes")).toEqual(
      expect.arrayContaining(before.outcomes.map((row) => ({ ...row, run_id: runOf(row) }))),
    );
    expect(await all("check_outcomes")).toHaveLength(3);
  });

  it("reads the rows through the default readers, as the current run's", async () => {
    await apply();
    await applyLater();
    expect((await readEvidence(db, never)).map((e) => [e.id, e.summary, e.detail, e.artefacts])).toEqual([
      ["E1", "Forwarded.", { path: "eml" }, []],
      ["E2", "SPF failed.", { result: "fail" }, ["raw/a"]],
    ]);
    expect(await readCheckOutcomes(db, retried)).toEqual([
      { check: "auth.spf", outcome: "failed", reason: "Error", findings: 0 },
    ]);
  });

  it("keeps the constraints and the case-deletion cascade", async () => {
    await apply();
    const insert = (seq: number, id: string) =>
      db
        .prepare(
          `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, created_at) VALUES (?, ?, ?, ?, 'x', 'info', 's', 't')`,
        )
        .bind(never, never, id, seq)
        .run();
    await expect(insert(3, "E4")).rejects.toThrow();
    await expect(insert(1, "E1")).rejects.toThrow();
    // Another run may use the same ids.
    await db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, created_at) VALUES (?, 'other', 'E1', 1, 'x', 'info', 's', 't')`,
      )
      .bind(never)
      .run();
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(never).run();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE case_id = ?").bind(never).first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM check_outcomes WHERE case_id = ?").bind(never).first("n")).toBe(
      0,
    );
  });
});
