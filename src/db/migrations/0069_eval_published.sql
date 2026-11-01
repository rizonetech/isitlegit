-- The eval runs published for the public results page (D08 T02 §4): one immutable row for each published run holding
-- its report (figures, counts and denominators only, never a message, a sender or a subject). The page reads the latest
-- published report of mode `full`; an ablation report is shown only against a matching baseline. A run is published once.
CREATE TABLE eval_published (
  run_id TEXT PRIMARY KEY REFERENCES eval_runs (id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (length(mode) BETWEEN 1 AND 64),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  published_at TEXT NOT NULL
);
CREATE INDEX eval_published_mode ON eval_published (mode, published_at);
