-- Which step wrote each evidence item (D02 T01 §5): a later pipeline step (the walkthrough, D04 T02 §5) adds its own
-- items after the checks' and replaces only its own on a retry. A nullable column added in place, never a rebuild:
-- every existing row keeps its values and a null producer, which every reader reads as the checks' (`checks`).
ALTER TABLE evidence ADD COLUMN producer TEXT
  CHECK (producer IS NULL OR (length(producer) BETWEEN 1 AND 40 AND producer GLOB '[a-z]*' AND producer NOT GLOB '*[^a-z0-9_]*'));
