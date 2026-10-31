-- The walkthrough's audit trail (D04 T02 §3; design spec 4.4a "every action logged"): one row per attempted action
-- and per walk-level event (a refused request, a popup, the end), in order within a walk. A case may be walked more
-- than once (a retried Workflow step, a cache refresh), so rows belong to a walk. Typed text is never stored: a
-- canary is named by its field, a refused text by its length. Screenshots are `page` artefacts (`artefacts`), named
-- here by key. Deleting a case deletes its rows (spec 4.8).
CREATE TABLE walkthrough_actions (
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  walk_id TEXT NOT NULL CHECK (length(walk_id) BETWEEN 1 AND 64),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('action', 'request', 'popup', 'end')),
  action_json TEXT NOT NULL CHECK (json_valid(action_json) AND length(action_json) <= 2000),
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'refused', 'limit', 'error')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  screenshot_key TEXT,
  ms INTEGER NOT NULL CHECK (ms >= 0),
  at TEXT NOT NULL,
  PRIMARY KEY (case_id, walk_id, seq)
);
