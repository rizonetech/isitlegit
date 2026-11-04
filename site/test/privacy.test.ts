// The built privacy page (D07 T06 §5, design/SPEC.md S6): who is responsible, what is processed and why, retention,
// the five processors, protected details and rights. Data statements come from the claims registry; the page must not
// contradict itself (Fireworks and training), mention removed things, or promise what no section ships.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claims } from "../src/lib/claims.ts";
import { contact, HELLO_ADDRESS } from "../src/lib/links.ts";
import { FIREWORKS_DATA, INFOREG_COMPLAINTS, INFOREG_POPIA } from "../src/lib/sources.ts";
import { element, has, hrefs, linkTo, page, region, text } from "./lib/page.ts";
import { proven } from "./lib/proven.ts";

const html = page("/privacy");
const rows = (fragment: string) => [...fragment.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => text(m[0]));

describe("Privacy and POPIA", () => {
  it("answers first, with the summary, the byline and every anchor resolving", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>What happens to the email you forward\?<\/h1>/);
    has(intro, "The email and its attachments are deleted after 30 days; the pictures and text we derive from it stay with the case.", "the intro");
    has(intro, "Rizonetech (Pty) Ltd · Last updated 31 Oct 2026 · By Derick Payne, Rizonetech", "the intro");
    const toc = element(html, /<nav aria-label="On this page"/, "contents");
    const anchors = hrefs(toc);
    assert.equal(anchors.length, 6);
    for (const anchor of anchors) assert.match(html, new RegExp(`<h2 id="${anchor.slice(1)}" tabindex="-1"`), `${anchor} has no focusable heading`);
  });

  it("names the responsible party and the Information Officer with a working address", () => {
    const who = region(html, "who");
    has(who, "Rizonetech (Pty) Ltd in George runs IsItLegit and is the responsible party under the Protection of Personal Information Act (POPIA).", "who");
    has(who, "Our Information Officer is Derick Payne, reachable at hello@isitlegit.co.za.", "who");
    linkTo(who, contact, HELLO_ADDRESS, "who");
  });

  it("lists the proven purposes and the training statement, apart from production screening", () => {
    const what = region(html, "what");
    const purposes: ["privacy.what.mail" | "privacy.what.account" | "privacy.closure" | "privacy.what.ledger" | "privacy.what.feedback" | "privacy.what.security", string][] = [
      ["privacy.what.mail", "Mail you forward or upload"],
      ["privacy.what.account", "Your account"],
      ["privacy.closure", "When an owner closes an organisation"],
      ["privacy.what.ledger", "Your supplier ledger"],
      ["privacy.what.feedback", "Feedback when you tell us a verdict was wrong"],
      ["privacy.what.security", "Sign-in and security records"],
    ];
    const shown = purposes.filter(([id]) => proven(id));
    assert.equal([...what.matchAll(/<li\b/g)].length, shown.length);
    for (const [, words] of shown) has(what, words, "what we process");
    for (const [id, words] of purposes.filter(([id]) => !proven(id))) {
      assert.doesNotMatch(text(what), new RegExp(words), `unproven purpose "${words}" is published`);
      assert.doesNotMatch(html, new RegExp(`data-claim="${id}"`), `unproven claim ${id} is published`);
    }
    for (const words of ["We accept mail only from members' verified addresses and domains."]) {
      has(what, words, "what we process");
    }
    const training = element(what, /<div data-training/, "training");
    has(training, "Forwarded mail may be kept and used to improve IsItLegit's screening models. Your address and name are removed, and other genuine mail is redacted. It is never sold or published.", "training");
    has(training, "That training copy is not deleted after 30 days, and closing your account does not remove it", "training retention");
    has(training, "Public lookalike pages retained for model research have no fixed expiry; a business can ask for its findings' pages to be removed.", "monitor lookalike training retention and removal");
    assert.doesNotMatch(text(html), /We use it only to investigate/, "the summary contradicts the training disclosure");
    assert.doesNotMatch(text(html), /We do not train any model on the mail you forward/i, "the page denies training on forwarded mail");
    has(training, "When Muse Spark screens a lookalike website for you, it receives that public page only.", "training");
    assert.doesNotMatch(text(html), /synthetic/i, "the page mentions synthetic lures");
    assert.doesNotMatch(text(html), /never use your mail to train|no model is ever trained/i, "the page promises no training at all");
  });

  it("keeps the proven retention periods, derived artefacts and security records included", () => {
    const keep = rows(region(html, "keep"));
    const labels: [string, "privacy.keep.raw" | "privacy.keep.derived" | "privacy.keep.case" | "privacy.keep.links" | "privacy.keep.security" | "privacy.keep.account"][] = [
      ["The email and its attachments", "privacy.keep.raw"],
      ["The pictures and text we derive from a message, such as rendered email and PDF pages", "privacy.keep.derived"],
      ["Case summary, verdict and evidence", "privacy.keep.case"],
      ["Report links in our replies", "privacy.keep.links"],
      ["Sign-in and security records", "privacy.keep.security"],
      ["Your account and supplier ledger", "privacy.keep.account"],
    ];
    const expected = labels.filter(([, id]) => proven(id));
    assert.equal(keep.length, expected.length + 1);
    for (const [label, id] of expected) assert.ok(keep.includes(`${label} ${claims[id].text}`), `no row "${label}" kept "${claims[id].text}"`);
    for (const [label, id] of labels.filter(([, id]) => !proven(id))) {
      assert.doesNotMatch(text(html), new RegExp(label), `unproven retention period "${label}" is published`);
      assert.doesNotMatch(html, new RegExp(`data-claim="${id}"`), `unproven claim ${id} is published`);
    }
  });

  it("names all five processors with what they do and what they receive", () => {
    const processors = rows(region(html, "processors"));
    assert.equal(processors.length, 6);
    for (const name of ["Cloudflare", "Meta Model API", "SMTP2GO", "Google Web Risk", "Fireworks AI"]) {
      assert.ok(processors.some((row) => row.startsWith(`${name} `)), `no row for ${name}`);
    }
    const meta = processors.find((row) => row.startsWith("Meta Model API")) ?? "";
    assert.match(meta, /Standard model IDs only, store: false on every call/);
    assert.match(processors.find((row) => row.startsWith("Google Web Risk")) ?? "", /Links with the query string removed/);
  });

  it("agrees with itself on Fireworks: historical public-page inference, redacted forwarded mail only in archived training, no assurance beyond Fireworks' own", () => {
    const fireworks = rows(region(html, "processors")).find((row) => row.startsWith("Fireworks AI")) ?? "";
    assert.match(fireworks, /Historical Loupe inference used public web pages. Archived training used public web pages and forwarded mail with your address and name removed/);
    assert.match(fireworks, /Loupe hosting is shut down; archived training retention is unchanged/);
    const statement = element(region(html, "processors"), /<p data-fireworks/, "Fireworks statement");
    has(statement, "Fireworks states in its published data handling terms that it does not log or store prompt or generation data for open models unless a customer opts in.", "the Fireworks statement");
    linkTo(statement, FIREWORKS_DATA.url, "published data handling terms", "the Fireworks statement");
    assert.doesNotMatch(text(html), /(dedicated deployment|our deployment)[^.]*(no|not|never)[^.]*(log|stor|keep)/i, "the page assures logging terms for our deployment");
    assert.doesNotMatch(text(html), /public pages only,? never your mail|public pages only\b(?!\s*\.)/i);
  });

  it("cites section 72 by number with the Regulator's page, and quotes no Act text", () => {
    const transfer = element(region(html, "processors"), /<p data-transfer/, "transfer sentence");
    has(transfer, "Section 72 of POPIA sets the conditions for sending personal information abroad", "the transfer sentence");
    has(transfer, "We are still confirming which condition covers each provider", "the transfer sentence");
    assert.doesNotMatch(text(transfer), /we rely on those conditions/i, "the page claims reliance it has not confirmed");
    linkTo(transfer, INFOREG_POPIA.url, "Information Regulator, POPIA", "the transfer sentence");
    assert.doesNotMatch(text(html), /substantially similar|binding corporate rules/i, "the page quotes the Act");
  });

  it("explains protected business details through the registry", () => {
    has(region(html, "identity"), "never shown to anyone who checks mail", "protected details");
    has(region(html, "identity"), "rate-limited", "protected details");
  });

  it("lists the rights with their sections, the contact and the Regulator's complaints page, and prints no complaints address", () => {
    const rights = region(html, "rights");
    for (const words of ["(POPIA section 23)", "(section 24)", "(section 11(3))"]) has(rights, words, "rights");
    linkTo(rights, contact, HELLO_ADDRESS, "rights");
    linkTo(rights, INFOREG_COMPLAINTS.url, "complain to the Information Regulator", "rights");
    assert.doesNotMatch(text(html), /@inforegulator/i, "the page prints a Regulator email address");
  });
});
