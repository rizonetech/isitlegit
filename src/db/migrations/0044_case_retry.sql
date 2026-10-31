-- A failed check retried (D01 T01 §17): the case's current Workflow run, null meaning its first run (whose instance id
-- is the case id); on an event, the member who made it (a retry's) and the run a retry event is about, so each start
-- and each failed start pair up by run; null on the pipeline's own events.
ALTER TABLE cases ADD COLUMN run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 100);
ALTER TABLE case_events ADD COLUMN actor TEXT CHECK (actor IS NULL OR length(actor) BETWEEN 1 AND 200);
-- When the retry sweep last looked at the case's run, so each sweep starts with the cases it looked at longest ago.
ALTER TABLE cases ADD COLUMN run_checked_at TEXT;
ALTER TABLE case_events ADD COLUMN run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 100);
