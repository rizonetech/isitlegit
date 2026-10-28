import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { VerdictView } from "../../src/db/verdicts";
import {
  buildReply,
  FALLBACK_SUBJECT,
  parentHeaders,
  replySubject,
  reportOrigin,
  threading,
} from "../../src/mail/reply";
import { signReportLink, verifyReportLink } from "../../src/web/report-link";

// D01 T02 §3: the reply's subject, threading, bodies and report link.
const view: VerdictView = {
  verdict: "malicious",
  headline: "The bank details changed in this invoice",
  confidence: 0.9,
  reasons: [
    "E1: the sender's domain is a week old",
    "E2: the account differs from last month's",
    "E3: urgent wording",
    "E4: a fourth",
  ],
  actions: ["Do not pay", "Call the supplier on a number you already have"],
  source: "rules",
};
const URL_ = "https://isitlegit.test/r/01JD0000000000000000000000?o=org&e=1&s=sig";
const base = { parentSubject: "Fwd: Invoice 77", headersAvailable: true, otherOriginals: 0, reportUrl: URL_ };

describe("buildReply", () => {
  it("answers with the verdict, its headline, three reasons, the actions and the link, in both bodies", () => {
    const reply = buildReply({ ...base, report: { status: "ready", view } });
    expect(reply.subject).toBe("Re: Fwd: Invoice 77");
    expect(reply.text).toMatchInlineSnapshot(`
      "Fraud: The bank details changed in this invoice

      Why:
      - E1: the sender's domain is a week old
      - E2: the account differs from last month's
      - E3: urgent wording

      What to do now:
      - Do not pay
      - Call the supplier on a number you already have

      The full report: https://isitlegit.test/r/01JD0000000000000000000000?o=org&e=1&s=sig
      "
    `);
    expect(reply.html).toMatchInlineSnapshot(`
      "<p><strong>Fraud</strong>: The bank details changed in this invoice</p>
      <p>Why:</p><ul><li>E1: the sender&#39;s domain is a week old</li><li>E2: the account differs from last month&#39;s</li><li>E3: urgent wording</li></ul>
      <p>What to do now:</p><ul><li>Do not pay</li><li>Call the supplier on a number you already have</li></ul>
      <p><a href="https://isitlegit.test/r/01JD0000000000000000000000?o=org&amp;e=1&amp;s=sig">Open the full report</a></p>"
    `);
  });

  it("keeps markup in a verdict's fields as literal text, the report link the only link", () => {
    const hostile = "<a href=\"https://evil.example\">click</a><script>x()</script> & 'quoted'";
    const reply = buildReply({
      ...base,
      report: { status: "ready", view: { ...view, headline: hostile, reasons: [hostile], actions: [hostile] } },
    });
    expect(reply.html).not.toContain("<script>");
    expect(reply.html).not.toContain('<a href="https://evil');
    expect(reply.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;&lt;script&gt;");
    expect(reply.html).toContain("&amp; &#39;quoted&#39;");
    // One anchor, the report link's; the escaped text may still spell "href=".
    expect(reply.html.match(/<a\s/g)).toHaveLength(1);
    expect(reply.html).toContain(`<a href="${URL_.replace(/&/g, "&amp;")}">`);
    expect(reply.text).toContain(hostile);
  });

  it("falls back to the verdict's own advice when it names no actions", () => {
    const reply = buildReply({
      ...base,
      report: { status: "ready", view: { ...view, verdict: "suspicious", actions: [] } },
    });
    expect(reply.text).toContain("checked with the sender on a phone number you already have");
  });

  it("explains missing headers and other originals only when they apply", () => {
    const plain = buildReply({ ...base, report: { status: "ready", view } });
    expect(plain.text).not.toContain("as an attachment");
    expect(plain.text).not.toContain("more than one message");
    const both = buildReply({ ...base, headersAvailable: false, otherOriginals: 2, report: { status: "ready", view } });
    expect(both.text).toContain("Forward as attachment");
    expect(both.text).toContain("we checked only the first");
  });

  it("tells a member plainly that a check could not finish, with no verdict and no internal names", () => {
    for (const failedStep of ["parse", "checks"]) {
      const reply = buildReply({ ...base, report: { status: "partial", failedStep, errorClass: "Error" } });
      expect(reply.text).toContain("We could not finish checking this message");
      expect(reply.text).not.toMatch(/Fraud|Suspicious|Looks legitimate|checks step|parse|ParseError|§/);
      expect(reply.text).toContain(URL_);
    }
    // Only a message the parsers refused is the member's to change; anything else is ours, and the advice is to try again.
    const advice = (errorClass: string) =>
      buildReply({ ...base, report: { status: "partial", failedStep: "parse", errorClass } }).text;
    expect(advice("ParseError")).toContain("save it as .eml");
    for (const ours of ["RawMissing", "StoreError", "Error"]) {
      expect(advice(ours), ours).not.toContain(".eml");
      expect(advice(ours), ours).toContain("forward the message again");
    }
  });
});

describe("replySubject", () => {
  it("prefixes Re: once, trims to 120 characters and falls back when there is none", () => {
    expect(replySubject("Re: Invoice")).toBe("Re: Invoice");
    expect(replySubject("x".repeat(300))).toHaveLength(120);
    // Never half an emoji: the cut falls on a character boundary.
    const cut = replySubject(`${"x".repeat(114)}🚩xx`);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.endsWith("🚩…") || cut.endsWith("x…")).toBe(true);
    expect(replySubject(null)).toBe(FALLBACK_SUBJECT);
    expect(replySubject("a\r\nBcc: someone@example.com")).toBe("Re: a Bcc: someone@example.com");
  });
});

