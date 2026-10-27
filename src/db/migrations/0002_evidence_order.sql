-- Evidence in creation order and in the shapes spec 4.3 names (D01 T01 §1, final review). Text ids sort E1, E10, E2,
-- so each row also carries its number, `seq`, tied to the id; `detail` is a JSON object and `artefacts` a JSON array of
-- R2 keys. SQLite cannot add CHECK constraints to a table, so the table is rebuilt; it held no rows when this was
-- written, and any it holds are copied with their number.

CREATE TABLE evidence_next (
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
);
INSERT INTO evidence_next (case_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at)
  SELECT case_id, id, CAST(substr(id, 2) AS INTEGER), "check", severity, summary, detail_json, artefact_keys_json, created_at
  FROM evidence;
DROP TABLE evidence;
ALTER TABLE evidence_next RENAME TO evidence;
