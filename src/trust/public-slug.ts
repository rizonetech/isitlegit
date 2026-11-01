// The verify page's public address (D05 T02 §6): assigned from the registered name when protection is first switched
// on (`setIdentity`), backfilled for identities protected before it existed (the quarter-hour tick), changed once by
// the owner, and looked up by the page. Every write is one conditional statement, so concurrent saves cannot assign
// two slugs or spend the one change twice, and a taken slug moves to the next number.

import { IdentityRefused } from "./errors";
import { eventStatement } from "./identity";
import { publicSlugOf, SLUG, withSuffix } from "./slug";

// Numbers tried before giving up on one assignment: far past any real collision, and the backfill tries again later.
const MAX_TRIES = 10_000;
// A slug in use (the unique index) or given up (the retirement trigger, migration 0062): either way, not this one.
const taken = (error: unknown) =>
  /UNIQUE constraint failed: identities\.public_slug|public address retired/.test(String(error));
const retired = async (db: D1Database, slug: string) =>
  (await db.prepare("SELECT 1 AS r FROM retired_public_slugs WHERE slug = ?").bind(slug).first()) !== null;

// Gives the identity its slug when it has none; returns the slug it has afterwards (null without an identity).
export async function assignPublicSlug(db: D1Database, orgId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT i.public_slug, o.name FROM identities i JOIN "organization" o ON o.id = i.org_id WHERE i.org_id = ?`,
    )
    .bind(orgId)
    .first<{ public_slug: string | null; name: string }>();
  if (!row) return null;
  if (row.public_slug) return row.public_slug;
  const base = publicSlugOf(row.name, orgId);
  for (let n = 1; n <= MAX_TRIES; n++) {
    const slug = withSuffix(base, n);
    if (await retired(db, slug)) continue;
    try {
      const result = await db
        .prepare("UPDATE identities SET public_slug = ? WHERE org_id = ? AND public_slug IS NULL")
        .bind(slug, orgId)
        .run();
      if ((result.meta.changes ?? 0) === 1) return slug;
      // Assigned meanwhile by another save: that slug stands.
      return (
        (
          await db
            .prepare("SELECT public_slug FROM identities WHERE org_id = ?")
            .bind(orgId)
            .first<{ public_slug: string | null }>()
        )?.public_slug ?? null
      );
    } catch (error) {
      if (!taken(error)) throw error;
    }
  }
  throw new Error("no free public address within 10,000 numbers");
}

// The identities protected before slugs existed (or whose assignment failed after their save): every one, a batch at
// a time, until none is left or the tick's time is spent; one that fails is logged and the rest go on, so a single
// stubborn name never holds the others back (completion review).
export async function backfillPublicSlugs(db: D1Database, budgetMs = 20_000, batch = 100): Promise<number> {
  const started = Date.now();
  const failed = new Set<string>();
  let assigned = 0;
  for (;;) {
    const rows = (
      await db
        .prepare("SELECT org_id FROM identities WHERE protected = 1 AND public_slug IS NULL ORDER BY org_id LIMIT ?")
        .bind(batch + failed.size)
        .all<{ org_id: string }>()
    ).results.filter((r) => !failed.has(r.org_id));
    if (rows.length === 0) return assigned;
    for (const r of rows) {
      try {
        if (await assignPublicSlug(db, r.org_id)) assigned++;
        else failed.add(r.org_id);
      } catch (error) {
        failed.add(r.org_id);
        console.log(
          JSON.stringify({ event: "public-slug", outcome: "backfill-skipped", error: (error as Error).name }),
        );
      }
      if (Date.now() - started > budgetMs) return assigned;
    }
  }
}

export type PublicSlug = { slug: string | null; changed: boolean };
export async function publicSlug(db: D1Database, orgId: string): Promise<PublicSlug> {
  const row = await db
    .prepare("SELECT public_slug, public_slug_changed FROM identities WHERE org_id = ?")
    .bind(orgId)
    .first<{ public_slug: string | null; public_slug_changed: number }>();
  return { slug: row?.public_slug ?? null, changed: row?.public_slug_changed === 1 };
}

export const SLUG_REFUSALS = {
  malformed:
    "a public address is 3 to 60 lower-case letters, digits and hyphens, starting and ending with a letter or digit",
  taken: "that public address is taken",
  spent: "the public address has already been changed once",
  none: "the identity has no public address yet",
} as const;

// The owner's one change, with its event, in one batch: it applies only while the change is unspent, so two
// submissions change it once, and a refused change (taken, malformed) keeps the allowance.
export async function changePublicSlug(db: D1Database, orgId: string, actor: string, slug: string, now = new Date()) {
  const wanted = slug.trim().toLowerCase();
  if (!SLUG.test(wanted)) throw new IdentityRefused(SLUG_REFUSALS.malformed);
  const current = await publicSlug(db, orgId);
  if (!current.slug) throw new IdentityRefused(SLUG_REFUSALS.none);
  if (current.changed) throw new IdentityRefused(SLUG_REFUSALS.spent);
  if (wanted === current.slug) return "unchanged" as const;
  if (await retired(db, wanted)) throw new IdentityRefused(SLUG_REFUSALS.taken);
  const at = now.toISOString();
  let result: D1Result | undefined;
  try {
    [result] = await db.batch([
      db
        .prepare(
          "UPDATE identities SET public_slug = ?, public_slug_changed = 1 WHERE org_id = ? AND public_slug_changed = 0 AND public_slug IS NOT NULL",
        )
        .bind(wanted, orgId),
      // The old address is kept from any other business for good, written only when this batch's own update applied
      // (`changes()` of the statement before), so a second submission racing the first is refused as spent, never a
      // duplicate retirement (round 3); the event follows the retirement the same way.
      db
        .prepare("INSERT INTO retired_public_slugs (slug, org_id, retired_at) SELECT ?, ?, ? WHERE changes() = 1")
        .bind(current.slug, orgId, at),
      eventStatement(db, orgId, actor, "identity.set", { fields: ["publicSlug"] }, at, true),
    ]);
  } catch (error) {
    if (taken(error)) throw new IdentityRefused(SLUG_REFUSALS.taken);
    throw error;
  }
  if ((result?.meta.changes ?? 0) !== 1) throw new IdentityRefused(SLUG_REFUSALS.spent);
  return "changed" as const;
}

// The organisation whose identity holds this public address, or null.
export async function orgBySlug(db: D1Database, slug: string): Promise<string | null> {
  const wanted = slug.toLowerCase();
  if (!SLUG.test(wanted)) return null;
  return (
    (await db.prepare("SELECT org_id FROM identities WHERE public_slug = ?").bind(wanted).first<{ org_id: string }>())
      ?.org_id ?? null
  );
}
