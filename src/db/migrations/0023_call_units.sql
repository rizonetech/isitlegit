-- D03 T01 §3, completion review. A call's non-token billable quantity (the images, the audio seconds), so every charge
-- can be reproduced from its row; and honest certainty for rows written before the call record: a settled row with no
-- call (`call_id` empty) was settled at either reported usage or the estimate, which 0022 could not tell apart, so it is
-- estimated unless it is an import of a ledger whose costs were Meta's reported usage (`import:` and `ledger:` rows, which
-- scripts/meta-spend-import.ts labels itself).
ALTER TABLE model_spend ADD COLUMN images INTEGER CHECK (images IS NULL OR images >= 0);
ALTER TABLE model_spend ADD COLUMN audio_seconds REAL CHECK (audio_seconds IS NULL OR audio_seconds >= 0);
UPDATE model_spend SET cost_certainty = 'estimated', cost_source = 'estimate'
WHERE call_id IS NULL AND id NOT LIKE 'import:%' AND id NOT LIKE 'ledger:%';
