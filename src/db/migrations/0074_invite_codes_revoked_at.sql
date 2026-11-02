-- A revoked invite code stays unusable and reads as Revoked (D07 T05 §2; design/SPEC.md X3): setting
-- `expires_at` to now is not enough, because an expired code and a revoked one must read apart, and a revoked code's
-- earlier signups are unaffected (their redemptions already exist). Old rows read NULL: no code was revocable before
-- this column existed.
ALTER TABLE invite_codes ADD COLUMN revoked_at TEXT;
