// The redirect fixtures on `fixtures.isitlegit.co.za` (D02 T07 §2; design spec section 11, Fixtures): fictional, harmless
// chains the link checks are proven against live. The host is served by the Worker itself, under a random path prefix
// kept as the secret `FIXTURES_PREFIX`, with `noindex` on every answer and a `robots.txt` that disallows everything. A
// request without the prefix is a 404. The chains end on `example.org` (IANA's reserved documentation domain), so a changed
// registrable domain needs no other zone of ours; D04 T02 §1 adds its fictional-brand pages beside them.

import fynbosLookalike from "../../fixtures/fynbos-lookalike/index.html";
import nimbusmailLure from "../../fixtures/nimbusmail/index.html";
import nimbusmailLogin from "../../fixtures/nimbusmail/login.html";
import multistepIndex from "../../fixtures/nimbusmail-multistep/index.html";
import multistepLogin from "../../fixtures/nimbusmail-multistep/login.html";
import multistepLure from "../../fixtures/nimbusmail-multistep/lure.html";
import multistepSubmitted from "../../fixtures/nimbusmail-multistep/submitted.html";
import proteabankCard from "../../fixtures/proteabank/index.html";
import { collectSubmission, type FixtureDeps } from "./collect";

export const FIXTURES_HOST = "fixtures.isitlegit.co.za";
const END = "https://example.org/";

const headers = (extra: Record<string, string> = {}) => ({
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
  ...extra,
});

// The answer for a request to the fixtures host, or null when the request is for another host (the app answers it).
// `deps` serves the collector (D04 T02 §1): without them a submission is a 500, never an acceptance.
export async function fixturesResponse(
  request: Request,
  prefix: string | undefined,
  deps?: FixtureDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.hostname !== FIXTURES_HOST) return null;
  if (url.pathname === "/robots.txt" && request.method === "GET")
    return new Response("User-agent: *\nDisallow: /\n", { headers: headers({ "content-type": "text/plain" }) });
  // A missing or short prefix serves nothing: the fixtures are not there until the secret is set.
  if (!prefix || prefix.length < 16) return new Response("Not found", { status: 404, headers: headers() });
  const [empty, first, ...rest] = url.pathname.split("/");
  if (empty !== "" || first !== prefix) return new Response("Not found", { status: 404, headers: headers() });
  const path = rest.join("/");
  // The collector is the one POST the host takes (D04 T02 §1).
  if (path === "collect") {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: headers() });
    if (!deps)
      return new Response("<!doctype html><title>Fixture</title><h1>Something went wrong on our side</h1>", {
        status: 500,
        headers: headers({ "content-type": "text/html; charset=utf-8" }),
      });
    return collectSubmission(request, deps);
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: headers() });
  const go = (location: string, status: number) => new Response(null, { status, headers: headers({ location }) });
  const here = (path: string) => `/${prefix}/${path}`;
  const htmlPage = (html: string) =>
    new Response(request.method === "HEAD" ? null : html, {
      headers: headers({ "content-type": "text/html; charset=utf-8" }),
    });
  switch (path) {
    // D04 T02 §10: byte-exact eval-owned pages, using the same host/prefix/method boundary.
    case "nimbusmail-multistep":
      return go(here("nimbusmail-multistep/"), 301);
    case "nimbusmail-multistep/":
      return htmlPage(multistepIndex);
    case "nimbusmail-multistep/lure":
      return htmlPage(multistepLure);
    case "nimbusmail-multistep/login":
      return htmlPage(multistepLogin);
    case "nimbusmail-multistep/submitted":
      return htmlPage(multistepSubmitted);
    // The fictional-brand pages (D04 T02 §1): a NimbusMail lure and login, a Protea Bank card form.
    // The slash-less addresses redirect to their slashed form, so the pages' relative links and
    // form actions resolve under the prefix either way (completion review, G1).
    case "nimbusmail":
      return go(here("nimbusmail/"), 301);
    case "nimbusmail/":
      return htmlPage(nimbusmailLure);
    case "nimbusmail/login":
      return htmlPage(nimbusmailLogin);
    case "proteabank":
      return go(here("proteabank/"), 301);
    case "proteabank/":
      return htmlPage(proteabankCard);
    // The demo lookalike (D05 T04 §6): a fictional Fynbos Freight login copy the daily monitor finds.
    case "fynbos-lookalike":
      return go(here("fynbos-lookalike/"), 301);
    case "fynbos-lookalike/":
      return htmlPage(fynbosLookalike);
  }
  switch (path) {
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
