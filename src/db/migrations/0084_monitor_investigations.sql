-- The full-pipeline investigation of a flagged page (D05 T04 §4): one row per organisation and settled
-- capture, carrying the monitor origin so no case channel is needed and `cases` is never rebuilt. A row
-- starts `investigating` when its case is created and ends confirmed, unconfirmed or partial, with the
-- evidence references §5 reads.
CREATE TABLE monitor_investigations (
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  capture_key TEXT NOT NULL,
  case_id TEXT,
  capture_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('investigating', 'confirmed', 'unconfirmed', 'partial')),
  evidence_refs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, capture_key)
);
CREATE INDEX monitor_investigations_outstanding ON monitor_investigations (org_id, state) WHERE state = 'investigating';
