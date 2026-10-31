-- An organisation's receiving chains behind a filtering gateway (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md):
-- the gateway its MX names hands its mail to Microsoft 365 or Google, proven by the provider's ingress hop recording an
-- address the gateway's rules pass. Bound to the verified claim whose receiver the gateway is, and deleted with it.
-- `status` is `proven`, or `unverified` when the gateway's addresses could not all be learned; `rules` are the
-- gateway's address rules (JSON, in evaluation order) with when they were looked up; `learned_case` is the case that
-- first proved it, which is read without it on a retry.
CREATE TABLE org_receiving_chains (
  claim_id TEXT NOT NULL REFERENCES org_domains (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  gateway TEXT NOT NULL CHECK (gateway = lower(gateway) AND length(gateway) BETWEEN 1 AND 255),
  provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
  status TEXT NOT NULL CHECK (status IN ('proven', 'unverified')),
  rules TEXT NOT NULL CHECK (json_valid(rules) AND json_type(rules) = 'array'),
  rules_at TEXT NOT NULL,
  learned_at TEXT NOT NULL,
  learned_case TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (claim_id, gateway, provider)
);
CREATE INDEX org_receiving_chains_org ON org_receiving_chains (org_id);
