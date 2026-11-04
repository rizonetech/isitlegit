import { describe, expect, it } from "vitest";
import COLOURS from "../../design/tokens/colors.json";
import SPACING from "../../design/tokens/spacing.json";
import TYPE from "../../design/tokens/typography.json";
import type { VerdictView } from "../../src/db/verdicts";
import { bankChangeAction } from "../../src/invoice/fixed-actions";
import { buildReply, type ReplyInput } from "../../src/mail/reply";
import { type ReplyDesign, replyDesign } from "../../src/mail/templates/reply";
import { CHECK_WORDS } from "../../src/web/components/evidence/check-words";

// The verdict reply in N1's design (D07 T03 §7), through `buildReply` as it is sent: each variant's content in both
// parts, the report's fixed-action order, the further findings counted once, coverage said, Headers checked only from
// the authentication results, buildReply's own notes and advice kept, hostile words escaped; the HTML free of what email
// clients drop; and the template's pills only for reasons that cite.
const L = COLOURS.themes.light;
const VIEW: VerdictView = {
  verdict: "malicious",
  headline: "This is a password-phishing email pretending to be NimbusMail.",
  confidence: 0.93,
  reasons: [{ text: "The link goes to a lookalike registered 3 days ago.", evidenceIds: [] }],
  actions: ["Do not click the link or open the attachment.", "Delete the email and warn your team."],
  meaning: null,
  source: "rules",
  floorApplied: null,
};
const URL_ = "https://app.isitlegit.co.za/r/01JCASE?o=org&e=1793664000&s=sig";
const DESIGN: ReplyInput["design"] = {
  appUrl: "https://app.isitlegit.co.za",
  organisation: "Karoo Couriers",
  evidence: [
    { id: "E1", severity: "critical" },
    { id: "E2", severity: "high" },
    { id: "E3", severity: "low" },
  ],
  coverage: [{ check: "auth.spf", outcome: "ran" }],
};
const send = (
  patch: {
    view?: Partial<VerdictView> | null;
    design?: Partial<ReplyInput["design"]>;
    otherOriginals?: number;
    headersAvailable?: boolean;
  } = {},
) =>
  buildReply({
    parentSubject: "Fwd: Your NimbusMail password expires today",
    headersAvailable: patch.headersAvailable ?? true,
    otherOriginals: patch.otherOriginals ?? 0,
    report:
      patch.view === null
        ? { status: "partial", failedStep: "checks", errorClass: "Error" }
        : { status: "ready", view: { ...VIEW, ...patch.view } },
    reportUrl: URL_,
    design: { ...DESIGN, ...patch.design },
  });

