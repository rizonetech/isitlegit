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
  -- A refusal's subject hash, so its reports, whichever run reads them and in whatever order, are one incident.
  subject_hash TEXT,
  -- The alias, or, when several forwards of the same subject could be the refused one, each of them (comma-separated),
  -- `uncertain` set: named, never guessed.
  alias TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1)),
  sender_domain TEXT,
  -- A Worker failure's sender, hashed, to recognise its retry when the message carried no Message-ID.
  sender_hash TEXT,
  no_message_id INTEGER NOT NULL DEFAULT 0 CHECK (no_message_id IN (0, 1)),
  destination_domain TEXT,
  -- The forward a refusal was tied to, so no other refusal claims it.
  forward_hash TEXT,
  -- When the original was received (the forward, when known) and when it failed (the report, or the Worker's failure).
  received_at TEXT,
  occurred_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  -- The provider's reason, addresses removed (a Worker failure's `errorDetail`; reports carry none).
  reason TEXT,
  -- A Worker failure waits to see whether the sender's retry arrived: `retrying`, then `recovered` or `unresolved`.
  state TEXT NOT NULL CHECK (state IN ('open', 'retrying', 'recovered', 'unresolved')),
  -- The alert: `waiting` for a refusal's forward to appear, `pending` until confirmed sent to each mailbox (or refused
  -- by the allowlist), tried again each run.
  alert TEXT NOT NULL CHECK (alert IN ('none', 'waiting', 'pending', 'sent', 'refused')),
  alert_tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX forward_incidents_alert ON forward_incidents (alert, detected_at);
CREATE INDEX forward_incidents_subject ON forward_incidents (subject_hash, occurred_at);
