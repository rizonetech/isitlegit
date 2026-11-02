-- The moment an owner closed the organisation (D07 T02 §9, migration 0087): from it the organisation refuses new
-- cases and its verified domains and addresses are inactive, and the scheduled purge deletes its data once the
-- closure is 25 days old so deletion completes within the promised 30. Null while the organisation is open.
ALTER TABLE "organization" ADD COLUMN "closedAt" date;
