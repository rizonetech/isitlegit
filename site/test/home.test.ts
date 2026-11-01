// The built home page (D07 T06 §2, design/SPEC.md S1, P3, P4): every region holds its content, every link goes where
// `links.ts` says, every figure sits beside its primary source, and every image resolves. Run after the site build.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allAddresses, app, CHECK_ADDRESS, companyLinks, productLinks, site } from "../src/lib/links.ts";
import { band, readResults } from "../src/lib/results.ts";
import { DIST, element, has, hrefs, linkTo, page, region as regionOf, text } from "./lib/page.ts";
import { homeFigures, IC3_2025, INTERPOL_AFRICA_2025, INTERPOL_QUOTE, SABRIC_2025, SABRIC_QUOTE } from "../src/lib/sources.ts";

const html = page("/");
const region = (name: string) => regionOf(html, name);

describe("links", () => {
  it("go only to the addresses links.ts names, the sources, or a page fragment", () => {
    const sources = [SABRIC_2025.url, IC3_2025.url, INTERPOL_AFRICA_2025.url];
    for (const href of hrefs(html)) {
      assert.ok(allAddresses.includes(href) || sources.includes(href) || href === "#main", `unexpected link ${href}`);
    }
  });

  it("leave the site only over https", () => {
    for (const href of hrefs(html)) if (/^[a-z]+:/i.test(href)) assert.match(href, /^https:\/\//, href);
  });

  it("keep isitlegit.co.za/eval working by sending it to the app's Results page", () => {
    assert.match(readFileSync(join(DIST, "_redirects"), "utf8"), /^\/eval https:\/\/app\.isitlegit\.co\.za\/eval 302$/m);
    assert.equal(app.results, "https://app.isitlegit.co.za/eval");
  });
});

describe("the header and footer", () => {
  const header = element(html, /<header\b/, "header");
  const footer = element(html, /<footer class="bg-dark/, "footer");

  it("header: logo home, the five product links, Sign in and Get started free", () => {
    assert.match(header, /<a href="\/"[^>]*>\s*<img [^>]*alt="IsItLegit home"/);
    const nav = element(header, /<nav aria-label="Site"/, "site nav");
    for (const link of productLinks) linkTo(nav, link.href, link.label, "the site nav");
    linkTo(header, app.signin, "Sign in", "the header");
    linkTo(header, app.signup, "Get started free", "the header");
  });

  it("phone header: Get started and a menu button whose popover holds every link", () => {
    linkTo(header, app.signup, "Get started", "the header");
    assert.match(header, /<button[^>]*popovertarget="site-menu"[^>]*aria-label="Open menu"/);
    const menu = element(header, /<nav id="site-menu" popover/, "phone menu");
    for (const link of productLinks) linkTo(menu, link.href, link.label, "the phone menu");
    linkTo(menu, app.signin, "Sign in", "the phone menu");
    assert.match(menu, /popovertargetaction="hide"[^>]*aria-label="Close menu"/);
  });

  it("footer: logo, check@ line, both link lists, Built on and both closing lines", () => {
    assert.match(footer, /<img [^>]*alt="IsItLegit"/);
    has(footer, `Forward a suspicious email to ${CHECK_ADDRESS}`, "the footer");
    const product = element(footer, /<nav aria-label="Product"/, "product links");
    for (const link of productLinks) linkTo(product, link.href, link.label, "the footer's Product list");
    const company = element(footer, /<nav aria-label="Company"/, "company links");
    for (const link of companyLinks) linkTo(company, link.href, link.label, "the footer's Company list");
    has(footer, "Meta's Muse Spark, Muse Wonder, SAM 3.1 and Muse Voice Transcribe", "the footer");
    has(footer, "Cloudflare Workers", "the footer");
    has(footer, "© 2026 Rizonetech (Pty) Ltd · George, South Africa", "the footer");
    has(footer, "IsItLegit by Rizonetech · Built for the Meta Global AI Developer Hackathon", "the footer");
  });
});

describe("the hero", () => {
  const hero = region("hero");

  it("answers first: eyebrow, the one h1 and the supporting line, with no unmeasured figure", () => {
    assert.equal(html.match(/<h1\b/g)?.length, 1);
    assert.match(hero, /<h1[^>]*>Is it legit\?<br>Ask before you pay\.<\/h1>/);
    has(hero, "For South African small businesses", "the hero");
    has(hero, "Forward any suspicious email, invoice or proof of payment.", "the hero");
  });

  it("gives the address as text, a hidden Copy address button, the upload link and the launch line", () => {
    assert.match(hero, new RegExp(`id="check-address"[^>]*>${CHECK_ADDRESS}<`));
    assert.match(hero, /<button type="button" hidden data-copy="check@isitlegit\.co\.za" data-status="copy-status"/);
    assert.match(hero, /id="copy-status" aria-live="polite"/);
    linkTo(hero, app.upload, "upload a file", "the hero");
    has(hero, "Free during launch · No card needed", "the hero");
  });

  it("says to sign up first, because the app answers only verified senders", () => {
    const line = element(hero, /<p data-membership/, "membership line");
    linkTo(line, app.signup, "Sign up first", "the membership line");
    has(line, "we answer mail from the address or domain you verify", "the membership line");
  });

  it("shows the sample report: verdict, action, three reasons and the fictional caption", () => {
    const card = region("sample-report");
    has(card, "Malicious", "the sample report");
    has(card, "The bank details on this invoice are not Fynbos Freight's.", "the sample report");
    has(card, "What to do now Phone Fynbos Freight on the number in your own records before you pay anything.", "the sample report");
    has(card, "E4 The account number differs from the one Fynbos Freight registered.", "the sample report");
    has(card, "E2 Sent from fynbos-freight.example, registered 6 days ago.", "the sample report");
    has(card, "E6 The PDF was edited after it was created.", "the sample report");
    has(card, "A sample report on fictional companies", "the sample report");
    for (const domain of text(card).match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) ?? []) assert.match(domain, /\.example$/);
  });
});

describe("the figures", () => {
  it("every figure sits in its region beside a link to its primary source", () => {
    for (const figure of homeFigures) {
      const where = figure.source === SABRIC_2025 ? region("figures") : region("threats");
      has(where, figure.text, `the region citing ${figure.source.title}`);
      assert.ok(hrefs(where).includes(figure.source.url), `${figure.text} has no link to ${figure.source.url}`);
    }
  });

  it("SABRIC: the three figures with their lines, the page 9 quote, the source line and the byline", () => {
    const figures = region("figures");
    has(figures, "R2.4 billion in reported client claims, up 29.2% on 2024", "the figures");
    has(figures, "110,074 incidents, more than double the 52,588 of 2023", "the figures");
    has(figures, "R21,865 lost on average, per incident", "the figures");
    has(figures, `"${SABRIC_QUOTE}" SABRIC, Annual Crime Statistics 2025, page 9`, "the figures");
    has(figures, "nine participating banks in 2025", "the figures");
    linkTo(figures, SABRIC_2025.url, "Read the report", "the figures");
    has(figures, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the figures");
  });

  it("FBI and INTERPOL: the figures as the reports state them, and the quote", () => {
    const threats = region("threats");
    has(threats, "more than US$3 billion in 2025, across 24,768 complaints reported to the FBI's IC3", "the threats");
    has(threats, `"${INTERPOL_QUOTE}" in Africa`, "the threats");
    linkTo(threats, IC3_2025.url, IC3_2025.title, "the threats");
    linkTo(threats, INTERPOL_AFRICA_2025.url, INTERPOL_AFRICA_2025.title, "the threats");
  });

  it("prints none of the board's unsourced wording", () => {
    for (const phrase of ["worldwide", "about a minute", "Eight checks"]) {
      assert.ok(!text(html).toLowerCase().includes(phrase.toLowerCase()), `"${phrase}" is on the page`);
    }
  });
});

describe("the sections", () => {
  it("What it catches: three cards, each with its label, heading and paragraph", () => {
    const cards = [...region("threats").matchAll(/<article\b[\s\S]*?<\/article>/g)].map((m) => text(m[0]));
    assert.equal(cards.length, 3);
    assert.match(cards[0], /^Phishing Fake logins and lures Mail that copies a brand/);
    assert.match(cards[1], /^Invoice fraud Changed bank details A real-looking invoice/);
    assert.match(cards[2], /^Impersonation Someone pretending to be you Mail sent to your customers/);
  });

  it("How it works: three steps with their text, the four model cards and the phone link", () => {
    const steps = region("steps");
    const items = [...steps.matchAll(/<li\b[\s\S]*?<\/li>/g)].map((m) => text(m[0]));
    assert.equal(items.length, 3);
    assert.match(items[0], /^01 Forward as an attachment From Outlook or Gmail to check@isitlegit\.co\.za/);
    assert.match(items[0], /Sign up first: we answer mail from the address or domain you verify\./);
    assert.match(items[1], /^02 Checks first, then four Meta models Sender authentication/);
    assert.match(items[2], /^03 A verdict you can check Safe, suspicious or malicious/);
    const models = text(region("models"));
    for (const [name, words] of [
      ["Muse Spark", "writes the cited verdict"],
      ["Muse Wonder", "typing only harmless test values"],
      ["SAM 3.1", "compares them with the real ones"],
      ["Muse Voice Transcribe", "into words we can check"],
    ]) {
      assert.match(models, new RegExp(`${name} [^.]*${words}`));
    }
    assert.match(steps, new RegExp(`<a href="${site.howItWorks}" data-phone-how class="md:hidden`));
  });

  it("Protect your business: the seal and badge with alt text and How protection works", () => {
    const protect = region("protect");
    assert.match(protect, /<img [^>]*alt="The IsItLegit Protected seal"/);
    assert.match(protect, /<img [^>]*alt="Protected by IsItLegit signature badge"/);
    linkTo(protect, site.protect, "How protection works", "Protect your business");
  });

  it("Protect your business reads heading, seal, explanation, then the action, as the phone board orders it", () => {
    const protect = region("protect");
    const at = (needle: string) => protect.indexOf(needle);
    const order = [at('id="protect-title"'), at('alt="The IsItLegit Protected seal"'), at("Register your real domains"), at(`href="${site.protect}"`)];
    assert.ok(order.every((n) => n >= 0), `a piece is missing: ${order.join(", ")}`);
    assert.deepEqual([...order].sort((x, y) => x - y), order, "the protection block is out of the board's order");
    assert.match(protect, new RegExp(`<a href="${site.protect}" class="w-full lg:w-auto`), "the action is not full width on a phone");
  });

  it("Measured, not claimed: the eval's numbers when its summary exists, the placeholders while it does not", () => {
    const results = region("results");
    const shown = band(readResults());
    for (const value of [`${shown.detection} phishing caught`, `${shown.falseAlarms} false alarms`, `${shown.median} median to verdict`, `${shown.samples} labelled samples`]) {
      has(results, value, "the results band");
    }
    if (shown.date) has(results, `Latest run: ${shown.date}.`, "the results band");
    else assert.ok(!text(results).includes("Latest run"), "a run date shows with no summary");
    linkTo(results, app.results, "See the results", "the results band");
  });

  it("closing: the line, the pricing sentence and both links", () => {
    const closing = region("closing");
    has(closing, "The next fake invoice is already on its way. Check it first.", "the closing");
    has(closing, "Free during launch. Protect from R499 per month after launch.", "the closing");
    linkTo(closing, app.signup, "Get started free", "the closing");
    linkTo(closing, site.pricing, "See pricing", "the closing");
  });
});

describe("images", () => {
  it("every image has alt text and resolves to a built file", () => {
    const images = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(images.length >= 6, `only ${images.length} images`);
    for (const img of images) {
      assert.match(img, /\balt="[^"]*"/, img);
      const src = /\bsrc="([^"]+)"/.exec(img)?.[1] ?? "";
      assert.ok(src.startsWith("/") && existsSync(join(DIST, src)), `${src} is not in site/dist`);
    }
    for (const img of images.filter((i) => !i.includes('src="/_astro/malicious'))) assert.doesNotMatch(img, /\balt=""/, img);
  });
});

