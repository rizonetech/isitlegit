-- The live signature badge's request count (D05 T02 §7, the coordinator's number 0065): one row per organisation per
-- SAST day, counting the requests for its badge. Nothing else is kept: no address, referrer, user agent or message
-- data.
CREATE TABLE badge_requests (
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (org_id, day)
);
