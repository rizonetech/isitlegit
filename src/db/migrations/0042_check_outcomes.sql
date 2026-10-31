-- Each case's check outcomes (D02 T01 §3): one row per registered check, whether it ran, was skipped or failed, why, and
-- how many items it gave, written in the evidence's own batch. The report's count line and the safe board's "Checks
-- that found nothing" read them (D07 T03 §18), from the rows alone, so a check renamed or retired since still reads.
-- Deleting a case deletes its rows, as its evidence's (spec 4.8).
CREATE TABLE check_outcomes (
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  check_name TEXT NOT NULL CHECK (length(check_name) BETWEEN 1 AND 100),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('ran', 'skipped', 'failed')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  findings INTEGER NOT NULL CHECK (findings >= 0),
  PRIMARY KEY (case_id, check_name)
);
