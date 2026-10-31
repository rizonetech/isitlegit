-- The impersonation monitor's daily state (D05 T04 §2, the coordinator's number 0063). `monitor_hosts`: each lookalike
-- candidate of a protected business, its last DNS observation kept apart from its last successful capture and its last
-- failure (corrections 2, 7 and 8), so a failed capture or a lookup that could not be made never stands as a fresh
-- check. `monitor_runs`: one row per organisation per SAST day, its outcome and counts (correction 13).
CREATE TABLE monitor_hosts (
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 253 AND domain = lower(domain)),
  resolves INTEGER NOT NULL DEFAULT 0 CHECK (resolves IN (0, 1)),
  dns_hash TEXT CHECK (dns_hash IS NULL OR length(dns_hash) = 64),
  dns_at TEXT,
  content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  captured_at TEXT,
  capture_key TEXT,
  capture_failed_at TEXT,
  capture_failures INTEGER NOT NULL DEFAULT 0 CHECK (capture_failures >= 0),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching', 'dismissed')),
  PRIMARY KEY (org_id, domain)
);

CREATE TABLE monitor_runs (
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'completed', 'partial', 'skipped', 'failed')),
  resolved INTEGER NOT NULL DEFAULT 0,
  not_resolving INTEGER NOT NULL DEFAULT 0,
  lookup_failed INTEGER NOT NULL DEFAULT 0,
  captured INTEGER NOT NULL DEFAULT 0,
  capture_failed INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(errors_json)),
  glimmer_json TEXT CHECK (glimmer_json IS NULL OR json_valid(glimmer_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (org_id, day)
);
