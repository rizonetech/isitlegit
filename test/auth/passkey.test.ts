import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { type GateEnv, requireSession } from "../../src/auth/gate";
import { authEnv, call, ORIGIN, sessionCookie, signIn } from "./helpers";
import { b64url, SoftAuthenticator } from "./webauthn";

// D07 T02 §2: passkeys through the Worker's fetch, with a software authenticator standing in for the browser's.
const db = (env as unknown as Env).DB;
const RP_ID = new URL(ORIGIN).hostname;

// Every cookie a response set, as Cookie header pairs, merged over the ones already held.
const jar = (held: string, response: Response) => {
  const pairs = new Map(
    held
      .split("; ")
      .filter(Boolean)
      .map((p) => [p.split("=")[0] as string, p]),
  );
  for (const c of response.headers.getSetCookie()) {
    const pair = c.split(";")[0] as string;
    pairs.set(pair.split("=")[0] as string, pair);
  }
  return [...pairs.values()].join("; ");
};
const post = (path: string, cookie: string, body: unknown) =>
  call(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const countPasskeys = async (email: string) =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM "passkey" p JOIN "user" u ON u.id = p."userId" WHERE lower(u.email) = ?`)
      .bind(email)
      .first<{ n: number }>()
  )?.n ?? 0;
// Moves a session's creation back, so Better Auth sees it as no longer fresh.
const ageSession = (cookie: string, days: number) => {
  const token = decodeURIComponent(cookie.split("session_token=")[1] ?? "").split(".")[0];
  return db
    .prepare(`UPDATE "session" SET "createdAt" = ? WHERE token = ?`)
    .bind(new Date(Date.now() - days * 86_400_000).toISOString(), token)
    .run();
};

// Registration options, as the browser gets them, with the challenge cookie they set.
async function registerOptions(cookie: string) {
  const response = await call("/api/auth/passkey/generate-register-options", { headers: { cookie } });
  return { response, cookie: jar(cookie, response) };
}
async function register(
  authenticator: SoftAuthenticator,
  cookie: string,
  credentialId?: Uint8Array,
  unverified = false,
) {
  const { response, cookie: withChallenge } = await registerOptions(cookie);
  if (response.status !== 200) return response;
  const created = await authenticator.create(await response.json(), ORIGIN, credentialId, unverified);
  return post("/api/auth/passkey/verify-registration", withChallenge, { response: created, name: "Laptop" });
}
type Forgery = Parameters<SoftAuthenticator["get"]>[2];
async function passkeySignIn(authenticator: SoftAuthenticator, as: Forgery = {}) {
  const options = await call("/api/auth/passkey/generate-authenticate-options");
  const cookie = jar("", options);
  const assertion = await authenticator.get(await options.json(), ORIGIN, as);
  const answer = await post("/api/auth/passkey/verify-authentication", cookie, { response: assertion });
  return { answer, cookie, assertion };
}
const whoIs = async (cookie: string) =>
  ((await (await call("/api/auth/get-session", { headers: { cookie } })).json()) as { user?: { email: string } } | null)
    ?.user?.email ?? null;

describe("passkey options", () => {
  it("serves registration options for this host, requiring a discoverable credential", async () => {
    const { cookie } = await signIn("options@example.com");
    const { response } = await registerOptions(cookie);
    expect(response.status).toBe(200);
    const options = (await response.json()) as { rp: { id: string; name: string }; authenticatorSelection: object };
    expect(options.rp).toEqual({ id: RP_ID, name: "IsItLegit" });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  });

  it("serves authentication options requiring user verification and naming no credential, signed in or not", async () => {
    const authenticator = new SoftAuthenticator();
    const { cookie } = await signIn("asks@example.com");
    await register(authenticator, cookie);
    for (const who of ["", cookie]) {
      const response = await call("/api/auth/passkey/generate-authenticate-options", { headers: { cookie: who } });
      expect(response.status).toBe(200);
      const options = (await response.json()) as {
        rpId: string;
        userVerification: string;
        allowCredentials: unknown[];
      };
      expect(options.rpId).toBe(RP_ID);
      expect(options.userVerification).toBe("required");
      expect(options.allowCredentials).toEqual([]);
      expect(response.headers.getSetCookie().some((c) => c.includes("better-auth-passkey"))).toBe(true);
    }
  });
});

describe("the passkey ceremony", () => {
  it("registers a passkey for a signed-in member, lists it, and signs in with it after signing out", async () => {
    const authenticator = new SoftAuthenticator();
    const { cookie } = await signIn("keyholder@example.com");
    expect((await register(authenticator, cookie)).status).toBe(200);
    const listed = (await (await call("/api/auth/passkey/list-user-passkeys", { headers: { cookie } })).json()) as {
      name: string;
    }[];
    expect(listed.map((p) => p.name)).toEqual(["Laptop"]);
    const out = await call("/auth/sign-out", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(303);
    const { answer } = await passkeySignIn(authenticator);
    expect(answer.status).toBe(200);
    expect(await whoIs(sessionCookie(answer))).toBe("keyholder@example.com");
    // A member page behind the gate takes the passkey's session as any other.
    const app = new Hono<GateEnv>();
    app.use("/member", requireSession);
    app.get("/member", (c) => c.text(c.get("signedIn").user.email));
    const through = await app.fetch(
      new Request(`${ORIGIN}/member`, { headers: { cookie: sessionCookie(answer), accept: "text/html" } }),
      authEnv,
    );
    expect([through.status, await through.text()]).toEqual([200, "keyholder@example.com"]);
  });
});

describe("registration refusals", () => {
  it("refuses an anonymous request and a stale session, for options and for verification, writing nothing", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerOptions("")).response.status).toBe(401);

    // Options while fresh, then the session ages past a day before the attestation comes back.
    const { cookie } = await signIn("stale@example.com");
    const { response, cookie: withChallenge } = await registerOptions(cookie);
    const created = await authenticator.create(await response.json(), ORIGIN);
    await ageSession(cookie, 2);
    expect((await registerOptions(cookie)).response.status).toBe(403);
    const late = await post("/api/auth/passkey/verify-registration", withChallenge, { response: created });
    expect(late.status).toBe(403);

    // Options while signed in, then signed out before the attestation comes back.
    const second = await signIn("leftearly@example.com");
    const asked = await registerOptions(second.cookie);
    const made = await authenticator.create(await asked.response.json(), ORIGIN);
    await call("/auth/sign-out", { method: "POST", headers: { cookie: second.cookie } });
    const orphan = await post("/api/auth/passkey/verify-registration", asked.cookie, { response: made });
    expect(orphan.status).toBe(401);

    expect(await countPasskeys("stale@example.com")).toBe(0);
    expect(await countPasskeys("leftearly@example.com")).toBe(0);
  });

  it("refuses a passkey made without user verification, saving nothing", async () => {
    const { cookie } = await signIn("nopin@example.com");
    const refused = await register(new SoftAuthenticator(), cookie, undefined, true);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe("USER_VERIFICATION_REQUIRED");
    expect(await countPasskeys("nopin@example.com")).toBe(0);
  });

  it("answers a malformed registration 400 before using the challenge, so the registration can still finish", async () => {
    const authenticator = new SoftAuthenticator();
    const { cookie } = await signIn("badattest@example.com");
    const { response, cookie: withChallenge } = await registerOptions(cookie);
    const good = await authenticator.create(await response.json(), ORIGIN);
    const malformed: unknown[] = [
      {},
      "a string",
      { ...good, id: "A" },
      { ...good, type: "password" },
      { ...good, response: { ...good.response, attestationObject: "A" } },
      { ...good, response: { ...good.response, attestationObject: "AA" } },
      { ...good, response: { ...good.response, attestationObject: undefined } },
      { ...good, response: { ...good.response, clientDataJSON: "A" } },
      { ...good, response: { ...good.response, transports: "internal" } },
      { ...good, response: { ...good.response, transports: [{}] } },
      {
        ...good,
        response: {
          ...good.response,
          clientDataJSON: b64url(new TextEncoder().encode('{"type":"webauthn.get","challenge":"x"}')),
        },
      },
    ];
    for (const attempt of malformed) {
      const refused = await post("/api/auth/passkey/verify-registration", withChallenge, { response: attempt });
      expect(refused.status, JSON.stringify(attempt).slice(0, 60)).toBe(400);
    }
    expect(await countPasskeys("badattest@example.com")).toBe(0);
    const finished = await post("/api/auth/passkey/verify-registration", withChallenge, { response: good });
    expect(finished.status).toBe(200);
    expect(await countPasskeys("badattest@example.com")).toBe(1);
  });

  it("refuses a sign-in posted with a registration's challenge, leaving the registration to finish", async () => {
    const authenticator = new SoftAuthenticator();
    const { cookie } = await signIn("crossed@example.com");
    const { response, cookie: withChallenge } = await registerOptions(cookie);
    const created = await authenticator.create(await response.json(), ORIGIN);
    const crossed = await post("/api/auth/passkey/verify-authentication", withChallenge, { response: created });
    expect(crossed.status).toBe(400);
    const finished = await post("/api/auth/passkey/verify-registration", withChallenge, { response: created });
    expect(finished.status).toBe(200);
  });

  it("refuses a credential ID another member already registered", async () => {
    const first = new SoftAuthenticator();
    const { cookie } = await signIn("first@example.com");
    expect((await register(first, cookie)).status).toBe(200);
    const taken = first.credentials[0]?.id as Uint8Array;
    const second = await signIn("copycat@example.com");
    const refused = await register(new SoftAuthenticator(), second.cookie, taken);
    expect(refused.status).toBe(400);
    expect(await countPasskeys("copycat@example.com")).toBe(0);
    expect((await passkeySignIn(first)).answer.status).toBe(200);
  });
});

describe("sign-in refusals", () => {
  async function holder(email: string) {
    const authenticator = new SoftAuthenticator();
    const { cookie } = await signIn(email);
    expect((await register(authenticator, cookie)).status).toBe(200);
    return authenticator;
  }

  it("refuses an assertion signed by another key, from another origin, or for another relying party", async () => {
    const authenticator = await holder("forged@example.com");
    const otherKey = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    for (const as of [{ signWith: otherKey }, { origin: "https://evil.example" }, { rpId: "evil.example" }]) {
      const { answer } = await passkeySignIn(authenticator, as);
      expect(answer.status, JSON.stringify(Object.keys(as))).toBeGreaterThanOrEqual(400);
      expect(sessionCookie(answer)).toBe("");
    }
  });

  it("refuses an assertion from another site even when the request itself says it comes from there", async () => {
    // A page on another site running the ceremony: its Origin header and its client data both name that site.
    const authenticator = await holder("phished@example.com");
    const options = await call("/api/auth/passkey/generate-authenticate-options");
    const cookie = jar("", options);
    const assertion = await authenticator.get(await options.json(), ORIGIN, { origin: "https://evil.example" });
    const answer = await call("/api/auth/passkey/verify-authentication", {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ response: assertion }),
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(sessionCookie(answer)).toBe("");
  });

  it("checks the signed client data against the app's origin, not a request header", async () => {
    // Over HTTP Better Auth's own origin check refuses a foreign or missing Origin first (403, above); called through
    // its server API there is no request header at all, and the client data must still be checked against APP_URL.
    const authenticator = await holder("serverside@example.com");
    const options = await call("/api/auth/passkey/generate-authenticate-options");
    const cookie = jar("", options);
    const assertion = await authenticator.get(await options.json(), ORIGIN);
    const api = createAuth(authEnv).api as unknown as {
      verifyPasskeyAuthentication: (a: { body: unknown; headers: Headers }) => Promise<{ user: { email: string } }>;
    };
    const signedIn = await api.verifyPasskeyAuthentication({
      body: { response: assertion },
      headers: new Headers({ cookie }),
    });
    expect(signedIn.user.email).toBe("serverside@example.com");
  });

  it("refuses an assertion without user verification", async () => {
    // Present but not unlocked, as a security key with no PIN answers.
    const authenticator = await holder("unverified@example.com");
    const { answer } = await passkeySignIn(authenticator, { unverified: true });
    expect(answer.status).toBe(401);
    expect(((await answer.json()) as { code: string }).code).toBe("USER_VERIFICATION_REQUIRED");
    expect(sessionCookie(answer)).toBe("");
  });

  it("refuses a malformed response before using the challenge, so the attempt can still finish", async () => {
    const authenticator = await holder("malformed@example.com");
    const options = await call("/api/auth/passkey/generate-authenticate-options");
    const cookie = jar("", options);
    const good = await authenticator.get(await options.json(), ORIGIN);
    const malformed: unknown[] = [
      {},
      { ...good, id: { $ne: null } },
      { ...good, type: "password" },
      { ...good, response: { ...good.response, signature: undefined } },
      { ...good, response: { ...good.response, authenticatorData: "not base64url!" } },
      { ...good, response: { ...good.response, userHandle: { toString: 1 } } },
      // Base64url that cannot decode (a length of 1 mod 4), in each field, and client data that is not webauthn.get.
      { ...good, id: "A", rawId: "A" },
      { ...good, response: { ...good.response, authenticatorData: "A" } },
      { ...good, response: { ...good.response, clientDataJSON: "A" } },
      { ...good, response: { ...good.response, signature: "AAAAA" } },
      { ...good, response: { ...good.response, authenticatorData: "AAAA" } },
      {
        ...good,
        response: {
          ...good.response,
          clientDataJSON: b64url(new TextEncoder().encode('{"type":"webauthn.create","challenge":"x"}')),
        },
      },
      "a string",
    ];
    for (const response of malformed) {
      const refused = await post("/api/auth/passkey/verify-authentication", cookie, { response });
      // 400, or 401 where it names a credential no one registered; either way before the challenge is used.
      expect([400, 401], JSON.stringify(response).slice(0, 60)).toContain(refused.status);
      expect(sessionCookie(refused)).toBe("");
    }
    const finished = await post("/api/auth/passkey/verify-authentication", cookie, { response: good });
    expect(finished.status).toBe(200);
    expect(await whoIs(sessionCookie(finished))).toBe("malformed@example.com");
  });

  it("refuses a replayed assertion", async () => {
    const authenticator = await holder("replay@example.com");
    const { answer, cookie, assertion } = await passkeySignIn(authenticator);
    expect(answer.status).toBe(200);
    const again = await post("/api/auth/passkey/verify-authentication", cookie, { response: assertion });
    expect(again.status).toBe(400);
    expect(sessionCookie(again)).toBe("");
  });

  it("finds no credential to answer with when the one it holds is not discoverable", async () => {
    // A credential made for a relying party that did not require a resident key: sign-in, which names no credential,
    // cannot reach it. Registration here requires one (above), so this is the failure that requirement prevents.
    const authenticator = new SoftAuthenticator();
    const challenge = "AAAA";
    await authenticator.create(
      { challenge, rp: { id: RP_ID }, user: { id: "dXNlcg" }, authenticatorSelection: { residentKey: "discouraged" } },
      ORIGIN,
    );
    const options = await (await call("/api/auth/passkey/generate-authenticate-options")).json();
    await expect(authenticator.get(options as never, ORIGIN)).rejects.toThrow(/NotAllowedError/);
  });
});

describe("removing a passkey", () => {
  it("removes a member's own passkey, after which it no longer signs in", async () => {
    const authenticator = new SoftAuthenticator();
    const { cookie } = await signIn("remover@example.com");
    await register(authenticator, cookie);
    const [key] = (await (await call("/api/auth/passkey/list-user-passkeys", { headers: { cookie } })).json()) as {
      id: string;
    }[];
    expect((await post("/api/auth/passkey/delete-passkey", cookie, { id: key?.id })).status).toBe(200);
    expect(await countPasskeys("remover@example.com")).toBe(0);
    const { answer } = await passkeySignIn(authenticator);
    expect(answer.status).toBe(401);
    expect(sessionCookie(answer)).toBe("");
  });

  it("lists and renames only a member's own passkeys", async () => {
    const owner = new SoftAuthenticator();
    const { cookie } = await signIn("lister@example.com");
    await register(owner, cookie);
    const other = await signIn("neighbour@example.com");
    await register(new SoftAuthenticator(), other.cookie);
    const listOf = async (who: string) =>
      (await (await call("/api/auth/passkey/list-user-passkeys", { headers: { cookie: who } })).json()) as {
        id: string;
        name: string;
        userId: string;
      }[];
    const mine = await listOf(cookie);
    const theirs = await listOf(other.cookie);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.id).not.toBe(theirs[0]?.id);
    expect((await call("/api/auth/passkey/list-user-passkeys")).status).toBe(401);
    // Renaming their own works; renaming the neighbour's is refused and leaves it as it was.
    expect((await post("/api/auth/passkey/update-passkey", cookie, { id: mine[0]?.id, name: "Phone" })).status).toBe(
      200,
    );
    expect((await listOf(cookie))[0]?.name).toBe("Phone");
    const refused = await post("/api/auth/passkey/update-passkey", cookie, { id: theirs[0]?.id, name: "Mine now" });
    expect(refused.status).toBe(401);
    expect((await post("/api/auth/passkey/update-passkey", "", { id: theirs[0]?.id, name: "x" })).status).toBe(401);
    expect((await listOf(other.cookie))[0]?.name).toBe("Laptop");
  });

  it("refuses removing another member's passkey and leaves it in place", async () => {
    const owner = new SoftAuthenticator();
    const { cookie } = await signIn("owner@example.com");
    await register(owner, cookie);
    const [key] = (await (await call("/api/auth/passkey/list-user-passkeys", { headers: { cookie } })).json()) as {
      id: string;
    }[];
    const intruder = await signIn("intruder@example.com");
    const refused = await post("/api/auth/passkey/delete-passkey", intruder.cookie, { id: key?.id });
    expect(refused.status).toBe(401);
    expect(await countPasskeys("owner@example.com")).toBe(1);
    expect((await passkeySignIn(owner)).answer.status).toBe(200);
  });
});
