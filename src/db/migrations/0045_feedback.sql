-- "This verdict is wrong" (D07 T03 §6; design spec 4.7, 4.3a): one row per member per case, replaced when the member
-- changes it. It never edits the case or its evidence. `providers_json` names the reputation providers whose items the
-- verdict's reasons cited, for the providers' false-alarm counts; `notified_at` is set once the operator's notice
-- (design/SPEC.md N9) has gone, so the cron sends any still waiting. Deleting a case deletes its feedback (spec 4.8).
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('false_alarm', 'missed')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  providers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(providers_json) AND json_type(providers_json) = 'array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notified_at TEXT,
  UNIQUE (case_id, user_id)
);
CREATE INDEX feedback_waiting ON feedback (notified_at) WHERE notified_at IS NULL;
