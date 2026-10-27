-- Each claim's own start (D01 T02 §5). A failed send tried again hours later is a new attempt: reconciliation searches
-- SMTP2GO around `claimed_at`, the latest claim, not `created_at`, the first, and settles a row only while its
-- `claimed_at` is the one it read. Rows written before this migration take their creation time.

ALTER TABLE mail_sends ADD COLUMN claimed_at TEXT;
UPDATE mail_sends SET claimed_at = created_at WHERE claimed_at IS NULL;
