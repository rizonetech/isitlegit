-- Domain and sending-address verification (D07 T02 §5; spec 4.1, 4.8): mail reaches check@ only from domains and
-- addresses an organisation has proven. A domain is held in its registrable form; a verified domain or address belongs
-- to one organisation. A claim's challenge is one live code, stored hashed, bound to its claim and organisation.
CREATE TABLE org_domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 16 AND 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified')),
  method TEXT CHECK (method IN ('dns', 'email')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, domain)
);
CREATE UNIQUE INDEX org_domains_verified ON org_domains (domain) WHERE state = 'verified';

CREATE TABLE org_addresses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  address TEXT NOT NULL CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 254),
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, address)
);
CREATE UNIQUE INDEX org_addresses_verified ON org_addresses (address) WHERE state = 'verified';

CREATE TABLE verification_codes (
  claim_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until TEXT
);

-- Codes sent per claim, for the hourly limit (kept after a claim is removed and re-added: keyed by organisation and target).
CREATE TABLE verification_sends (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  target TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX verification_sends_target ON verification_sends (org_id, target, sent_at);

-- Ownership codes are their own mail kind, `claim`, apart from closed-loop `verify` mail (D01 T02 §2). SQLite cannot
-- change a CHECK, so mail_sends is rebuilt with every row, column and index it had (0003 to 0006).
CREATE TABLE mail_sends_next (
  id TEXT PRIMARY KEY,
  send_key TEXT NOT NULL UNIQUE CHECK (length(send_key) BETWEEN 1 AND 200),
  case_id TEXT REFERENCES cases (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'signin', 'verify', 'alert', 'notice', 'renewal', 'claim')),
  to_hash TEXT NOT NULL CHECK (length(to_hash) = 64 AND to_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'uncertain', 'refused')),
  provider_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT CHECK (error IS NULL OR length(error) <= 300),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  search_cursor TEXT,
  searched_at TEXT
);
INSERT INTO mail_sends_next (id, send_key, case_id, kind, to_hash, status, provider_id, attempts, error, created_at, updated_at, claimed_at, search_cursor, searched_at)
  SELECT id, send_key, case_id, kind, to_hash, status, provider_id, attempts, error, created_at, updated_at, claimed_at, search_cursor, searched_at FROM mail_sends;
DROP TABLE mail_sends;
ALTER TABLE mail_sends_next RENAME TO mail_sends;
CREATE INDEX mail_sends_case ON mail_sends (case_id);
