-- Sign-in codes (D07 T02 §11): a 6-digit code mailed beside each sign-in link, which signs in only the browser that
-- asked for it. The browser holds a random handle in an HttpOnly cookie; each link it asks for is a row under the
-- handle's SHA-256, written before the mail goes, so every code it was mailed works until it is used, runs out or is
-- guessed at three times. A request whose mail is refused keeps its row with a decoy token, so what a browser can see
-- never tells an address that may sign in from one that may not. The link's token is sealed (AES-GCM under a key
-- derived from the auth secret) and the code kept only as an HMAC of handle and code, so a copy of the table opens no
-- account. Expired rows are swept as new ones are issued.
CREATE TABLE signin_codes (
  id TEXT PRIMARY KEY,
  handle_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  token_box TEXT NOT NULL,
  code_mac TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  used_at INTEGER
);
CREATE INDEX signin_codes_handle ON signin_codes (handle_hash, expires_at);
CREATE INDEX signin_codes_expires ON signin_codes (expires_at);
