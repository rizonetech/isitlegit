-- D01 T02 §8, round 1. When an exhausted resend's alert was last tried, so each run tries the least recently tried
-- first and an alert left uncertain never holds the others back.
ALTER TABLE mail_sends ADD COLUMN resend_alert_tried_at TEXT;
