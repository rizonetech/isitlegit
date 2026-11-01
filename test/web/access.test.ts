import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../../src/auth/access";
import worker from "../../src/index";
import { authEnv, call } from "../auth/helpers";

// The admin guard (D07 T05 §1): /admin and everything under it answers only a request whose Cloudflare Access JWT
// verifies against the team certificates, with the right audience, issuer, expiry and an admitted operator address.
// These tests sign real RS256 tokens and serve the JWKS through the stubbed certs endpoint.
const TEAM = "team.example.cloudflareaccess.com";
const AUD = "test-aud-tag";
const OPERATOR = "hostmaster@rizonetech.com";
const SIGNIN = "derick@rizonetech.com";
const env = {
  ...authEnv,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_EMAIL: SIGNIN,
  OPERATOR_EMAIL: OPERATOR,
} as unknown as Env;

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

type Key = { kid: string; privateKey: CryptoKey; jwk: JsonWebKey };
async function makeKey(kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey };
}

const key1 = await makeKey("kid-1");
const key2 = await makeKey("kid-2");
const stranger = await makeKey("kid-1");

let certKeys: Key[] = [key1];
let certAnswer: "ok" | "fail" | "malformed" | "down" | "stall" = "ok";
let certFetches = 0;
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return realFetch(input, init);
  certFetches += 1;
  if (certAnswer === "stall")
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
      else signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  if (certAnswer === "down") throw new DOMException("timed out", "TimeoutError");
  if (certAnswer === "fail") return new Response("no", { status: 500 });
  if (certAnswer === "malformed") return Response.json({ keys: [{ kty: "RSA" }] });
  return Response.json({ keys: certKeys.map((k) => k.jwk) });
});
afterEach(() => {
  certKeys = [key1];
  certAnswer = "ok";
  resetAccessKeyCache();
});

