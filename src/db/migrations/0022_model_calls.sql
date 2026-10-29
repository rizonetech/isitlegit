-- Each Meta call's record (D03 T01 §3): the budget's row per transport attempt (0020) carries what the report's model
-- trace, the cost per case and the eval read. One row, written by the call itself, so a paid call can never finish with
-- its record lost: a settlement that cannot be written leaves the row counted at its estimate, which the cron marks.
ALTER TABLE model_spend ADD COLUMN call_id TEXT;
ALTER TABLE model_spend ADD COLUMN owner TEXT CHECK (owner IS NULL OR owner IN ('case', 'monitor', 'script'));
ALTER TABLE model_spend ADD COLUMN monitor_run TEXT;
ALTER TABLE model_spend ADD COLUMN host TEXT;
ALTER TABLE model_spend ADD COLUMN step TEXT;
ALTER TABLE model_spend ADD COLUMN ms INTEGER CHECK (ms IS NULL OR ms >= 0);
ALTER TABLE model_spend ADD COLUMN input_tokens INTEGER;
ALTER TABLE model_spend ADD COLUMN cached_tokens INTEGER;
ALTER TABLE model_spend ADD COLUMN output_tokens INTEGER;
ALTER TABLE model_spend ADD COLUMN log_id TEXT;
ALTER TABLE model_spend ADD COLUMN request_id TEXT;
ALTER TABLE model_spend ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ok', 'error', 'refused'));
ALTER TABLE model_spend ADD COLUMN error_class TEXT;
-- Whether the cost is Meta's reported usage priced (measured), an estimate (usage missing, the answer lost, a 5xx kept
-- counted, a settlement never written), or nothing (a request refused before it ran).
ALTER TABLE model_spend ADD COLUMN cost_certainty TEXT CHECK (cost_certainty IS NULL OR cost_certainty IN ('measured', 'estimated', 'none'));
ALTER TABLE model_spend ADD COLUMN cost_source TEXT CHECK (cost_source IS NULL OR cost_source IN ('meta-usage', 'estimate'));
-- The rows written before this migration: a settled row's cost was reported (or recorded) spend, any other its estimate.
UPDATE model_spend SET
  cost_certainty = CASE state WHEN 'settled' THEN 'measured' ELSE 'estimated' END,
  cost_source = CASE state WHEN 'settled' THEN 'meta-usage' ELSE 'estimate' END;
CREATE INDEX model_spend_case ON model_spend (case_id);
CREATE INDEX model_spend_call ON model_spend (call_id);
