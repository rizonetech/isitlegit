// Better Auth's per-IP limiter, counted in D1 (D07 T02 §6). By default it counts in each Worker instance's memory, so
// no limit holds across instances; here every instance counts in `rate_limits` with one atomic upsert, so two cannot both
// pass the last slot. A fixed window: a bucket's first request opens it, and the first request after it opens a new one.
// Only the paths with a rule are counted; the rest (reading a session, say) pass without a write.
import type { BetterAuthOptions } from "better-auth";
import { type AuthEvent, bucketKey } from "./audit";

// 20 link requests, 20 link verifications, 20 passkey challenges and 20 passkey proofs per IP per 10 minutes, each
// counted apart (Better Auth keys a bucket by IP and path). The per-address limit on sign-in mail is sendMail's own (D01 T02 §2).
export const LINK_WINDOW_SECONDS = 600;
export const LINK_MAX = 20;
export const SIGNUP_MAX = 10;
export const RATE_RULES = {
  "/sign-in/public-demo": { window: LINK_WINDOW_SECONDS, max: SIGNUP_MAX },
  "/sign-in/magic-link": { window: LINK_WINDOW_SECONDS, max: LINK_MAX },
  "/magic-link/verify": { window: LINK_WINDOW_SECONDS, max: LINK_MAX },
  // A passkey sign-in is a challenge then its proof, each bounded the same (completion review, G1).
  "/passkey/generate-authenticate-options": { window: LINK_WINDOW_SECONDS, max: LINK_MAX },
  "/passkey/verify-authentication": { window: LINK_WINDOW_SECONDS, max: LINK_MAX },
  // The invite-code signup keeps a limit of its own (Better Auth's default for /sign-up is not counted here).
  "/sign-up/invite-code": { window: LINK_WINDOW_SECONDS, max: SIGNUP_MAX },
} as const;

// The app's own sign-in routes, counted in the same table by the same rule (D07 T02 §11): the code form, 20 posts per
// IP per 10 minutes, counted before a code is read, so refusals cannot be sent faster than that or fill the audit trail.
export const APP_RULES = {
  "/signin/code": { window: LINK_WINDOW_SECONDS, max: LINK_MAX },
} as const;

// The paths counted are the ones with a rule here; every other path passes without a write, as it did when Better Auth's
// limiter was off (it is off outside production by default). A request without Cloudflare's client address is not counted
// per IP: Cloudflare sets `cf-connecting-ip` on every request from the internet, so only the Worker's own calls (the
// signup's first link) lack it, and the per-address limit still holds for them.
const COUNTED = new Set<string>([...Object.keys(RATE_RULES), ...Object.keys(APP_RULES)]);

type Rule = { window: number; max: number };
type CustomStorage = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]>;

export function d1RateLimit(
  db: () => D1Database,
  secret: string,
  refused: (event: AuthEvent) => Promise<void>,
  now: () => number = Date.now,
): CustomStorage {
  return {
    async consume(key: string, rule: Rule) {
      const split = key.lastIndexOf("|");
      const ip = split > 0 ? key.slice(0, split) : null;
      const path = split > 0 ? key.slice(split + 1) : key;
      if (!COUNTED.has(path) || !ip || ip === "no-trusted-ip") return { allowed: true, retryAfter: null };
      const at = Math.floor(now() / 1000);
      const row = await db()
        .prepare(
          "INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END, window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END RETURNING count, window_start",
        )
        .bind(await bucketKey(secret, key), at, rule.window)
        .first<{ count: number; window_start: number }>();
      if (!row || row.count <= rule.max) return { allowed: true, retryAfter: null };
      const retryAfter = Math.max(1, row.window_start + rule.window - at);
      // One row for each window a client is refused in, not one per refusal, so a flood cannot grow the trail at its
      // own rate (final review).
      if (row.count === rule.max + 1)
        await refused({
          kind: "rate-limited",
          outcome: "per-ip",
          ip,
          detail: { path, retryAfter },
        });
      return { allowed: false, retryAfter };
    },
  };
}
