-- What a clean check examined (D02 T01 §8): the targets as stored text with the count omitted, as one
-- nullable JSON column on the check's outcome. Null means the check stored none (no hook, findings,
-- partial, skipped or failed); an examined empty set stores {"targets":[],"omitted":0}, never null.
ALTER TABLE check_outcomes ADD COLUMN examined TEXT;
