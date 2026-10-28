-- An organisation invitation is used once (D07 T02 §3). Better Auth's invitation status moves both ways (it resets
-- an acceptance to pending when its membership write fails), so it cannot say whether an invitation was spent; this
-- row, written before the plugin accepts it (src/auth/auth.ts), does. A removed member cannot come back through their
-- old invitation and two acceptances of one cannot both proceed; after an interrupted acceptance an owner invites again.
CREATE TABLE invitation_uses (
  invitation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  used_at TEXT NOT NULL
);
