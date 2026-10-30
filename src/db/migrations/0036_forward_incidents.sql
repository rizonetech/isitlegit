-- Forwarding failures (D01 T02 §6): mail an Email Routing rule forwarded and the destination then
-- refused, and member mail the Worker failed to take, read from Cloudflare's Email Routing events. The scan's progress
-- and each incident are kept here, so a run that missed a window catches up and an alert not yet handed over is tried
-- again. Subjects are never stored: a forward is matched to its refusal by a SHA-256 of its subject.
CREATE TABLE forward_scan (
  zone TEXT PRIMARY KEY,
  scanned_to TEXT NOT NULL
);

-- Forwards seen recently, so a refusal read in a later run still finds its forward (kept a day).
CREATE TABLE forward_seen (
  message_hash TEXT PRIMARY KEY CHECK (length(message_hash) = 64),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64),
  alias TEXT NOT NULL,
  sender_domain TEXT,
  at TEXT NOT NULL
);
CREATE INDEX forward_seen_subject ON forward_seen (subject_hash, at);

CREATE TABLE forward_incidents (
  key TEXT PRIMARY KEY CHECK (length(key) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('refused', 'worker')),
  alias TEXT,
  sender_domain TEXT,
  destination_domain TEXT,
  occurred_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  -- A Worker failure waits to see whether the sender's retry arrived: `retrying`, then `recovered` or `unresolved`.
  state TEXT NOT NULL CHECK (state IN ('open', 'retrying', 'recovered', 'unresolved')),
  -- The alert: `pending` until handed over to both mailboxes (or refused by the allowlist), tried again each run.
  alert TEXT NOT NULL CHECK (alert IN ('none', 'pending', 'sent', 'refused')),
  alert_tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX forward_incidents_alert ON forward_incidents (alert, detected_at);
