// Better Auth on D1 (D07 T02 §1; stack doc): users, sessions and email magic links. One instance per request, built
// from the Worker's bindings: the `DB` binding (Better Auth's Kysely adapter talks to D1 itself, using batch() for want
// of interactive transactions), BETTER_AUTH_SECRET, and APP_URL as the base URL its cookies and origin check rely on.
//
// A magic link goes out through `sendMail` (src/mail/smtp2go.ts) under the send key `signin:<SHA-256 of its token>`:
// stable for the link it carries, new for every link requested, and no secret. Only a send SMTP2GO confirmed is a
// delivered link; anything else answers the request with an error, never "check your email". The link returns to the
// `callbackURL` it was asked with, accepted only as a same-site path, else to /cases.
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { ConfigError } from "../config";
import { type MailDeps, sendMail } from "../mail/smtp2go";
import { MAGIC_LINK_SECONDS, schemaOptions } from "./schema";

export { MAGIC_LINK_SECONDS };
export const SIGNIN_FROM = "IsItLegit <signin@isitlegit.co.za>";
// Where a redeemed link goes when it was asked for nowhere in particular.
export const DEFAULT_RETURN = "/cases";

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  APP_URL: string;
  SMTP2GO_API_KEY?: string;
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
    ...schemaOptions(async ({ email, url, token }) => {
      const outcome = await sendMail(mail(), {
        sendKey: `signin:${await sha256Hex(token)}`,
        kind: "signin",
        to: email,
        from: SIGNIN_FROM,
        subject: "Your IsItLegit sign-in link",
        text: `Sign in to IsItLegit with this link. It works once, for ${MAGIC_LINK_SECONDS / 60} minutes:\n\n${url}\n\nIf you did not ask for it, ignore this mail.`,
      });
      const delivered = outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent");
      if (!delivered)
        throw new APIError("BAD_GATEWAY", {
          message: "the sign-in link could not be sent; try again in a few minutes",
        });
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    trustedOrigins: [new URL(env.APP_URL).origin],
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax" as const },
    },
    hooks: {
      // The return destination, on the link request and on the link itself: a same-site path or nothing.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/magic-link") {
          const callbackURL = (ctx.body as { callbackURL?: unknown } | undefined)?.callbackURL;
          if (callbackURL !== undefined && !sameSitePath(callbackURL))
            throw new APIError("BAD_REQUEST", { message: "the return destination must be a path on this site" });
          return { context: { body: { ...ctx.body, callbackURL: callbackURL ?? DEFAULT_RETURN } } };
        }
        if (ctx.path === "/magic-link/verify") {
          const callbackURL = (ctx.query as { callbackURL?: unknown } | undefined)?.callbackURL;
          if (callbackURL !== undefined && !sameSitePath(callbackURL))
            throw new APIError("BAD_REQUEST", { message: "the return destination must be a path on this site" });
        }
      }),
    },
  } satisfies BetterAuthOptions;
}

export function createAuth(env: AuthEnv, fetchImpl?: typeof fetch) {
  if (!env.BETTER_AUTH_SECRET) throw new ConfigError("BETTER_AUTH_SECRET is not set");
  return betterAuth(
    authOptions(env.DB, env, () => ({
      db: env.DB,
      apiKey: env.SMTP2GO_API_KEY,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })),
  );
}

export type Auth = ReturnType<typeof createAuth>;
