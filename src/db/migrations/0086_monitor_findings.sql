-- A monitor finding's lifecycle (D05 T04 §5): one row per organisation and flagged host, across
-- captures, so a dismissal survives a changed capture. Status names the M6 list: new, watching,
-- offline (taken offline), dismissed. The alert record rides the same row: `alerted_at` is written
-- only on a confirmed send, and an uncertain delivery is stated, never resent blindly.
CREATE TABLE monitor_findings (
  org_id TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'watching', 'offline', 'dismissed')),
  first_seen TEXT NOT NULL,
  capture_key TEXT NOT NULL,
  case_id TEXT,
  outcome TEXT NOT NULL,
  evidence_refs TEXT,
  alerted_at TEXT,
  alert_state TEXT,
  dismissed_reason TEXT,
  dismissed_at TEXT,
  dismissed_capture_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, host)
);
CREATE INDEX monitor_findings_unalerted ON monitor_findings (org_id, status) WHERE alerted_at IS NULL AND status != 'dismissed';