describe("the one-step demo (D07 T06 §10)", () => {
  const demo = () => region("demo");

  it("is a native disclosure with one control, labelled as a fictional sample, and no sign-up step inside", () => {
    const d = demo();
    assert.match(d, /^<details/, "the demo is not a details element");
    has(d, "See a sample check", "the demo control");
    has(d, "A prewritten example on a fictional email, not a live analysis: nothing runs when you open this", "the demo label");
    has(d, "nothing is sent or stored", "the demo label");
    assert.doesNotMatch(d, /<(form|input|textarea|select)\b/i, "the demo asks for input");
    assert.deepEqual(hrefs(d), [], "the demo links away before it has shown its verdict");
  });

  it("walks the three checks in order and ends on the same verdict and action as the sample report card", () => {
    const d = demo();
    const order = ["Who sent it.", "The PDF.", "The bank account."].map((label) => d.indexOf(label));
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "the checks are missing or out of order");
    for (const line of [
      "Sent from fynbos-freight.example, registered 6 days ago.",
      "The PDF was edited after it was created.",
      "The account number differs from the one Fynbos Freight registered.",
    ]) {
      has(d, line, "the demo");
      has(region("sample-report"), line, "the sample report card");
    }
    has(d, "Verdict: Malicious.", "the demo verdict");
    has(d, "Phone Fynbos Freight on the number in your own records before you pay anything.", "the demo action");
    has(d, "A real check needs sign-up first.", "the demo says real mail needs membership");
  });
});
