// Better Auth on D1 (D07 T02 §1; stack doc): users, sessions and email magic links. One instance per request, built
// from the Worker's bindings: the `DB` binding (Better Auth's Kysely adapter talks to D1 itself, using batch() for want
// of interactive transactions), BETTER_AUTH_SECRET, and APP_URL as the base URL its cookies and origin check rely on.
//
// A magic link goes out through `sendMail` (src/mail/smtp2go.ts) under the send key `signin:<SHA-256 of its token>`:
// stable for the link it carries, new for every link requested, and no secret. Only a send SMTP2GO confirmed is a
// delivered link; anything else answers the request with an error, never "check your email". The link returns to the
// `callbackURL` it was asked with, accepted only as a same-site path, else to /cases. A link that fails (used, expired,
// unknown) goes to the public sign-in page instead, carrying the destination as `next` and Better Auth's `error` code,
// so the member can ask for a new one (`/signin` renders that state, §7). The return paths are ours, never the client's.
//
// Signing out ends the session in D1 before Better Auth clears the cookie, and refuses (503, cookie kept) when that delete
// fails: Better Auth's own sign-out logs a failed delete and reports success, which would leave a copied cookie
// signed in after the member was told they were out. The hook covers every way in: /api/auth/sign-out and the app's form.
//
// Passkey responses are vetted by @simplewebauthn's own verifier before the plugin consumes the challenge, with user
// verification required and a credential ID already registered refused (src/auth/passkey.ts).
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { ConfigError } from "../config";
import { type MailDeps, sendMail } from "../mail/smtp2go";
import { authenticationOptions, vetAuthentication, vetRegistration } from "./passkey";
import { MAGIC_LINK_SECONDS, relyingParty, schemaOptions } from "./schema";

export { MAGIC_LINK_SECONDS };
export const SIGNIN_FROM = "IsItLegit <signin@isitlegit.co.za>";
// Where a redeemed link goes when it was asked for nowhere in particular.
export const DEFAULT_RETURN = "/cases";
// Where a link that fails goes: sign-in, with the destination kept as `next` (Better Auth appends `error`).
export const recoveryPath = (destination: string) => `/signin?next=${encodeURIComponent(destination)}`;
const RETURN_PARAMS = ["callbackURL", "errorCallbackURL", "newUserCallbackURL"] as const;
const notSameSite = () =>
  new APIError("BAD_REQUEST", { message: "the return destination must be a path on this site" });

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  APP_URL: string;
  SMTP2GO_API_KEY?: string;
  OPERATOR_EMAIL?: string;
};

// A path on this site, with its query: one leading slash, not two, and no scheme, host or backslash.
export function sameSitePath(value: unknown): value is string {
  return typeof value === "string" && /^\/(?!\/)/.test(value) && !/[\\\s]/.test(value) && !value.includes("://");
}

