-- Invite-code signup and the daily case cap (D07 T02 §4; design spec section 11).
--
-- A code is stored only as its SHA-256 (scripts/invite-code.ts prints it once). A signup redeems one use and records a
-- pending redemption for its address in the same batch, then provisions the user, organisation and owner membership
-- keyed by that redemption (src/auth/signup.ts), so a signup stopped part way resumes without a second use or a second
-- organisation.
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE invite_redemptions (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES invite_codes (id),
  email TEXT NOT NULL CHECK (email = lower(email)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  user_id TEXT,
  org_id TEXT,
  consented_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- One signup in progress per address; a completed one leaves room for none (the address then belongs to an organisation).
CREATE UNIQUE INDEX invite_redemptions_pending_email ON invite_redemptions (email) WHERE status = 'pending';

-- An organisation's daily case cap; one with no row has the default of 50 (src/db/cases.ts, admitCase).
CREATE TABLE org_limits (
  org_id TEXT PRIMARY KEY,
  daily_cases INTEGER NOT NULL DEFAULT 50 CHECK (daily_cases >= 0)
);
