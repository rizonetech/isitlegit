// The redirect fixtures on `fixtures.isitlegit.co.za` (D02 T07 §2; design spec section 11, Fixtures): fictional, harmless
// chains the link checks are proven against live. The host is served by the Worker itself, under a random path prefix
// kept as the secret `FIXTURES_PREFIX`, with `noindex` on every answer and a `robots.txt` that disallows everything. A
// request without the prefix is a 404. The chains end on `example.org` (IANA's reserved documentation domain), so a changed
// registrable domain needs no other zone of ours; D04 T02 §1 adds its fictional-brand pages beside them.
export const FIXTURES_HOST = "fixtures.isitlegit.co.za";
const END = "https://example.org/";

const headers = (extra: Record<string, string> = {}) => ({
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
  ...extra,
});

// The answer for a request to the fixtures host, or null when the request is for another host (the app answers it).
export function fixturesResponse(request: Request, prefix: string | undefined): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== FIXTURES_HOST) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: headers() });
  if (url.pathname === "/robots.txt")
    return new Response("User-agent: *\nDisallow: /\n", { headers: headers({ "content-type": "text/plain" }) });
  // A missing or short prefix serves nothing: the fixtures are not there until the secret is set.
  if (!prefix || prefix.length < 16) return new Response("Not found", { status: 404, headers: headers() });
  const [empty, first, ...rest] = url.pathname.split("/");
  if (empty !== "" || first !== prefix) return new Response("Not found", { status: 404, headers: headers() });
  const go = (location: string, status: number) => new Response(null, { status, headers: headers({ location }) });
  const here = (path: string) => `/${prefix}/${path}`;
  switch (rest.join("/")) {
    // Two redirects, then another site: the registrable domain changes.
    case "chain/1":
      return go(here("chain/2"), 302);
    case "chain/2":
      return go(END, 301);
    // Two redirects inside the fixtures host: a chain with no change of site.
    case "same/1":
      return go(here("same/2"), 302);
    case "same/2":
      return go(here("same/end"), 301);
    case "same/end":
      return new Response(
        "<!doctype html><meta charset=utf-8><meta name=robots content='noindex,nofollow'><title>Fixture</title><h1>Fixture page</h1><p>Test fixture for IsItLegit, not a real service.</p>",
        { headers: headers({ "content-type": "text/html; charset=utf-8" }) },
      );
    default:
      return new Response("Not found", { status: 404, headers: headers() });
  }
}
