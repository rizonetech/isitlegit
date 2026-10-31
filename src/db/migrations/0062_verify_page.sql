-- The verify page's public address per identity (D05 T02 §6, the coordinator's number 0062): `public_slug`, readable
-- from the registered name (src/trust/slug.ts), and `public_slug_changed`, the owner's one change spent. Additive
-- only. The backfill of identities already protected is the Worker's own, by the same rule (`backfillPublicSlugs` in
-- the quarter-hour tick), since the rule folds accents and drops company forms, which SQL cannot do the same way.
ALTER TABLE identities ADD COLUMN public_slug TEXT CHECK (
  public_slug IS NULL OR (length(public_slug) BETWEEN 3 AND 60 AND public_slug NOT GLOB '*[^a-z0-9-]*')
);
ALTER TABLE identities ADD COLUMN public_slug_changed INTEGER NOT NULL DEFAULT 0 CHECK (public_slug_changed IN (0, 1));

CREATE UNIQUE INDEX identities_public_slug ON identities (public_slug) WHERE public_slug IS NOT NULL;

-- An address given up stays given up (completion review): a badge or seal already shared names it, and it must keep
-- answering "not protected", never another business's page. A change records the old address here, and neither an
-- assignment nor a change takes one listed.
CREATE TABLE retired_public_slugs (
  slug TEXT PRIMARY KEY CHECK (length(slug) BETWEEN 3 AND 60 AND slug NOT GLOB '*[^a-z0-9-]*'),
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  retired_at TEXT NOT NULL
);
