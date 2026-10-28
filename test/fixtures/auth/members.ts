// A member of an organisation, as the recipient allowlist (src/mail/allowlist.ts) reads one from Better Auth's tables:
// a user with a membership. For tests of what is sent rather than who may receive it (D01 T02 §2).
export async function addMember(db: D1Database, email: string) {
  const now = new Date().toISOString();
  const userId = `user-${email}`;
  const orgId = `org-${email}`;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .bind(userId, email, email.toLowerCase(), now, now),
    db
      .prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, `Fixture ${email}`, orgId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`,
      )
      .bind(`member-${email}`, orgId, userId, now),
  ]);
}
