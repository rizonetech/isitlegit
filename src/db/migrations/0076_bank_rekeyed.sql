-- The bank key replacement admin action's audit kind (D05 T01 §4, the coordinator's number 0076).
--
-- `trust_events` is rebuilt so its kind CHECK also allows `bank.rekeyed` (one event per organisation a re-key
-- moved rows for). SQLite cannot alter a CHECK, so the table is copied, dropped and renamed; every existing
-- row is kept in the copy, with its organisation foreign key, cascade and index as 0047 made them.
CREATE TABLE trust_events_rebuilt (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'identity.set', 'identity.logo_stored', 'identity.logo_removed', 'identity.logo_orphaned',
      'bank.added', 'bank.removed', 'bank.matched', 'bank.rekeyed'
    )
  ),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  created_at TEXT NOT NULL
);

INSERT INTO trust_events_rebuilt (id, org_id, actor, kind, detail_json, created_at)
SELECT id, org_id, actor, kind, detail_json, created_at
FROM trust_events;

DROP TABLE trust_events;
ALTER TABLE trust_events_rebuilt RENAME TO trust_events;

CREATE INDEX trust_events_org ON trust_events (org_id, created_at);
