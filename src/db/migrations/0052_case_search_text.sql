-- What the Cases list's search reads (D07 T04 §7): the case's subject, sender name and address and upload name, folded
-- by the Worker (Unicode NFKD, marks dropped, lower case; `searchText` in src/db/case-search.ts), because SQLite's
-- lower() folds ASCII only and D1 has no ICU. Written at every write of those fields (src/db/cases.ts); the rows stored
-- before this column are filled by the 15-minute schedule (`refreshSearchText`). Null until then.
ALTER TABLE cases ADD COLUMN search_text TEXT CHECK (search_text IS NULL OR length(search_text) <= 1100);
