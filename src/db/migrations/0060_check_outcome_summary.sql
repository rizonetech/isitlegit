-- What each check saw, with its outcome (D02 T01 §7): a short plain summary a check that ran writes ("1, to
-- fynbosfreight.example"), drawn by the report after the check's own words. A nullable column added in place, never a
-- rebuild: every existing row keeps its values and a null summary, which reads as no summary. The runner checks the
-- text before storing it (one line of plain words, no markup); this bounds its length here too.
ALTER TABLE check_outcomes ADD COLUMN summary TEXT CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 120);
