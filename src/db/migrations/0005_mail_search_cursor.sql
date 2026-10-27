-- Reconciliation's progress through SMTP2GO's activity for one attempt (D01 T02 §5): the continue token of the next
-- page, so a window longer than one run's page budget is read across runs instead of from page one every time. It
-- belongs to the attempt (`claimed_at`) it was taken for, and a new claim starts it again.

ALTER TABLE mail_sends ADD COLUMN search_cursor TEXT;
