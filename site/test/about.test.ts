// The built about page (D07 T06 §8, design/SPEC.md S9): Rizonetech (Pty) Ltd in George with its light and dark SVG
// logos, Derick Payne, the Meta Global AI Developer Hackathon build, the sourced SABRIC 2025 figure, the three contact
// cards, and negative checks that fail when a source link, Results link or contact destination breaks. Proven-only
// (D07 T06 §20): the model and purpose claims are omitted while their owners are unstamped.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allAddresses, app, CHECK_ADDRESS, contact, HELLO_ADDRESS, repo, site } from "../src/lib/links.ts";
import { SABRIC_2025 } from "../src/lib/sources.ts";
import { DIST, element, has, hrefs, linkTo, page, region } from "./lib/page.ts";

const html = page("/about");

function verifyAboutPage(source: string) {
  const company = region(source, "company");
  linkTo(company, repo, "github.com/rizonetech/isitlegit", "company");

  const built = region(source, "built");
  assert.doesNotMatch(built, /data-claim="about\.built\.models"/, "the unproven model claim is published");
  has(built, "See how each model performs on our benchmark on the", "built");
  linkTo(built, app.results, "Results page", "built");

  const why = region(source, "why");
  has(why, "R2.4 billion", "why");
  has(why, "110,074", "why");
  linkTo(why, SABRIC_2025.url, `SABRIC, ${SABRIC_2025.title}`, "why");

  const contactRegion = region(source, "contact");
  const general = element(contactRegion, /<article data-contact="general"/, "general contact");
  linkTo(general, contact, HELLO_ADDRESS, "general contact");
  const check = element(contactRegion, /<article data-contact="check"/, "check contact");
  has(check, CHECK_ADDRESS, "check contact");
  linkTo(check, app.signup, "sign up", "check contact");
  const security = element(contactRegion, /<article data-contact="security"/, "security contact");
  linkTo(security, site.security, "isitlegit.co.za/security", "security contact");
}

describe("About and contact", () => {
  it("leads with the question heading, direct answer naming Rizonetech (Pty) Ltd in George, and byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>Who is behind IsItLegit\?<\/h1>/);
    has(intro, "IsItLegit is built and run by Rizonetech (Pty) Ltd, a software company in George in the Western Cape, South Africa.", "the intro");
    has(intro, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the intro");
  });

  it("renders the Rizonetech light and dark SVG logos on disk and the FSL-1.1-ALv2 repository link", () => {
    const company = region(html, "company");
    const logos = [...company.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*alt="Rizonetech"[^>]*>/g)];
    assert.equal(logos.length, 2, "expected light and dark Rizonetech logo images");
    assert.match(logos[0][0], /dark:hidden/);
    assert.match(logos[1][0], /hidden dark:block/);
    for (const [, src] of logos) {
      const file = join(DIST, src);
      assert.ok(existsSync(file) && statSync(file).size > 100, `missing Rizonetech logo asset ${src}`);
    }
    has(company, "Functional Source License (FSL-1.1-ALv2, converting to Apache 2.0 after two years)", "company");
    assert.doesNotMatch(company, /3 November/, "the company card still dates the repository's opening");
    linkTo(company, repo, "github.com/rizonetech/isitlegit", "company");
  });

  it("names Derick Payne and the Meta Global AI Developer Hackathon, links the Results page, and omits the unproven model claim", () => {
    const built = region(html, "built");
    has(built, "IsItLegit was designed and built by Derick Payne, Rizonetech's CEO, for the Meta Global AI Developer Hackathon (Startup track, 26 October to 4 November 2026)", "built");
    has(built, "every change reviewed by an independent model before it shipped", "built");
    linkTo(built, app.results, "Results page", "built");
    assert.doesNotMatch(built, /Each check uses the Meta model that fits the job/, "the unproven model claim is published");
  });

  it("cites the SABRIC 2025 loss and incident figures beside a link to the primary report", () => {
    const why = region(html, "why");
    has(why, "South African banks reported R2.4 billion in digital banking fraud claims across 110,074 incidents in 2025", "why");
    linkTo(why, SABRIC_2025.url, `SABRIC, ${SABRIC_2025.title}`, "why");
  });

  it("shows all three contact cards with hello@isitlegit.co.za, check@isitlegit.co.za (with sign-up link) and /security", () => {
    verifyAboutPage(html);
  });

  it("links only to known addresses or the SABRIC source, and fails when a source link, model claim or contact link is removed", () => {
    for (const href of hrefs(html)) {
      assert.ok(allAddresses.includes(href) || href === SABRIC_2025.url || href === "#main", `unexpected link ${href} on /about`);
    }
    assert.throws(() => verifyAboutPage(html.replace(">Results page<", ">Dropped page<")));
    assert.throws(() => verifyAboutPage(html.replace(SABRIC_2025.url, "https://example.com")));
    assert.throws(() => verifyAboutPage(html.replace(`href="${contact}"`, 'href="mailto:wrong@example.com"')));
    assert.throws(() => verifyAboutPage(html.replace(`href="${site.security}"`, 'href="/wrong"')));
  });
});
