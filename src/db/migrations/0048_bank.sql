-- Registered bank accounts, match-only (D05 T01 §2; design spec 2a, AGENTS.md: registered bank details are never
-- revealed to a checker). An account number is stored encrypted (AES-GCM under BANK_KEY, a fresh 12-byte IV each) and
-- as a keyed HMAC (BANK_MATCH_KEY), so a match compares HMACs and never decrypts. Each row names the fingerprints of
-- the two keys it was made under: a registry with a row under another key refuses to add or match until it is
-- re-keyed (src/trust/bank.ts `rekeyAccounts`), so a replaced or lost key never reads as a changed bank. Only the last
-- three digits are kept in clear, for the owner's masked view.
CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL CHECK (length(bank_name) BETWEEN 1 AND 120),
  branch_code TEXT NOT NULL CHECK (length(branch_code) = 6 AND branch_code NOT GLOB '*[^0-9]*'),
  holder TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 120),
  number_ciphertext BLOB NOT NULL CHECK (length(number_ciphertext) BETWEEN 17 AND 64),
  number_iv BLOB NOT NULL CHECK (length(number_iv) = 12),
  number_hmac TEXT NOT NULL CHECK (length(number_hmac) = 64 AND number_hmac NOT GLOB '*[^0-9a-f]*'),
  key_id TEXT NOT NULL CHECK (length(key_id) = 16),
  match_key_id TEXT NOT NULL CHECK (length(match_key_id) = 16),
  last3 TEXT NOT NULL CHECK (length(last3) = 3 AND last3 NOT GLOB '*[^0-9]*'),
  added_by TEXT NOT NULL CHECK (length(added_by) BETWEEN 1 AND 200),
  added_at TEXT NOT NULL,
  UNIQUE (org_id, number_hmac)
);

-- Match attempts counted in fixed hourly windows, one row a bucket ("caller:org:<id>", "caller:sender:<address>",
-- "protected:<org id>"), each bumped by one atomic upsert so concurrent matches cannot both take the last slot.
CREATE TABLE bank_match_counts (
  bucket TEXT PRIMARY KEY CHECK (length(bucket) BETWEEN 1 AND 300),
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);
