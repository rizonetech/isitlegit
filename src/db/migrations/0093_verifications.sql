-- One immutable closed-loop request per case (D05 T03 §1). The mail sender owns delivery claims.
-- No recipient address, plaintext reply token or registered bank detail is persisted here.
CREATE TABLE verifications (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  supplier_org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source_run TEXT NOT NULL,
  source_evidence TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  attachment TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0 AND amount_cents <= 9007199254740991),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  account_last3 TEXT NOT NULL CHECK(length(account_last3) = 3 AND account_last3 NOT GLOB '*[^0-9]*'),
  recipient_hash TEXT NOT NULL CHECK(length(recipient_hash) = 64),
  nonce TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  answer TEXT CHECK(answer IS NULL OR answer IN ('confirmed', 'denied', 'unclear')),
  answered_at TEXT,
  delivery_evidence_run TEXT,
  refresh_checked_at TEXT
);
