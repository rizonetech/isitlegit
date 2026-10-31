-- Counterparty checks (D05 T02 §1; design spec 2a): mail from someone who is not a member, forwarding an original that
-- claims a protected business, becomes a case of that business marked by `origin`. The channel stays the honest
-- transport (it arrived by email). Additive only: `cases` is the parent of evidence, check outcomes, case events and
-- intake messages on delete cascade, so the table is never rebuilt (a rebuild's implicit delete would wipe every
-- case's findings).
ALTER TABLE cases ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('counterparty'));

-- The counterparty limits count today's counterparty cases per forwarder and per protected business
-- (src/db/cases.ts `admitCase`), so these two reads are what every admission asks.
CREATE INDEX cases_counterparty_sender ON cases (origin, forwarded_by, created_at);
CREATE INDEX cases_counterparty_org ON cases (org_id, origin, created_at);
