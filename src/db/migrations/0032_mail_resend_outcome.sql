-- D01 T02 §8, completion review. What a resend ended in, said safely (`resend_outcome`: sent, refused by the
-- allowlist, left to the reconciler, no forwarder, or the rebuild's error name; never the message), and whether an
-- exhausted resend's operator alert has gone (`resend_alerted`), so a failed alert is tried again on the next run.
ALTER TABLE mail_sends ADD COLUMN resend_outcome TEXT;
ALTER TABLE mail_sends ADD COLUMN resend_alerted INTEGER NOT NULL DEFAULT 0;
