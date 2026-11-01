-- The Worker version that ran each check outcome (D02 T01 §4): its `CF_VERSION_METADATA` id, so a stored row says
-- which implementation of a check produced it after the check changes under the same name, as an analysis record such
-- as VirusTotal's keeps each engine's version beside its result. Nullable: rows from before read null. Each run's rows
-- carry their own (the table is keyed by run since 0051).
ALTER TABLE check_outcomes ADD COLUMN revision TEXT CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 100);