async function token(key: Key, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
  const body = b64url(
    JSON.stringify({
      aud: AUD,
      iss: `https://${TEAM}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      email: SIGNIN,
      ...claims,
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

const get = (path: string, headers: Record<string, string> = {}, e: Env = env, method = "GET") =>
  call(path, { method, headers }, e);
const withJwt = async (t: string) => ({ "cf-access-jwt-assertion": t });

describe("the admin guard", () => {
  it("refuses a missing, expired, wrong-audience, wrong-issuer and wrong-email token, and passes both admitted addresses", async () => {
    expect((await get("/admin")).status).toBe(403);
    const expired = await token(key1, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await get("/admin", await withJwt(expired))).status).toBe(403);
    expect((await get("/admin", await withJwt(await token(key1, { aud: "another-app" })))).status).toBe(403);
    expect((await get("/admin", await withJwt(await token(key1, { iss: "https://evil.example" })))).status).toBe(403);
    expect((await get("/admin", await withJwt(await token(key1, { email: "mallory@example.com" })))).status).toBe(403);
    // A verified token reaches the downstream handler (in §1 that is the app's own 404); the guard's refusal is not a 404.
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(404);
    expect((await get("/admin", await withJwt(await token(key1, { email: OPERATOR })))).status).toBe(404);
  });

  it("refuses a tampered payload, an unrelated key, an unsigned token, a disallowed algorithm and a missing claim", async () => {
    const good = await token(key1);
    const [head, , sig] = good.split(".");
    const tampered = `${head}.${b64url(JSON.stringify({ aud: AUD, iss: `https://${TEAM}`, exp: 9999999999, email: SIGNIN }))}.${sig}`;
    expect((await get("/admin", await withJwt(tampered))).status).toBe(403);
    expect((await get("/admin", await withJwt(await token(stranger)))).status).toBe(403);
    const unsigned = `${b64url(JSON.stringify({ alg: "none", kid: "kid-1" }))}.${b64url(JSON.stringify({ aud: AUD, iss: `https://${TEAM}`, exp: 9999999999, email: SIGNIN }))}.`;
    expect((await get("/admin", await withJwt(unsigned))).status).toBe(403);
    expect((await get("/admin", await withJwt(await token(key1, {}, { alg: "HS256" })))).status).toBe(403);
    const noEmail = await token(key1, { email: undefined });
    expect((await get("/admin", await withJwt(noEmail))).status).toBe(403);
  });

  it("guards nested paths and POST through the Worker entry, on the workers.dev hostname, and refuses a forged email header", async () => {
    expect((await get("/admin/orgs", {}, env, "POST")).status).toBe(403);
    expect((await get("/admin/orgs")).status).toBe(403);
    expect((await get("/admin", { "cf-access-authenticated-user-email": SIGNIN })).status).toBe(403);
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const dev = await worker.fetch(
      new Request("https://isitlegit.derick-f5a.workers.dev/admin", {
        headers: { origin: "https://isitlegit.derick-f5a.workers.dev" },
      }),
      env,
      ctx,
    );
    expect(dev.status).toBe(403);
    const devOk = await worker.fetch(
      new Request("https://isitlegit.derick-f5a.workers.dev/admin", {
        headers: { origin: "https://isitlegit.derick-f5a.workers.dev", "cf-access-jwt-assertion": await token(key1) },
      }),
      env,
      ctx,
    );
    expect(devOk.status).toBe(404);
  });

  it("survives key rotation: an absent kid refreshes once, and a kid no set holds is refused", async () => {
    // Warm the cache with kid-1 only, then rotate kid-2 in behind it.
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(404);
    certKeys = [key1, key2];
    expect((await get("/admin", await withJwt(await token(key2)))).status).toBe(404);
    const ghost = await makeKey("kid-ghost");
    certKeys = [key1, key2];
    const before = certFetches;
    expect((await get("/admin", await withJwt(await token(ghost)))).status).toBe(403);
    expect(certFetches - before).toBeLessThanOrEqual(1);
  });

  it("refuses a malformed token as 403, never a server error", async () => {
    expect((await get("/admin", await withJwt("bnVsbA.e30.AA"))).status).toBe(403);
    expect((await get("/admin", await withJwt("e30.bnVsbA.AA"))).status).toBe(403);
    expect((await get("/admin", await withJwt("not-a-jwt"))).status).toBe(403);
    expect((await get("/admin", await withJwt(".."))).status).toBe(403);
  });

  it("bounds certificate downloads when the unknown kid changes every time", async () => {
    const before = certFetches;
    for (let i = 0; i < 6; i++) {
      const ghost = await makeKey(`kid-varying-${i}`);
      expect((await get("/admin", await withJwt(await token(ghost)))).status).toBe(403);
    }
    expect(certFetches - before).toBeLessThanOrEqual(2);
  });

  it("guards /admin on the fixtures hostname too", async () => {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://fixtures.isitlegit.co.za/admin/orgs", {
        method: "POST",
        headers: { origin: "https://fixtures.isitlegit.co.za" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("bounds certificate downloads for repeated and concurrent unknown kids", async () => {
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(404);
    const ghost = await makeKey("kid-ghost-2");
    const before = certFetches;
    const answers = await Promise.all([
      get("/admin", await withJwt(await token(ghost))),
      get("/admin", await withJwt(await token(ghost))),
      get("/admin", await withJwt(await token(ghost))),
    ]);
    expect(answers.map((a) => a.status)).toEqual([403, 403, 403]);
    expect((await get("/admin", await withJwt(await token(ghost)))).status).toBe(403);
    expect(certFetches - before).toBeLessThanOrEqual(1);
  });

  it("fails closed when the verifier cannot run, and recovers when it can", async () => {
    certAnswer = "fail";
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(503);
    certAnswer = "malformed";
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(503);
    certAnswer = "down";
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(503);
    certAnswer = "ok";
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(404);
    const noAud = { ...env, CF_ACCESS_AUD: "" } as Env;
    expect((await get("/admin", await withJwt(await token(key1)), noAud)).status).toBe(503);
    const noTeam = { ...env, CF_ACCESS_TEAM_DOMAIN: "" } as Env;
    expect((await get("/admin", await withJwt(await token(key1)), noTeam)).status).toBe(503);
    const noEmails = { ...env, CF_ACCESS_EMAIL: "", OPERATOR_EMAIL: "" } as Env;
    expect((await get("/admin", await withJwt(await token(key1)), noEmails)).status).toBe(503);
  });

  it("cancels a stalled certificate fetch instead of hanging", { timeout: 20_000 }, async () => {
    certAnswer = "stall";
    expect((await get("/admin", await withJwt(await token(key1)))).status).toBe(503);
  });
});
