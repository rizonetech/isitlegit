// Operator-authorized public Fynbos workspace. Never signs in as an existing protected user.
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { PROTECTED_ORGANISATIONS } from "./protected";

export function publicDemo(database: () => D1Database, appURL: string) {
  return {
    id: "public-fynbos-demo",
    endpoints: {
      publicDemoSignIn: createAuthEndpoint(
        "/sign-in/public-demo",
        {
          method: "POST",
          body: z.object({ consent: z.literal(true) }).strict(),
        },
        async (ctx) => {
          if (ctx.headers?.get("origin") !== new URL(appURL).origin) {
            throw new APIError("FORBIDDEN", { message: "Open the demo from the application." });
          }
          const db = database();
          const orgId = PROTECTED_ORGANISATIONS[0];
          const org = await db.prepare('SELECT id FROM "organization" WHERE id = ?').bind(orgId).first();
          if (!org) throw new APIError("SERVICE_UNAVAILABLE", { message: "The demo workspace is unavailable." });
          // One shared ten-minute admission cap, using the same seconds and retention as auth rate limits.
          const now = Math.floor(Date.now() / 1000);
          const admitted = await db
            .prepare(
              "INSERT INTO rate_limits (key, count, window_start) VALUES ('public-demo-global', 1, ?1) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN ?1 - window_start >= 600 THEN 1 ELSE count + 1 END, window_start = CASE WHEN ?1 - window_start >= 600 THEN ?1 ELSE window_start END RETURNING count",
            )
            .bind(now)
            .first<{ count: number }>();
          if (!admitted || admitted.count > 100)
            throw new APIError("TOO_MANY_REQUESTS", { message: "The public demo is busy. Please try again later." });
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: `public-demo-${crypto.randomUUID()}@example.invalid`,
              name: "Public demo visitor",
              emailVerified: false,
            },
            { method: "admin" },
          );
          await ctx.context.adapter.create({
            model: "member",
            data: {
              userId: user.id,
              organizationId: orgId,
              role: "owner",
              createdAt: new Date(),
            },
          });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError("SERVICE_UNAVAILABLE", { message: "The demo session could not start." });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ready: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
