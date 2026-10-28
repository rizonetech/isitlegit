import { env } from "cloudflare:test";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { authOptions, createAuth } from "../../src/auth/auth";
import { ConfigError } from "../../src/config";
import { signIn } from "./helpers";

// D07 T02 §1: Better Auth configured on D1, its cookies, and its schema as migration 0007 created it.
const db = (env as unknown as Env).DB;

describe("Better Auth on D1", () => {
  it("creates a session whose cookie is Secure, HttpOnly and SameSite=Lax", async () => {
    const { redeemed } = await signIn("cookie@example.com");
    const cookie = redeemed.headers.getSetCookie().find((c) => c.includes("session_token")) ?? "";
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });

  it("refuses to start without its secret", () => {
    const { BETTER_AUTH_SECRET: _secret, ...withoutSecret } = env as unknown as Env;
    expect(() => createAuth(withoutSecret)).toThrow(ConfigError);
  });

  it("finds nothing left to migrate in the D1 that migration 0007 built", async () => {
    const options = authOptions(db, { APP_URL: "http://localhost", BETTER_AUTH_SECRET: "x".repeat(32) }, () => ({
      db,
      apiKey: undefined,
    }));
    const { toBeCreated, toBeAdded } = await getMigrations(options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});
