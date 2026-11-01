-- Single-use invite creation keys (D07 T05 §2, round 1 P2; migration number provisional until the coordinator
-- confirms it): the first POST for a key creates exactly one code, and any repeat POST of the same key renders the
-- already-submitted page instead of a second code. Only hashes are stored; a key with no code yet is an unused form.
CREATE TABLE invite_creation_keys (
  key_hash TEXT PRIMARY KEY CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  code_id TEXT NULL REFERENCES invite_codes (id),
  claim TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX invite_creation_keys_created_at ON invite_creation_keys (created_at);
