-- Where each supplier account came from (D06 T01 §4, correction 4): typed by hand on the ledger page, imported from a
-- CSV, or verified from an invoice case. `verified_from_case_id` is cleared when its case is deleted, so the source is
-- kept apart from it and survives that. Additive only, the coordinator's number 0061; existing rows are backfilled from
-- the case link they still hold.
ALTER TABLE supplier_accounts
  ADD COLUMN source TEXT NOT NULL DEFAULT 'hand' CHECK (source IN ('hand', 'csv', 'case'));

UPDATE supplier_accounts SET source = 'case' WHERE verified_from_case_id IS NOT NULL;

-- A supplier holds at most 20 domains (src/invoice/ledger.ts MAX_SUPPLIER_DOMAINS), enforced where the row is written,
-- so an import that merges into the stored row cannot take a supplier past it while a member saves a domain at the same
-- moment (D06 T01 §4 round 1): the whole batch fails instead.
CREATE TRIGGER suppliers_domains_limit_insert BEFORE INSERT ON suppliers
WHEN json_array_length(NEW.domains_json) > 20
BEGIN
  SELECT RAISE(ABORT, 'suppliers: more than 20 domains');
END;

CREATE TRIGGER suppliers_domains_limit_update BEFORE UPDATE OF domains_json ON suppliers
WHEN json_array_length(NEW.domains_json) > 20
BEGIN
  SELECT RAISE(ABORT, 'suppliers: more than 20 domains');
END;
