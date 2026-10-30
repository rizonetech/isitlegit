-- Sign-in codes (D07 T02 §11): a 6-digit code mailed beside each sign-in link, which signs in only the browser that
-- asked for it. The browser holds a random handle in an HttpOnly cookie and the row is keyed by the handle's SHA-256;
-- the link's token is sealed (AES-GCM under a key derived from the auth secret) and the code kept only as an HMAC of
-- handle and code, so a copy of the table opens no account. Three wrong codes end a row; a row lives as long as its
-- link, and expired rows are swept as new ones are issued.
CREATE TABLE signin_codes (
  handle_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_box TEXT NOT NULL,
  code_mac TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  used_at INTEGER
);
CREATE INDEX signin_codes_expires ON signin_codes (expires_at);
