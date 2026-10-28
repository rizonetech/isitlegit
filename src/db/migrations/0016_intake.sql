-- Email intake (D01 T01 §3). A delivery is claimed before anything else is written, keyed by organisation and the
-- forward's Message-ID (or the raw message's SHA-256 when it has none): `pending` while it is processed, with its case
-- once admitted, and `done` once its Workflow started. A done claim younger than a day marks a duplicate; a pending one
-- older than five minutes belongs to a delivery that stopped, and is taken over or swept (src/intake/email.ts). Claims
-- carry no foreign key to the organisation; the closure purge (D07 T02 §9) deletes them.
CREATE TABLE intake_messages (
  org_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  case_id TEXT,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, message_key)
);
CREATE INDEX intake_messages_claimed ON intake_messages (state, claimed_at);

-- Who forwarded the case and the forward's Message-ID: the reply (D01 T02 §3) goes to the admitted envelope sender,
-- never to an address the message itself names, and threads on the Message-ID. Null for uploads.
ALTER TABLE cases ADD COLUMN forwarded_by TEXT;
ALTER TABLE cases ADD COLUMN message_id TEXT;
