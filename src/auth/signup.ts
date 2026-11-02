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
import { NAME_LIMIT } from "./names";
import { validOrganisationName } from "./schema";
import { CODE_COOKIE, HANDLE_COOKIE, newHandle, readHandle } from "./signin-code";

const SignUp = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().max(200).optional(),
  organizationName: z
    .string()
    .trim()
    .refine(validOrganisationName, "an organisation name is one line of 1 to 120 characters"),
  consent: z.boolean(),
});

const encoder = new TextEncoder();
export const codeHash = async (code: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code.trim())))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

type Redemption = { id: string; status: string; user_id: string | null; org_id: string | null };

// The member's first link: true only when SMTP2GO confirmed it, false when it failed, is unknown, or was held back
// (the sign-in limit), which the magic-link endpoint does not tell apart from a send.
// The first link's sender, given the signup browser's code handle (D07 T02 §11).
export type SendFirstLink = (email: string, handle: string) => Promise<boolean>;

export function inviteSignup(database: () => D1Database, sendFirstLink: SendFirstLink) {
  return {
    id: "invite-signup",
    endpoints: {
      signUpInviteCode: createAuthEndpoint("/sign-up/invite-code", { method: "POST", body: SignUp }, async (ctx) => {
        const { email, code, organizationName, consent } = ctx.body;
        if (consent !== true) throw new APIError("BAD_REQUEST", { message: "consent is required" });
        const { adapter, internalAdapter } = ctx.context;
        const db = database();
        const now = new Date().toISOString();

        // 1. The redemption: this address's pending one (read first, so a signup stopped even after its membership
        // resumes), or, for an address that is not yet a member, a use of the code taken with a new pending one.
        let redemption = await db
          .prepare("SELECT id, status, user_id, org_id FROM invite_redemptions WHERE email = ? AND status = 'pending'")
          .bind(email)
          .first<Redemption>();
        if (!redemption) {
          const existing = await internalAdapter.findUserByEmail(email);
          const member =
            existing &&
            (await adapter.findOne({ model: "member", where: [{ field: "userId", value: existing.user.id }] }));
          if (member)
            throw new APIError("CONFLICT", { message: "this address already has an account; sign in instead" });
          const unusable = () => new APIError("BAD_REQUEST", { message: "that invite code is not valid" });
          if (!code) throw unusable();
          const id = crypto.randomUUID();
          const hash = await codeHash(code);
          // One redemption per address (migration 0014): a signup overlapping one already redeemed for this address
          // fails its insert, the batch (the use included) rolls back, and it reads that redemption again below.
          const batch = await db
            .batch([
              db
                .prepare(
                  "UPDATE invite_codes SET uses = uses + 1 WHERE code_hash = ? AND uses < max_uses AND expires_at > ? AND revoked_at IS NULL",
                )
                .bind(hash, now),
              db
                .prepare(
                  "INSERT INTO invite_redemptions (id, code_id, email, status, consented_at, created_at) SELECT ?, id, ?, 'pending', ?, ? FROM invite_codes WHERE code_hash = ? AND revoked_at IS NULL AND changes() = 1",
                )
                .bind(id, email, now, now, hash),
            ])
            .catch((error: unknown) => ({ failed: error }));
          if (Array.isArray(batch) && batch[0]?.meta.changes === 1) {
            redemption = { id, status: "pending", user_id: null, org_id: null };
          } else {
            // Not redeemed here: the insert lost to this address's redemption, or the code had no use left (perhaps
            // because an overlapping signup for this address just took it). Either way, this address's redemption
            // decides: resume a pending one, refer a completed one to sign-in, or refuse the code. A batch that failed
            // with no redemption to show for it was the database failing, not the code: that is a 503 to retry.
            const other = await db
              .prepare("SELECT id, status, user_id, org_id FROM invite_redemptions WHERE email = ?")
              .bind(email)
              .first<Redemption>();
            if (!other && !Array.isArray(batch))
              throw new APIError("SERVICE_UNAVAILABLE", {
                message: "signing up could not be completed just now; try again in a moment",
              });
            if (!other) throw unusable();
            if (other.status !== "pending")
              throw new APIError("CONFLICT", { message: "this address already has an account; sign in instead" });
            redemption = other;
          }
        }

        // 2. The user, the organisation and the owner membership, each found or made, keyed by the redemption. Two
        // requests resuming the same redemption at once can race to make each: the loser's insert fails a unique
        // constraint (the user's address, the organisation's slug, migration 0011's membership) and it finds the
        // winner's.
        // A create that loses a race finds the winner's row, or fails as it would have.
        const orFound = async <T>(create: () => Promise<T>, find: () => Promise<T | null | undefined>): Promise<T> =>
          (await find()) ??
          (await create().catch(async (error) => {
            const found = await find();
            if (!found) throw error;
            return found;
          }));
        const user = await orFound(
          () =>
            internalAdapter.createUser(
              // The address as the name until the member sets one, when it fits the name's bound (D07 T02 §22); a longer
              // address leaves the name blank, which every reader shows as the address.
              { email, name: email.length <= NAME_LIMIT ? email : "", emailVerified: false },
              { method: "admin" },
            ),
          async () => (await internalAdapter.findUserByEmail(email))?.user,
        );
        // The provisioning references are recorded as each resource is made, so an interrupted signup's user and
        // organisation stay findable by the abandoned-signup cleanup (D07 T02 §9).
        await db.prepare("UPDATE invite_redemptions SET user_id = ? WHERE id = ?").bind(user.id, redemption.id).run();
        const slug = `org-${redemption.id}`;
        // A pending signup resumed for an address that has since joined another organisation (an invitation accepted
        // meanwhile) is one that address no longer needs: it is told to sign in, not given a second organisation.
        const memberships = await adapter.findMany<{ organizationId: string }>({
          model: "member",
          where: [{ field: "userId", value: user.id }],
        });
        if (memberships.length > 0) {
          const own = await adapter.findOne<{ id: string }>({
            model: "organization",
            where: [{ field: "slug", value: slug }],
          });
          if (memberships.some((m) => m.organizationId !== own?.id))
            throw new APIError("CONFLICT", { message: "this address already has an account; sign in instead" });
        }
        const organization = await orFound(
          () =>
            adapter.create<{ name: string; slug: string; createdAt: Date }, { id: string }>({
              model: "organization",
              data: { name: organizationName, slug, createdAt: new Date() },
            }),
          () => adapter.findOne<{ id: string }>({ model: "organization", where: [{ field: "slug", value: slug }] }),
        );
        await db
          .prepare("UPDATE invite_redemptions SET org_id = ? WHERE id = ?")
          .bind(organization.id, redemption.id)
          .run();
        const ownership = [
          { field: "userId", value: user.id },
          { field: "organizationId", value: organization.id },
        ];
        if (!(await adapter.findOne({ model: "member", where: ownership })))
          await adapter
            .create({
              model: "member",
              data: { userId: user.id, organizationId: organization.id, role: "owner", createdAt: new Date() },
            })
            .catch(async (error) => {
              if (!(await adapter.findOne({ model: "member", where: ownership }))) throw error;
            });
        await db
          .prepare(
            "UPDATE invite_redemptions SET status = 'complete', user_id = ?, org_id = ?, consented_at = ? WHERE id = ?",
          )
          .bind(user.id, organization.id, now, redemption.id)
          .run();

        // 3. The first link, now that the membership admits the address (D01 T02 §2).
        // Its code is bound to this browser: the handle it holds, or a new one, set on this answer either way.
        const handle = readHandle(ctx.headers ?? ctx.request?.headers ?? new Headers()) ?? newHandle();
        const linkSent = await sendFirstLink(email, handle).catch(() => false);
        ctx.setCookie(CODE_COOKIE, handle, HANDLE_COOKIE);
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
