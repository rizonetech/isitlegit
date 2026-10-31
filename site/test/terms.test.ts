// The built terms page (D07 T06 §8, design/SPEC.md S7): plain-language launch rules, the awaiting-review draft state
// (and `termsStatus` approved state), all six anchored sections, the partial-report vs daily-cap refusal distinction,
// the on-page update rule, and negative checks that fail when a section or distinction is removed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allAddresses, contact, HELLO_ADDRESS, inviteRequest } from "../src/lib/links.ts";
import { TERMS_REVIEWED_ON, termsStatus } from "../src/lib/terms.ts";
import { element, has, hrefs, linkTo, page, region, text } from "./lib/page.ts";

const html = page("/terms");

const REQUIRED_SECTIONS = [
  { region: "service", id: "service-title", heading: "What is the service?" },
  { region: "verdicts", id: "verdicts-title", heading: "What is a verdict, and what is it not?" },
  { region: "you", id: "you-title", heading: "What we ask of you" },
  { region: "protect", id: "protect-title", heading: "Protected businesses and bank details" },
  { region: "limits", id: "limits-title", heading: "Service levels and liability" },
  { region: "changes", id: "changes-title", heading: "Changes, governing law and contact" },
] as const;

function verifyTermsStructure(source: string) {
  const toc = element(source, /<nav aria-label="On this page"/, "contents");
  const anchors = hrefs(toc);
  assert.deepEqual(
    anchors,
    REQUIRED_SECTIONS.map((s) => `#${s.id}`),
  );
  for (const s of REQUIRED_SECTIONS) {
    const sec = region(source, s.region);
    assert.match(sec, new RegExp(`<h2 id="${s.id}" tabindex="-1"[^>]*>${s.heading.replace("?", "\\?")}<\\/h2>`));
  }
  const limits = text(region(source, "limits"));
  assert.match(limits, /model is unavailable or a model spend cap is reached, you receive a report marked partial/);
  assert.match(limits, /daily check limit \(5 checks a day on Free check, 50 during the 14-day trial\), further checks are refused until midnight South African time/);
}

describe("Terms of use", () => {
  it("leads with the question heading, direct answer, the dated reviewed badge, byline and six resolving anchors", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>What are the rules for using IsItLegit\?<\/h1>/);
    has(intro, "Forward mail your business received or was asked to act on. Treat a verdict as evidence for your decision, not a guarantee. During the launch the service is free.", "the intro");
    has(intro, "Rizonetech (Pty) Ltd · Last updated 31 Oct 2026 · By Derick Payne, Rizonetech", "the intro");
    const draft = element(intro, /<span[^>]*data-draft=/, "draft badge");
    assert.equal(TERMS_REVIEWED_ON, "1 Nov 2026");
    assert.match(draft, /data-draft="false"/);
    has(draft, "Reviewed by Rizonetech on 1 Nov 2026", "reviewed badge");
    assert.doesNotMatch(text(html), /awaiting Rizonetech review|Draft for the launch period/i, "the page still shows the draft marker after approval");
    verifyTermsStructure(html);
  });

  it("supports both the awaiting-review draft state and the dated approved state in termsStatus", () => {
    assert.deepEqual(termsStatus(null), {
      draft: true,
      badge: "Draft for the launch period; awaiting Rizonetech review",
    });
    assert.deepEqual(termsStatus("   "), {
      draft: true,
      badge: "Draft for the launch period; awaiting Rizonetech review",
    });
    assert.deepEqual(termsStatus("31 Oct 2026"), {
      draft: false,
      badge: "Reviewed by Rizonetech on 31 Oct 2026",
    });
  });

  it("renders all six product claims through the registry and discloses the invite-code requirement", () => {
    const claims = [...html.matchAll(/data-claim="(terms\.[a-z.]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      [...claims].sort(),
      ["terms.limits.partial", "terms.protect.bank", "terms.service", "terms.you.authority", "terms.you.limits", "terms.you.mail"],
    );
    const service = region(html, "service");
    has(service, "Rizonetech (Pty) Ltd in George, South Africa", "service");
    const invite = element(service, /<p data-invite/, "invite line");
    has(invite, "sign-up requires an invite code", "invite line");
    linkTo(invite, inviteRequest, HELLO_ADDRESS, "invite line");
  });

  it("explains what a verdict is and is not, and keeps the phone-first bank rule", () => {
    const verdicts = region(html, "verdicts");
    has(verdicts, "evidence to help your team decide what to do next", "verdicts");
    has(verdicts, "not financial, legal or banking advice", "verdicts");
    has(verdicts, "verify the change on a phone number from your own records before you pay", "verdicts");
  });

  it("distinguishes a partial report on model unavailability from check refusal at the 50-check daily limit", () => {
    const limits = region(html, "limits");
    has(limits, "When a model is unavailable or a model spend cap is reached, you receive a report marked partial rather than a guess", "limits");
    has(limits, "when your organisation reaches its daily check limit (5 checks a day on Free check, 50 during the 14-day trial), further checks are refused until midnight South African time", "limits");
    has(limits, "limited to direct damages and to the amount you paid us for the service in the twelve months before the claim (which during the free launch is R0)", "limits");
  });

  it("states the South African governing law, on-page update rule with no unowned broadcast promise, and contact address", () => {
    const changes = region(html, "changes");
    has(changes, "governed by the laws of the Republic of South Africa", "changes");
    has(changes, "Updates to these free launch terms are published on this page with an updated date.", "changes");
    has(changes, "if paid plans are introduced later, they will require a separate commercial agreement and opt-in before any charge applies", "changes");
    linkTo(changes, contact, HELLO_ADDRESS, "changes");
  });

  it("links only to known addresses or in-page section anchors, and fails when a section or the partial/refusal distinction is removed", () => {
    const validAnchors = new Set(["#main", ...REQUIRED_SECTIONS.map((s) => `#${s.id}`)]);
    for (const href of hrefs(html)) {
      assert.ok(allAddresses.includes(href) || validAnchors.has(href), `unexpected link ${href} on /terms`);
    }
    assert.throws(() => verifyTermsStructure(html.replace('id="limits-title"', 'id="dropped-title"')));
    assert.throws(() => verifyTermsStructure(html.replace("further checks are refused until midnight South African time", "you get a partial report")));
  });
});
