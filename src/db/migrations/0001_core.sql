-- The core case store (D01 T01 §1): cases and what each one gathers. Auth and organisation tables belong to Better
-- Auth (D07 T02), so org_id carries no foreign key here. The CHECK constraints hold the spec's values (verdicts from
-- the design spec's opening, severities from 4.3), and each child row belongs to exactly one case: deleting a case
-- deletes its rows, which the POPIA deletion in spec 4.8 relies on.

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'upload')),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'running', 'done', 'partial')),
  verdict TEXT CHECK (verdict IN ('safe', 'suspicious', 'malicious')),
  headers_available INTEGER NOT NULL DEFAULT 0 CHECK (headers_available IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cases_org_created ON cases (org_id, created_at);

CREATE TABLE artefacts (
  r2_key TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('raw', 'attachment', 'render', 'crop', 'page', 'audio')),
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
);
CREATE INDEX artefacts_case ON artefacts (case_id);

-- Evidence ids are per case (E1, E2 in creation order, D02 T01 §1), so the key is the pair.
CREATE TABLE evidence (
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  "check" TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  artefact_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artefact_keys_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, id)
);

-- The audit trail and model trace; the id orders a case's events.
CREATE TABLE case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  started_at TEXT NOT NULL,
  ms INTEGER,
  cost_usd REAL,
  error TEXT
);
CREATE INDEX case_events_case ON case_events (case_id, id);
