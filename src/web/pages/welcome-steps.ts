// What the checklist reads, shared by the page (./welcome.tsx) and the Cases link (./cases.tsx): the five steps from the
// organisation's stored state, each a lookup on its own rows, and the browser's hidden-list preference.
import type { Steps } from "./welcome-view";

export const COOKIE = "welcome_hidden";
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_HIDDEN = 20;

// The organisations whose list this browser hid: only well-formed ids, at most MAX_HIDDEN.
export const hiddenIn = (cookie: string | undefined): string[] =>
  (cookie ?? "")
    .split(",")
    .filter((id) => ORG_ID.test(id))
    .slice(0, MAX_HIDDEN);

// The five steps for an organisation, in one bounded read: each is a lookup on the organisation's own rows.
export async function stepsOf(db: D1Database, orgId: string): Promise<Steps> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT domain FROM org_domains WHERE org_id = ?1 AND state = 'verified' ORDER BY verified_at, id LIMIT 1) AS domain,
         (SELECT COUNT(*) FROM "member" WHERE "organizationId" = ?1) AS members,
         EXISTS (SELECT 1 FROM cases WHERE org_id = ?1 AND channel = 'email') AS emailed,
         (SELECT COUNT(*) FROM suppliers WHERE org_id = ?1) AS suppliers,
         COALESCE((SELECT protected FROM identities WHERE org_id = ?1), 0) AS protectedIdentity`,
    )
    .bind(orgId)
    .first<{ domain: string | null; members: number; emailed: number; suppliers: number; protectedIdentity: number }>();
  if (!row) throw new Error("the steps could not be read");
  return {
    domain: row.domain,
    members: row.members,
    emailed: row.emailed === 1,
    suppliers: row.suppliers,
    protectedIdentity: row.protectedIdentity === 1,
  };
}
