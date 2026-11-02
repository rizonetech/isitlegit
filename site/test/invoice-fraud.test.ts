// The built invoice fraud page (D07 T06 §3, design/SPEC.md S3): the answer and the one rule, the fictional invoice,
// every figure beside its primary source, the payment document check with its proven signs, and the close.
// Proven-only (D07 T06 §20): the catch section and the limit box are omitted while their claims are unstamped.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claims } from "../src/lib/claims.ts";
import { app, site } from "../src/lib/links.ts";
import {
  FBI_BEC,
  IC3_2025,
  invoiceFigures,
  SABRIC_2025,
  SABRIC_POP_QUOTE,
  SABRIC_QUOTE,
  SABRIC_STAY_SAFE,
  SAPS_REPORT_CRIME,
} from "../src/lib/sources.ts";
import { element, has, hrefs, linkTo, page, region, text } from "./lib/page.ts";
import { proven, provenIds } from "./lib/proven.ts";

const html = page("/invoice-fraud");

describe("Invoice fraud", () => {
  it("answers what it is, gives the one rule and the byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>What is invoice fraud\?<\/h1>/);
    has(intro, "the bank account belongs to a criminal", "the intro");
    has(element(intro, /<div data-rule/, "rule"), "phone the supplier on the number you already have. Never use the number in the email.", "the rule");
    has(intro, "By Derick Payne, Rizonetech · Reviewed 2 Nov 2026", "the intro");
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

  it("shows the catch section with the proven steps, omitting what is unproven", () => {
    const steps = [
      ["01", "Read the invoice", "Muse Spark reads every page", "invoice.read"],
      ["02", "Compare with your ledger", "Your supplier ledger", "invoice.ledger"],
      ["03", "Tell you to phone first", "The report always gives the same instruction", "invoice.phone"],
    ] as const;
    const shown = steps.filter(([, , , id]) => proven(id));
    if (proven("invoice.catch") || shown.length > 0) {
      const catchRegion = region(html, "catch");
      has(catchRegion, proven("invoice.catch") ? "How does IsItLegit catch a changed bank account?" : "Invoice checks", "the catch heading");
      if (proven("invoice.catch")) assert.doesNotMatch(text(catchRegion), /^Invoice checks$/m, "both catch headings are published");
      const items = [...catchRegion.matchAll(/<li\b[\s\S]*?<\/li>/g)].map((m) => text(m[0]));
      assert.equal(items.length, shown.length);
      for (let i = 0; i < shown.length; i++) assert.match(items[i], new RegExp(`^${shown[i][0]} ${shown[i][1]} ${shown[i][2]}`));
      if (!proven("invoice.catch")) assert.doesNotMatch(text(html), /It reads the invoice, pulls out the bank details/, "the unproven catch is published");
    } else {
      assert.doesNotMatch(html, /data-region="catch"/, "the unproven catch section is published");
      assert.doesNotMatch(text(html), /It reads the invoice, pulls out the bank details/, "the unproven catch is published");
    }
    for (const [, title, , id] of steps.filter(([, , , id]) => !proven(id))) {
      assert.doesNotMatch(html, new RegExp(`<h3 class="type-h3">${title}</h3>`), `unproven step "${title}" is published`);
      assert.doesNotMatch(html, new RegExp(`data-claim="${id}"`), `unproven claim ${id} is published`);
    }
    if (!proven("invoice.catch")) {
      assert.doesNotMatch(text(html), /How does IsItLegit catch a changed bank account\?/, "the unproven catch heading is published");
    }
  });

  it("explains the payment document check, its proven signs, the proven limit and a sample", () => {
    const pop = region(html, "pop");
    has(pop, `"${SABRIC_POP_QUOTE}"`, "the payment document check");
    linkTo(pop, SABRIC_2025.url, "page 9", "the payment document check");
    has(pop, "These are the signs of editing we check a payment document for:", "the signs intro");
    const signs = provenIds(["invoice.sign.edits", "invoice.sign.fonts", "invoice.sign.dates", "invoice.sign.layout"] as const);
    assert.equal([...pop.matchAll(/<li>/g)].length, signs.length);
    for (const id of signs) has(pop, claims[id].text, "the signs");
    for (const id of ["invoice.sign.edits", "invoice.sign.fonts", "invoice.sign.dates", "invoice.sign.layout"] as const) {
      if (!proven(id)) assert.doesNotMatch(pop, new RegExp(claims[id].text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `unproven sign ${id} is published`);
    }
    if (proven("invoice.limit")) has(element(pop, /<p data-limit/, "limit"), "It cannot prove that money was paid", "the limit");
    else assert.doesNotMatch(html, /data-limit/, "the unproven limit box is published");
    has(region(html, "sample-pop"), "This proof of payment was edited after it was created.", "the sample");
    has(region(html, "sample-pop"), "A sample report on a fictional document", "the sample");
  });

  it("already paid: four steps in order, each beside its source, reached from the opening", () => {
    linkTo(region(html, "intro"), "#already-paid", "Already paid", "the opening");
    const recovery = region(html, "recovery");
    assert.match(recovery, /<h2 id="already-paid"[^>]*>/, "the recovery heading is not labelled");
    const steps = [...recovery.matchAll(/<li data-step[\s>]([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? "");
    assert.equal(steps.length, 4, "the recovery steps are not four list items");
    const expected: [string, string][] = [
      ["Phone your bank's fraud line now", SABRIC_STAY_SAFE.url],
      ["Keep the email and the documents", FBI_BEC.url],
      ["nearest South African Police Service station", SAPS_REPORT_CRIME.url],
      ["Warn the real supplier", FBI_BEC.url],
    ];
    for (const [i, [words, url]] of expected.entries()) {
      assert.ok(text(steps[i] ?? "").includes(words), `step ${i + 1} is not "${words}"`);
      assert.ok(hrefs(steps[i] ?? "").includes(url), `step ${i + 1} has no link to its source`);
    }
    has(recovery, "keep the case (CAS) reference", "the SAPS step");
  });

  it("closes with sign-up and the protect page", () => {
    const closing = region(html, "closing");
    has(closing, "Paying a supplier today? Check the invoice first.", "the closing");
    linkTo(closing, app.signup, "Get started free", "the closing");
    linkTo(closing, site.protect, "Protect your own business", "the closing");
  });
});
