-- First-time senders per organisation (D02 T02 §5; spec 4.3, Sender). A sender is kept only as an HMAC-SHA-256 of its
-- canonical mailbox under the organisation's own random salt, never in clear. One row per case: the case's sender
-- classified once, `first` unless the organisation has a row for that sender already, so a retried step reads its own
-- row back and a sender's count is its rows.
CREATE TABLE org_sender_salts (
  org_id TEXT PRIMARY KEY,
  salt TEXT NOT NULL CHECK (length(salt) = 64)
);

CREATE TABLE sender_observations (
  org_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sender_hash TEXT NOT NULL CHECK (length(sender_hash) = 64),
  classification TEXT NOT NULL CHECK (classification IN ('first', 'seen')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, case_id)
);
CREATE INDEX sender_observations_sender ON sender_observations (org_id, sender_hash);