describe("the stored sentence in the reply (D07 T03 s10)", () => {
  it("draws a distinctive stored sentence in both bodies, and the fixed one when none is stored", () => {
    const stored = send({
      view: { meaning: "This message asks for the mailbox password on a page that is not NimbusMail's." },
    });
    expect(stored.text).toContain("This message asks for the mailbox password on a page that is not NimbusMail's.");
    expect(stored.html).toContain("This message asks for the mailbox password on a page that is not NimbusMail&#39;s.");
    expect(stored.text).not.toContain("do not click its links, open its attachments or pay anything it asks for.");
    const none = send({ view: { meaning: null } });
    expect(none.text).toContain(
      "Treat it as unsafe: do not click its links, open its attachments or pay anything it asks for.",
    );
    expect(none.html).toContain("Treat it as unsafe: do not click its links");
  });

  it("keeps hostile stored markup literal in the text and escaped in the HTML", () => {
    const hostile = send({ view: { meaning: "<script>alert(1)</script> Do not use it." } });
    expect(hostile.text).toContain("<script>alert(1)</script> Do not use it.");
    expect(hostile.html).not.toContain("<script>alert(1)</script>");
    expect(hostile.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Do not use it.");
    // At the stored field's 300-character maximum, the same holds in both bodies.
    const longest = `<script>alert(1)</script> ${"Do not use it. ".repeat(30)}`.slice(0, 300);
    expect(longest).toHaveLength(300);
    const maxed = send({ view: { meaning: longest } });
    expect(maxed.text).toContain(longest);
    expect(maxed.html).not.toContain("<script>alert(1)</script>");
    expect(maxed.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

// What email clients drop or mishandle: stylesheets, scripts, CSS layout, unlabelled images, untokened colours; and
// a size off the tokens (spacing on the 4 px scale, type on the type scale, radii the radius tokens, 1 px hairlines).
const TOKENS = new Set(Object.values(L).map((c) => c.toLowerCase()));
const SPACE = new Set(SPACING.scale);
const SIZES = new Set(TYPE.scale);
const RADII = new Set([...Object.values(SPACING.radius), 12]);
function emailLint(html: string): string[] {
  const problems: string[] = [];
  if (/<style\b|<link\b|<script\b/i.test(html)) problems.push("a <style>, <link> or <script>");
  for (const m of html.matchAll(/(display\s*:\s*(flex|grid)|position\s*:|float\s*:)/gi)) problems.push(m[0]);
  for (const m of html.matchAll(/<table\b[^>]*>/gi))
    if (!/role="(presentation|list)"/.test(m[0]))
      problems.push(`a table without role="presentation": ${m[0].slice(0, 60)}`);
  for (const m of html.matchAll(/<img\b[^>]*>/gi))
    if (!/\balt="/.test(m[0])) problems.push(`an image without alt: ${m[0].slice(0, 60)}`);
  // Gmail and Outlook show no SVG: every image is a raster.
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi))
    if (!/\.(png|jpe?g|gif)$/i.test(m[1] ?? "")) problems.push(`an image email clients may not show: ${m[1]}`);
  for (const m of html.matchAll(/#[0-9a-f]{3,8}\b/gi))
    if (!TOKENS.has(m[0].toLowerCase())) problems.push(`a colour that is not a token: ${m[0]}`);
  for (const m of html.matchAll(
    /\b(padding|margin|font-size|border-radius|width|height|line-height)\s*:\s*([^;"]+)/gi,
  )) {
    const [, prop = "", value = ""] = m;
    for (const px of value.matchAll(/(\d+)px/g)) {
      const n = Number(px[1]);
      const allowed =
        prop === "font-size"
          ? SIZES
          : prop === "border-radius"
            ? RADII
            : prop === "width" || prop === "height" || prop === "line-height"
              ? new Set([...SPACE, 600])
              : SPACE;
      if (!allowed.has(n)) problems.push(`a size off the tokens: ${prop}: ${value}`);
    }
  }
  return problems;
}

describe("the reply's design through buildReply", () => {
  for (const [name, view, band] of [
    ["malicious", {}, "Malicious · high confidence"],
    ["suspicious", { verdict: "suspicious", confidence: 0.6 }, "Suspicious · medium confidence"],
    ["safe", { verdict: "safe", confidence: 0.95, actions: ["Pay as usual."] }, "Safe · high confidence"],
  ] as const)
    it(`draws a ${name} verdict's band, actions, link and footer, its text keeping buildReply's words`, () => {
      const { html, text } = send({ view: view as Partial<VerdictView> });
      expect(html).toContain(band);
      expect(html).toContain("Karoo Couriers");
      expect(html).toContain("expires after 7 days");
      expect(html).toContain("Think we got it wrong?");
      // The footer's dispute link carries the intent, the report link does not (D07 T03 §22).
      expect(html).toContain(`href="${`${URL_}&dispute=1`.replaceAll("&", "&amp;")}"`);
      expect(text).toContain(`Tell us on the report page: ${URL_}&dispute=1.`);
      expect(html).toContain(`href="${URL_.replaceAll("&", "&amp;")}"`);
      expect(html).toMatch(/>Open the full report<\/a>/);
      expect(html).toContain("<title>Re: Fwd: Your NimbusMail password expires today</title>");
      expect(text).toContain(`The full report: ${URL_}`);
      expect(text).toContain("What to do now:");
    });

  it("draws a reply with no verdict in the same frame, with buildReply's own lead and advice", () => {
    const { html, text } = send({ view: null });
    for (const part of [html, text]) {
      expect(part).toContain("We could not finish checking this message, so we have no verdict on it yet.");
      expect(part).toContain(
        "Open the report, sign in if asked, and select Retry the check there, or forward the message again in a few minutes.",
      );
    }
    expect(html).toContain("Check failed · no verdict");
    expect(html).not.toContain("What to do now");
  });

  it("says when checks did not all finish, in both parts, and nothing when outcomes were not stored", () => {
    const { html, text } = send({
      design: {
        coverage: [
          { check: "auth.spf", outcome: "ran" },
          { check: "domain.age", outcome: "failed" },
          { check: "content.hidden_text", outcome: "partial" },
        ],
      },
    });
    for (const part of [html, text]) {
      expect(part).toContain("2 checks did not finish or read only part of the message");
      expect(part).toContain(`${CHECK_WORDS["domain.age"]} did not run`);
      expect(part).toContain(`${CHECK_WORDS["content.hidden_text"]} read only part of its input`);
    }
    expect(send({ design: { coverage: null } }).text).not.toContain("did not finish");
    expect(send({}).text).not.toContain("did not finish");
  });

  it("puts a fixed action given seventh first, then cuts to three, in both parts", () => {
    const actions = ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", bankChangeAction("011 555 0142")];
    const { html, text } = send({ view: { actions } });
    expect(text).toContain(`- ${bankChangeAction("011 555 0142")}\n- One.\n- Two.\n`);
    expect(text).not.toContain("- Three.");
    expect(html.indexOf("Confirm by phoning the supplier")).toBeLessThan(html.indexOf("One."));
  });

  it("counts the findings the reasons do not cite, once, in both parts, and says nothing at zero", () => {
    for (const part of [send({}).html, send({}).text])
      expect(part).toContain("3 more findings are in the full report.");
    expect(send({ design: { evidence: [] } }).html).not.toContain("more finding");
    expect(send({ design: { evidence: [] } }).text).not.toContain("more finding");
  });

  it("says the confidence and what the verdict means in the text too", () => {
    expect(send({}).text).toContain("High confidence. Treat it as unsafe");
    expect(send({ view: { verdict: "suspicious", confidence: 0.6 } }).text).toContain("Medium confidence.");
  });

  it("draws buildReply's fallback advice in the HTML when the verdict stored no actions", () => {
    const { html, text } = send({ view: { actions: [] } });
    const advice = "Do not pay, click or reply. Delete it, and warn whoever else may have received it.";
    expect(text).toContain(advice);
    expect(html).toContain("What to do now");
    expect(html).toContain(advice);
  });

  it("says Headers checked only from the authentication results, and keeps buildReply's notes", () => {
    expect(send({}).text).not.toContain("Headers checked");
    const { html, text } = send({
      design: { headers: { spf: "pass", dkim: "pass", dmarc: "fail" } },
      otherOriginals: 1,
    });
    for (const part of [html, text]) {
      expect(part).toContain("Headers checked.");
      expect(part).toContain("SPF passed, DKIM passed, DMARC failed.");
      expect(part).toContain("we checked only the first");
    }
    expect(send({ headersAvailable: false }).html).toContain("Forward as attachment");
  });

  // D07 T03 §34: a method the receiver did not report is named as such, in both bodies, with the others' results kept;
  // with none reported there is no panel, while the reply's other notes stay.
  it("names a method the receiving system did not report, and draws no panel when none was", () => {
    const cases: [Partial<Record<"spf" | "dkim" | "dmarc", "pass" | "fail">>, string][] = [
      [{ dkim: "pass", dmarc: "fail" }, "SPF not reported by the receiving system, DKIM passed, DMARC failed."],
      [{ spf: "fail", dmarc: "fail" }, "SPF failed, DKIM not reported by the receiving system, DMARC failed."],
      [{ spf: "fail", dkim: "pass" }, "SPF failed, DKIM passed, DMARC not reported by the receiving system."],
      // One method reported is enough for the panel.
      [
        { spf: "fail" },
        "SPF failed, DKIM not reported by the receiving system, DMARC not reported by the receiving system.",
      ],
      [
        { dkim: "pass" },
        "SPF not reported by the receiving system, DKIM passed, DMARC not reported by the receiving system.",
      ],
      [
        { dmarc: "fail" },
        "SPF not reported by the receiving system, DKIM not reported by the receiving system, DMARC failed.",
      ],
    ];
    for (const [headers, words] of cases) {
      const { html, text } = send({ design: { headers } });
      for (const part of [html, text]) {
        expect(part, words).toContain("Headers checked.");
        expect(part, words).toContain(words);
      }
    }
    const { html, text } = send({ design: { headers: {} }, otherOriginals: 1 });
    for (const part of [html, text]) {
      expect(part).not.toContain("Headers checked");
      expect(part).toContain("we checked only the first");
    }
  });

  // D07 T03 §35: `none` means something different for each method (RFC 8601 §2.7.1, §2.7.2; RFC 7489 §11.2): DKIM
  // found no signature on the message, SPF no record to check, DMARC no policy to apply (none published, or no domain to look one up for). None of them says "not set up".
  it("words each method's none as what it means, in both bodies", () => {
    const { html, text } = send({ design: { headers: { spf: "none", dkim: "none", dmarc: "none" } } });
    for (const part of [html, text]) {
      expect(part).toContain("SPF found no record to check, DKIM found no signature, DMARC found no policy to apply.");
      expect(part).not.toContain("not set up");
    }
    // Every other result keeps its words.
    const other = send({ design: { headers: { spf: "softfail", dkim: "permerror", dmarc: "temperror" } } }).text;
    expect(other).toContain("SPF soft-failed, DKIM is broken, DMARC could not be checked.");
  });

  // D07 T03 §36: the results are the receiving system's record, never a claim of who sent the message; a pass that
  // DMARC did not count is explained (RFC 7489 §3.1, alignment), naming the domains when the producer gives them.
  describe("the receiving system's record and alignment", () => {
    type H = NonNullable<ReplyInput["design"]["headers"]>;
    const both = (headers: H) => {
      const { html, text } = send({ design: { headers } });
      return [html, text] as const;
    };

    it("attributes the results to the receiving system in both bodies", () => {
      for (const part of both({ spf: "pass", dkim: "pass", dmarc: "pass" })) {
        expect(part).toContain(
          "You forwarded the email as an attachment, so we could read the checks the receiving system recorded: SPF passed, DKIM passed, DMARC passed.",
        );
        expect(part).not.toContain("who really sent");
      }
    });

    const RULE = "a pass counts toward DMARC only when it establishes the domain the message says it is from";
    it("says why DMARC failed although a method passed, without domains, asserting no cause", () => {
      const cases: [H, string][] = [
        [
          { spf: "pass", dkim: "fail", dmarc: "fail" },
          `DMARC failed although SPF passed: ${RULE}, and this one did not.`,
        ],
        [
          { spf: "fail", dkim: "pass", dmarc: "fail" },
          `DMARC failed although DKIM passed: ${RULE}, and this one did not.`,
        ],
        [
          { spf: "pass", dkim: "pass", dmarc: "fail" },
          `DMARC failed although SPF and DKIM passed: ${RULE}, and these did not.`,
        ],
      ];
      for (const [headers, words] of cases)
        for (const part of both(headers)) {
          expect(part, words).toContain(words);
          // An SPF pass for the HELO name can be for the From domain and still not count: no other domain is claimed.
          expect(part).not.toContain("domain other than");
        }
    });

    it("names each pass's domain and the From domain", () => {
      const domains = { from: "paypal.example", spf: "bounce.mailer.example", dkim: "mailer.example" };
      for (const part of both({ spf: "pass", dkim: "pass", dmarc: "fail", domains }))
        expect(part).toContain(
          `DMARC failed although SPF passed for bounce.mailer.example and DKIM passed for mailer.example: ${RULE} (paypal.example), and these did not.`,
        );
      for (const part of both({ spf: "pass", dkim: "fail", dmarc: "fail", domains }))
        expect(part).toContain(
          `DMARC failed although SPF passed for bounce.mailer.example: ${RULE} (paypal.example), and this one did not.`,
        );
      for (const part of both({ spf: "fail", dkim: "pass", dmarc: "fail", domains }))
        expect(part).toContain(
          `DMARC failed although DKIM passed for mailer.example: ${RULE} (paypal.example), and this one did not.`,
        );
    });

    it("says a pass for the From domain itself does not explain DMARC's failure, keeping every pass, in any case", () => {
      const domains = { from: "Karoo.example", spf: "karoo.EXAMPLE", dkim: "mailer.example" };
      for (const part of both({ spf: "pass", dkim: "pass", dmarc: "fail", domains }))
        expect(part).toContain(
          "The receiving system recorded DMARC as failed although SPF passed for karoo.EXAMPLE and DKIM passed for mailer.example, and the message says it is from Karoo.example; these results do not explain that failure.",
        );
    });

    it("keeps every known domain and names every passing method when the domains are partial", () => {
      for (const part of both({ spf: "pass", dkim: "pass", dmarc: "fail", domains: { spf: "bounce.mailer.example" } }))
        expect(part).toContain(
          `DMARC failed although SPF passed for bounce.mailer.example and DKIM passed: ${RULE}, and these did not.`,
        );
      for (const part of both({ spf: "pass", dkim: "fail", dmarc: "fail", domains: { from: "paypal.example" } }))
        expect(part).toContain(`DMARC failed although SPF passed: ${RULE} (paypal.example), and this one did not.`);
      for (const part of both({
        spf: "pass",
        dkim: "pass",
        dmarc: "fail",
        domains: { from: "paypal.example", dkim: "mailer.example" },
      }))
        expect(part).toContain(
          `DMARC failed although SPF passed and DKIM passed for mailer.example: ${RULE} (paypal.example), and these did not.`,
        );
    });

    it("says once what each method checks, in both bodies", () => {
      for (const part of both({ spf: "fail", dmarc: "fail" }))
        expect(part).toContain(
          "SPF checks that the sending server may send for a domain, DKIM checks a signature a domain put on the message, and DMARC checks that one of them passed for the domain the message says it is from.",
        );
    });

    it("escapes a hostile domain in the HTML and cuts a long one at 253 characters", () => {
      const hostile = "<img src=x onerror=alert(1)>.example";
      const [html, text] = both({
        spf: "pass",
        dkim: "fail",
        dmarc: "fail",
        domains: { from: "a.example", spf: hostile },
      });
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.example");
      expect(text).toContain(hostile);
      const long = `${"a".repeat(296)}.example`;
      const [, cut] = both({ spf: "pass", dkim: "fail", dmarc: "fail", domains: { from: "b.example", spf: long } });
      expect(cut).toContain(`SPF passed for ${long.slice(0, 253)}: `);
      expect(cut).not.toContain(long.slice(0, 254));
    });

    it("draws no alignment sentence when DMARC passed or nothing passed", () => {
      for (const headers of [
        { spf: "pass", dkim: "pass", dmarc: "pass" },
        { spf: "fail", dkim: "fail", dmarc: "fail" },
        { spf: "pass", dkim: "pass" },
      ] as H[])
        for (const part of both(headers)) {
          expect(part).not.toContain("DMARC failed although");
          expect(part).not.toContain("counts toward DMARC");
          expect(part).not.toContain("do not explain");
        }
    });
  });

  it("escapes hostile words in every part of the HTML", () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const { html, text } = send({
      view: { headline: hostile, reasons: [{ text: hostile, evidenceIds: [] }], actions: [hostile] },
      design: { organisation: hostile },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(text).toContain(hostile);
  });

  it("passes the email-safety lint in every variant, and the lint catches what clients drop", () => {
    for (const patch of [
      {},
      { view: null },
      { design: { headers: { spf: "pass", dkim: "pass", dmarc: "pass" } as const }, otherOriginals: 1 },
    ])
      expect(emailLint(send(patch as never).html)).toEqual([]);
    const { html } = send({});
    expect(emailLint(html.replace("display: block", "display:flex"))).not.toEqual([]);
    expect(emailLint(html.replace('alt="IsItLegit"', ""))).not.toEqual([]);
    expect(emailLint(html.replace(L.accent, "#123456"))).not.toEqual([]);
    expect(emailLint(html.replace("padding: 16px 24px", "padding: 14px 24px"))).not.toEqual([]);
    expect(emailLint(html.replace("font-size: 22px", "font-size: 21px"))).not.toEqual([]);
    expect(emailLint(html.replace(/(src="[^"]*)\.png"/, '$1.svg"'))).not.toEqual([]);
  });
});

describe("the template's reasons", () => {
  const BASE: ReplyDesign = {
    appUrl: "https://app.isitlegit.co.za",
    reportUrl: URL_,
    organisation: "Karoo Couriers",
    verdict: { ...VIEW },
    evidence: DESIGN.evidence ?? [],
    voice: false,
    coverage: null,
    notes: [],
  };
  // Structured reasons reach the template once the stored verdict carries them (D04 T01 §2); drawn here directly.
  // The count is the report's (`cited`, D07 T03 §2): only the first item each reason cites is drawn first, so E2, cited
  // second by the first reason, is still a further finding, as the report's own disclosure counts it.
  it("draws a pill only for a reason that cites evidence on the case, and counts as the report does", () => {
    const { html } = replyDesign({
      ...BASE,
      verdict: {
        ...VIEW,
        reasons: [
          { text: "A lookalike domain.", evidenceIds: ["E1", "E2"] },
          { text: "The same lookalike again.", evidenceIds: ["E1"] },
          { text: "Cites a card this case lacks.", evidenceIds: ["E9"] },
        ],
      },
    });
    expect(html).toMatch(new RegExp(`background: ${L["mal-wash"]}; color: ${L.mal}[^>]*>E1</span>`));
    expect(html).not.toContain(">E9</span>");
    expect(html).toContain("2 more findings are in the full report.");
    expect(replyDesign(BASE).html).not.toMatch(/border-radius: 999px[^>]*>E\d/);
  });
});
