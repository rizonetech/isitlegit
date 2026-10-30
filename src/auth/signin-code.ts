// Sign-in codes (D07 T02 §11): a link signs in whichever browser opens it, so a member who asked on a laptop and reads
// the mail on a phone would be signed in on the phone. Each link is mailed with a 6-digit code that signs in only the
// browser that asked: that browser holds a random handle in an HttpOnly cookie, and the code is checked against the row
// the handle names. A right code redeems the link's own token through Better Auth's verify (src/auth/confirm.tsx), so
// the link and the code are one sign-in and whichever is used first spends the other.
//
// Stored (migration 0035): the handle's SHA-256, the address and return path (to draw the page's recovery controls), the
// token sealed with AES-GCM and the code as an HMAC of handle and code, both under keys derived from the auth secret,
// so a copy of the table opens no account. Three wrong codes end a row.
import { MAGIC_LINK_SECONDS } from "./schema";

export const CODE_COOKIE = "isitlegit_signin";
export const CODE_PATH = "/signin/code";
export const MAX_ATTEMPTS = 3;
// The largest multiple of 1,000,000 a 32-bit draw can reach: a draw at or above it is drawn again, so every code is as
// likely as every other.
export const DRAW_LIMIT = 4_294_000_000;

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) => new Uint8Array((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromBase64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const uint32 = () => crypto.getRandomValues(new Uint32Array(1))[0] as number;

// A uniformly drawn 6-digit code, zero-padded ("000007"). `draw` is the 32-bit source, given in tests.
export function drawCode(draw: () => number = uint32): string {
  for (;;) {
    const value = draw();
    if (value < DRAW_LIMIT) return String(value % 1_000_000).padStart(6, "0");
  }
}

// The handle a browser holds: 32 random bytes, base64url.
export const newHandle = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
export const validHandle = (value: unknown): value is string => typeof value === "string" && HANDLE.test(value);

export const handleHash = async (handle: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(handle)));

// The two keys, derived from the auth secret with HKDF-SHA-256 under their own labels.
type KeyUsageList = Parameters<SubtleCrypto["deriveKey"]>[4];
async function keys(secret: string) {
  if (!secret) throw new Error("signin-code: the auth secret is not set");
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  const derive = (info: string, algorithm: Parameters<SubtleCrypto["deriveKey"]>[2], usages: KeyUsageList) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info) },
      base,
      algorithm,
      false,
      usages,
    );
  return {
    seal: await derive("isitlegit signin-code", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    mac: await derive("isitlegit signin-code mac", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]),
  };
}

// The token sealed: a fresh 12-byte IV and the AES-GCM ciphertext, base64url.
export async function sealToken(secret: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, (await keys(secret)).seal, encoder.encode(token));
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), 12);
  return base64url(out);
}

// The token back, or null when the box was changed or sealed under another secret.
export async function unsealToken(secret: string, box: string): Promise<string | null> {
  try {
    const bytes = fromBase64url(box);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      (await keys(secret)).seal,
      bytes.slice(12),
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

const macInput = (handle: string, code: string) => encoder.encode(`${handle}:${code}`);

export async function codeMac(secret: string, handle: string, code: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", (await keys(secret)).mac, macInput(handle, code)));
}

// Whether a code is the one a row was issued with: WebCrypto's verify compares in constant time.
export async function codeMatches(secret: string, handle: string, code: string, mac: string): Promise<boolean> {
  return crypto.subtle.verify("HMAC", (await keys(secret)).mac, fromHex(mac), macInput(handle, code));
}

// A code as typed: "123 456", "123-456" or "123456" are the same code; anything but six digits is no code.
export function normaliseCode(typed: unknown): string | null {
  if (typeof typed !== "string") return null;
  const digits = typed.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

// "123 456", as the mail shows it.
export const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

// The handle cookie: the browser that asked, for the link's lifetime. The options are
// Better Auth's endpoint form (`ctx.setCookie`); `handleCookie` is the same cookie as a header, for the app's own routes.
// Path `/`: the handle goes with every way a link is asked for, the app's `/signin` routes and Better Auth's own
// `/api/auth/sign-in/magic-link` and `/api/auth/sign-up/invite-code` alike (RFC 6265 5.1.4: a narrower path would keep
// it from the API, which would then hand out a new handle and orphan the browser's codes; round 1).
export const HANDLE_COOKIE = {
  path: "/",
  maxAge: MAGIC_LINK_SECONDS,
  httpOnly: true,
  secure: true,
  sameSite: "lax",
} as const;
export const handleCookie = (handle: string) =>
  `${CODE_COOKIE}=${handle}; Path=${HANDLE_COOKIE.path}; Max-Age=${HANDLE_COOKIE.maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const clearHandleCookie = () =>
  `${CODE_COOKIE}=; Path=${HANDLE_COOKIE.path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// The handle a request carries, if it is one.
export function readHandle(headers: Headers): string | undefined {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === CODE_COOKIE) {
      const handle = value.join("=");
      return validHandle(handle) ? handle : undefined;
    }
  }
  return undefined;
}
