-- The checked original's subject and sender on the case (D01 T01 §16), for the report header (D07 T03 §9): written by
-- the Workflow's parse step, decoded, one line and bounded; null for a document, image or audio upload and for an inline
-- forward, whose Subject and From are the member's.
ALTER TABLE cases ADD COLUMN original_subject TEXT CHECK (original_subject IS NULL OR length(original_subject) <= 300);
ALTER TABLE cases ADD COLUMN original_from_name TEXT CHECK (original_from_name IS NULL OR length(original_from_name) <= 300);
ALTER TABLE cases ADD COLUMN original_from_address TEXT CHECK (original_from_address IS NULL OR length(original_from_address) <= 254);
