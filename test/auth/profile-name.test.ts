import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { boundedName, NAME_LIMIT } from "../../src/auth/names";
import { addInviteCode } from "../fixtures/auth/members";
import { authEnv, call, signIn, stubSmtp2go } from "./helpers";

// D07 T02 §22: a user's name is bounded where Better Auth writes it: trimmed, at most 100 characters, one line with no
// control characters, else a typed 400 with nothing stored. Every write path passes the same hooks, /update-user and a
// user's creation (a magic-link sign-in that makes an invited user, the invite-code signup) alike.
const db = (env as unknown as Env).DB;
const tag = () => crypto.randomUUID().slice(0, 8);
const storedName = async (email: string) =>
  (await db.prepare(`SELECT name FROM "user" WHERE lower(email) = ?`).bind(email).first<{ name: string }>())?.name;
const update = (cookie: string, name: unknown) =>
  call("/api/auth/update-user", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

describe("a user's name, bounded where it is written", () => {
  it("refuses an over-long, multi-line or control-character name at /update-user, keeping the stored one", async () => {
    const email = `named-${tag()}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    expect((await update(cookie, "Lindiwe Dlamini")).status).toBe(200);
    expect(await storedName(email)).toBe("Lindiwe Dlamini");
    for (const name of [
      "x".repeat(NAME_LIMIT + 1),
      "Lindiwe\nDlamini",
      "Lindiwe\u0007",
      "Lindiwe\u007f",
      // Unicode's own line breaks, C1 controls, and a bidirectional override that would reverse the name in mail.
      "Lindiwe\u2028Dlamini",
      "Lindiwe\u2029Dlamini",
      "Lindiwe\u0085Dlamini",
      "Lindiwe\u009b",
      "\u202einiwdniL",
      "Lindiwe\u2066x\u2069",
    ]) {
      const refused = await update(cookie, name);
      expect(refused.status, JSON.stringify(name)).toBe(400);
      expect(((await refused.json()) as { code?: string }).code).toBe("INVALID_NAME");
      expect(await storedName(email)).toBe("Lindiwe Dlamini");
    }
    // The bound itself is allowed, trimmed; and a later valid update goes through.
    expect((await update(cookie, `  ${"y".repeat(NAME_LIMIT)}  `)).status).toBe(200);
    expect(await storedName(email)).toBe("y".repeat(NAME_LIMIT));
    expect((await update(cookie, "Lindiwe")).status).toBe(200);
    expect(await storedName(email)).toBe("Lindiwe");
  });

  it("bounds a user's creation by the same rule, the path a magic-link sign-in takes", async () => {
    const create = createAuth(authEnv).options.databaseHooks?.user?.create?.before;
    if (!create) throw new Error("no user create hook");
    await expect(create({ name: "x".repeat(300), email: "a@b.example" } as never)).rejects.toMatchObject({
      body: { code: "INVALID_NAME" },
    });
    await expect(create({ name: "  Thandi  ", email: "a@b.example" } as never)).resolves.toMatchObject({
      data: { name: "Thandi" },
    });
    expect(boundedName(undefined)).toEqual({});
  });

  it("signs up an address too long to be a name, leaving the name blank for every reader to show the address", async () => {
    const long = `${"m".repeat(110)}@demo.isitlegit.co.za`;
    expect(long.length).toBeGreaterThan(NAME_LIMIT);
    const code = `code-${crypto.randomUUID()}`;
    await addInviteCode(db, code);
    const smtp = stubSmtp2go();
    try {
      const signedUp = await call("/api/auth/sign-up/invite-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: long, code, organizationName: "Long Address Logistics", consent: true }),
      });
      expect(signedUp.status).toBe(201);
    } finally {
      smtp.restore();
    }
    expect(await storedName(long)).toBe("");
    // A short address is its own name, as before.
    const short = `short-${tag()}@demo.isitlegit.co.za`;
    const shortCode = `code-${crypto.randomUUID()}`;
    await addInviteCode(db, shortCode);
    const smtp2 = stubSmtp2go();
    try {
      await call("/api/auth/sign-up/invite-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: short,
          code: shortCode,
          organizationName: "Short Address Couriers",
          consent: true,
        }),
      });
    } finally {
      smtp2.restore();
    }
    expect(await storedName(short)).toBe(short);
  });
});
