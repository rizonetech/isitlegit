-- Who verified a domain or an address claim (D07 T02 §24): the user id of the member whose request proved it, by the
-- DNS check or the emailed code. Null for a claim still pending and for one verified before this column (no verifier is
-- ever invented for it). ADD COLUMN only, no foreign key: a member who has since left stays recorded, and the reader
-- (src/auth/domains.ts) says a member no longer in the organisation is a former member.
ALTER TABLE org_domains ADD COLUMN verified_by TEXT CHECK (verified_by IS NULL OR length(verified_by) BETWEEN 1 AND 100);
ALTER TABLE org_addresses ADD COLUMN verified_by TEXT CHECK (verified_by IS NULL OR length(verified_by) BETWEEN 1 AND 100);
