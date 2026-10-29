-- D01 T02 §8. A verdict reply the operator settled failed can be sent again: the row carries the resend's own state,
-- so the operator and the cron always read where it stands. `requested` by `mail-settle.ts --resend`; `sending` once
-- the cron has claimed it; `done` once the send is final (or handed to the reconciler); `exhausted` after three failed
-- runs, until the operator requeues it; `cancelled` by the operator before the cron claimed it.
ALTER TABLE mail_sends ADD COLUMN resend_state TEXT CHECK (resend_state IS NULL OR resend_state IN ('requested', 'sending', 'done', 'exhausted', 'cancelled'));
ALTER TABLE mail_sends ADD COLUMN resend_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_sends ADD COLUMN resend_at TEXT;
CREATE INDEX mail_sends_resend ON mail_sends (resend_state);
