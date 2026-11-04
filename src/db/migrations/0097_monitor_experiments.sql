-- D04 T01 §18: additive immutable labelled monitor identity. No production monitor cache or case keys reused.
CREATE TABLE monitor_experiments (
 org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 experiment_id TEXT NOT NULL,
 manifest_digest TEXT NOT NULL,
 deployment TEXT NOT NULL,
 model_versions_json TEXT NOT NULL CHECK(length(model_versions_json)<=4096 AND json_valid(model_versions_json)),
 settings_digest TEXT NOT NULL CHECK(length(settings_digest)=64),
 PRIMARY KEY(org_id,experiment_id)
);
CREATE TABLE monitor_experiment_pages (
 org_id TEXT NOT NULL,
 experiment_id TEXT NOT NULL,
 experiment_case_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 capture_digest TEXT NOT NULL,
 label_digest TEXT NOT NULL,
 PRIMARY KEY(org_id,experiment_id,experiment_case_id),
 UNIQUE(org_id,experiment_id,page_id),
 FOREIGN KEY(org_id,experiment_id) REFERENCES monitor_experiments(org_id,experiment_id) ON DELETE CASCADE
);
CREATE TABLE monitor_experiment_arms (
 org_id TEXT NOT NULL,
 experiment_id TEXT NOT NULL,
 arm TEXT NOT NULL CHECK(arm IN ('full','no-screening')),
 replay_run_id TEXT NOT NULL,
 monitor_run_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','waiting','unknown','complete','failed')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0 AND created_at<=9007199168340991),
 resume_state TEXT NOT NULL DEFAULT 'idle' CHECK(resume_state IN ('idle','calling','unknown')),
 resume_token TEXT,
 spark_deadline INTEGER NOT NULL CHECK(typeof(spark_deadline)='integer' AND spark_deadline=created_at+86400000),
 PRIMARY KEY(org_id,experiment_id,arm),
 UNIQUE(org_id,replay_run_id),
 UNIQUE(org_id,experiment_id,arm,monitor_run_id),
 FOREIGN KEY(org_id,experiment_id) REFERENCES monitor_experiments(org_id,experiment_id) ON DELETE CASCADE
);
CREATE TABLE monitor_experiment_results (
 org_id TEXT NOT NULL,
 experiment_id TEXT NOT NULL,
 arm TEXT NOT NULL,
 monitor_run_id TEXT NOT NULL,
 experiment_case_id TEXT NOT NULL,
 page_operation_id TEXT NOT NULL UNIQUE,
 screen_nonce TEXT NOT NULL CHECK(length(screen_nonce)=32 AND screen_nonce NOT GLOB '*[^0-9a-f]*'),
 second_nonce TEXT NOT NULL CHECK(length(second_nonce)=32 AND second_nonce NOT GLOB '*[^0-9a-f]*'),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','waiting','unknown','complete','failed')),
 result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=16384)),
 PRIMARY KEY(org_id,experiment_id,arm,experiment_case_id),
 UNIQUE(monitor_run_id,page_operation_id),
 FOREIGN KEY(org_id,experiment_id,arm,monitor_run_id) REFERENCES monitor_experiment_arms(org_id,experiment_id,arm,monitor_run_id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,experiment_id,experiment_case_id) REFERENCES monitor_experiment_pages(org_id,experiment_id,experiment_case_id) ON DELETE CASCADE
);
-- Each transport attempt has its own immutable identity; running/unknown states never become unstarted work.
CREATE TABLE monitor_experiment_attempts (
 attempt_id TEXT PRIMARY KEY,
 monitor_run_id TEXT NOT NULL REFERENCES monitor_experiment_arms(monitor_run_id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('wake','loupe','screen','second-look')),
 answer_ordinal INTEGER NOT NULL CHECK(answer_ordinal IN (1,2)),
 retry_index INTEGER NOT NULL CHECK(retry_index>=0 AND retry_index<=52),
 request_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','complete','capacity','unknown','failed')),
 started_at INTEGER NOT NULL,
 deadline INTEGER NOT NULL,
 next_eligible_at INTEGER,
 metadata_json TEXT CHECK(metadata_json IS NULL OR (json_valid(metadata_json) AND length(metadata_json)<=16384)),
 UNIQUE(monitor_run_id,operation_id,phase,answer_ordinal,retry_index),
 CHECK(deadline>=started_at),
 CHECK(next_eligible_at IS NULL OR next_eligible_at>started_at)
);
CREATE TRIGGER monitor_experiments_immutable BEFORE UPDATE ON monitor_experiments
BEGIN SELECT RAISE(ABORT,'immutable monitor experiment'); END;
CREATE TRIGGER monitor_experiment_pages_immutable BEFORE UPDATE ON monitor_experiment_pages
BEGIN SELECT RAISE(ABORT,'immutable monitor page'); END;
CREATE TRIGGER monitor_experiment_arms_immutable BEFORE UPDATE ON monitor_experiment_arms
WHEN NEW.org_id!=OLD.org_id OR NEW.experiment_id!=OLD.experiment_id OR NEW.arm!=OLD.arm
 OR NEW.replay_run_id!=OLD.replay_run_id OR NEW.monitor_run_id!=OLD.monitor_run_id OR NEW.created_at!=OLD.created_at OR NEW.spark_deadline!=OLD.spark_deadline
BEGIN SELECT RAISE(ABORT,'immutable monitor arm'); END;
CREATE TRIGGER monitor_experiment_results_immutable BEFORE UPDATE ON monitor_experiment_results
WHEN NEW.org_id!=OLD.org_id OR NEW.experiment_id!=OLD.experiment_id OR NEW.arm!=OLD.arm
 OR NEW.monitor_run_id!=OLD.monitor_run_id OR NEW.experiment_case_id!=OLD.experiment_case_id
 OR NEW.page_operation_id!=OLD.page_operation_id OR NEW.screen_nonce!=OLD.screen_nonce OR NEW.second_nonce!=OLD.second_nonce
BEGIN SELECT RAISE(ABORT,'immutable monitor result identity'); END;
CREATE TRIGGER monitor_experiment_attempts_owner BEFORE INSERT ON monitor_experiment_attempts
WHEN NOT ((NEW.phase='wake' AND NEW.operation_id=NEW.monitor_run_id AND NEW.answer_ordinal=1)
 OR (NEW.phase!='wake' AND EXISTS(SELECT 1 FROM monitor_experiment_results r
 WHERE r.monitor_run_id=NEW.monitor_run_id AND r.page_operation_id=NEW.operation_id)))
BEGIN SELECT RAISE(ABORT,'invalid monitor attempt owner'); END;
CREATE TRIGGER monitor_experiment_attempts_immutable BEFORE UPDATE ON monitor_experiment_attempts
WHEN NEW.attempt_id!=OLD.attempt_id OR NEW.monitor_run_id!=OLD.monitor_run_id OR NEW.operation_id!=OLD.operation_id
 OR NEW.phase!=OLD.phase OR NEW.answer_ordinal!=OLD.answer_ordinal OR NEW.retry_index!=OLD.retry_index
 OR NEW.request_digest!=OLD.request_digest OR NEW.started_at!=OLD.started_at OR NEW.deadline!=OLD.deadline
BEGIN SELECT RAISE(ABORT,'immutable monitor attempt identity'); END;
