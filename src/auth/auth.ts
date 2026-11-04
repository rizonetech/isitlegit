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
import { seedJudgePack } from "../demo/judges";
import { isAllowedRecipient } from "../mail/allowlist";
import { type MailDeps, type SendOutcome, sendMail } from "../mail/smtp2go";
import { inviteEmail, signinEmail } from "../mail/templates/auth-mail";
import { type AuthEvent, clientIp, recordAuthEvent } from "./audit";
import { mailedLink, returnPath } from "./confirm-page";
import { boundedName, defaultPasskeyName } from "./names";
import { authenticationOptions, vetAuthentication, vetRegistration } from "./passkey";
import { DEFAULT_RETURN, sameSitePath } from "./paths";
import { isProtectedAccount, PROTECTED_ACCOUNT } from "./protected";
import { d1RateLimit, RATE_RULES } from "./ratelimit";
import { MAGIC_LINK_SECONDS, relyingParty, schemaOptions } from "./schema";
import { CODE_COOKIE, drawCode, HANDLE_COOKIE, newHandle, readHandle, spaced } from "./signin-code";
import { decoy, issueSignInCode, withdraw } from "./signin-code-store";
import { inviteSignup, type SendFirstLink } from "./signup";

export { DEFAULT_RETURN, MAGIC_LINK_SECONDS, sameSitePath };
export const SIGNIN_FROM = "IsItLegit <signin@isitlegit.co.za>";
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
  ARTEFACTS?: R2Bucket;
  ANALYSIS?: Env["ANALYSIS"];
  FIXTURES_PREFIX?: string;
};

