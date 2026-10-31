// The built How it works page (D07 T06 §3, design/SPEC.md S2): every region, the vendor-documented forwarding steps
// with their sources, the membership step, what happens when a check cannot finish, and no unmeasured figure.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { app, CHECK_ADDRESS, site } from "../src/lib/links.ts";
import { HELP } from "../src/lib/sources.ts";
import { element, has, linkTo, page, region, text } from "./lib/page.ts";

const html = page("/how-it-works");

describe("How it works", () => {
  it("answers first, with the sign-up step beside the first instruction and the byline", () => {
    const intro = region(html, "intro");
    assert.match(intro, /<h1[^>]*>How does IsItLegit check an email\?<\/h1>/);
    has(intro, `Forward it as an attachment to ${CHECK_ADDRESS}.`, "the intro");
    const first = element(intro, /<p data-membership/, "sign-up line");
    linkTo(first, app.signup, "Sign up first", "the intro's sign-up line");
    has(intro, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", "the intro");
    const strip = region(html, "strip");
    const steps = [...strip.matchAll(/<li\b[\s\S]*?<\/li>/g)].map((m) => m[0]);
    assert.equal(steps.length, 3);
    has(steps[0], "01 You forward the email as an attachment", "step 01");
    linkTo(steps[0], app.signup, "Sign up first", "step 01");
    has(steps[1], "We investigate the sender, links, attachments and pictures", "step 02");
    has(steps[2], "You get safe, suspicious or malicious, with proof", "step 03");
  });

  it("gives each client the steps its vendor documents, with key caps and the vendor's page", () => {
    const forward = region(html, "forward");
    has(forward, "Why forward as an attachment?", "the forwarding section");
    const classic = element(forward, /<article data-client="outlook-classic"/, "classic Outlook card");
    has(classic, "Press Ctrl+Alt+F, or choose More Respond Actions, then Forward as Attachment.", "classic Outlook");
    assert.equal(classic.match(/<kbd\b/g)?.length, 3);
    linkTo(classic, HELP.outlookShortcuts.url, HELP.outlookShortcuts.title, "classic Outlook");
    const modern = element(forward, /<article data-client="outlook-new"/, "new Outlook card");
    has(modern, 'Drag the suspicious email from your inbox into the new message until you see "Drop messages here".', "new Outlook");
    const keyboard = element(modern, /<p data-keyboard/, "keyboard route");
    has(keyboard, "Using only a keyboard? Forward the email normally", "new Outlook");
    has(keyboard, "It is still checked, without the sender checks.", "new Outlook");
    has(keyboard, "when Settings, General, Accessibility, Keyboard shortcuts is set to Outlook", "new Outlook");
    has(keyboard, "or Tab to the Forward button", "new Outlook");
    linkTo(modern, HELP.outlookAttach.url, HELP.outlookAttach.title, "new Outlook");
    const gmail = element(forward, /<article data-client="gmail"/, "Gmail card");
    has(gmail, "Choose More, then Forward as attachment.", "Gmail");
    has(element(gmail, /<p data-download/, "download route"), "open the email, choose More, then Download message, and upload the .eml file", "Gmail");
    has(gmail, "The Gmail phone apps do not offer either", "Gmail");
    linkTo(gmail, HELP.gmailAttach.url, HELP.gmailAttach.title, "Gmail");
    const members = element(forward, /<p data-members/, "members note");
    linkTo(members, app.upload, "upload an .eml or .msg file, a PDF or a voice note", "the members note");
  });

  it("shows the eight evidence cards and says what happens when a check cannot finish", () => {
    const cards = [...region(html, "happens").matchAll(/<article\b[\s\S]*?<\/article>/g)].map((m) => text(m[0]));
    assert.equal(cards.length, 8);
    for (const title of ["Who really sent it", "Lookalike domains and links", "Attachments and hidden text", "Reads it the way you see it", "Checks the logos", "Walks the link for you", "Listens to voice notes", "Weighs it and cites the proof"]) {
      assert.ok(cards.some((c) => c.includes(title)), `no card "${title}"`);
    }
    const cannot = region(html, "cannot");
    has(cannot, "checked without the sender checks, and the reply says so", "the cannot-finish section");
    has(cannot, "If we cannot read the message you forwarded, you get no verdict", "the cannot-finish section");
    has(cannot, "If a check cannot finish, you get no verdict yet", "the cannot-finish section");
    has(cannot, "Until it is checked, do not pay, click or reply.", "the cannot-finish section");
    const size = element(cannot, /<li data-size/, "size limit");
    has(size, 'A bigger one is refused with "Message too large" and no verdict.', "the size limit");
    has(size, "Gmail turns attachments over 25 MB into Google Drive links", "the size limit");
  });

  it("answers what comes back, how long we keep it and whether Meta keeps it, and closes", () => {
    const answers = region(html, "answers");
    assert.match(answers, /^<section [^>]*class="bg-dark text-on-dark"/, "the answers are not the board's dark band");
    has(answers, "Report links are signed and expire after 7 days.", "the answers");
    has(answers, "deleted after 30 days", "the answers");
    linkTo(answers, site.privacy, "Privacy and POPIA", "the answers");
    has(answers, "store: false", "the answers");
    const closing = region(html, "closing");
    linkTo(closing, app.signup, "Get started free", "the closing");
    linkTo(closing, site.invoiceFraud, "Read about invoice fraud", "the closing");
    has(closing, "Members join with an invite code.", "the closing");
  });

  it("prints none of the board's unmeasured figures or its certainty claim", () => {
    for (const phrase of ["eight checks", "about a minute", "nothing in your report is a guess"]) {
      assert.ok(!text(html).toLowerCase().includes(phrase), `"${phrase}" is on the page`);
    }
  });
});
