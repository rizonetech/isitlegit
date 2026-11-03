// Protected identities (D05 T01 §1; design spec 2a): an organisation's display names, finance contact, logo and the
// switch that registers them against impersonation. Internal helpers: `orgId` is always the caller's authenticated
// organisation (D07 T02's session, the console of §3), never a value from a request, and nothing here is shown to
// someone checking a payment: a claim match returns only which organisation a name or domain belongs to.
//
// Protection is effective only while its prerequisites hold, read at read time: the switch is on, the organisation
// still has a verified domain, and the finance contact is still one of its verified addresses. Removing a domain or
// an address through the domain routes (src/auth/domains.ts) therefore ends protection without touching this table.

import { z } from "zod";
import { claimable, registrable } from "../auth/senders";
import { ulid } from "../db/ulid";
import { IdentityRefused } from "./errors";
import { normaliseName } from "./names";
import { assignPublicSlug } from "./public-slug";

export const MAX_NAMES = 10;
export const MAX_NAME = 120;

export { normaliseName };

const Name = z
  .string()
  .min(1)
  .max(MAX_NAME)
  .refine((n) => normaliseName(n).length > 0, "a name needs letters or digits");

export const IdentityInput = z
  .strictObject({
    displayNames: z
      .array(Name)
      .min(1)
      .max(MAX_NAMES)
      .refine((names) => new Set(names.map(normaliseName)).size === names.length, "two names are the same"),
    financeContact: z.email().max(254).nullable(),
    protected: z.boolean(),
  })
  .readonly();
export type IdentityInput = z.infer<typeof IdentityInput>;

export type Identity = {
  orgId: string;
  displayNames: string[];
  financeContact: string | null;
  logo: { key: string; mediaType: "image/png" | "image/svg+xml" } | null;
  protected: boolean;
  // Whether protection holds now, and why not when it does not.
  effective: { on: true } | { on: false; reason: string };
  // The revision of the stored identity: it rises with every change to it (a save, a logo stored or removed), so a form
  // drawn from one revision can tell the identity has moved on since. 0 stands for no identity yet.
  version: number;
  updatedAt: string;
  updatedBy: string;
};

export { IdentityRefused };

// What a change refused for a stale revision says; the page maps it to its 409 (src/web/pages/identity.tsx).
export const STALE_IDENTITY = "the identity was changed since the page was drawn";

type Row = {
  org_id: string;
  display_names_json: string;
  finance_contact_email: string | null;
  logo_r2_key: string | null;
  logo_media_type: "image/png" | "image/svg+xml" | null;
  protected: number;
  version: number;
  updated_at: string;
  updated_by: string;
};

async function verifiedDomains(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT domain FROM org_domains WHERE org_id = ? AND state = 'verified' AND ${claimable()} ORDER BY domain`,
    )
    .bind(orgId)
    .all<{ domain: string }>();
  return rows.results.map((r) => r.domain);
}

async function addressVerified(db: D1Database, orgId: string, address: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM org_addresses WHERE org_id = ? AND address = ? AND state = 'verified'")
    .bind(orgId, address)
    .first<{ ok: number }>();
  return row !== null;
}

async function effectiveOf(db: D1Database, row: Row): Promise<Identity["effective"]> {
  if (row.protected !== 1) return { on: false, reason: "protection is switched off" };
  if ((await verifiedDomains(db, row.org_id)).length === 0) return { on: false, reason: "no domain is verified" };
  if (!row.finance_contact_email) return { on: false, reason: "no finance contact is set" };
  if (!(await addressVerified(db, row.org_id, row.finance_contact_email)))
    return { on: false, reason: "the finance contact is no longer a verified address" };
  return { on: true };
}

async function identityOf(db: D1Database, row: Row): Promise<Identity> {
  return {
    orgId: row.org_id,
    displayNames: JSON.parse(row.display_names_json) as string[],
    financeContact: row.finance_contact_email,
    logo: row.logo_r2_key && row.logo_media_type ? { key: row.logo_r2_key, mediaType: row.logo_media_type } : null,
    protected: row.protected === 1,
    effective: await effectiveOf(db, row),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

const rowOf = (db: D1Database, orgId: string) =>
  db.prepare("SELECT * FROM identities WHERE org_id = ?").bind(orgId).first<Row>();

export async function getIdentity(db: D1Database, orgId: string): Promise<Identity | null> {
  const row = await rowOf(db, orgId);
  return row ? identityOf(db, row) : null;
}

// An audit event as a statement, to go in the same batch as the change it records.
// With `ifChanged`, the event is written only when the statement before it in the batch changed a row (SQLite's
// `changes()`), so a conditional update that loses a race records nothing.
export function eventStatement(
  db: D1Database,
  orgId: string,
  actor: string,
  kind:
    | "identity.set"
    | "identity.logo_stored"
    | "identity.logo_removed"
    | "identity.logo_orphaned"
    | "bank.added"
    | "bank.removed"
    | "bank.matched"
    | "bank.rekeyed",
  detail: Record<string, unknown>,
  at: string,
  ifChanged = false,
  id = ulid(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?${ifChanged ? " WHERE changes() = 1" : ""}`,
    )
    .bind(id, orgId, actor, kind, JSON.stringify(detail), at);
}

