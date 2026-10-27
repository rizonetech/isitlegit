// Signed, expiring report links (D01 T01 §8; stack doc: HMAC-signed URLs, 7 days, single tenant scope). A reply carries
// `/r/<caseId>?o=<orgId>&e=<expiry>&s=<signature>`, which opens the report without a session. The signature is
// HMAC-SHA256 under REPORT_LINK_SECRET over the JSON array ["report-link:v1", caseId, orgId, expiry], so changing any
// of them, or a signature made for another purpose or link format, fails. A tampered, malformed or expired link is
// refused, never served; a missing or short secret is a configuration error, never a refusal of the link.
import { ConfigError } from "../config";
import { isUlid } from "../db/ulid";

export const LINK_DAYS = 7;
const LIFETIME = LINK_DAYS * 24 * 60 * 60;
const VERSION = "report-link:v1";
const MIN_SECRET_BYTES = 32;
// An HMAC-SHA256 in base64url without padding: 32 bytes, 43 characters. Any string this matches decodes to exactly 32
// bytes, so the constant-time comparison never meets a length it would throw on.
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
// The case store's organisation id (src/db/cases.ts: 1 to 200 characters).
const orgIdValid = (orgId: string) => orgId.length >= 1 && orgId.length <= 200;

// The shared configuration error (src/config.ts), re-exported for the link's callers.
export { ConfigError };

export type LinkRefusal = "malformed" | "path" | "signature" | "expired" | "too-far";
export type VerifiedLink =
  | { ok: true; caseId: string; orgId: string; expires: number }
  | { ok: false; reason: LinkRefusal };

const encoder = new TextEncoder();

async function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || encoder.encode(secret).byteLength < MIN_SECRET_BYTES)
    throw new ConfigError(`REPORT_LINK_SECRET is missing or shorter than ${MIN_SECRET_BYTES} bytes`);
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(key: CryptoKey, caseId: string, orgId: string, expires: number): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify([VERSION, caseId, orgId, expires])));
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

// The link's path and query; the reply makes it absolute from a trusted origin (D01 T02 §3).
export async function signReportLink(
  secret: string | undefined,
  caseId: string,
  orgId: string,
  now = Date.now(),
): Promise<string> {
  const key = await hmacKey(secret);
  if (!isUlid(caseId)) throw new Error("signReportLink: the case id is not a ULID");
  if (!orgIdValid(orgId)) throw new Error("signReportLink: the organisation id is not 1 to 200 characters");
  const expires = Math.floor(now / 1000) + LIFETIME;
  const signature = base64url(await sign(key, caseId, orgId, expires));
  return `/r/${caseId}?${new URLSearchParams({ o: orgId, e: String(expires), s: signature })}`;
}

export async function verifyReportLink(
  secret: string | undefined,
  url: string | URL,
  now = Date.now(),
): Promise<VerifiedLink> {
  const key = await hmacKey(secret);
  const refuse = (reason: LinkRefusal): VerifiedLink => ({ ok: false, reason });
  let parsed: URL;
  try {
    // A path alone is read against a placeholder origin; only the path and query are judged.
    parsed = new URL(url, "https://report.invalid");
  } catch {
    return refuse("malformed");
  }
  const caseId = /^\/r\/([^/]+)$/.exec(parsed.pathname)?.[1];
  if (!caseId || !isUlid(caseId)) return refuse("path");
  const params = [...parsed.searchParams.keys()];
  if (params.length !== 3 || ["o", "e", "s"].some((name) => parsed.searchParams.getAll(name).length !== 1))
    return refuse("malformed");
  const orgId = parsed.searchParams.get("o") ?? "";
  const expiry = parsed.searchParams.get("e") ?? "";
  const given = parsed.searchParams.get("s") ?? "";
  if (!orgIdValid(orgId) || !/^\d{1,12}$/.test(expiry) || !SIGNATURE.test(given)) return refuse("malformed");
  let presented: Uint8Array;
  try {
    presented = fromBase64url(given);
  } catch {
    return refuse("malformed");
  }
  const expires = Number(expiry);
  const expected = new Uint8Array(await sign(key, caseId, orgId, expires));
  if (!crypto.subtle.timingSafeEqual(expected, presented)) return refuse("signature");
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds) return refuse("expired");
  if (expires > seconds + LIFETIME) return refuse("too-far");
  return { ok: true, caseId, orgId, expires };
}
