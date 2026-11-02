-- The payee account an invoice case's extraction stated (D06 T01 §1; design spec 4.5): one row per document of a
-- case, its number kept as the bank registry keeps numbers (0048): encrypted under BANK_KEY, compared by its HMAC
-- under BANK_MATCH_KEY, with the fingerprints of both keys, and refused by the triggers below when written under
-- keys other than `bank_key_epoch`'s, so a re-key moves it with the registry and the ledger (src/trust/bank.ts
-- `rekeyAccounts`, `abandonLostKeys`). Only the last three digits are kept in clear. Deleted with its case.
CREATE TABLE case_invoice_accounts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  artefact_key TEXT NOT NULL CHECK (length(artefact_key) BETWEEN 1 AND 1024),
  bank_name TEXT CHECK (bank_name IS NULL OR length(bank_name) BETWEEN 1 AND 120),
  branch_code TEXT NOT NULL CHECK (length(branch_code) = 6 AND branch_code NOT GLOB '*[^0-9]*'),
  holder TEXT CHECK (holder IS NULL OR length(holder) BETWEEN 1 AND 120),
  number_ciphertext BLOB NOT NULL CHECK (length(number_ciphertext) BETWEEN 17 AND 64),
  number_iv BLOB NOT NULL CHECK (length(number_iv) = 12),
  number_hmac TEXT NOT NULL CHECK (length(number_hmac) = 64 AND number_hmac NOT GLOB '*[^0-9a-f]*'),
  key_id TEXT NOT NULL CHECK (length(key_id) = 16),
  match_key_id TEXT NOT NULL CHECK (length(match_key_id) = 16),
  last3 TEXT NOT NULL CHECK (length(last3) = 3 AND last3 NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE (case_id, artefact_key)
);
CREATE INDEX case_invoice_accounts_case ON case_invoice_accounts (org_id, case_id);

CREATE TRIGGER case_invoice_accounts_insert_current_keys BEFORE INSERT ON case_invoice_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM bank_key_epoch WHERE id = 1 AND key_id = NEW.key_id AND match_key_id = NEW.match_key_id
)
BEGIN
  SELECT RAISE(ABORT, 'case_invoice_accounts: not under the current keys');
END;

CREATE TRIGGER case_invoice_accounts_update_current_keys BEFORE UPDATE OF key_id, match_key_id, number_ciphertext,
  number_iv, number_hmac ON case_invoice_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM bank_key_epoch WHERE id = 1 AND key_id = NEW.key_id AND match_key_id = NEW.match_key_id
)
BEGIN
  SELECT RAISE(ABORT, 'case_invoice_accounts: not under the current keys');
END;