describe("threading (RFC 5322 section 3.6.4)", () => {
  it("replies to the Message-ID and extends an existing References chain", () => {
    expect(threading({ messageId: "<m3@x>", references: "<m1@x> <m2@x>", inReplyTo: "<m2@x>" })).toEqual({
      "In-Reply-To": "<m3@x>",
      References: "<m1@x> <m2@x> <m3@x>",
    });
  });

  it("uses a single In-Reply-To when there are no References", () => {
    expect(threading({ messageId: "<m2@x>", references: null, inReplyTo: "<m1@x>" })).toEqual({
      "In-Reply-To": "<m2@x>",
      References: "<m1@x> <m2@x>",
    });
    expect(threading({ messageId: "<m2@x>", references: null, inReplyTo: "<a@x> <b@x>" })).toEqual({
      "In-Reply-To": "<m2@x>",
      References: "<m2@x>",
    });
  });

  it("inherits a lone In-Reply-To when the parent has neither Message-ID nor References", () => {
    expect(threading({ messageId: null, references: null, inReplyTo: "<m1@x>" })).toEqual({ References: "<m1@x>" });
  });

  it("ignores identifiers inside comments", () => {
    expect(
      threading({
        messageId: "(tracking <comment@x>) <real@x>",
        references: "<a@x> (see <b@x>) <c@x>",
        inReplyTo: null,
      }),
    ).toEqual({ "In-Reply-To": "<real@x>", References: "<a@x> <c@x> <real@x>" });
    expect(threading({ messageId: "(nested (<x@x>) \\) still) <real@x>", references: null, inReplyTo: null })).toEqual({
      "In-Reply-To": "<real@x>",
      References: "<real@x>",
    });
  });

  it("gives no In-Reply-To without a Message-ID, and neither header without any", () => {
    expect(threading({ messageId: null, references: "<m1@x>", inReplyTo: null })).toEqual({ References: "<m1@x>" });
    expect(threading({ messageId: null, references: null, inReplyTo: null })).toEqual({});
  });
});

describe("parentHeaders", () => {
  it("reads the forward's subject and threading from its header block, and nothing from a block it cannot find", async () => {
    const raw = new TextEncoder().encode(
      "From: a@x.example\r\nSubject: Fwd: Invoice\r\nMessage-ID: <f@x>\r\nReferences: <o@x>\r\n\r\nbody <not@header>\r\n",
    );
    expect(await parentHeaders(raw)).toEqual({
      subject: "Fwd: Invoice",
      messageId: "<f@x>",
      references: "<o@x>",
      inReplyTo: null,
    });
    expect(await parentHeaders(null)).toBeNull();
    const utf8 = new TextEncoder().encode("Subject: Fwd: Faktuur vir José 🚩\r\nMessage-ID: <ü@x>\r\n\r\nbody\r\n");
    expect(await parentHeaders(utf8)).toMatchObject({ subject: "Fwd: Faktuur vir José 🚩" });
    expect(await parentHeaders(new TextEncoder().encode("no blank line at all"))).toBeNull();
  });
});

describe("reportOrigin and the link", () => {
  it("takes an https origin only", () => {
    expect(reportOrigin("https://app.isitlegit.co.za")).toBe("https://app.isitlegit.co.za");
    for (const bad of [
      "http://app.isitlegit.co.za",
      "https://app.isitlegit.co.za/path",
      "https://u:p@x.example",
      "not a url",
      undefined,
    ])
      expect(() => reportOrigin(bad), String(bad)).toThrow(/PUBLIC_ORIGIN/);
  });

  it("puts the same absolute link in both bodies, one verifyReportLink accepts", async () => {
    const caseId = "01JD0000000000000000000000";
    const link = `${reportOrigin(env.PUBLIC_ORIGIN)}${await signReportLink(env.REPORT_LINK_SECRET, caseId, "org-reply")}`;
    const reply = buildReply({ ...base, reportUrl: link, report: { status: "ready", view } });
    expect(reply.text).toContain(link);
    expect(reply.html).toContain(link.replace(/&/g, "&amp;"));
    expect(link.startsWith("https://isitlegit.test/r/")).toBe(true);
    expect(await verifyReportLink(env.REPORT_LINK_SECRET, link)).toMatchObject({ ok: true });
  });
});
