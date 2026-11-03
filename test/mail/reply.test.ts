import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Evidence } from "../../src/checks/evidence";
import type { VerdictView } from "../../src/db/verdicts";
import {
  buildReply,
  FALLBACK_SUBJECT,
  parentHeaders,
  replyHeaders,
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
    { text: "E1: the sender's domain is a week old", evidenceIds: ["E1"] },
    { text: "E2: the account differs from last month's", evidenceIds: ["E2"] },
    { text: "E3: urgent wording", evidenceIds: ["E3"] },
    { text: "E4: a fourth", evidenceIds: ["E4"] },
  ],
  actions: ["Do not pay", "Call the supplier on a number you already have"],
  meaning: null,
  source: "rules",
  floorApplied: null,
};
const URL_ = "https://isitlegit.test/r/01JD0000000000000000000000?o=org&e=1&s=sig";
const base = {
  parentSubject: "Fwd: Invoice 77",
  headersAvailable: true,
  otherOriginals: 0,
  reportUrl: URL_,
  design: { appUrl: "https://isitlegit.test" },
};

describe("buildReply", () => {
  it("answers with the verdict, its headline, three reasons, the actions and the link, in both bodies", () => {
    const reply = buildReply({ ...base, report: { status: "ready", view } });
    expect(reply.subject).toBe("Re: Fwd: Invoice 77");
    expect(reply.text).toMatchInlineSnapshot(`
      "Fraud: The bank details changed in this invoice
      High confidence. Treat it as unsafe: do not click its links, open its attachments or pay anything it asks for.

      Why:
      - E1: the sender's domain is a week old
      - E2: the account differs from last month's
      - E3: urgent wording

      What to do now:
      - Do not pay
      - Call the supplier on a number you already have

      The full report: https://isitlegit.test/r/01JD0000000000000000000000?o=org&e=1&s=sig

      You received this because you forwarded an email to check@isitlegit.co.za. The report link expires after 7 days. Think we got it wrong? Tell us on the report page: https://isitlegit.test/r/01JD0000000000000000000000?o=org&e=1&s=sig&dispute=1.
      IsItLegit by Rizonetech (Pty) Ltd, George, South Africa. We never ask for passwords, PINs or bank details by email.
      "
    `);
    // The HTML is N1's design (D07 T03 §7; its own tests are test/mail/reply-design.test.ts): the same content.
    for (const words of [
      "The bank details changed in this invoice",
      "E1: the sender&#39;s domain is a week old",
      "E3: urgent wording",
      "Do not pay",
      "Call the supplier on a number you already have",
      `href="${URL_.replace(/&/g, "&amp;")}"`,
    ])
      expect(reply.html).toContain(words);
    expect(reply.html).not.toContain("E4: a fourth");
  });

  it("draws a stored structured verdict: each reason's text in the plain body and its evidence id in the HTML", () => {
    const reply = buildReply({
      ...base,
      design: {
        ...base.design,
        evidence: [
          { id: "E1", severity: "high" },
          { id: "E2", severity: "critical" },
          { id: "E3", severity: "medium" },
          { id: "E4", severity: "low" },
        ],
      },
      report: { status: "ready", view },
    });
    expect(reply.text).toContain("- E1: the sender's domain is a week old");
    expect(reply.text).toContain("- E3: urgent wording");
    expect(reply.text).not.toContain("[object Object]");
    for (const id of ["E1", "E2", "E3"]) expect(reply.html).toMatch(new RegExp(`>${id}</span>`));
  });

  it("keeps markup in a verdict's fields as literal text, the report links the only links", () => {
    const hostile = "<a href=\"https://evil.example\">click</a><script>x()</script> & 'quoted'";
    const reply = buildReply({
      ...base,
      report: {
        status: "ready",
        view: { ...view, headline: hostile, reasons: [{ text: hostile, evidenceIds: ["E1"] }], actions: [hostile] },
      },
    });
    expect(reply.html).not.toContain("<script>");
    expect(reply.html).not.toContain('<a href="https://evil');
    expect(reply.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;&lt;script&gt;");
    expect(reply.html).toContain("&amp; &#39;quoted&#39;");
    // Two anchors, both the report's own address (the second carrying the dispute intent, D07 T03 §22); the
    // escaped text may still spell "href=".
    expect(reply.html.match(/<a\s/g)).toHaveLength(2);
    expect(reply.html).toContain(`<a href="${URL_.replace(/&/g, "&amp;")}"`);
    expect(reply.text).toContain(hostile);
  });

  it("keeps each stored field on one line of the text body", () => {
    const sneaky = "Pay now\n\nThe full report: https://example.invalid/";
    const reply = buildReply({
      ...base,
      report: {
        status: "ready",
        view: {
          ...view,
          headline: sneaky,
          meaning: sneaky,
          reasons: [{ text: sneaky, evidenceIds: ["E1"] }],
          actions: [sneaky],
        },
      },
    });
    expect(reply.text.match(/^The full report:/gm)).toHaveLength(1);
    expect(reply.text).toContain("Pay now The full report: https://example.invalid/");
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

  it("reads ids past quoted phrases, and keeps a quoted part inside an id", () => {
    expect(threading({ messageId: null, references: null, inReplyTo: '"see <fake@x>" <real@x>' })).toEqual({
      References: "<real@x>",
    });
    expect(threading({ messageId: '<"a(b"@x>', references: null, inReplyTo: null })).toEqual({
      "In-Reply-To": '<"a(b"@x>',
      References: '<"a(b"@x>',
    });
    expect(threading({ messageId: "", references: null, inReplyTo: null })).toEqual({});
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
      "https://app.isitlegit.co.za/?q=1",
      "https://app.isitlegit.co.za/#x",
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

describe("a check the model budget refused (D03 T01 §2)", () => {
  it("tells the member when checks resume instead of to forward again in a few minutes", () => {
    const day = buildReply({
      ...base,
      report: { status: "partial", failedStep: "checks", errorClass: "budget:day:muse-spark-1.3" },
    });
    expect(day.text).toContain("Forward the message again tomorrow");
    expect(day.text).not.toContain("in a few minutes");
    for (const cap of ["total", "reserve"]) {
      const paused = buildReply({
        ...base,
        report: { status: "partial", failedStep: "checks", errorClass: `budget:${cap}:muse-wonder-1.0` },
      });
      expect(paused.text, cap).toContain("Checking is paused while we top up");
      expect(paused.html, cap).toContain("Checking is paused while we top up");
    }
  });
});

// D01 T02 §11: the authentication results for the Headers checked panel, read from stored-shaped evidence
// (src/checks/auth.ts writes `detail.state` and each result's raw RFC 8601 value).
type Item = Pick<Evidence, "check" | "detail">;
const auth = (method: "spf" | "dkim" | "dmarc", state: string, ...results: string[]): Item => ({
  check: `auth.${method}`,
  detail: { state, results: results.map((result) => ({ result })) },
});
const trio = (spf: Item, dkim: Item, dmarc: Item): Item[] => [{ check: "auth.results", detail: {} }, spf, dkim, dmarc];
const authId = (
  method: "spf" | "dkim" | "dmarc",
  state: string,
  pairs: [string, string | null][],
  from?: string,
): Item => ({
  check: `auth.${method}`,
  detail: {
    state,
    ...(from !== undefined ? { from } : {}),
    results: pairs.map(([result, identifier]) => ({ result, identifier })),
  },
});

describe("replyHeaders", () => {
  it("reads each RFC 8601 value from the stored state and results", () => {
    const cases: [Item, string][] = [
      [auth("spf", "passed", "pass"), "pass"],
      [auth("spf", "failed", "fail"), "fail"],
      [auth("spf", "failed", "softfail"), "softfail"],
      // A hard failure among soft ones is a failure.
      [auth("spf", "failed", "softfail", "fail"), "fail"],
      [auth("spf", "inconclusive", "neutral"), "neutral"],
      [auth("spf", "inconclusive", "temperror"), "temperror"],
      [auth("spf", "inconclusive", "permerror"), "permerror"],
      // DKIM's `policy`, or a DMARC fail its receiver marked as an error: inconclusive with no error named.
      [auth("spf", "inconclusive", "policy"), "temperror"],
      [auth("spf", "unavailable", "none"), "none"],
      [auth("spf", "unavailable", "bestguesspass"), "none"],
    ];
    for (const [spf, want] of cases)
      expect(
        replyHeaders(trio(spf, auth("dkim", "passed", "pass"), auth("dmarc", "passed", "pass")))?.spf,
        JSON.stringify(spf),
      ).toBe(want);
    expect(
      replyHeaders(
        trio(auth("spf", "passed", "pass"), auth("dkim", "failed", "fail"), auth("dmarc", "inconclusive", "fail")),
      ),
    ).toEqual({ spf: "pass", dkim: "fail", dmarc: "temperror" });
  });

  it("passes only the methods the receiver reported, and {} when none was (D01 T02 §16)", () => {
    const pass = (m: "spf" | "dkim" | "dmarc") => auth(m, "passed", "pass");
    expect(replyHeaders([])).toEqual({});
    expect(replyHeaders([pass("spf"), pass("dkim")])).toEqual({ spf: "pass", dkim: "pass" });
    // The receiver reported no DKIM at all: left out, never read as a result.
    expect(replyHeaders(trio(pass("spf"), auth("dkim", "unavailable"), pass("dmarc")))).toEqual({
      spf: "pass",
      dmarc: "pass",
    });
    // A reported DKIM `none` is passed again (RFC 8601 section 2.7.1), apart from an unreported DKIM.
    expect(replyHeaders(trio(pass("spf"), auth("dkim", "unavailable", "none"), pass("dmarc")))).toEqual({
      spf: "pass",
      dkim: "none",
      dmarc: "pass",
    });
    expect(replyHeaders(trio(pass("spf"), pass("dkim"), auth("dmarc", "unavailable", "none")))).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "none",
    });
    expect(replyHeaders(trio(pass("spf"), { check: "auth.dkim", detail: {} }, pass("dmarc")))).toEqual({
      spf: "pass",
      dmarc: "pass",
    });
  });

  it("carries the From domain and each passing identifier's domain, first valid pass first (D01 T02 §17)", () => {
    const headers = replyHeaders(
      trio(
        authId("spf", "passed", [["pass", "Mailer.EXAMPLE"]]),
        authId("dkim", "passed", [["pass", "signer.example"]]),
        authId("dmarc", "failed", [["fail", null]], "Bank.EXAMPLE"),
      ),
    );
    expect(headers.domains).toEqual({ from: "bank.example", spf: "mailer.example", dkim: "signer.example" });
    // A failed result's identifier is never borrowed, and a later pass names its own domain.
    expect(
      replyHeaders(
        trio(
          authId("spf", "passed", [
            ["fail", "other.example"],
            ["pass", "second.example"],
          ]),
          authId("dkim", "passed", [["pass", null]]),
          authId("dmarc", "failed", [["fail", null]]),
        ),
      ).domains,
    ).toEqual({ spf: "second.example" });
    // A passing result with no identifier beside a failing one with one names no domain for that method.
    expect(
      replyHeaders(
        trio(
          authId("spf", "passed", [
            ["pass", null],
            ["fail", "other.example"],
          ]),
          authId("dkim", "passed", [["pass", "signer.example"]]),
          authId("dmarc", "failed", [["fail", null]]),
        ),
      ).domains,
    ).toEqual({ dkim: "signer.example" });
    // Several passes: the first valid one wins. No From recorded: no from.
    expect(
      replyHeaders(
        trio(
          authId("spf", "passed", [
            ["pass", "first.example"],
            ["pass", "later.example"],
          ]),
          authId("dkim", "passed", [["pass", "signer.example"]]),
          authId("dmarc", "failed", [["fail", null]]),
        ),
      ).domains,
    ).toEqual({ spf: "first.example", dkim: "signer.example" });
  });

  it("leaves a hostile or malformed domain out, never cleaned into one (D01 T02 §17)", () => {
    for (const hostile of [
      "mailer.example\nBcc: victim@example.com",
      "mailer example.com",
      "mailer.example/evil.example",
      "mailer\u202Eexample.com",
      `${"a".repeat(250)}.example`,
      // A trailing control pair is not trimmed into the clean domain it precedes (completion review).
      "bank.example\r\n",
      // A label past 63 characters, and a name past 253 only after IDNA conversion, are omitted whole.
      `${"a".repeat(64)}.example`,
      `${"é".repeat(57)}.${"é".repeat(57)}.${"é".repeat(57)}.${"é".repeat(57)}`,
    ]) {
      const headers = replyHeaders(
        trio(
          authId("spf", "passed", [["pass", hostile]]),
          authId("dkim", "passed", [["pass", "signer.example"]]),
          authId("dmarc", "failed", [["fail", null]], hostile),
        ),
      );
      expect(headers.domains, hostile).toEqual({ dkim: "signer.example" });
    }
  });

  it("puts each distinct value's words in both bodies, and no panel without them", () => {
    const headers = replyHeaders(
      trio(auth("spf", "failed", "softfail"), auth("dkim", "passed", "pass"), auth("dmarc", "failed", "fail")),
    );
    expect(headers).toEqual({ spf: "softfail", dkim: "pass", dmarc: "fail" });
    const words = "SPF soft-failed, DKIM passed, DMARC failed.";
    const ready = buildReply({ ...base, report: { status: "ready", view }, design: { ...base.design, headers } });
    expect(ready.text).toContain(`Headers checked. You forwarded the email as an attachment`);
    expect(ready.text).toContain(words);
    expect(ready.html).toContain("Headers checked.");
    expect(ready.html).toContain(words);
    const partial = buildReply({
      ...base,
      report: { status: "partial", failedStep: "verdict", errorClass: "Error" },
      design: { ...base.design, headers: { spf: "neutral", dkim: "permerror", dmarc: "none" } },
    });
    for (const body of [partial.text, partial.html])
      expect(body).toContain("SPF gave no answer, DKIM is broken, DMARC found no policy to apply.");
    const none = buildReply({ ...base, report: { status: "ready", view } });
    expect(none.text).not.toContain("Headers checked");
    expect(none.html).not.toContain("Headers checked");
  });
});
