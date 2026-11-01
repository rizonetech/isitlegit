-- The daily count of reputation lookups made to a paid-for provider (D02 T06 §1): one row per UTC day and scope, the
-- scope `webrisk:<organisation id>` or `webrisk:*` for all organisations, so the caps (src/checks/caps.ts) hold under
-- cases running at once. Counted with one atomic upsert that refuses past the cap; nothing here holds a URL or an address.
CREATE TABLE reputation_calls (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  calls INTEGER NOT NULL CHECK (calls >= 0),
  PRIMARY KEY (day, scope)
);
