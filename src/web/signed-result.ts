// An action's result carried by the redirect that follows it (post, redirect, get): signed with a server secret over
// what it is about and its moment, for one purpose, so a page draws only words an action of its own produced lately,
// never ones a crafted address claims (the domain page, D07 T02 §15; the report's retry, D07 T03 §20).
const encoder = new TextEncoder();
const key = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function signResult(secret: string, purpose: string, text: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await key(secret, "sign"), encoder.encode(`${purpose}\n${text}`));
  return base64url(new Uint8Array(mac));
}

// Whether a signature holds, compared in constant time by the platform (`crypto.subtle.verify`).
export async function resultHolds(secret: string, purpose: string, text: string, signature: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", await key(secret, "verify"), raw, encoder.encode(`${purpose}\n${text}`));
}

// How long a carried result is drawn after its action, and how far ahead of the server's clock one may claim to be.
export const RESULT_TTL_MS = 10 * 60_000;
export const fresh = (at: number, now = Date.now()) =>
  Number.isFinite(at) && now - at <= RESULT_TTL_MS && at <= now + 60_000;
