-- The data a run judged by, stored beside its outcomes (D02 T01 §6): the brand table's revision, an identity taken from
-- its content (two tables published under one revision date differ in it) and where it was read from (KV's copy, or
-- the bundled table it falls back to). A Worker version names the code that ran, not the table it
-- read, which changes in KV without a deploy. Nullable columns added in place, never a rebuild: every existing row keeps
-- its values and reads as having no recorded data, never as today's table.
ALTER TABLE check_outcomes ADD COLUMN data_revision TEXT CHECK (data_revision IS NULL OR length(data_revision) BETWEEN 1 AND 100);
ALTER TABLE check_outcomes ADD COLUMN data_id TEXT CHECK (data_id IS NULL OR length(data_id) BETWEEN 8 AND 64);
ALTER TABLE check_outcomes ADD COLUMN data_source TEXT CHECK (data_source IS NULL OR data_source IN ('kv', 'bundled'));
