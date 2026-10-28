-- A case's verdict as the report and the reply show it (D01 T01 §7): the headline, the confidence from 0 to 1, the
-- reasons and actions as JSON arrays, and which path made it (`source`: the stub, the rules or the agent; D04 T01).
-- `cases.verdict` keeps the label the status lifecycle checks; this row holds the rest. Written once per case
-- (src/db/verdicts.ts), and removed with its case.
CREATE TABLE case_verdicts (
  case_id TEXT PRIMARY KEY REFERENCES cases (id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('safe', 'suspicious', 'malicious')),
  headline TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reasons TEXT NOT NULL CHECK (json_type(reasons) = 'array'),
  actions TEXT NOT NULL CHECK (json_type(actions) = 'array'),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
