-- D07 T02 §6, final review. A member's hold names its holder, so only the request that took it releases it: a late
-- release can never free a hold another request has since taken.
ALTER TABLE member_locks ADD COLUMN holder TEXT;
