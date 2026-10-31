-- The supplier ledger (D06 T01 §2; design spec 4.5): the suppliers an organisation really pays, their registrable
-- domains, phone number and bank accounts. Account numbers are kept as the bank registry keeps them (0048): encrypted
-- under BANK_KEY, compared by their HMAC under BANK_MATCH_KEY, with the fingerprints of both keys, and refused by the
-- triggers below when written under keys other than `bank_key_epoch`'s, so a re-key moves the ledger with the registry
-- (src/trust/bank.ts `rekeyAccounts`, `abandonLostKeys`). Only the last three digits are kept in clear.
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- The name lower-cased with runs of spaces as one (src/invoice/ledger.ts `nameKey`): one supplier per spelling.
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 120),
  domains_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(domains_json) AND json_type(domains_json) = 'array'),
  phone TEXT CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 30),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, name_key)
);

CREATE TABLE supplier_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL CHECK (length(bank_name) BETWEEN 1 AND 120),
  branch_code TEXT NOT NULL CHECK (length(branch_code) = 6 AND branch_code NOT GLOB '*[^0-9]*'),
  holder TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 120),
  number_ciphertext BLOB NOT NULL CHECK (length(number_ciphertext) BETWEEN 17 AND 64),
  number_iv BLOB NOT NULL CHECK (length(number_iv) = 12),
  number_hmac TEXT NOT NULL CHECK (length(number_hmac) = 64 AND number_hmac NOT GLOB '*[^0-9a-f]*'),
  key_id TEXT NOT NULL CHECK (length(key_id) = 16),
  match_key_id TEXT NOT NULL CHECK (length(match_key_id) = 16),
  last3 TEXT NOT NULL CHECK (length(last3) = 3 AND last3 NOT GLOB '*[^0-9]*'),
  -- The invoice case the member marked verified (D06 T01 §4), kept only while that case exists.
  verified_from_case_id TEXT REFERENCES cases (id) ON DELETE SET NULL,
  added_by TEXT NOT NULL CHECK (length(added_by) BETWEEN 1 AND 200),
  added_at TEXT NOT NULL,
  UNIQUE (supplier_id, number_hmac)
);
CREATE INDEX supplier_accounts_supplier ON supplier_accounts (org_id, supplier_id);

CREATE TRIGGER supplier_accounts_insert_current_keys BEFORE INSERT ON supplier_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM bank_key_epoch WHERE id = 1 AND key_id = NEW.key_id AND match_key_id = NEW.match_key_id
)
BEGIN
  SELECT RAISE(ABORT, 'supplier_accounts: not under the current keys');
END;

CREATE TRIGGER supplier_accounts_update_current_keys BEFORE UPDATE OF key_id, match_key_id, number_ciphertext,
  number_iv, number_hmac ON supplier_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM bank_key_epoch WHERE id = 1 AND key_id = NEW.key_id AND match_key_id = NEW.match_key_id
)
BEGIN
  SELECT RAISE(ABORT, 'supplier_accounts: not under the current keys');
END;

-- Every change to the ledger, with who made it and when; payloads are an allowlist (src/invoice/ledger.ts), never a
-- number or key.
CREATE TABLE ledger_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (
    kind IN ('supplier.added', 'supplier.updated', 'supplier.removed', 'account.added', 'account.removed')
  ),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX ledger_events_org ON ledger_events (org_id, created_at);