const encoder = new TextEncoder();
const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// The Worker's options: the table-shaping ones from ./schema, which scripts/auth-schema.ts compiles the migration from.
export function authOptions(database: BetterAuthOptions["database"], env: Omit<AuthEnv, "DB">, mail: () => MailDeps) {
  return {
    database,
    ...schemaOptions(
      {
        sendMagicLink: async ({ email, url, token }) => {
          const outcome = await sendMail(mail(), {
            sendKey: `signin:${await sha256Hex(token)}`,
            kind: "signin",
            to: email,
            from: SIGNIN_FROM,
            subject: "Your IsItLegit sign-in link",
            text: `Sign in to IsItLegit with this link. It works once, for ${MAGIC_LINK_SECONDS / 60} minutes:\n\n${url}\n\nIf you did not ask for it, ignore this mail.`,
          });
          const delivered =
            outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent");
          if (!delivered)
            throw new APIError("BAD_GATEWAY", {
              message: "the sign-in link could not be sent; try again in a few minutes",
            });
        },
        // Better Auth swallows a failure here (it logs and reports the invite made), so its outcome is read back in the
        // after hook on /organization/invite-member, which answers 502 unless the send was confirmed.
        sendInvitationEmail: async ({ id, email, organization, inviter, invitation }) => {
          const who = inviter.user.name || inviter.user.email;
          await sendMail(mail(), {
            sendKey: inviteSendKey(invitation),
            kind: "signin",
            to: email,
            from: SIGNIN_FROM,
            subject: `You are invited to ${organization.name} on IsItLegit`,
            text: `${who} invited you to join ${organization.name} on IsItLegit. The invitation is open for 48 hours:\n\n${new URL(`/invite/${id}`, env.APP_URL)}\n\nIf you did not expect it, ignore this mail.`,
          });
        },
      },
      env.APP_URL,
    ),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    trustedOrigins: [new URL(env.APP_URL).origin],
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax" as const },
    },
    hooks: {
      // The return paths, on the link request and on the link itself. The request takes only `callbackURL` (a same-site
      // path, else /cases); the failure and new-user paths are set here from it, whatever the client sent. On the link,
      // all three must still be same-site paths, so an edited link cannot send the member off the site, and the failure and
      // new-user paths are set again from `callbackURL`, so removing or changing them changes nothing.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/magic-link") {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (body.callbackURL !== undefined && !sameSitePath(body.callbackURL)) throw notSameSite();
          const callbackURL = (body.callbackURL as string | undefined) ?? DEFAULT_RETURN;
          const paths = { callbackURL, newUserCallbackURL: callbackURL, errorCallbackURL: recoveryPath(callbackURL) };
          return { context: { body: { ...body, ...paths } } };
        }
        // Passkey responses vetted by @simplewebauthn before the plugin consumes the challenge (src/auth/passkey.ts).
        if (ctx.path === "/passkey/verify-registration") return vetRegistration(ctx, relyingParty(env.APP_URL));
        if (ctx.path === "/passkey/verify-authentication") return vetAuthentication(ctx, relyingParty(env.APP_URL));
        if (ctx.path === "/organization/set-active") {
          // Better Auth clears the active organisation before refusing a switch to one the user does not belong to,
          // leaving them in none; the switch is refused here first, the session as it was.
          const body = (ctx.body ?? {}) as { organizationId?: unknown; organizationSlug?: unknown };
          const signedIn = await getSessionFromCtx(ctx);
          if (!signedIn || (body.organizationId == null && body.organizationSlug == null)) return;
          const organization =
            typeof body.organizationId === "string"
              ? { id: body.organizationId }
              : typeof body.organizationSlug === "string"
                ? await ctx.context.adapter.findOne<{ id: string }>({
                    model: "organization",
                    where: [{ field: "slug", value: body.organizationSlug }],
                  })
                : null;
          const member =
            organization &&
            (await ctx.context.adapter.findOne({
              model: "member",
              where: [
                { field: "userId", value: signedIn.user.id },
                { field: "organizationId", value: organization.id },
              ],
            }));
          if (!member) throw new APIError("FORBIDDEN", { message: "you are not a member of this organisation" });
          return;
        }
        if (ctx.path === "/organization/invite-member") {
          // An invitation already spent (invitation_uses) but still pending, after an acceptance interrupted before
          // Better Auth wrote its status, would make Better Auth refuse a new invitation ("already invited") or resend
          // the spent one; it is cancelled first, so inviting again, with or without resend, makes a fresh one. This runs
          // before the plugin checks the caller, so it acts only for a signed-in owner or admin of that organisation,
          // and only moves an invitation still pending.
          const body = (ctx.body ?? {}) as { email?: unknown; organizationId?: unknown };
          const signedIn = await getSessionFromCtx(ctx);
          if (!signedIn || typeof body.email !== "string") return;
          const organizationId =
            typeof body.organizationId === "string"
              ? body.organizationId
              : (signedIn.session as { activeOrganizationId?: string | null }).activeOrganizationId;
          if (!organizationId) return;
          const inviter = await ctx.context.adapter.findOne<{ role: string }>({
            model: "member",
            where: [
              { field: "userId", value: signedIn.user.id },
              { field: "organizationId", value: organizationId },
            ],
          });
          if (!inviter || !["owner", "admin"].includes(inviter.role)) return;
          const pending = await ctx.context.adapter.findMany<{ id: string }>({
            model: "invitation",
            where: [
              { field: "organizationId", value: organizationId },
              { field: "email", value: body.email.toLowerCase() },
              { field: "status", value: "pending" },
            ],
          });
          for (const { id } of pending) {
            const spent = await mail()
              .db.prepare("SELECT 1 FROM invitation_uses WHERE invitation_id = ?")
              .bind(id)
              .first();
            if (spent)
              await ctx.context.adapter.update({
                model: "invitation",
                where: [
                  { field: "id", value: id },
                  { field: "status", value: "pending" },
                ],
                update: { status: "canceled" },
              });
          }
          return;
        }
        if (ctx.path === "/organization/accept-invitation") {
          // An invitation is used once: its use is recorded (migration 0012) before the plugin accepts it, only for
          // the signed-in recipient of an invitation the plugin would take (pending, not expired by its own test), so a
          // stranger's attempt spends nothing; the insert is the one check, so a second use, sequential or racing, is
          // refused whatever the invitation's status says, and one Better Auth refuses (accepted, cancelled) it refuses.
          // After an interrupted acceptance (Better Auth writes the status and the membership separately) an owner
          // sends a new invitation.
          const invitationId = (ctx.body as { invitationId?: unknown } | undefined)?.invitationId;
          const signedIn = await getSessionFromCtx(ctx);
          if (typeof invitationId !== "string" || !signedIn) return;
          const invitation = await ctx.context.adapter.findOne<{ status: string; email: string; expiresAt: Date }>({
            model: "invitation",
            where: [{ field: "id", value: invitationId }],
          });
          const usable =
            invitation?.status === "pending" &&
            invitation.email.toLowerCase() === signedIn.user.email.toLowerCase() &&
            !(new Date(invitation.expiresAt) < new Date());
          if (!usable) return;
          const recorded = await mail()
            .db.prepare(
              "INSERT INTO invitation_uses (invitation_id, user_id, used_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            )
            .bind(invitationId, signedIn.user.id, new Date().toISOString())
            .run();
          if (recorded.meta.changes !== 1)
            throw new APIError("CONFLICT", { message: "this invitation has already been used; ask for a new one" });
          return;
        }
        if (ctx.path === "/sign-out") {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
          if (!token) return;
          const ended = await ctx.context.internalAdapter.deleteSession(token).then(
            () => true,
            () => false,
          );
          if (!ended)
            throw new APIError("SERVICE_UNAVAILABLE", { message: "signing out did not finish; try again in a moment" });
          return;
        }
        if (ctx.path === "/magic-link/verify") {
          const query = (ctx.query ?? {}) as Record<string, unknown>;
          for (const name of RETURN_PARAMS)
            if (query[name] !== undefined && !sameSitePath(query[name])) throw notSameSite();
          // Set again here, so a link with its return parameters removed still lands on ours, not Better Auth's
          // defaults (session JSON, `/`, or a failure sent to the destination instead of sign-in).
          const callbackURL = (query.callbackURL as string | undefined) ?? DEFAULT_RETURN;
          const paths = { callbackURL, newUserCallbackURL: callbackURL, errorCallbackURL: recoveryPath(callbackURL) };
          return { context: { query: { ...query, ...paths } } };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/passkey/generate-authenticate-options") {
          const options = authenticationOptions(ctx.context.returned);
          if (options) return ctx.json(options);
          return;
        }
        if (ctx.path === "/organization/invite-member") {
          const invitation = ctx.context.returned as { id?: unknown; expiresAt?: unknown } | null;
          if (!invitation || typeof invitation.id !== "string" || isAPIError(invitation)) return;
          const sent = await mail()
            .db.prepare("SELECT status FROM mail_sends WHERE send_key = ?")
            .bind(inviteSendKey(invitation as Invitation))
            .first<{ status: string }>();
          // Confirmed, unknown (SMTP2GO may have taken it before its answer was lost), or not sent: each says so.
          if (sent?.status === "sent") return;
          throw new APIError("BAD_GATEWAY", {
            message:
              sent?.status === "uncertain" || sent?.status === "pending"
                ? "the invitation is saved, but whether its email went is not known; check with them before sending it again"
                : "the invitation is saved but its email could not be sent; send it again",
          });
        }
        if (ctx.path === "/organization/remove-member") {
          // A removed member's sessions in that organisation end with the membership; requireOrg refuses the rest, and
          // their old invitation is spent (invitation_uses), so it cannot bring them back.
          const removed = ctx.context.returned as { member?: { userId?: string; organizationId?: string } } | null;
          const member = removed?.member;
          if (!member?.userId || !member.organizationId || isAPIError(removed)) return;
          await ctx.context.adapter.deleteMany({
            model: "session",
            where: [
              { field: "userId", value: member.userId },
              { field: "activeOrganizationId", value: member.organizationId },
            ],
          });
        }
      }),
    },
    // A new session starts in the member's earliest organisation, or none for a user who belongs to none.
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const [first] = ctx
              ? await ctx.context.adapter.findMany<{ organizationId: string }>({
                  model: "member",
                  where: [{ field: "userId", value: session.userId }],
                  sortBy: { field: "createdAt", direction: "asc" },
                  limit: 1,
                })
              : [];
            return { data: { ...session, activeOrganizationId: first?.organizationId ?? null } };
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

// One send key per invitation email: a resend extends the invitation's expiry, so it is a new send, not a duplicate.
type Invitation = { id: string; expiresAt: Date | string };
const inviteSendKey = (invitation: Invitation) =>
  `invite:${invitation.id}:${new Date(invitation.expiresAt).toISOString()}`;

export function createAuth(env: AuthEnv, fetchImpl?: typeof fetch) {
  if (!env.BETTER_AUTH_SECRET) throw new ConfigError("BETTER_AUTH_SECRET is not set");
  return betterAuth(
    authOptions(env.DB, env, () => ({
      db: env.DB,
      apiKey: env.SMTP2GO_API_KEY,
      operator: env.OPERATOR_EMAIL,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })),
  );
}

export type Auth = ReturnType<typeof createAuth>;
