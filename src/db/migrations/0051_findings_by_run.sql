-- Each run's findings kept apart (D01 T01 §19): a retry no longer deletes the failed run's evidence and check outcomes,
-- so both tables carry the run that wrote them in their keys. A run is named as `retryCase` names it: the first by the
-- case id (its Workflow instance id), a retry by `cases.run_id`; a case's current run is `COALESCE(cases.run_id,
-- cases.id)`, and every existing row is given its case's current run, the only run whose rows a retry left.
--
-- SQLite cannot change a key in place, so each table is rebuilt: created anew, every column copied by name, the old
-- dropped and the new renamed, with foreign keys checked at commit (D1 enforces them), every constraint kept. No table
-- references either one, and neither has an index or trigger of its own.
PRAGMA defer_foreign_keys = true;

CREATE TABLE evidence_next (
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 100),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  "check" TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  artefact_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artefact_keys_json) AND json_type(artefact_keys_json) = 'array'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, run_id, id),
  UNIQUE (case_id, run_id, seq),
  CHECK (id = 'E' || seq)
);
INSERT INTO evidence_next (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at)
  SELECT e.case_id, COALESCE(c.run_id, e.case_id), e.id, e.seq, e."check", e.severity, e.summary, e.detail_json,
    e.artefact_keys_json, e.created_at
  FROM evidence e LEFT JOIN cases c ON c.id = e.case_id;
DROP TABLE evidence;
ALTER TABLE evidence_next RENAME TO evidence;

CREATE TABLE check_outcomes_next (
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 100),
  check_name TEXT NOT NULL CHECK (length(check_name) BETWEEN 1 AND 100),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('ran', 'partial', 'skipped', 'failed')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  findings INTEGER NOT NULL CHECK (findings >= 0),
  PRIMARY KEY (case_id, run_id, check_name)
);
INSERT INTO check_outcomes_next (case_id, run_id, check_name, seq, outcome, reason, findings)
  SELECT o.case_id, COALESCE(c.run_id, o.case_id), o.check_name, o.seq, o.outcome, o.reason, o.findings
  FROM check_outcomes o LEFT JOIN cases c ON c.id = o.case_id;
DROP TABLE check_outcomes;
ALTER TABLE check_outcomes_next RENAME TO check_outcomes;
