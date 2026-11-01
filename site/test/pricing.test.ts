// The built pricing page (D07 T06 §4, design/SPEC.md S5): the launch banner, each tier's whole price inside its own
// tier, what is included today (through the claims registry) and what is planned, the trial's end, the no-code route,
// the questions, and no checkout anywhere.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { app, HELLO_ADDRESS, inviteRequest, site, trialRequest } from "../src/lib/links.ts";
import { SABRIC_2025 } from "../src/lib/sources.ts";
import { element, has, hrefs, linkTo, page, region, text } from "./lib/page.ts";

const html = page("/pricing");
const tier = (source: string, name: string) => element(source, new RegExp(`<article data-tier="${name}"`), `${name} tier`);
const price = (source: string, name: string) => text(element(tier(source, name), /<(p|span) data-price/, `${name} price`));
// The whole price each tier must show, as one string.
const PRICES = { free: "R0", protect: "from R499 per organisation per month", msp: "from R199 per client per month" };
function checkPrices(source: string) {
  assert.ok(price(source, "free").startsWith(PRICES.free), `free tier shows "${price(source, "free")}"`);
  assert.equal(price(source, "protect"), PRICES.protect);
  assert.equal(price(source, "msp"), PRICES.msp);
  assert.ok(text(tier(source, "free")).includes("R0 per month"), "free tier lacks per month");
}

describe("Pricing", () => {
  it("leads with the launch banner and the answer, with the byline", () => {
    const intro = region(html, "intro");
    has(intro, "Free during launch", "the intro");
    assert.match(intro, /<h1[^>]*>What does IsItLegit cost\?<\/h1>/);
    has(intro, "Nobody is charged today and we do not ask for a card.", "the intro");
    has(intro, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the intro");
  });

  it("shows each tier's whole price inside its own tier", () => {
    checkPrices(html);
  });

  it("refuses a swapped price, a dropped qualifier or a changed unit", () => {
    const swapped = html.replace(">R499<", ">TMP<").replace(">R199<", ">R499<").replace(">TMP<", ">R199<");
    assert.throws(() => checkPrices(swapped));
    assert.throws(() => checkPrices(html.replace('<span class="text-muted">per client per month</span>', '<span class="text-muted">per month</span>')));
    assert.throws(() => checkPrices(html.replace(/(<article data-tier="protect"[\s\S]*?)<span class="text-muted">from<\/span>/, "$1")));
  });

  it("refuses a deleted, duplicated or substituted Protect inclusion", () => {
    const strip = (id: string) => html.replace(new RegExp(`<span data-claim="pricing\\.protect\\.${id}"`), '<span data-claim="pricing.protect.team"');
    const shown = (source: string) => [...tier(source, "protect").matchAll(/data-claim="(pricing\.protect\.[a-z]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(shown(strip("pop"))).size, 5, "a substitution leaves a duplicate");
    const items = [...tier(html, "protect").matchAll(/<li class="flex gap-8">(?:(?!<\/li>)[\s\S])*<\/li>/g)].map((m) => m[0]);
    const deleted = html.replace(items.find((item) => item.includes("pricing.protect.pop")) ?? "", "");
    assert.equal(shown(deleted).length, 5, "a deletion leaves fewer");
  });

  it("Free check: today's inclusions with their units, the planned one marked, signup and the no-code route", () => {
    const free = tier(html, "free");
    has(free, "Verdicts on mail your team forwards from its verified address or domain, with the evidence", "Free check");
    has(free, "Up to 5 checks a day per organisation", "Free check");
    has(element(free, /<li data-planned/, "planned item"), "Planned: anyone checking mail that claims to be a Protected business, up to 5 checks a day per sender", "Free check");
    linkTo(free, app.signup, "Get started free", "Free check");
    linkTo(element(free, /<p data-invite/, "invite route"), inviteRequest, `Ask for one at ${HELLO_ADDRESS}`, "Free check");
  });

  it("Protect: 14 days free, the launch price, six inclusions, what follows the trial and the trial link", () => {
    const protect = tier(html, "protect");
    has(protect, "Free for 14 days during the launch", "Protect");
    const required = ["team", "identity", "alerts", "bank", "verify", "pop"].map((id) => `pricing.protect.${id}`);
    const shown = [...protect.matchAll(/data-claim="(pricing\.protect\.[a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...shown].sort(), [...required].sort(), "the Protect inclusions are not exactly the six required, once each");
    assert.equal([...protect.matchAll(/<li\b/g)].length, 6, "an inclusion bypasses the registry");
    const after = element(protect, /<p data-after/, "after-trial line");
    has(after, "After the trial your organisation keeps Free check until billing starts.", "Protect");
    linkTo(after, trialRequest, `Ask us at ${HELLO_ADDRESS}`, "Protect");
    linkTo(protect, app.signup, "Start your 14-day trial", "Protect");
  });

  it("MSP: planned, with planned items outside the registry and Talk to us", () => {
    const msp = tier(html, "msp");
    has(msp, "Planned", "MSP");
    assert.doesNotMatch(msp, /data-claim=/, "an MSP item passes for a current feature");
    assert.equal([...msp.matchAll(/<li\b[\s\S]*?<\/li>/g)].filter((m) => text(m[0]).includes("Planned:")).length, 3);
    linkTo(msp, site.about, "Talk to us", "MSP");
  });

  it("answers the four questions, with the invite route and a sourced figure", () => {
    const questions = region(html, "questions");
    assert.equal([...questions.matchAll(/<div data-question/g)].length, 4);
    for (const q of ["Do I need a card to start?", "How do I join during the launch?", "What happens when the launch ends?", "Why is checking free?"]) {
      has(questions, q, "the questions");
    }
    linkTo(questions, inviteRequest, `ask for one at ${HELLO_ADDRESS}`, "the questions");
    has(questions, "New organisations get a 14-day trial with every feature unlocked.", "the questions");
    linkTo(questions, SABRIC_2025.url, SABRIC_2025.title, "the questions");
  });

  it("has no checkout, payment or card form", () => {
    assert.doesNotMatch(html, /<form\b|checkout|stripe|paystack|payfast|card number/i);
    for (const href of hrefs(html)) assert.match(href, /^(\/|#main$|https:\/\/|mailto:hello@isitlegit\.co\.za)/, href);
  });
});
