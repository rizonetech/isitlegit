import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// D05 T01 §4: migration 0076 rebuilds `trust_events` so its kind CHECK also allows `bank.rekeyed`. Proven here on
// the table as 0047 made it, with audit history already in it: every row survives, the organisation foreign key
// and cascade and the index still hold, the new kind is accepted and an unknown kind is still refused.
const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0076_"));
const apply = async () => {
  if (!migration) throw new Error("migration 0076 is missing");
  for (const query of migration.queries) await db.prepare(query).run();
};

const BEFORE = [
  "DROP INDEX IF EXISTS trust_events_org",
  "DROP TABLE IF EXISTS trust_events",
  `CREATE TABLE trust_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
    actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
    kind TEXT NOT NULL CHECK (
      kind IN (
        'identity.set', 'identity.logo_stored', 'identity.logo_removed', 'identity.logo_orphaned',
        'bank.added', 'bank.removed', 'bank.matched'
      )
    ),
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX trust_events_org ON trust_events (org_id, created_at)",
];

describe("migration 0076", () => {
  it("keeps the audit history, widens the kind CHECK and keeps every other constraint", async () => {
    for (const sql of BEFORE) await db.prepare(sql).run();
    const orgId = crypto.randomUUID();
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Migration Org (fictional)", `org-${orgId.slice(0, 8)}`, new Date().toISOString())
      .run();
    await db
      .prepare(
        "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "evt-before-1",
        orgId,
        "owner",
        "bank.added",
        '{"accountId":"a1"}',
        "2026-10-31T00:00:00.000Z",
        "evt-before-2",
        orgId,
        "owner",
        "identity.set",
        "{}",
        "2026-10-31T00:01:00.000Z",
      )
      .run();

    await apply();

    const kept = await db
      .prepare("SELECT id, kind, detail_json FROM trust_events WHERE org_id = ? ORDER BY id")
      .bind(orgId)
      .all<{ id: string; kind: string; detail_json: string }>();
    expect(kept.results).toEqual([
      { id: "evt-before-1", kind: "bank.added", detail_json: '{"accountId":"a1"}' },
      { id: "evt-before-2", kind: "identity.set", detail_json: "{}" },
    ]);
    const index = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'trust_events_org'")
      .first();
    expect(index).not.toBeNull();

    await db
      .prepare(
        "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES (?, ?, ?, 'bank.rekeyed', ?, ?)",
      )
      .bind("evt-rekeyed", orgId, "hostmaster@rizonetech.com", '{"moved":2}', "2026-11-02T00:00:00.000Z")
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES (?, ?, ?, 'bank.unknown', '{}', ?)",
        )
        .bind("evt-unknown", orgId, "owner", "2026-11-02T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES (?, 'no-such-org', 'owner', 'bank.added', '{}', ?)",
        )
        .bind("evt-orphan", "2026-11-02T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();

    // The other constraints 0047 set still hold: a blank actor and a non-object detail are refused.
    await expect(
      db
        .prepare(
          "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES (?, ?, '', 'bank.added', '{}', ?)",
        )
        .bind("evt-actor", orgId, "2026-11-02T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES (?, ?, 'owner', 'bank.added', '[]', ?)",
        )
        .bind("evt-detail", orgId, "2026-11-02T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();

    await db.prepare(`DELETE FROM "organization" WHERE id = ?`).bind(orgId).run();
    const left = await db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE org_id = ?").bind(orgId).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
