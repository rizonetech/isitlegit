-- The member who uploaded a case (D01 T03 §11), for the cases list's "Checked by" (D07 T04 §1): Better Auth's user id,
-- kept as given (a member who leaves keeps their id on the cases they checked); null on an email case, whose checker is
-- `forwarded_by`.
ALTER TABLE cases ADD COLUMN uploaded_by TEXT CHECK (uploaded_by IS NULL OR length(uploaded_by) BETWEEN 1 AND 200);
