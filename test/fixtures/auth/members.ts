// A member of an organisation, as the recipient allowlist (src/mail/allowlist.ts) reads one from Better Auth's tables:
// a user with a membership, its address not yet verified (a first signup's state: membership alone admits it). For tests
// of what is sent rather than who may receive it (D01 T02 §2); test/auth/org.test.ts makes members through Better Auth.
export async function addMember(db: D1Database, email: string) {
  const now = new Date().toISOString();
  const userId = `user-${email}`;
  const orgId = `org-${email}`;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, ?, ?)`,
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

// An invite code as scripts/invite-code.ts stores one: only its SHA-256 (D07 T02 §4).
export async function addInviteCode(
  db: D1Database,
  code: string,
  {
    maxUses = 1,
    uses = 0,
    expiresAt = new Date(Date.now() + 86_400_000),
  }: { maxUses?: number; uses?: number; expiresAt?: Date } = {},
) {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?)",
    )
    .bind(id, hash, maxUses, uses, expiresAt.toISOString(), new Date().toISOString())
    .run();
  return id;
}
