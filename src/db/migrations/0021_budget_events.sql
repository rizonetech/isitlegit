-- A Meta cap's refusal, once per event (D03 T01 §2): recorded by whichever caller was refused, the Worker or a local
-- script (scripts/lib/meta-budget.ts), so the operator's alert reaches them either way. The Worker sends the alert at
-- once where it can and its cron sends any not yet sent (`notified_at` empty), keyed by the event so it goes once.
CREATE TABLE budget_events (
  event TEXT PRIMARY KEY,
  cap TEXT NOT NULL CHECK (cap IN ('day', 'total', 'reserve')),
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  notified_at TEXT
);
