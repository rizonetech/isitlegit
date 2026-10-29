-- D07 T02 §6. The auth audit trail: one row per sign-in, failed link, invitation, team change, verification attempt
-- and rate-limit refusal, for the owners' team history (D07 T04 §3) and the operator's incident review (D07 T05 §2).
-- Ids and outcomes only: the IP is an HMAC (`ip_hash`), and no address, token, code or link is ever written. Kept 12
-- months (src/auth/audit.ts), and an organisation's rows leave with it when it closes (D07 T02 §9).
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  org_id TEXT,
  user_id TEXT,
  actor_id TEXT,
  target_id TEXT,
  ip_hash TEXT,
  detail_json TEXT
);
CREATE INDEX auth_events_org ON auth_events (org_id, at);
CREATE INDEX auth_events_at ON auth_events (at);
-- Better Auth's per-IP limiter, counted here so every Worker instance shares one count (D07 T02 §6): one bucket per
-- client and path, its key an HMAC of both, a fixed window from its first request. Expired buckets are swept by the cron.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);
