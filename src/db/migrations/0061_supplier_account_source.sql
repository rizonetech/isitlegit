-- Where each supplier account came from (D06 T01 §4, correction 4): typed by hand on the ledger page, imported from a
-- CSV, or verified from an invoice case. `verified_from_case_id` is cleared when its case is deleted, so the source is
-- kept apart from it and survives that. Additive only, the coordinator's number 0061; existing rows are backfilled from
-- the case link they still hold.
ALTER TABLE supplier_accounts
  ADD COLUMN source TEXT NOT NULL DEFAULT 'hand' CHECK (source IN ('hand', 'csv', 'case'));

UPDATE supplier_accounts SET source = 'case' WHERE verified_from_case_id IS NOT NULL;