// Stores the identity, the change and its event in one batch (they commit together or not at all). Refuses, with
// an `IdentityRefused` naming why: a malformed input, a finance contact that is not a verified address of this
// organisation, or protection switched on without a verified domain and a finance contact. With `expectedVersion` (the
// revision the caller's form was drawn from; 0 for no identity yet) it also refuses, before anything is written, when
// the stored identity has moved on since.
export async function setIdentity(
  db: D1Database,
  orgId: string,
  actor: string,
  input: unknown,
  now = new Date(),
  expectedVersion?: number,
): Promise<Identity> {
  const parsed = IdentityInput.safeParse(input);
  if (!parsed.success) throw new IdentityRefused(z.prettifyError(parsed.error));
  const v = parsed.data;
  const contact = v.financeContact?.toLowerCase() ?? null;
  const before = await rowOf(db, orgId);
  if (expectedVersion !== undefined && (before?.version ?? 0) !== expectedVersion)
    throw new IdentityRefused(STALE_IDENTITY);
  // A contact is checked when it is set or changed, or when protection is asked for: switching protection off, or
  // renaming, never needs a contact repaired first (completion review).
  const checkContact = contact !== null && (contact !== (before?.finance_contact_email ?? null) || v.protected);
  if (checkContact && !(await addressVerified(db, orgId, contact)))
    throw new IdentityRefused("the finance contact must be a verified address of this organisation");
  if (v.protected) {
    const missing = [
      (await verifiedDomains(db, orgId)).length === 0 ? "a verified domain" : "",
      contact ? "" : "a finance contact",
    ].filter(Boolean);
    if (missing.length) throw new IdentityRefused(`protection needs ${missing.join(" and ")}`);
  }
  const names = JSON.stringify(v.displayNames);
  const changed = [
    !before || before.display_names_json !== names ? "displayNames" : "",
    !before || before.finance_contact_email !== contact ? "financeContact" : "",
    !before || (before.protected === 1) !== v.protected ? "protected" : "",
  ].filter(Boolean);
  const at = now.toISOString();
  // The change applies only to the version it read (a first change only where no row exists yet), and its event is
  // written only when it applied: two concurrent edits cannot leave an event naming fields the other changed back
  // (round 1).
  const write = before
    ? db
        .prepare(
          `UPDATE identities SET display_names_json = ?, finance_contact_email = ?, protected = ?, version = version + 1,
             updated_at = ?, updated_by = ?
           WHERE org_id = ? AND version = ?`,
        )
        .bind(names, contact, v.protected ? 1 : 0, at, actor, orgId, before.version)
    : db
        .prepare(
          `INSERT INTO identities (org_id, display_names_json, finance_contact_email, protected, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (org_id) DO NOTHING`,
        )
        .bind(orgId, names, contact, v.protected ? 1 : 0, at, actor);
  const [result] = await db.batch([
    write,
    eventStatement(db, orgId, actor, "identity.set", { fields: changed }, at, true),
  ]);
  if ((result?.meta.changes ?? 0) !== 1) throw new IdentityRefused("the identity was changed meanwhile; try again");
  // The verify page's address, given once protection is on (D05 T02 §6); a failure here leaves the saved identity as
  // it is, and the quarter-hour backfill gives the address later.
  if (v.protected)
    await assignPublicSlug(db, orgId).catch((error: unknown) =>
      console.log(JSON.stringify({ event: "public-slug", outcome: "deferred", error: (error as Error).name })),
    );
  return (await getIdentity(db, orgId)) as Identity;
}

export type OrgDomain = { domain: string; state: "verified" | "pending" };

// The organisation's claimed domains with their states (the console's Domains region, D05 T01 §3), verified first.
export async function orgDomains(db: D1Database, orgId: string): Promise<OrgDomain[]> {
  const rows = await db
    .prepare("SELECT domain, state FROM org_domains WHERE org_id = ? ORDER BY state = 'pending', domain")
    .bind(orgId)
    .all<OrgDomain>();
  return rows.results;
}

