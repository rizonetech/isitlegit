-- D03 T01 §4. A call answered from the result cache leaves its record like any other (D03 T01 §3): settled at nothing,
-- certainty none, marked a hit, so the trace shows it and no cap counts it.
ALTER TABLE model_spend ADD COLUMN cache TEXT CHECK (cache IS NULL OR cache IN ('hit'));
