-- Protected identities (D05 T01 §1; design spec 2a): what a business really uses, registered so impersonation of it can
-- be caught. One identity per organisation, written only by its owners and admins through the console (§3). Its
-- display names, finance contact (the address that answers bank verification requests and receives impersonation
-- alerts) and logo are matched against mail; they are never shown to anyone checking a payment (AGENTS.md).
-- Protection is stored as a switch, and is effective only while a verified domain and the verified finance contact
-- still exist (read at read time, src/trust/identity.ts), so removing either ends it without touching this row.
CREATE TABLE identities (
  org_id TEXT PRIMARY KEY REFERENCES "organization" (id) ON DELETE CASCADE,
  display_names_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(display_names_json) AND json_type(display_names_json) = 'array'),
  finance_contact_email TEXT CHECK (
    finance_contact_email IS NULL
    OR (finance_contact_email = lower(finance_contact_email) AND length(finance_contact_email) BETWEEN 3 AND 254)
  ),
  -- The logo's R2 key and media type, set together or not at all, the key under the organisation's own prefix.
  logo_r2_key TEXT,
  logo_media_type TEXT CHECK (logo_media_type IS NULL OR logo_media_type IN ('image/png', 'image/svg+xml')),
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
  -- Raised by every change: a change applies only to the version it read, so its event names what it really changed.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  CHECK ((logo_r2_key IS NULL) = (logo_media_type IS NULL)),
  CHECK (logo_r2_key IS NULL OR substr(logo_r2_key, 1, length('ident/' || org_id || '/')) = 'ident/' || org_id || '/')
);

-- The trust network's audit trail (spec 4.8): who changed what in an identity and, from D05 T01 §2, its bank accounts
-- and matches. Never a bank number or another field's value beyond what names the change.
CREATE TABLE trust_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  -- The bank kinds are §2's (its add, remove and match), listed here since SQLite cannot widen a CHECK in place.
  kind TEXT NOT NULL CHECK (
    kind IN (
      'identity.set', 'identity.logo_stored', 'identity.logo_removed', 'identity.logo_orphaned',
      'bank.added', 'bank.removed', 'bank.matched'
    )
  ),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  created_at TEXT NOT NULL
);
CREATE INDEX trust_events_org ON trust_events (org_id, created_at);
