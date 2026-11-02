// The built Protect page (D07 T06 §7, design/SPEC.md S4): the scoped answer, the story, no universal-detection or
// unsupported exclusivity promise, invite-only disclosure before both CTAs, and the orange-wash horizontal closing
// band. Proven-only (D07 T06 §20): the five protection blocks are omitted while their claims are unstamped.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { app, demoVerify, HELLO_ADDRESS, inviteRequest, site } from "../src/lib/links.ts";
import { SABRIC_2025 } from "../src/lib/sources.ts";
import { DIST, element, has, linkTo, page, region, text } from "./lib/page.ts";

const html = page("/protect");
const images = (fragment: string) => [...fragment.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

describe("Protect your business", () => {
  it("answers first, scoped to what triggers a check and what it cannot see, with the invite notice, calls to action and byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>Who protects your name when a scammer uses it\?<\/h1>/);
    has(intro, "Your own mail filter never sees an email a scammer sends to your customers or suppliers in your name.", "the intro");
    has(intro, "A fake that nobody forwards and no lookalike site shows, we do not see.", "the intro");
    assert.doesNotMatch(text(intro), /checks mail that claims to be you against what you registered/, "the unproven answer is published");
    assert.doesNotMatch(text(html), /every fake|catches? every|always catch/i, "the page promises universal detection");
    assert.doesNotMatch(text(html), /nothing protects/i, "the page claims nothing else protects businesses");
    const invite = element(intro, /<p data-invite/, "intro invite notice");
    has(invite, "Members join with an invite code during the launch.", "the intro invite notice");
    linkTo(invite, inviteRequest, `Ask for one at ${HELLO_ADDRESS}`, "the intro invite notice");
    assert.ok(intro.indexOf('data-invite') < intro.indexOf(`href="${app.signup}"`), "the intro invite notice must precede the signup CTA");
    linkTo(intro, app.signup, "Protect my business", "the intro");
    linkTo(intro, demoVerify, "See a verify page", "the intro");
    has(intro, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the intro");
  });

  it("puts the real seal and badge in the hero, the seal in its dark variant too, each resolving to a built file", () => {
    const art = images(region(html, "hero-art"));
    assert.equal(art.length, 3, "hero artwork: light seal, dark seal, badge");
    assert.equal(art.filter((i) => i.includes('alt="The IsItLegit Protected seal"')).length, 2);
    assert.ok(art.some((i) => /dark:hidden/.test(i)) && art.some((i) => /hidden[^"]*dark:block/.test(i)), "the seal has no theme variants");
    assert.ok(art.some((i) => i.includes('alt="Protected by IsItLegit signature badge"')));
    for (const img of art) assert.ok(existsSync(join(DIST, /src="([^"]+)"/.exec(img)?.[1] ?? "")), `${img} does not resolve`);
  });

  it("tells the story with a fictional email, every address .example", () => {
    const why = region(html, "why");
    has(why, "Why did we build this?", "the story");
    has(why, "We tell the story here with a fictional name: Fynbos Freight.", "the story");
    linkTo(why, SABRIC_2025.url, SABRIC_2025.title, "the story");
    const email = region(html, "story-email");
    for (const words of ["From", "Fynbos Freight Accounts", "accounts@karoocouriers.example", "Please send our latest statement", "Not from Fynbos Freight", "only sends from fynbosfreight.example"]) has(email, words, "the story email");
    for (const address of text(email).match(/[\w.-]+@[\w.-]+/g) ?? []) assert.match(address, /\.example$/, address);
  });

  it("omits the five protection blocks while their claims are unproven", () => {
    assert.doesNotMatch(html, /data-region="gives"/, "the unproven protections section is published");
    for (const id of ["identity", "seal", "badge", "monitor", "bank"]) {
      assert.doesNotMatch(html, new RegExp(`data-block="${id}"`), `unproven block ${id} is published`);
      assert.doesNotMatch(html, new RegExp(`data-claim="protect\\.${id}"`), `unproven claim protect.${id} is published`);
    }
    for (const words of ["Register who you really are", "A seal that only works on your website", "Find the fake website before the fake email", "Changed bank details get confirmed by you"]) {
      assert.doesNotMatch(text(html), new RegExp(words), `unproven block title "${words}" is published`);
    }
  });

  it("closes with the orange-wash horizontal price band, invite notice before the CTA, and both links", () => {
    const closing = region(html, "closing");
    assert.match(closing, /bg-orange-wash/);
    assert.match(closing, /lg:flex-row[^"]*lg:items-center[^"]*lg:justify-between/);
    has(closing, "Protect is free for 14 days during the launch. After launch it starts at R499 per organisation per month.", "the closing");
    has(closing, "Checking mail stays free for the people who receive it.", "the closing");
    const invite = element(closing, /<p data-invite/, "closing invite notice");
    has(invite, "Members join with an invite code during the launch.", "the closing invite notice");
    linkTo(invite, inviteRequest, `Ask for one at ${HELLO_ADDRESS}`, "the closing invite notice");
    assert.ok(closing.indexOf('data-invite') < closing.indexOf(`href="${app.signup}"`), "the closing invite notice must precede the signup CTA");
    linkTo(closing, app.signup, "Protect my business", "the closing");
    linkTo(closing, site.pricing, "See pricing", "the closing");
  });
});
