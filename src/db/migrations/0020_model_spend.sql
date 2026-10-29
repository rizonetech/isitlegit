-- The Meta Model API budget (D03 T01 §2): one row for each transport attempt, reserved at its estimate before the send
-- and settled at its reported cost after. The one authority for the caps (src/meta/caps.ts): the Worker reserves here
-- directly and every local caller (the smoke test, the Glimmer lane's teacher labels) through `wrangler d1 execute`, with
-- the same statement (src/meta/budget-sql.ts). A row counts at `actual_usd` once settled and at `estimate_usd`
-- otherwise, so a reservation whose answer was lost is never released.
CREATE TABLE model_spend (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  -- The SAST date the attempt was reserved on (src/meta/day.ts), the day cap's day.
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source TEXT NOT NULL CHECK (source IN ('worker', 'local')),
  caller TEXT NOT NULL CHECK (length(caller) BETWEEN 1 AND 120),
  model TEXT NOT NULL,
  case_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  estimate_usd REAL NOT NULL CHECK (estimate_usd >= 0),
  actual_usd REAL CHECK (actual_usd IS NULL OR actual_usd >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'uncertain')),
  settled_at TEXT
);
CREATE INDEX model_spend_day ON model_spend (day);
