-- Which browser asked for a sign-in link (D07 T02 §12): the SHA-256 of the link's token, hex, beside the row the link's
-- code was issued under (migration 0035), so the confirm page can tell a link opened in another browser from the one
-- that asked. The token itself is stored only sealed with a fresh IV, which cannot be searched from a link. A hash of a
-- high-entropy token opens nothing. Rows issued before this column stay null and are treated as no row (the page as it
-- was). ADD COLUMN and an index only.
ALTER TABLE signin_codes ADD COLUMN token_hash TEXT CHECK (token_hash IS NULL OR length(token_hash) = 64);
CREATE INDEX signin_codes_token ON signin_codes (token_hash) WHERE token_hash IS NOT NULL;
