-- D01 T03 §17: immutable experiment attribution, separate from mutable intake leases.
CREATE TABLE eval_experiments (
  org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  deployment TEXT NOT NULL,
  PRIMARY KEY (org_id, experiment_id)
);
CREATE TABLE eval_experiment_arms (
  org_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('full','no-agent-reasoning','no-walkthrough','no-sam','no-transcribe','no-screening')),
  replay_run_id TEXT NOT NULL,
  PRIMARY KEY (org_id, experiment_id, arm),
  UNIQUE (org_id, replay_run_id),
  UNIQUE (org_id, experiment_id, arm, replay_run_id),
  FOREIGN KEY (org_id, experiment_id) REFERENCES eval_experiments(org_id, experiment_id) ON DELETE CASCADE
);
CREATE TABLE case_experiments (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  replay_run_id TEXT NOT NULL,
  upload_key TEXT NOT NULL,
  active_upload_key TEXT,
  CHECK (active_upload_key IS NULL OR active_upload_key = upload_key),
  UNIQUE (org_id, replay_run_id, active_upload_key),
  FOREIGN KEY (org_id, experiment_id, arm, replay_run_id)
    REFERENCES eval_experiment_arms(org_id, experiment_id, arm, replay_run_id) ON DELETE CASCADE
);
CREATE TRIGGER eval_experiments_immutable BEFORE UPDATE ON eval_experiments
BEGIN SELECT RAISE(ABORT, 'immutable experiment'); END;
CREATE TRIGGER eval_experiment_arms_immutable BEFORE UPDATE ON eval_experiment_arms
BEGIN SELECT RAISE(ABORT, 'immutable experiment arm'); END;
CREATE TRIGGER case_experiments_immutable BEFORE UPDATE ON case_experiments
WHEN NEW.case_id != OLD.case_id OR NEW.org_id != OLD.org_id OR NEW.experiment_id != OLD.experiment_id
 OR NEW.arm != OLD.arm OR NEW.replay_run_id != OLD.replay_run_id OR NEW.upload_key != OLD.upload_key
 OR NEW.active_upload_key IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM cases c JOIN case_events e ON e.case_id=c.id
   WHERE c.id=OLD.case_id AND c.status='partial' AND e.step='admit' AND e.status='failed' AND e.error='RawMissing')
BEGIN SELECT RAISE(ABORT, 'immutable case experiment'); END;
