-- Per-case canary credentials (D04 T02 §2; design spec 4.4a, 4.6a): the only values the walkthrough may type. One row is
-- one issue: a case keeps one username and may be issued more than one password (a retried walk mints a fresh one), so
-- an arrival anywhere traces to its case and to the issue. Only the password's SHA-256 is stored. Deleting a case
-- deletes its canaries (spec 4.8).
CREATE TABLE canaries (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  username TEXT NOT NULL CHECK (
    length(username) = 42
    AND substr(username, 1, 7) = 'canary-'
    AND substr(username, 20) = '@canary.isitlegit.co.za'
    AND substr(username, 8, 12) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  password_hash TEXT NOT NULL UNIQUE CHECK (length(password_hash) = 64 AND password_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);
CREATE INDEX canaries_username ON canaries (username);
CREATE INDEX canaries_case ON canaries (case_id);
