-- One signup per address, in progress or done (D07 T02 §4, review round 1): 0013 held one pending redemption per
-- address, so once one completed a second overlapping signup could redeem again and make a second organisation. Now
-- a second redemption for the address fails, its batch (the code's use included) rolls back, and the signup resumes the
-- pending one or answers that the address already has an account. Account closure (§9) purges an address's
-- redemption, so it can sign up again then.
DROP INDEX invite_redemptions_pending_email;
CREATE UNIQUE INDEX invite_redemptions_email ON invite_redemptions (email);
