-- The evaluation runner's record (D08 T02 §1, the coordinator's number 0067). `eval_runs`: one row per run, its status
-- (a run is `complete` only when every selected sample ended `done` or `partial`), the deployed commit and the content
-- identity of the sets it ran. `eval_results`: one row per sample of a run, set-qualified (`synthetic-sa/x.eml`), with
-- the case the upload opened, so every measurement can be audited back to its case. `ms` is the server's own
-- admission-to-terminal time for the case (`cases.updated_at - created_at`), so a slow poll or a resume cannot change it;
-- the forward-to-reply time is measured by the live mail run (D09 T01 §1). `http_status` and `detail` keep why an
-- upload was refused or a sample was lost, in a safe short form.
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) >= 7),
  set_version TEXT NOT NULL CHECK (length(set_version) = 64),
  mode TEXT NOT NULL CHECK (length(mode) BETWEEN 1 AND 64),
  -- The selection, so a resume restores it exactly: the sets (comma-separated, in order) and the limit.
  sets TEXT NOT NULL CHECK (length(sets) > 0),
  sample_limit INTEGER CHECK (sample_limit IS NULL OR sample_limit > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'incomplete', 'aborted')),
  selected INTEGER NOT NULL CHECK (selected >= 0),
  cap_usd REAL NOT NULL CHECK (cap_usd > 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX eval_runs_started ON eval_runs (started_at);

CREATE TABLE eval_results (
  run_id TEXT NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  sample TEXT NOT NULL CHECK (instr(sample, '/') > 1),
  case_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'partial', 'refused', 'capped', 'timeout', 'stale-repeat', 'lost')),
  label TEXT NOT NULL CHECK (label IN ('attack', 'genuine')),
  category TEXT NOT NULL,
  verdict TEXT CHECK (verdict IN ('safe', 'suspicious', 'malicious')),
  ms INTEGER CHECK (ms IS NULL OR ms >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  critical_found INTEGER NOT NULL DEFAULT 0 CHECK (critical_found IN (0, 1)),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  PRIMARY KEY (run_id, sample)
);
CREATE INDEX eval_results_case ON eval_results (case_id);
