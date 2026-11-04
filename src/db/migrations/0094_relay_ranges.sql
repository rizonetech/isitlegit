-- D02 T02 §10: immutable proposals, a versioned current pointer, and idempotent audit outcomes.
-- Configuration is never stored in the receiving-chain discovery cache.
CREATE TABLE relay_range_revisions (
  claim_id TEXT NOT NULL REFERENCES org_domains(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  gateway TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('microsoft', 'google')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  cidrs TEXT NOT NULL CHECK(json_valid(cidrs) AND json_type(cidrs) = 'array'),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(claim_id, gateway, provider, revision)
);
CREATE TABLE relay_range_heads (
  claim_id TEXT NOT NULL REFERENCES org_domains(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  gateway TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('microsoft', 'google')),
  version INTEGER NOT NULL CHECK(version > 0),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY(claim_id, gateway, provider)
);
CREATE INDEX relay_range_heads_org ON relay_range_heads(org_id, claim_id);
CREATE TABLE relay_range_actions (
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES org_domains(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(json_valid(outcome)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(org_id, request_key)
);
