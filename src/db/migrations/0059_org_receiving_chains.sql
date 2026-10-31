-- An organisation's receiving chains behind a filtering gateway (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md):
-- the gateway its MX names hands its mail to Microsoft 365 or Google, proven by the provider's ingress hop recording one
-- of the gateway's addresses. Bound to the verified claim whose receiver the gateway is, and deleted with it; the
-- gateway's addresses (a JSON array of CIDRs) are kept with when they were looked up, and used for a day.
CREATE TABLE org_receiving_chains (
  claim_id TEXT NOT NULL REFERENCES org_domains (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  gateway TEXT NOT NULL CHECK (gateway = lower(gateway) AND length(gateway) BETWEEN 1 AND 255),
  provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
  addresses TEXT NOT NULL CHECK (json_valid(addresses) AND json_type(addresses) = 'array' AND json_array_length(addresses) <= 256),
  addresses_at TEXT NOT NULL,
  learned_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (claim_id, gateway, provider)
);
CREATE INDEX org_receiving_chains_org ON org_receiving_chains (org_id);
