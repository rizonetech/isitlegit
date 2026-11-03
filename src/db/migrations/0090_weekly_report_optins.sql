-- The opt-in for the Friday weekly counts email (D07 T04 §20; operator decision 2026-11-02): one row per member
-- of an organisation who asked for it, with when they asked. Clearing the opt-in deletes the row, so a row's
-- presence is the whole state; the send's idempotency lives in the mail ledger's send keys, not here.
CREATE TABLE weekly_report_optins (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  opted_in_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
