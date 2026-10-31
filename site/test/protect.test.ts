// The built Protect page (D07 T06 §7, design/SPEC.md S4): the scoped answer, the story, the five protections with
// their real artwork in both placements and every example cell, planned items marked, the illustration's text
// equivalent, no universal-detection promise, and the price as S5 states it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { app, demoVerify, site } from "../src/lib/links.ts";
import { SABRIC_2025 } from "../src/lib/sources.ts";
import { DIST, element, has, linkTo, page, region, text } from "./lib/page.ts";

const html = page("/protect");
const block = (id: string) => element(html, new RegExp(`<article data-block="${id}"`), `${id} block`);
const example = (id: string) => element(block(id), new RegExp(`<div class="[^"]*" data-example="${id}"`), `${id} example`);
const images = (fragment: string) => [...fragment.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

describe("Protect your business", () => {
  it("answers first, scoped to what triggers a check and what it cannot see, with the calls to action and byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>Who protects your name when a scammer uses it\?<\/h1>/);
    has(intro, "checks mail that claims to be you against what you registered, when someone forwards it, and finds lookalike websites every day.", "the intro");
    has(intro, "A fake that nobody forwards and no lookalike site shows, we do not see.", "the intro");
    assert.doesNotMatch(text(html), /every fake|catches? every|always catch/i, "the page promises universal detection");
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

  it("has the five blocks in order, each through the registry, with its example", () => {
    const ids = [...region(html, "gives").matchAll(/<article data-block="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["identity", "seal", "badge", "monitor", "bank"]);
    for (const id of ids) assert.match(block(id), new RegExp(`data-claim="protect\\.${id}"`), `${id} bypasses the registry`);
    has(example("identity"), "Verified fynbosfreight.example, mail.fynbosfreight.example", "identity example");
    has(example("identity"), "Registered Logo, used by SAM 3.1 to compare logos", "identity example");
    has(example("identity"), "Registered Bank account, never shown to anyone", "identity example");
  });

  it("seal: both placements, the dark variant, and both example rows with their status", () => {
    const seal = example("seal");
    const imgs = images(seal);
    assert.equal(imgs.length, 2, "seal example: light and dark");
    for (const img of imgs) {
      assert.match(img, /alt="Seal shown on the real domain"/);
      assert.ok(existsSync(join(DIST, /src="([^"]+)"/.exec(img)?.[1] ?? "")), `${img} does not resolve`);
    }
    has(seal, "fynbosfreight.example Shown, 26 Oct 2026", "seal example");
    has(seal, "fynbos-freight.example Blocked by the browser. You get an alert", "seal example");
  });

  it("badge: both placements and the fictional signature", () => {
    const badge = example("badge");
    assert.match(badge, /alt="Protected by IsItLegit badge in an email signature"/);
    has(badge, "Lindiwe Mokoena · Accounts, Fynbos Freight", "badge example");
    for (const address of text(badge).match(/[\w.-]+@[\w.-]+/g) ?? []) assert.match(address, /\.example$/, address);
    for (const img of images(badge)) assert.ok(existsSync(join(DIST, /src="([^"]+)"/.exec(img)?.[1] ?? "")), `${img} does not resolve`);
    assert.ok(images(region(html, "hero-art")).some((i) => i.includes("Protected by IsItLegit signature badge")));
  });

  it("monitor: three columns, three fully filled rows, and certificate watching marked planned", () => {
    const table = element(example("monitor"), /<table/, "lookalike table");
    const heads = [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
    assert.deepEqual(heads, ["Lookalike", "Found", "Status"]);
    const body = [...element(table, /<tbody/, "table body").matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => text(m[0]));
    assert.deepEqual(body, ["fynbos-freight.example Today Login form", "fynbosfreight-pay.example Yesterday Parked", "fynb0sfreight.example 21 Oct Not live"]);
    has(element(block("monitor"), /<p data-planned/, "planned note"), "Planned: we will also watch new certificates that use your name.", "the monitor block");
    const prose = text(block("monitor")).replace(/Planned: we will also watch new certificates[^.]*\./, "");
    assert.doesNotMatch(prose, /certificate/i, "certificate watching is promised outside the planned sentence");
  });

  it("bank verification: the request and both answers in text, drawn as an illustration with no controls", () => {
    const bank = example("bank");
    const equivalent = text(element(bank, /<p data-illustration-text/, "text equivalent"));
    for (const words of ["Did Fynbos Freight change its bank account?", "An invoice in your name lists an account that does not match your registered one.", "No, this is not us", "Yes, we changed it"]) {
      assert.ok(equivalent.includes(words), `the text equivalent lacks "${words}"`);
    }
    const drawn = element(bank, /<div aria-hidden="true" data-illustration/, "illustration");
    for (const words of ["No, this is not us", "Yes, we changed it"]) has(drawn, words, "the illustration");
    assert.doesNotMatch(bank, /<(button|input|select|textarea|form)\b/, "the illustration holds a control");
    assert.doesNotMatch(drawn, /<a\b/, "the illustration holds a link");
    has(element(bank, /<p data-caption/, "caption"), "the real request is answered by email reply", "the illustration");
  });

  it("closes with the price as the pricing page states it, and both links", () => {
    const closing = region(html, "closing");
    has(closing, "Protect is free for 14 days during the launch. After launch it starts at R499 per organisation per month.", "the closing");
    has(closing, "Checking mail stays free for the people who receive it.", "the closing");
    linkTo(closing, app.signup, "Protect my business", "the closing");
    linkTo(closing, site.pricing, "See pricing", "the closing");
  });
});
