-- Outbound mail's send log (D01 T02 §1). One row per logical send, written as `pending` before SMTP2GO is called and
-- updated with the outcome, so a send whose outcome write failed, or whose Worker stopped, is never sent again: its
-- `send_key` (such as `reply:<caseId>`) already has a row. The recipient is a SHA-256 of the trimmed, lower-cased
-- address; no address, body or key is ever stored. `refused` is D01 T02 §2's (a recipient it will not mail). A case's
-- sends go with the case (the account purge, D07 T02 §9); a send with no case (sign-in, alerts) stands alone.

CREATE TABLE mail_sends (
  id TEXT PRIMARY KEY,
  send_key TEXT NOT NULL UNIQUE CHECK (length(send_key) BETWEEN 1 AND 200),
  case_id TEXT REFERENCES cases (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'signin', 'verify', 'alert', 'notice', 'renewal')),
  to_hash TEXT NOT NULL CHECK (length(to_hash) = 64 AND to_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'uncertain', 'refused')),
  provider_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT CHECK (error IS NULL OR length(error) <= 300),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mail_sends_case ON mail_sends (case_id);
