// The admin console's second lock (D07 T05 §1): Cloudflare Access admits the operator at the edge, and the Worker
// verifies the Access JWT itself, so a misconfigured Access policy still cannot expose /admin. The token's RS256
// signature is checked against the team certificates, chosen by `kid`, and its audience, issuer, expiry and email
// against the configuration; the admitted addresses are the Access policy's own (OPERATOR_EMAIL and
// CF_ACCESS_EMAIL). The `Cf-Access-Authenticated-User-Email` header is never trusted on its own. A bad token
// answers 403; a verifier that cannot run (certificates unreachable or malformed, configuration missing) answers
// 503 and fails closed; neither answer carries the token or the provider's error.
import type { MiddlewareHandler } from "hono";

export type AccessEnv = {
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_EMAIL?: string;
  OPERATOR_EMAIL?: string;
};

const CACHE_MS = 60 * 60_000;
const FETCH_MS = 5_000;

type KeySet = { at: number; keys: Map<string, CryptoKey> };
let cache: KeySet | null = null;
export const resetAccessKeyCache = () => {
  cache = null;
  pending = null;
  lastRefreshAt = 0;
};

const refused = (status: 403 | 503, why: string) => {
  console.log(
    JSON.stringify({ event: "admin-access", outcome: status === 403 ? "refused" : "unavailable", reason: why }),
  );
  return new Response(
    status === 403 ? "Forbidden" : "The admin console is not available just now; try again in a moment",
    {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
    },
  );
};

const decode = (part: string): unknown => {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(padded)) as unknown;
};
const bytes = (part: string) => {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
};

async function fetchKeys(team: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`certs-${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("certs-shape");
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    const k = jwk as JsonWebKey & { kid?: unknown };
    if (k.kty !== "RSA" || typeof k.kid !== "string" || !k.n || !k.e) throw new Error("certs-shape");
    keys.set(
      k.kid,
      await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  return keys;
}

const MISS_MS = 30_000;
let pending: Promise<Map<string, CryptoKey>> | null = null;
let lastRefreshAt = 0;
async function keysOnce(team: string): Promise<Map<string, CryptoKey>> {
  if (!pending) {
    pending = fetchKeys(team)
      .then((keys) => {
        cache = { at: Date.now(), keys };
        return keys;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

async function keyFor(team: string, kid: string): Promise<CryptoKey | null> {
  let fresh = false;
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    await keysOnce(team);
    fresh = true;
  }
  const held = cache?.keys.get(kid);
  if (held) return held;
  if (fresh) return null;
  // Cloudflare rotates its signing keys: one bounded refresh past the cache before refusing (plan review, D07 T05
  // §1). The bound is resolver-wide, not per kid: a set downloaded within the last 30 seconds is current whatever
  // kid a hostile token names, so varying the kid cannot make the Worker download certificates on every request
  // (round 1, D07 T05 §1).
  if (Date.now() - lastRefreshAt < MISS_MS) return null;
  lastRefreshAt = Date.now();
  await keysOnce(team);
  return cache?.keys.get(kid) ?? null;
}

type Claims = { aud?: unknown; iss?: unknown; exp?: unknown; email?: unknown };
export const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: { accessEmail: string } }> = async (
  c,
  next,
) => {
  const env = c.env as AccessEnv;
  const team = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.CF_ACCESS_AUD ?? "").trim();
  const admitted = [env.OPERATOR_EMAIL, env.CF_ACCESS_EMAIL].map((e) => (e ?? "").trim().toLowerCase()).filter(Boolean);
  if (!team || !aud || admitted.length === 0) return refused(503, "configuration");
  const jwt = c.req.header("cf-access-jwt-assertion");
  if (!jwt) return refused(403, "missing");
  const parts = jwt.split(".");
  if (parts.length !== 3) return refused(403, "shape");
  let header: { alg?: unknown; kid?: unknown };
  let claims: Claims;
  let signature: Uint8Array;
  try {
    const head: unknown = decode(parts[0] as string);
    const body: unknown = decode(parts[1] as string);
    if (
      !head ||
      typeof head !== "object" ||
      Array.isArray(head) ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    )
      return refused(403, "shape");
    header = head as typeof header;
    claims = body as Claims;
    signature = bytes(parts[2] as string);
  } catch {
    return refused(403, "shape");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return refused(403, "algorithm");
  let key: CryptoKey | null;
  try {
    key = await keyFor(team, header.kid);
  } catch {
    return refused(503, "certificates");
  }
  if (!key) return refused(403, "unknown-key");
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, signed);
  } catch {
    valid = false;
  }
  if (!valid) return refused(403, "signature");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) return refused(403, "audience");
  if (claims.iss !== `https://${team}`) return refused(403, "issuer");
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return refused(403, "expired");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || !admitted.includes(email)) return refused(403, "email");
  c.set("accessEmail", email);
  return next();
};
