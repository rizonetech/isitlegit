-- D07 T02 §6, round 1. A role change holds its member for the moment it runs, so two at once cannot both read the
-- same previous role: the second is refused (409) and tried again, and each audit row names the role it really
-- replaced. `until` (epoch seconds) frees a lock its request never released.
CREATE TABLE member_locks (
  member_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
