-- One reputation result per provider per subject (D02 T06 §9): the report shows each provider's own answer
-- (listed, clear or unavailable, the well-known list's own states), when it was obtained and whether it came
-- from the cache. Rows belong to their case and run, are replaced atomically per run, and go with the case.
CREATE TABLE reputation_results (
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  state TEXT NOT NULL,
  obtained_at TEXT NOT NULL,
  cached INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (case_id, run_id, provider, subject)
);
CREATE INDEX reputation_results_case_run ON reputation_results (case_id, run_id);
