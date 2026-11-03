-- The fan-out manifest for a forward carrying several originals (D01 T01 §12): one row per further original,
-- written before the child case is started, so a retried parse step resumes the same children and never
-- makes one twice. The child is a full case of its own; this row is the only link back to the forward.
CREATE TABLE case_children (
  parent_case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  child_case_id TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('rfc822', 'eml', 'msg')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'admitted', 'refused-cap', 'started')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_case_id, position)
);
