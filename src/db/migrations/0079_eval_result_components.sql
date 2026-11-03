-- Per-case component capture for the eval measurements (D08 T02 section 8, coordinator number 0079):
-- the reputation providers that listed the case (from its stored reputation.listing evidence, detail.provider)
-- and whether the case used the walkthrough (walkthrough_actions). Checked-but-unlisted providers are not
-- persisted by the pipeline today, so an empty list means not recorded, never checked-and-clean; the metrics
-- keep those denominators apart until the checks lane persists checked states.
ALTER TABLE eval_results ADD COLUMN providers TEXT CHECK (providers IS NULL OR json_valid(providers));
ALTER TABLE eval_results ADD COLUMN walkthrough INTEGER CHECK (walkthrough IS NULL OR walkthrough IN (0, 1));
