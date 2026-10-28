-- One membership per user and organisation (D07 T02 §3). Better Auth's organisation schema indexes the two columns but
-- cannot declare the pair unique, and two acceptances of one invitation overlapping (one recovering an interrupted
-- acceptance, src/auth/auth.ts) would otherwise each write a row, leaving access after a removal deletes one.
CREATE UNIQUE INDEX member_org_user_unique ON member ("organizationId", "userId");
