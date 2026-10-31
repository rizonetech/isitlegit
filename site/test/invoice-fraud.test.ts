// The built invoice fraud page (D07 T06 §3, design/SPEC.md S3): the answer and the one rule, the fictional invoice,
// every figure beside its primary source, the catch, the payment document check with its limit, and the close.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { app, site } from "../src/lib/links.ts";
import { IC3_2025, invoiceFigures, SABRIC_2025, SABRIC_POP_QUOTE, SABRIC_QUOTE } from "../src/lib/sources.ts";
import { element, has, hrefs, linkTo, page, region, text } from "./lib/page.ts";

const html = page("/invoice-fraud");

describe("Invoice fraud", () => {
  it("answers what it is, gives the one rule and the byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>What is invoice fraud\?<\/h1>/);
    has(intro, "the bank account belongs to a criminal", "the intro");
    has(element(intro, /<div data-rule/, "rule"), "phone the supplier on the number you already have. Never use the number in the email.", "the rule");
    has(intro, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the intro");
  });

  it("shows a fictional invoice with the E4 callout, and nothing real in it", () => {
    const invoice = region(html, "sample-invoice");
    for (const words of ["Fynbos Freight", "INV-20931", "R53,130.00", "Please note our NEW banking details", "Fictional Bank", "E4 · Critical", "account ending 4417", "A fictional invoice from a fictional supplier"]) {
      has(invoice, words, "the sample invoice");
    }
    for (const domain of text(invoice).match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi)?.filter((d) => /[a-z]/i.test(d) && !/^\d/.test(d)) ?? []) {
      assert.match(domain, /\.example$/, domain);
    }
  });

  it("prints every figure beside its primary source, with the quote and no 'worldwide'", () => {
    const figures = region(html, "figures");
    for (const figure of invoiceFigures) {
      has(figures, figure.text, "the figures");
      assert.ok(hrefs(figures).includes(figure.source.url), `${figure.text} has no link to ${figure.source.url}`);
    }
    has(figures, `"${SABRIC_QUOTE}" SABRIC, Annual Crime Statistics 2025, page 9`, "the figures");
    linkTo(figures, SABRIC_2025.url, SABRIC_2025.title, "the figures");
    linkTo(figures, IC3_2025.url, IC3_2025.title, "the figures");
    has(figures, "nine participating banks", "the figures");
    assert.ok(!text(html).toLowerCase().includes("worldwide"), "the page says worldwide");
  });

  it("explains the catch in three steps", () => {
    const items = [...region(html, "catch").matchAll(/<li\b[\s\S]*?<\/li>/g)].map((m) => m[0]);
    for (const item of items) assert.match(item, /^<li class="rounded-card border border-line bg-surface/, "a step is not in its card");
    const steps = items.map(text);
    assert.equal(steps.length, 3);
    assert.match(steps[0], /^01 Read the invoice Muse Spark reads every page/);
    assert.match(steps[1], /^02 Compare with your ledger Your supplier ledger/);
    assert.match(steps[2], /^03 Tell you to phone first The report always gives the same instruction/);
  });

  it("explains the payment document check, its four signs, its limit and a sample", () => {
    const pop = region(html, "pop");
    has(pop, `"${SABRIC_POP_QUOTE}"`, "the payment document check");
    linkTo(pop, SABRIC_2025.url, "page 9", "the payment document check");
    assert.equal([...pop.matchAll(/<li>/g)].length, 4);
    has(element(pop, /<p data-limit/, "limit"), "It cannot prove that money was paid", "the limit");
    has(region(html, "sample-pop"), "This proof of payment was edited after it was created.", "the sample");
    has(region(html, "sample-pop"), "A sample report on a fictional document", "the sample");
  });

  it("closes with sign-up and the protect page", () => {
    const closing = region(html, "closing");
    has(closing, "Paying a supplier today? Check the invoice first.", "the closing");
    linkTo(closing, app.signup, "Get started free", "the closing");
    linkTo(closing, site.protect, "Protect your own business", "the closing");
  });
});
