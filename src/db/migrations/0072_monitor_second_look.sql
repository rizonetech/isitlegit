-- D05 T04 §9: Spark's second look at a page Loupe flagged, before the walkthrough (§4) is paid for. The verdict is kept
-- on the page's screening row beside Loupe's, both verdicts: `confirmed` (Spark flags it too), `declined` (it does not: a
-- likely false positive, §10's training example) or `unavailable` (Spark could not answer, so the flag stands). A page
-- Spark screened itself, a benign page and a parked one have none (NULL).
ALTER TABLE monitor_screens ADD COLUMN second_look TEXT
  CHECK (second_look IS NULL OR second_look IN ('confirmed', 'declined', 'unavailable'));
ALTER TABLE monitor_screens ADD COLUMN second_look_lure INTEGER
  CHECK (second_look_lure IS NULL OR second_look_lure IN (0, 1));
ALTER TABLE monitor_screens ADD COLUMN second_look_type TEXT
  CHECK (second_look_type IS NULL OR second_look_type IN ('credential', 'payment', 'fake_shop', 'impersonation', 'none'));
ALTER TABLE monitor_screens ADD COLUMN second_look_call_id TEXT;
ALTER TABLE monitor_screens ADD COLUMN second_look_log_id TEXT;

-- A second look is asked only of a page Loupe flagged, and its verdict columns go with it: a confirmed or declined one
-- carries Spark's verdict, an unavailable one none.
CREATE TRIGGER monitor_screens_second_look BEFORE INSERT ON monitor_screens
WHEN NEW.second_look IS NOT NULL AND NOT (
  NEW.outcome IS 'screened' AND NEW.screener IS 'glimmer' AND NEW.lure IS 1
  AND ((NEW.second_look IS 'unavailable' AND NEW.second_look_lure IS NULL AND NEW.second_look_type IS NULL)
    OR (NEW.second_look IS 'confirmed' AND NEW.second_look_lure IS 1 AND NEW.second_look_type IS NOT NULL
        AND NEW.second_look_type IS NOT 'none')
    OR (NEW.second_look IS 'declined' AND NEW.second_look_lure IS 0 AND NEW.second_look_type IS 'none')))
BEGIN
  SELECT RAISE(ABORT, 'monitor_screens: a second look belongs to a page Loupe flagged, with its own verdict');
END;

-- The declined flags, newest first, for §10's export.
CREATE INDEX monitor_screens_declined ON monitor_screens (org_id, screened_at) WHERE second_look = 'declined';

ALTER TABLE monitor_runs ADD COLUMN lures_declined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_runs ADD COLUMN second_look_unavailable INTEGER NOT NULL DEFAULT 0;
