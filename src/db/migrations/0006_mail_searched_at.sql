-- When reconciliation last searched SMTP2GO for a row (D01 T02 §5). A run takes the rows never searched first, then
-- the least recently searched, so a run budget smaller than the backlog still reaches every row across runs instead of
-- the oldest claims every time.

ALTER TABLE mail_sends ADD COLUMN searched_at TEXT;