const encoder = new TextEncoder();
const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// The Worker's options: the table-shaping ones from ./schema, which scripts/auth-schema.ts compiles the migration from.
export function authOptions(
  database: BetterAuthOptions["database"],
  env: Omit<AuthEnv, "DB">,
  mail: () => MailDeps,
  sendFirstLink: SendFirstLink = async () => false,
  // Told the outcome of each magic-link send, so the signup knows whether its own first link went (createAuth).
  onMagicLinkOutcome: (email: string, outcome: SendOutcome) => void = () => {},
) {
  // The audit trail (D07 T02 §6, ./audit): a row that cannot be written is logged, never a failed sign-in.
  const audit = (event: AuthEvent) => recordAuthEvent(mail().db, env.BETTER_AUTH_SECRET ?? "", event);
  const releaseMember = (request: Request | undefined) => releaseHeld(mail().db, request);
  const schema = schemaOptions(
    {
      // A removal refused at Better Auth's deletion boundary (the race past the before hook): audited without an actor.
      refusedRemoval: ({ orgId, targetId }) =>
        audit({ kind: "remove-member", outcome: "refused-protected", orgId, targetId, detail: { at: "deletion" } }),
      sendMagicLink: async ({ email, url, token }, ctx) => {
        // The moment the link was asked for: the expiry the mail states counts from it.
        const requestedAt = new Date();
        // The code beside the link signs in only the browser that asked (D07 T02 §11, ./signin-code): the handle it
        // already holds, or a new one, set on this answer.
        const held = readHandle(ctx?.headers ?? ctx?.request?.headers ?? new Headers());
        const handle = held ?? newHandle();
        const keepHandle = () => ctx?.setCookie(CODE_COOKIE, handle, HANDLE_COOKIE);
        const code = drawCode();
        const db = mail().db;
        const secret = env.BETTER_AUTH_SECRET ?? "";
        const unrecorded = (step: string) => (error: unknown) =>
          console.log(JSON.stringify({ event: "signin-code", outcome: step, error: (error as Error).name }));
        // The code's row is written before the mail goes, so a code in a member's inbox always has one behind it; one
        // that cannot be written sends nothing and answers as a failed send.
        let row: string;
        try {
          row = await issueSignInCode(
            db,
            secret,
            { email, token, callbackURL: returnPath(new URL(url).searchParams.get("callbackURL")), handle },
            code,
          );
        } catch (error) {
          unrecorded("unissued")(error);
          throw new APIError("BAD_GATEWAY", {
            message: "the sign-in link could not be sent; try again in a few minutes",
          });
        }
        const outcome = await sendMail(mail(), {
          sendKey: `signin:${await sha256Hex(token)}`,
          kind: "signin",
          to: email,
          from: SIGNIN_FROM,
          subject: "Your IsItLegit sign-in link",
          // The confirm page, not Better Auth's verify URL, which signs in on GET (D07 T02 §10).
          ...signinEmail({
            appUrl: env.APP_URL,
            email,
            link: mailedLink(env.APP_URL, url, token),
            code: spaced(code),
            lifetimeSeconds: MAGIC_LINK_SECONDS,
            requestedAt,
          }),
        });
        onMagicLinkOutcome(email, outcome);
        // The per-address limit held the link back (sendMail's, D01 T02 §2): answered as sent, recorded here.
        if (outcome.status === "refused" && /too many sign-in links/.test(outcome.reason))
          await audit({ kind: "rate-limited", outcome: "per-address", ip: clientIp(ctx?.request?.headers) });
        // Refused (not on the allowlist, or too many links to this address) answers exactly as sent, so the answer
        // never tells a stranger who is registered; a failed or unknown send is still an error. A refused request keeps
        // its row with a decoy token and gets the browser's handle like a sent one (./signin-code-store), so nothing the
        // browser can see afterwards tells the two apart.
        if (outcome.status === "refused") {
          await decoy(db, secret, row).catch(unrecorded("undecoyed"));
          keepHandle();
          return;
        }
        const delivered = outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent");
        if (!delivered) {
          await withdraw(db, row).catch(unrecorded("unwithdrawn"));
          throw new APIError("BAD_GATEWAY", {
            message: "the sign-in link could not be sent; try again in a few minutes",
          });
        }
        keepHandle();
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
          ...inviteEmail({
            appUrl: env.APP_URL,
            inviter: who,
            organisation: organization.name,
            role:
              String(invitation.role ?? "member")
                .split(",")[0]
                ?.trim() || "member",
            link: new URL(`/invite/${id}`, env.APP_URL).toString(),
            expiresAt: new Date(invitation.expiresAt),
            // What is left of it now, to the minute: a resent invitation keeps its first `createdAt`, so its age is no measure.
            lifetimeSeconds: Math.max(
              60,
              Math.round((new Date(invitation.expiresAt).getTime() - Date.now()) / 60_000) * 60,
            ),
          }),
        });
      },
    },
    env.APP_URL,
  );
  return {
    database,
    ...schema,
    // Invite-code signup (D07 T02 §4, src/auth/signup.ts) beside the table-shaping plugins; it adds no table of Better
    // Auth's own (its tables are migration 0013).
    plugins: [
      ...schema.plugins,
      inviteSignup(
        () => mail().db,
        sendFirstLink,
        env.ARTEFACTS && env.ANALYSIS
          ? (orgId, userId) =>
              seedJudgePack(
                {
                  DB: mail().db,
                  ARTEFACTS: env.ARTEFACTS as R2Bucket,
                  ANALYSIS: env.ANALYSIS as Env["ANALYSIS"],
                  ...(env.FIXTURES_PREFIX ? { FIXTURES_PREFIX: env.FIXTURES_PREFIX } : {}),
                },
                orgId,
                userId,
              ).then(() => {})
          : undefined,
      ),
    ],
    // Every user creation passes here with its source: the signup endpoint (`admin`) has redeemed a code; a magic link
    // makes an account only for a pending invitee, a demo alias or the operator (the addresses the recipient
    // allowlist admits for sign-in mail, D01 T02 §2, less members, who already have one). Nothing else makes one.
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (source.method === "admin") return;
        const email = typeof user.email === "string" ? user.email : "";
        if (
          source.method === "magic-link" &&
          (await isAllowedRecipient(mail().db, email, "signin", env.OPERATOR_EMAIL))
        )
          return;
        throw new APIError("FORBIDDEN", {
          message: "accounts are made by invitation or with an invite code during the event",
        });
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    // Better Auth's per-IP limiter, counted in D1 so every Worker instance shares the count (D07 T02 §6, ./ratelimit).
    rateLimit: {
      enabled: true,
      customRules: RATE_RULES,
      customStorage: d1RateLimit(() => mail().db, env.BETTER_AUTH_SECRET ?? "", audit),
    },
    basePath: "/api/auth",
    trustedOrigins: [new URL(env.APP_URL).origin],
    advanced: {
      // Cloudflare sets the client's address in CF-Connecting-IP and a client cannot; X-Forwarded-For (Better Auth's
      // default) a client can write, so the limiter and the stored sessions read the one Cloudflare set (D07 T02 §10).
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
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
        // The protected live accounts are never removed from an organisation, by an owner or by leaving (D07 T02 §21,
        // AGENTS.md): the target is read from the stored member and user rows, by member id or email, in the named
        // organisation or else the session's active one, so no spelling of the request reaches them. Nothing changes,
        // and the refusal is in the audit trail.
        if (ctx.path === "/organization/remove-member" || ctx.path === "/organization/leave") {
          const body = (ctx.body ?? {}) as { memberIdOrEmail?: unknown; organizationId?: unknown };
          const caller = await getSessionFromCtx(ctx);
          // The organisation as Better Auth resolves it: a non-empty id named, else the session's active one (an empty
          // id falls back too, so it must here; completion review).
          const orgId =
            (typeof body.organizationId === "string" && body.organizationId) ||
            (caller?.session.activeOrganizationId ?? null);
          const leaving = ctx.path === "/organization/leave";
          // A protected caller never leaves, whatever a membership lookup finds now: an invitation accepted at the same
          // moment could add the membership after this check and before Better Auth's own, and leave has no deletion
          // hook to refuse it later (round 2). The caller is the account itself, so this discloses nothing.
          if (leaving && caller && isProtectedAccount(caller.user.email)) {
            await audit({
              kind: "leave-organization",
              outcome: "refused-protected",
              orgId,
              actorId: caller.user.id,
              targetId: caller.user.id,
              ip: clientIp(ctx.request?.headers),
            });
            throw new APIError("FORBIDDEN", {
              code: PROTECTED_ACCOUNT,
              message: "this account is kept for testing and cannot be removed from an organisation",
            });
          }
          // Only a caller who could act there learns that an account is protected: an owner or admin to remove, a
          // member to leave. Anyone else reaches Better Auth's own refusal, which says nothing of who belongs.
          const role =
            caller && orgId
              ? (
                  await mail()
                    .db.prepare(`SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
                    .bind(orgId, caller.user.id)
                    .first<{ role: string }>()
                )?.role
              : undefined;
          const authorised =
            role !== undefined &&
            (leaving || role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin"));
          if (caller && orgId && authorised) {
            const key = leaving ? caller.user.id : typeof body.memberIdOrEmail === "string" ? body.memberIdOrEmail : "";
            const target = await mail()
              .db.prepare(
                `SELECT u.id AS userId, u.email AS email, m.role AS role FROM "member" m JOIN "user" u ON u.id = m."userId"
                 WHERE m."organizationId" = ? AND (m.id = ? OR u.id = ? OR lower(u.email) = lower(?)) LIMIT 1`,
              )
              .bind(orgId, key, key, key)
              .first<{ userId: string; email: string; role: string }>();
            // An admin may not remove an owner (Better Auth's own rule, which refuses after this): such a caller could not
            // act on that member, so is not told the account is protected.
            const roles = (list: string) => list.split(",").map((r) => r.trim());
            const adminOnOwner =
              !leaving && !roles(role ?? "").includes("owner") && roles(target?.role ?? "").includes("owner");
            if (target && isProtectedAccount(target.email) && !adminOnOwner) {
              await audit({
                kind: leaving ? "leave-organization" : "remove-member",
                outcome: "refused-protected",
                orgId,
                actorId: caller.user.id,
                targetId: target.userId,
                ip: clientIp(ctx.request?.headers),
              });
              throw new APIError("FORBIDDEN", {
                code: PROTECTED_ACCOUNT,
                message: "this account is kept for testing and cannot be removed from an organisation",
              });
            }
          }
        }
        // Passkey responses vetted by @simplewebauthn before the plugin consumes the challenge (src/auth/passkey.ts).
        // A passkey's name is bounded like a person's (src/auth/names.ts): stored trimmed, one line, at most NAME_LIMIT
        // characters, and an update must carry one. A registration may carry none (the list names it by position).
        if (ctx.path === "/passkey/update-passkey" || ctx.path === "/passkey/verify-registration") {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const named = boundedName(body.name);
          if (ctx.path === "/passkey/update-passkey" && !named.name)
            throw new APIError("BAD_REQUEST", { code: "INVALID_NAME", message: "a passkey needs a name" });
          if (ctx.path === "/passkey/verify-registration") await vetRegistration(ctx, relyingParty(env.APP_URL));
          // Registered with no name, a passkey is named for the day it was added.
          const given =
            ctx.path === "/passkey/verify-registration" && !named.name
              ? { name: defaultPasskeyName(new Date()) }
              : named;
          return { context: { body: { ...body, ...given } } };
        }
        if (ctx.path === "/passkey/verify-authentication") return vetAuthentication(ctx, relyingParty(env.APP_URL));
        if (ctx.path === "/organization/update-member-role" && ctx.request) {
          // The role being replaced, read before the change, for its audit row (completion review, E1). The member is
          // held while the change runs (migration 0028), so a second change at once is refused, not recorded against a
          // role it did not replace (round 1).
          const memberId = (ctx.body as { memberId?: unknown } | undefined)?.memberId;
          // The hold is taken only for a change Better Auth would allow (rounds 2 and 3), mirroring its own rule
          // (better-auth/dist/plugins/organization/routes/crud-members.mjs, updateMemberRole): the member is in the
          // caller's active organisation, the caller is an owner or an admin there, and only an owner changes an owner or
          // makes one. Anyone else is refused by Better Auth after this, and must not hold a member another is changing.
          const caller = await getSessionFromCtx(ctx);
          const body = (ctx.body ?? {}) as { organizationId?: unknown; role?: unknown };
          const orgId =
            typeof body.organizationId === "string"
              ? body.organizationId
              : ((caller?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ??
                null);
          const target =
            typeof memberId === "string"
              ? await ctx.context.adapter.findOne<{ organizationId: string; role: string }>({
                  model: "member",
                  where: [{ field: "id", value: memberId }],
                })
              : null;
          const callerMember =
            caller && target && orgId && target.organizationId === orgId
              ? await ctx.context.adapter.findOne<{ role: string }>({
                  model: "member",
                  where: [
                    { field: "userId", value: caller.user.id },
                    { field: "organizationId", value: orgId },
                  ],
                })
              : null;
          const roles = (value: string) => value.split(",").map((r) => r.trim());
          const asked = (Array.isArray(body.role) ? body.role : [body.role])
            .filter((r): r is string => typeof r === "string")
            .flatMap(roles);
          const callerRoles = callerMember ? roles(callerMember.role) : [];
          const callerIsOwner = callerRoles.includes("owner");
          const mayChange =
            target !== null &&
            (callerIsOwner ||
              (callerRoles.includes("admin") && !roles(target.role).includes("owner") && !asked.includes("owner")));
          if (typeof memberId === "string" && mayChange) {
            const now = Math.floor(Date.now() / 1000);
            const holder = crypto.randomUUID();
            const held = await mail()
              .db.prepare(
                "INSERT INTO member_locks (member_id, until, holder) VALUES (?1, ?2, ?4) ON CONFLICT (member_id) DO UPDATE SET until = excluded.until, holder = excluded.holder WHERE member_locks.until < ?3 RETURNING member_id",
              )
              .bind(memberId, now + MEMBER_LOCK_SECONDS, now, holder)
              .first();
            // Taken when the row came back: a held member returns none.
            if (!held)
              throw new APIError("CONFLICT", { message: "another change to this member is in progress; try again" });
            lockedMembers.set(ctx.request, { memberId, holder });
            const member = await ctx.context.adapter.findOne<{ role: string }>({
              model: "member",
              where: [{ field: "id", value: memberId }],
            });
            if (member) previousRoles.set(ctx.request, member.role);
          }
          return;
        }
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
        if (ctx.path === "/organization/accept-invitation" || ctx.path === "/organization/reject-invitation") {
          // An invitation is used once: its use is recorded (migration 0012) before the plugin accepts it, only for
          // the signed-in recipient of an invitation the plugin would take (pending, not expired by its own test), so a
          // stranger's attempt spends nothing; the insert is the one check, so a second use, sequential or racing, is
          // refused whatever the invitation's status says, and one Better Auth refuses (accepted, cancelled) it refuses.
          // After an interrupted acceptance (Better Auth writes the status and the membership separately) an owner
          // sends a new invitation. A decline spends the same one use: Better Auth's rejection does not require the
          // invitation still pending, so without it a decline racing an acceptance would mark a joined member's
          // invitation declined; with it, whichever comes second is refused (D07 T02 §14, round 1).
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
          const invitation = ctx.context.returned as {
            id?: unknown;
            expiresAt?: unknown;
            organizationId?: string;
            inviterId?: string;
            role?: string;
          } | null;
          if (!invitation || typeof invitation.id !== "string" || isAPIError(invitation)) return;
          // The caller is the actor, not the invitation's first inviter: a resend by another admin is theirs (G3).
          const resent = (ctx.body as { resend?: unknown } | undefined)?.resend === true;
          await audit({
            kind: "invite",
            outcome: resent ? "resent" : "made",
            orgId: invitation.organizationId ?? null,
            actorId: (await getSessionFromCtx(ctx))?.user.id ?? invitation.inviterId ?? null,
            targetId: invitation.id,
            ip: clientIp(ctx.request?.headers),
            detail: { role: invitation.role ?? null },
          });
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
        if (ctx.path === "/organization/update-member-role" || ctx.path === "/organization/cancel-invitation") {
          const returned = ctx.context.returned as {
            id?: string;
            userId?: string;
            organizationId?: string;
            role?: string;
            status?: string;
          } | null;
          if (!returned || isAPIError(returned) || !returned.organizationId) {
            await releaseMember(ctx.request);
            return;
          }
          const role = ctx.path === "/organization/update-member-role";
          const before = ctx.request ? previousRoles.get(ctx.request) : undefined;
          await releaseMember(ctx.request);
          await audit({
            kind: role ? "update-member-role" : "cancel-invitation",
            outcome: role ? "changed" : "revoked",
            orgId: returned.organizationId,
            actorId: (await getSessionFromCtx(ctx))?.user.id ?? null,
            targetId: (role ? returned.userId : returned.id) ?? null,
            ip: clientIp(ctx.request?.headers),
            // A role change says what it replaced (E1), read before the change was made.
            ...(role ? { detail: { from: before ?? null, to: returned.role ?? null } } : {}),
          });
          return;
        }
        if (ctx.path === "/organization/leave") {
          // A member who leaves is a departure in the team history, by themselves (round 1).
          const left = ctx.context.returned as { userId?: string; organizationId?: string } | null;
          if (!left?.userId || !left.organizationId || isAPIError(left)) return;
          await audit({
            kind: "leave-organization",
            outcome: "left",
            orgId: left.organizationId,
            actorId: left.userId,
            targetId: left.userId,
            ip: clientIp(ctx.request?.headers),
          });
          return;
        }
        if (ctx.path === "/organization/remove-member") {
          // A removed member's sessions in that organisation end with the membership; requireOrg refuses the rest, and
          // their old invitation is spent (invitation_uses), so it cannot bring them back.
          const removed = ctx.context.returned as { member?: { userId?: string; organizationId?: string } } | null;
          const member = removed?.member;
          if (!member?.userId || !member.organizationId || isAPIError(removed)) return;
          // Sessions first, then the row, which says whether they ended (final review): the membership is already gone,
          // so a session delete that fails is logged and recorded, never a 500 an owner's retry could not repair
          // (requireOrg refuses those sessions in the organisation either way).
          const ended = await ctx.context.adapter
            .deleteMany({
              model: "session",
              where: [
                { field: "userId", value: member.userId },
                { field: "activeOrganizationId", value: member.organizationId },
              ],
            })
            .then(
              () => true,
              () => {
                console.error(JSON.stringify({ event: "auth-audit", outcome: "removed-sessions-not-ended" }));
                return false;
              },
            );
          await audit({
            kind: "remove-member",
            outcome: "removed",
            orgId: member.organizationId,
            actorId: (await getSessionFromCtx(ctx))?.user.id ?? null,
            targetId: member.userId,
            ip: clientIp(ctx.request?.headers),
            detail: { sessionsEnded: ended },
          });
        }
      }),
    },
    // A new session starts in the member's earliest organisation, or none for a user who belongs to none.
    databaseHooks: {
      // A user's name, bounded where Better Auth writes it (D07 T02 §22): every path that creates or changes a user goes
      // through these, /update-user and a magic-link sign-in that makes an invited user alike.
      user: {
        create: { before: async (user) => ({ data: { ...user, ...boundedName(user.name) } }) },
        update: { before: async (user) => ({ data: { ...user, ...boundedName(user.name) } }) },
      },
      session: {
        create: {
          // Each session made is a sign-in in the audit trail, by the path that made it (a link, a passkey, a signup).
          after: async (session, ctx) => {
            await audit({
              kind: "sign-in",
              outcome: "signed-in",
              orgId: (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
              userId: session.userId,
              ip: clientIp(ctx?.request?.headers) ?? session.ipAddress ?? null,
              detail: { method: methodOf(ctx?.path) },
            });
          },
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

// A role change's previous role and its held member, from its before hook to its after hook, by request.
const previousRoles = new WeakMap<Request, string>();
const lockedMembers = new WeakMap<Request, { memberId: string; holder: string }>();
const MEMBER_LOCK_SECONDS = 10;

// A role change's hold released once it has run, whatever its answer: from the after hook, and again around the
// handler, since Better Auth skips after hooks on an error that is not an APIError (final review). Only its own holder
// releases it, so a late release never frees a hold another request has since taken.
async function releaseHeld(db: D1Database, request: Request | undefined): Promise<void> {
  const held = request ? lockedMembers.get(request) : undefined;
  if (!request || !held) return;
  lockedMembers.delete(request);
  await db
    .prepare("DELETE FROM member_locks WHERE member_id = ? AND holder = ?")
    .bind(held.memberId, held.holder)
    .run()
    .catch(() => console.error(JSON.stringify({ event: "auth-audit", outcome: "member-lock-unreleased" })));
}

// The way a session was made, as the audit trail names it.
function methodOf(path: string | undefined): string {
  if (!path) return "other";
  if (path.startsWith("/magic-link")) return "magic-link";
  if (path.startsWith("/passkey")) return "passkey";
  if (path.startsWith("/sign-up")) return "signup";
  return "other";
}

// One send key per invitation email: a resend extends the invitation's expiry, so it is a new send, not a duplicate.
type Invitation = { id: string; expiresAt: Date | string };
const inviteSendKey = (invitation: Invitation) =>
  `invite:${invitation.id}:${new Date(invitation.expiresAt).toISOString()}`;

export function createAuth(env: AuthEnv, fetchImpl?: typeof fetch) {
  if (!env.BETTER_AUTH_SECRET) throw new ConfigError("BETTER_AUTH_SECRET is not set");
  // The signup's first link goes through the magic-link endpoint itself, so it is the same link a member asks for.
  const origin = new URL(env.APP_URL).origin;
  // Whether it went is this send's own outcome, told by the magic-link sender (this instance serves one request): the
  // endpoint answers a held-back link (the sign-in limit) as a sent one, so a stranger learns nothing, but the new
  // owner must be told the truth (D01 T02 §2), and no other mail to the address can stand in for it.
  const outcomes = new Map<string, SendOutcome>();
  // The handle is the signup browser's (D07 T02 §11): carried in as its cookie, so the code mailed with this first link
  // is bound to the browser that signed up.
  const sendFirstLink: SendFirstLink = async (email, handle) => {
    outcomes.delete(email.toLowerCase());
    await auth.api.signInMagicLink({
      // A newly made organisation starts on its setup list (D07 T08 §17); every other link lands as it always did.
      body: { email, callbackURL: "/welcome" },
      headers: new Headers({ origin, cookie: `${CODE_COOKIE}=${handle}` }),
    });
    const outcome = outcomes.get(email.toLowerCase());
    return outcome?.status === "sent" || (outcome?.status === "duplicate" && outcome.previous === "sent");
  };
  const auth = betterAuth(
    authOptions(
      env.DB,
      env,
      () => ({
        db: env.DB,
        apiKey: env.SMTP2GO_API_KEY,
        operator: env.OPERATOR_EMAIL,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
      sendFirstLink,
      (email, outcome) => outcomes.set(email.toLowerCase(), outcome),
    ),
  );
  // Every request's hold released when it ends, even past an error Better Auth rethrows before its after hooks.
  const handler = auth.handler;
  auth.handler = async (request: Request) => {
    try {
      return await handler(request);
    } finally {
      await releaseHeld(env.DB, request);
    }
  };
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
