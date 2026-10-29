-- D03 T01 §3, final review. A script owner's name (the gateway's metadata carries it; the row had nowhere to keep it),
-- so a script's calls are found by the script, not by the budget caller that happens to share its name.
ALTER TABLE model_spend ADD COLUMN script TEXT;
UPDATE model_spend SET script = caller WHERE owner = 'script';
