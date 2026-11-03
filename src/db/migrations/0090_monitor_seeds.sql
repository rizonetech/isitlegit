-- Monitor seeds (D05 T04 §6): extra candidate hosts checked only for organisations flagged
-- demo, so the demo business's daily run finds the hosted lookalike fixture. A seed carries
-- its page path; the fixtures host's secret prefix is applied by the Worker's own capture.
-- (Number provisional: asked from the coordinator 2026-11-03, next free in the ledger.)
CREATE TABLE monitor_seeds (
  org_id TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, host)
);
