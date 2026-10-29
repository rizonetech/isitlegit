-- D03 T01 §3, round 1. A row written before the call record (`call_id` empty) for a model billed per image or per
-- second was priced from the request (SAM's image sent, an edit's count asked for, a clip's length given), never from
-- usage Meta reported: it is estimated, whatever 0022 and 0023 left it as. Token models' imports keep their label.
UPDATE model_spend SET cost_certainty = 'estimated', cost_source = 'estimate'
WHERE call_id IS NULL AND cost_certainty = 'measured'
  AND model NOT IN ('muse-spark-1.3', 'muse-wonder-1.0');
