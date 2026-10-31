-- Loupe's dedicated deployment minutes (D03 T04 §14; design spec section 11): Fireworks has no daily runtime cap, so every
-- caller that wakes the deployment (the Worker's monitor and the local scripts) reserves its minutes here before its
-- first request and settles them after its last. One row per reservation per SAST day it touches. A row counts its
-- used minutes once settled and its reserved minutes until then, so an interrupted caller is never counted less.
-- `ended_at` is a settled burst's end (its wake plus everything it used, the tail included), and `seq` the order the
-- database settled it in: a burst is charged only for its time outside the bursts settled before it, so shared runtime
-- is counted once. A settlement first charges the whole interval (`reconciled` 0), then the reconciliation lowers it;
-- one that was interrupted is reconciled by the next settlement or reservation.
CREATE TABLE glimmer_runtime (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source TEXT NOT NULL CHECK (source IN ('worker', 'local', 'import')),
  caller TEXT NOT NULL,
  purpose TEXT NOT NULL,
  wake_at TEXT NOT NULL,
  reserved_minutes REAL NOT NULL CHECK (reserved_minutes >= 0),
  used_minutes REAL CHECK (used_minutes IS NULL OR used_minutes >= 0),
  last_answer_at TEXT,
  ended_at TEXT,
  seq INTEGER,
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  settled_at TEXT
);
CREATE INDEX glimmer_runtime_day ON glimmer_runtime (day);
CREATE INDEX glimmer_runtime_reservation ON glimmer_runtime (reservation_id);
CREATE INDEX glimmer_runtime_unreconciled ON glimmer_runtime (reconciled, settled_at);
