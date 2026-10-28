// Invite-code signup during the event (D07 T02 §4; design spec section 11), a Better Auth plugin so the user is created
// inside an endpoint, where `user.validateUserInfo` (src/auth/auth.ts) sees it with the source `admin`.
//
// POST /api/auth/sign-up/invite-code { email, code, organizationName, consent }. It is resumable, not compensated: the
// first write is one D1 batch that takes a use of the code and records a pending redemption for the address, both or
// neither; every later step finds or creates its object keyed by that redemption (the user by address, the
// organisation by a slug from the redemption id, the owner membership), and the redemption is marked complete last. A
// signup stopped anywhere resumes on retry with no second use and no second organisation. Then the member's first
// magic link is sent; the answer says whether it went, and the registration stands either way.
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";

const SignUp = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().max(200).optional(),
  organizationName: z.string().trim().min(1).max(120),
  consent: z.boolean(),
});

const encoder = new TextEncoder();
export const codeHash = async (code: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code.trim())))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

type Redemption = { id: string; status: string; user_id: string | null; org_id: string | null };

// The member's first link: true when SMTP2GO confirmed it, false when it failed or is unknown.
export type SendFirstLink = (email: string) => Promise<boolean>;

export function inviteSignup(database: () => D1Database, sendFirstLink: SendFirstLink) {
  return {
    id: "invite-signup",
    endpoints: {
      signUpInviteCode: createAuthEndpoint("/sign-up/invite-code", { method: "POST", body: SignUp }, async (ctx) => {
        const { email, code, organizationName, consent } = ctx.body;
        if (consent !== true) throw new APIError("BAD_REQUEST", { message: "consent is required" });
        const { adapter, internalAdapter } = ctx.context;
        const db = database();
        const existing = await internalAdapter.findUserByEmail(email);
        if (existing) {
          const member = await adapter.findOne({
            model: "member",
            where: [{ field: "userId", value: existing.user.id }],
          });
          if (member)
            throw new APIError("CONFLICT", { message: "this address already has an account; sign in instead" });
        }
        const now = new Date().toISOString();

        // 1. The redemption: this address's pending one, or a use of the code taken with a new pending one.
        let redemption = await db
          .prepare("SELECT id, status, user_id, org_id FROM invite_redemptions WHERE email = ? AND status = 'pending'")
          .bind(email)
          .first<Redemption>();
        if (!redemption) {
          const unusable = () => new APIError("BAD_REQUEST", { message: "that invite code is not valid" });
          if (!code) throw unusable();
          const id = crypto.randomUUID();
          const hash = await codeHash(code);
          const [taken] = await db.batch([
            db
              .prepare(
                "UPDATE invite_codes SET uses = uses + 1 WHERE code_hash = ? AND uses < max_uses AND expires_at > ?",
              )
              .bind(hash, now),
            db
              .prepare(
                "INSERT INTO invite_redemptions (id, code_id, email, status, consented_at, created_at) SELECT ?, id, ?, 'pending', ?, ? FROM invite_codes WHERE code_hash = ? AND changes() = 1",
              )
              .bind(id, email, now, now, hash),
          ]);
          if (taken?.meta.changes !== 1) throw unusable();
          redemption = { id, status: "pending", user_id: null, org_id: null };
        }

        // 2. The user, the organisation and the owner membership, each found or made, keyed by the redemption.
        const user =
          (await internalAdapter.findUserByEmail(email))?.user ??
          (await internalAdapter.createUser({ email, name: email, emailVerified: false }, { method: "admin" }));
        const slug = `org-${redemption.id}`;
        const organization =
          (await adapter.findOne<{ id: string }>({ model: "organization", where: [{ field: "slug", value: slug }] })) ??
          (await adapter.create<{ name: string; slug: string; createdAt: Date }, { id: string }>({
            model: "organization",
            data: { name: organizationName, slug, createdAt: new Date() },
          }));
        const membership = await adapter.findOne({
          model: "member",
          where: [
            { field: "userId", value: user.id },
            { field: "organizationId", value: organization.id },
          ],
        });
        if (!membership)
          await adapter.create({
            model: "member",
            data: { userId: user.id, organizationId: organization.id, role: "owner", createdAt: new Date() },
          });
        await db
          .prepare(
            "UPDATE invite_redemptions SET status = 'complete', user_id = ?, org_id = ?, consented_at = ? WHERE id = ?",
          )
          .bind(user.id, organization.id, now, redemption.id)
          .run();

        // 3. The first link, now that the membership admits the address (D01 T02 §2).
        const linkSent = await sendFirstLink(email).catch(() => false);
        ctx.setStatus(201);
        return ctx.json({
          registered: true,
          linkSent,
          message: linkSent
            ? "check your inbox for your sign-in link"
            : "your account is ready, but the sign-in link could not be confirmed; ask for a new one",
        });
      }),
    },
  } satisfies BetterAuthPlugin;
}
