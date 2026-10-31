-- An organisation's receiving chains behind a filtering gateway (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md):
-- read from its own DNS, never from a message. The verified claim's MX names the gateway; the claim's records name the
-- provider it hands mail to. Bound to that claim and deleted with it. `status` is `proven` from complete discovery, or
-- `unverified` when the gateway's addresses or the claim's providers could not all be read; `rules` are the gateway's
-- address rules (JSON, in evaluation order) with when they were looked up.
CREATE TABLE org_receiving_chains (
  claim_id TEXT NOT NULL REFERENCES org_domains (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  gateway TEXT NOT NULL CHECK (gateway = lower(gateway) AND length(gateway) BETWEEN 1 AND 255),
  provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
  status TEXT NOT NULL CHECK (status IN ('proven', 'unverified')),
  rules TEXT NOT NULL CHECK (json_valid(rules) AND json_type(rules) = 'array'),
  rules_at TEXT NOT NULL,
  learned_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, gateway, provider)
);
CREATE INDEX org_receiving_chains_org ON org_receiving_chains (org_id);
