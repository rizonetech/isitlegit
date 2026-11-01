-- The monitor's screening of captured pages (D05 T04 §3, the coordinator's number 0068).
--
-- 1. `monitor_hosts` is rebuilt so `status` allows `parked` (a page the parking rules skipped) and so it counts the
--    failed screenings of its current capture (`screen_failures`). SQLite cannot alter a CHECK, so the table is copied,
--    dropped and renamed; nothing references it, and every row is kept in the copy. It comes first, so nothing created
--    below can reference the table while it is being replaced.
CREATE TABLE monitor_hosts_rebuilt (
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 253 AND domain = lower(domain)),
  resolves INTEGER NOT NULL DEFAULT 0 CHECK (resolves IN (0, 1)),
  dns_hash TEXT CHECK (dns_hash IS NULL OR length(dns_hash) = 64),
  dns_at TEXT,
  content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  captured_at TEXT,
  capture_key TEXT,
  captured_dns_hash TEXT CHECK (captured_dns_hash IS NULL OR length(captured_dns_hash) = 64),
  capture_url TEXT CHECK (capture_url IS NULL OR capture_url LIKE 'http://%' OR capture_url LIKE 'https://%'),
  capture_failed_at TEXT,
  capture_failures INTEGER NOT NULL DEFAULT 0 CHECK (capture_failures >= 0),
  -- Failed screenings of the current capture: reset when a new capture replaces it, the page left at five.
  screen_failures INTEGER NOT NULL DEFAULT 0 CHECK (screen_failures >= 0),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching', 'parked', 'dismissed')),
  PRIMARY KEY (org_id, domain)
);

INSERT INTO monitor_hosts_rebuilt (org_id, domain, resolves, dns_hash, dns_at, content_hash, captured_at, capture_key,
  captured_dns_hash, capture_url, capture_failed_at, capture_failures, first_seen, last_seen, status)
SELECT org_id, domain, resolves, dns_hash, dns_at, content_hash, captured_at, capture_key, captured_dns_hash,
  capture_url, capture_failed_at, capture_failures, first_seen, last_seen, status
FROM monitor_hosts;

DROP TABLE monitor_hosts;
ALTER TABLE monitor_hosts_rebuilt RENAME TO monitor_hosts;

-- 2. One row per capture screened: a model's verdict (`screened`) or the parking rules' decision (`parked`), each with
--    only its own columns (the CHECK). A capture is owed a screening while it has no row of either kind; the history
--    stays for the findings (§4) and their dismissal (§5).
CREATE TABLE monitor_screens (
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 253 AND domain = lower(domain)),
  capture_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('screened', 'parked')),
  screener TEXT CHECK (screener IS NULL OR screener IN ('glimmer', 'spark')),
  brand TEXT CHECK (brand IS NULL OR length(brand) BETWEEN 1 AND 200),
  has_login_form INTEGER CHECK (has_login_form IS NULL OR has_login_form IN (0, 1)),
  has_payment_form INTEGER CHECK (has_payment_form IS NULL OR has_payment_form IN (0, 1)),
  lure INTEGER CHECK (lure IS NULL OR lure IN (0, 1)),
  lure_type TEXT CHECK (lure_type IS NULL OR lure_type IN ('credential', 'payment', 'fake_shop', 'impersonation', 'none')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- Why Loupe did not answer, when it did not (Spark took the page).
  glimmer_reason TEXT,
  spark_call_id TEXT,
  spark_log_id TEXT,
  parked_reason TEXT,
  screened_at TEXT NOT NULL,
  PRIMARY KEY (org_id, domain, capture_key),
  CHECK (
    (outcome = 'screened' AND screener IS NOT NULL AND lure IS NOT NULL AND lure_type IS NOT NULL
      AND confidence IS NOT NULL AND has_login_form IS NOT NULL AND has_payment_form IS NOT NULL
      AND parked_reason IS NULL AND ((lure = 1) = (lure_type != 'none')))
    OR
    (outcome = 'parked' AND screener IS NULL AND lure IS NULL AND lure_type IS NULL AND confidence IS NULL
      AND brand IS NULL AND has_login_form IS NULL AND has_payment_form IS NULL AND glimmer_reason IS NULL
      AND spark_call_id IS NULL AND spark_log_id IS NULL AND parked_reason IS NOT NULL)
  )
);

-- The pages judged lures, newest first, for the findings (§4).
CREATE INDEX monitor_screens_lures ON monitor_screens (org_id, screened_at) WHERE lure = 1;

-- 3. The run row's screening counts.
ALTER TABLE monitor_runs ADD COLUMN screened INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_runs ADD COLUMN parked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_runs ADD COLUMN lures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_runs ADD COLUMN screen_failed INTEGER NOT NULL DEFAULT 0;
-- Owed screenings left for the next run: past the 50 a run, or at the failure limit.
ALTER TABLE monitor_runs ADD COLUMN screen_deferred INTEGER NOT NULL DEFAULT 0;
