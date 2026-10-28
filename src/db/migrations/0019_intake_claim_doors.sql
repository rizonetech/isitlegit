-- A delivery's claim key carries its door and its form from D01 T03 §1 on (src/intake/admit.ts, claimKey;
-- src/intake/email.ts): `email:id:<Message-ID>`, `email:sha256:<hex>` or `upload:sha256:<hex>`. Every claim made before
-- this migration was a forward's (the upload door ships with it): a key `sha256:` and 64 hex digits was a forward's
-- hash and becomes `email:sha256:...`, any other was its Message-ID and becomes `email:id:...`, so a forward
-- redelivered across the deploy still finds its claim.
--
-- Through a new table, not an UPDATE in place: the prefixes keep every key distinct, but an update row by row
-- can meet a key that is not yet renamed (`<a>` becoming `email:<a>` while an `email:<a>` claim still stands) and abort.
CREATE TABLE intake_messages_doors (
  org_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  case_id TEXT,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, message_key)
);
INSERT INTO intake_messages_doors (org_id, message_key, state, case_id, claimed_at)
  SELECT
    org_id,
    CASE
      WHEN message_key GLOB 'sha256:[0-9a-f]*' AND length(message_key) = 71 THEN 'email:' || message_key
      ELSE 'email:id:' || message_key
    END,
    state,
    case_id,
    claimed_at
  FROM intake_messages;
DROP TABLE intake_messages;
ALTER TABLE intake_messages_doors RENAME TO intake_messages;
CREATE INDEX intake_messages_claimed ON intake_messages (state, claimed_at);
