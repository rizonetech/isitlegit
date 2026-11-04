-- Additive safe metadata only. Case retention owns these records; model_spend call_id is not unique.
CREATE TABLE model_validation_diagnostics (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CHECK(length(run_id) <= 100),
  call_id TEXT NOT NULL CHECK(length(call_id) = 36),
  phase TEXT NOT NULL CHECK(phase IN ('structured', 'citation')),
  attempt INTEGER NOT NULL CHECK(attempt IN (1, 2)),
  diagnostic_json TEXT NOT NULL CHECK(json_valid(diagnostic_json) AND length(diagnostic_json) <= 2048),
  PRIMARY KEY(case_id, run_id, call_id, phase, attempt)
);
