-- The floor outcome stored with a verdict (D04 T01 §11): the JSON of FloorApplied (from, to, evidenceIds) when
-- the deterministic floor raised the verdict, NULL when it did not or for every row stored before this column
-- existed. The eval reads the floor component per case from it (D08 T02 §8); nothing else decides from it.
ALTER TABLE case_verdicts ADD COLUMN floor_applied TEXT;