// The organisation's verified sending addresses: the finance contact is chosen from these.
export async function verifiedAddresses(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT address FROM org_addresses WHERE org_id = ? AND state = 'verified' ORDER BY address")
    .bind(orgId)
    .all<{ address: string }>();
  return rows.results.map((r) => r.address);
}

// When protection was last switched on: the moment of the latest `identity.set` event that changed `protected`. Read
// only while protection is on, when that change was the switching on, so a rename or a new logo never moves it.
export async function protectedSince(db: D1Database, orgId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT created_at FROM trust_events
       WHERE org_id = ? AND kind = 'identity.set'
         AND EXISTS (SELECT 1 FROM json_each(json_extract(detail_json, '$.fields')) WHERE value = 'protected')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(orgId)
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

// The identity's contact for verification requests and alerts (D05 T02 §4, D05 T03, D05 T04 §5), re-read against the
// organisation's verified addresses, so a contact whose verification was removed is never used. Whether mail may go
// to it is the mail layer's decision at send time (`isAllowedRecipient`, src/mail/allowlist.ts; spec 11).
export async function identityContact(db: D1Database, orgId: string): Promise<string | null> {
  const row = await rowOf(db, orgId);
  const contact = row?.finance_contact_email ?? null;
  return contact && (await addressVerified(db, orgId, contact)) ? contact : null;
}

export type ProtectedCandidate = {
  orgId: string;
  names: string[];
  domains: string[];
  logo: { key: string; mediaType: "image/png" | "image/svg+xml" } | null;
};

// Every effectively protected identity as a candidate for the trust claim match (D02 T01 §9): an allowlisted
// projection (org id, display names, verified domains, the registered logo's reference, never its bytes, and
// never a finance contact or bank field), in org-id order, filtered by the same effective test `getIdentity`
// reports, so an identity whose protection lapsed is not a candidate. The bound on the set is the view's
// (src/checks/case-view.ts), applied by the caller.
export async function protectedIdentities(db: D1Database): Promise<ProtectedCandidate[]> {
  const rows = await db.prepare("SELECT * FROM identities WHERE protected = 1 ORDER BY org_id").all<Row>();
  const out: ProtectedCandidate[] = [];
  for (const row of rows.results) {
    if (!(await effectiveOf(db, row)).on) continue;
    out.push({
      orgId: row.org_id,
      names: JSON.parse(row.display_names_json) as string[],
      domains: await verifiedDomains(db, row.org_id),
      logo: row.logo_r2_key && row.logo_media_type ? { key: row.logo_r2_key, mediaType: row.logo_media_type } : null,
    });
  }
  return out;
}

export type ClaimMatch = { orgId: string; name: string; matchedBy: "name" | "domain" };

// Which effectively protected identities a sender's claimed name or domain belongs to: every one that matches (two
// businesses can share a trading name), and only which organisation and which name, never a contact, logo or bank
// field. The domain matches in registrable form against the organisation's verified domains, so a subdomain counts.
export async function findIdentityByClaim(
  db: D1Database,
  claim: { displayName?: string | null; domain?: string | null },
): Promise<ClaimMatch[]> {
  const out = new Map<string, ClaimMatch>();
  const wanted = claim.displayName ? normaliseName(claim.displayName) : "";
  const domain = claim.domain ? registrable(claim.domain) : null;
  if (domain) {
    const rows = await db
      .prepare(
        `SELECT i.* FROM identities i JOIN org_domains d ON d.org_id = i.org_id
         WHERE d.domain = ? AND d.state = 'verified' AND ${claimable("d.domain")} AND i.protected = 1`,
      )
      .bind(domain)
      .all<Row>();
    for (const row of rows.results)
      if ((await effectiveOf(db, row)).on)
        out.set(row.org_id, { orgId: row.org_id, name: domain, matchedBy: "domain" });
  }
  if (wanted) {
    const rows = await db.prepare("SELECT * FROM identities WHERE protected = 1").all<Row>();
    for (const row of rows.results) {
      if (out.has(row.org_id)) continue;
      const names = JSON.parse(row.display_names_json) as string[];
      const name = names.find((n) => normaliseName(n) === wanted);
      if (name && (await effectiveOf(db, row)).on) out.set(row.org_id, { orgId: row.org_id, name, matchedBy: "name" });
    }
  }
  return [...out.values()];
}
