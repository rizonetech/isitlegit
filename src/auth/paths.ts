// The app's return paths (D07 T02 §1): where a redeemed sign-in link goes, and what counts as a path on this site. Kept
// apart from ./auth so the sign-in pages (./confirm-page) render without Better Auth.

// Where a redeemed link goes when it was asked for nowhere in particular.
export const DEFAULT_RETURN = "/cases";

// A path on this site, with its query: one leading slash, not two, and no scheme, host or backslash; and still a path
// on this site once a URL parser resolves it, since dot segments can turn `/a/..//evil.example` into the
// protocol-relative `//evil.example`, which a browser follows off the site (D07 T02 §10 round 3).
const BASE = "https://same-site.invalid";
export function sameSitePath(value: unknown): value is string {
  if (typeof value !== "string" || !/^\/(?!\/)/.test(value) || /[\\\s]/.test(value) || value.includes("://"))
    return false;
  const resolved = new URL(value, BASE);
  return resolved.origin === BASE && !resolved.pathname.startsWith("//");
}
