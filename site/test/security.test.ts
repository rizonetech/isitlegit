// The built security page (D07 T06 §8, design/SPEC.md S8, SECURITY.md): the six pipeline safeguards and five data
// protections rendered through the claims registry, the disclosure scope and 3-working-day commitment, the GitHub
// advisory, SECURITY.md and direct email reporting links, and negative checks that fail on claim or link mutations.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allAddresses, HELLO_ADDRESS, securityAdvisory, securityEmail, securityPolicy, site } from "../src/lib/links.ts";
import { element, has, hrefs, linkTo, page, region } from "./lib/page.ts";

const html = page("/security");

const REQUIRED_SAFEGUARDS = [
  "security.safeguards.untrusted",
  "security.safeguards.floor",
  "security.safeguards.citations",
  "security.safeguards.walkthrough",
  "security.safeguards.zod",
  "security.safeguards.store",
] as const;

const REQUIRED_DATA_CLAIMS = [
  "security.data.bank",
  "security.data.reports",
  "security.data.tenancy",
  "security.data.retention",
  "security.data.auth",
] as const;

function verifySecurityPage(source: string) {
  const safeguards = region(source, "safeguards");
  const safeguardClaims = [...safeguards.matchAll(/data-claim="(security\.safeguards\.[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...safeguardClaims].sort(), [...REQUIRED_SAFEGUARDS].sort(), "missing or duplicated safeguard claim");

  const data = region(source, "data");
  const dataClaims = [...data.matchAll(/data-claim="(security\.data\.[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...dataClaims].sort(), [...REQUIRED_DATA_CLAIMS].sort(), "missing or duplicated data-protection claim");

  const disclosure = region(source, "disclosure");
  linkTo(disclosure, securityAdvisory, "Report a vulnerability", "disclosure");
  linkTo(disclosure, securityEmail, `Email ${HELLO_ADDRESS}`, "disclosure");
  linkTo(disclosure, securityPolicy, "SECURITY.md", "disclosure");
}

describe("Security and disclosure", () => {
  it("leads with the question heading, direct answer and byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>How do we handle a hostile email safely\?<\/h1>/);
    has(
      intro,
      "Every message you send us may be an attack. We treat its text, attachments and links as untrusted data, open links only inside a short-lived browser with strict limits, and let rules cap what a model can say.",
      "the intro",
    );
    has(intro, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the intro");
  });

  it("renders all six pipeline safeguards through the claims registry", () => {
    verifySecurityPage(html);
    const safeguards = region(html, "safeguards");
    const cards = [...safeguards.matchAll(/<article data-safeguard="([a-z]+)"[\s\S]*?<\/article>/g)];
    assert.equal(cards.length, 6);
    for (const phrase of [
      "Untrusted text stays data",
      "delimited untrusted blocks",
      "Hard rules set the floor",
      "never lower it below the floor",
      "Every claim cites evidence",
      "replaced by the rule-based verdict",
      "A sealed browser for links",
      "at most 8 steps and 60 seconds",
      "Validated model outputs",
      "auto mode only",
      "Meta stores and trains on nothing",
      "store: false",
    ]) {
      has(safeguards, phrase, "safeguards");
    }
  });

  it("renders all five data-protection bullets through the registry and links /privacy", () => {
    const data = region(html, "data");
    assert.equal([...data.matchAll(/<li\b/g)].length, 5);
    for (const phrase of ["AES-256-GCM", "HMAC-SHA256 and expire after 7 days", "scoped to that tenant", "expire after 30 days", "passkeys (WebAuthn)"]) {
      has(data, phrase, "data protection");
    }
    linkTo(data, site.privacy, "Privacy and POPIA page", "data protection");
  });

  it("states the disclosure scope, 3-working-day response, 3 November repository note, and all three reporting/policy links", () => {
    const disclosure = region(html, "disclosure");
    has(disclosure, "We read every report within 3 working days and credit reporters who want to be named once the fix is live.", "disclosure");
    has(
      disclosure,
      "In scope: the Worker, the report and verify pages, the mail intake pipeline, the walkthrough containment, and the tenant and bank-verification boundaries.",
      "disclosure",
    );
    const repoNote = element(disclosure, /<p data-repo-access/, "repository access note");
    has(repoNote, "Our GitHub repository opens publicly on 3 November 2026 for the hackathon submission", "repository access note");
    linkTo(repoNote, securityEmail, HELLO_ADDRESS, "repository access note");
  });

  it("links only to known addresses and fails when a safeguard, data claim or disclosure destination is removed or substituted", () => {
    for (const href of hrefs(html)) {
      assert.ok(allAddresses.includes(href) || href === "#main", `unexpected link ${href} on /security`);
    }
    assert.throws(() => verifySecurityPage(html.replace('data-claim="security.safeguards.store"', 'data-claim="security.safeguards.zod"')));
    assert.throws(() => verifySecurityPage(html.replace('data-claim="security.data.auth"', 'data-claim="security.data.bank"')));
    assert.throws(() => verifySecurityPage(html.replace(securityAdvisory, "https://github.com/rizonetech/isitlegit/issues")));
  });
});
