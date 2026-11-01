-- The sentence a verdict gives the reader on what it means and what to do (D04 T01 §2): one sentence, 1 to 300
-- characters, nullable. A verdict stored before this column reads `meaning: null`, and the report then draws its own
-- sentence for the label. Added in place; no row is rewritten.
ALTER TABLE case_verdicts ADD COLUMN meaning TEXT;
