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
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { ConfigError } from "../config";
import { type MailDeps, sendMail } from "../mail/smtp2go";
import { MAGIC_LINK_SECONDS, schemaOptions } from "./schema";

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
      // The return paths, on the link request and on the link itself. The request takes only `callbackURL` (a same-site
      // path, else /cases); the failure and new-user paths are set here from it, whatever the client sent. On the link,
      // all three must still be same-site paths, so an edited link cannot send the member off the site.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/magic-link") {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (body.callbackURL !== undefined && !sameSitePath(body.callbackURL)) throw notSameSite();
          const callbackURL = (body.callbackURL as string | undefined) ?? DEFAULT_RETURN;
          const paths = { callbackURL, newUserCallbackURL: callbackURL, errorCallbackURL: recoveryPath(callbackURL) };
          return { context: { body: { ...body, ...paths } } };
        }
        if (ctx.path === "/magic-link/verify") {
          const query = (ctx.query ?? {}) as Record<string, unknown>;
          for (const name of RETURN_PARAMS)
            if (query[name] !== undefined && !sameSitePath(query[name])) throw notSameSite();
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
