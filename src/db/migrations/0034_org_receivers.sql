-- The receiving systems an organisation's mail arrives through (D02 T02 §1; spec 4.3): learned from each verified
-- domain's MX records, so only the Authentication-Results headers those systems wrote are trusted. A row is bound to its
-- verified claim and goes with it; `kind` names a known provider or `other`, and `pattern` is a receiving host, or
-- `*.` and a domain for any host under it.
CREATE TABLE org_receivers (
  claim_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain = lower(domain)),
  kind TEXT NOT NULL CHECK (kind IN ('microsoft', 'google', 'other')),
  pattern TEXT NOT NULL CHECK (pattern = lower(pattern) AND length(pattern) BETWEEN 1 AND 255),
  learned_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, kind, pattern)
);
CREATE INDEX org_receivers_org ON org_receivers (org_id);

-- When each verified claim's receivers were last looked up, found or not, so the checks step tries every claim in turn:
-- a domain with no MX, or whose lookup fails, waits its turn rather than taking every slot (completion review).
CREATE TABLE receiver_lookups (
  claim_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tried_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('found', 'none', 'failed'))
);
