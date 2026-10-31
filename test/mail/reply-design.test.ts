import { describe, expect, it } from "vitest";
import COLOURS from "../../design/tokens/colors.json";
import { bankChangeAction } from "../../src/invoice/fixed-actions";
import { type ReplyDesign, replyDesign } from "../../src/mail/templates/reply";

// The verdict reply in N1's design (D07 T03 §7): each variant's content in both parts, the report's fixed-action order,
// pills only for reasons that cite, the further findings counted once, coverage said, Headers checked only from the
// authentication results, hostile words escaped; and the HTML free of what email clients drop.
const BASE: ReplyDesign = {
  appUrl: "https://app.isitlegit.co.za",
  reportUrl: "https://app.isitlegit.co.za/r/01JCASE?o=org&e=1793664000&s=sig",
  organisation: "Karoo Couriers",
  verdict: {
    verdict: "malicious",
    headline: "This is a password-phishing email pretending to be NimbusMail.",
    confidence: 0.93,
    reasons: ["The link goes to a lookalike registered 3 days ago."],
    actions: ["Do not click the link or open the attachment.", "Delete the email and warn your team."],
  },
  evidence: [
    { id: "E1", severity: "critical" },
    { id: "E2", severity: "high" },
    { id: "E3", severity: "low" },
  ],
  voice: false,
  coverage: [{ check: "auth.spf", outcome: "ran" }],
  notes: [],
};
const draw = (patch: Partial<ReplyDesign>) => replyDesign({ ...BASE, ...patch });

// What email clients drop or mishandle: stylesheets, scripts, CSS layout, unlabelled images, untokened colours.
const TOKENS = new Set(Object.values(COLOURS.themes.light).map((c) => c.toLowerCase()));
export function emailLint(html: string): string[] {
  const problems: string[] = [];
  if (/<style\b|<link\b|<script\b/i.test(html)) problems.push("a <style>, <link> or <script>");
  for (const m of html.matchAll(/(display\s*:\s*(flex|grid)|position\s*:|float\s*:)/gi)) problems.push(m[0]);
  for (const m of html.matchAll(/<table\b[^>]*>/gi))
    if (!/role="presentation"/.test(m[0])) problems.push(`a table without role="presentation": ${m[0].slice(0, 60)}`);
  for (const m of html.matchAll(/<img\b[^>]*>/gi))
    if (!/\balt="/.test(m[0])) problems.push(`an image without alt: ${m[0].slice(0, 60)}`);
  for (const m of html.matchAll(/#[0-9a-f]{3,8}\b/gi))
    if (!TOKENS.has(m[0].toLowerCase())) problems.push(`a colour that is not a token: ${m[0]}`);
  return problems;
}

describe("the reply's design", () => {
  for (const [name, patch, words] of [
    [
      "malicious",
      {},
      ["Malicious · high confidence", "pretending to be NimbusMail", "What to do now", "Why we say so"],
    ],
    [
      "suspicious",
      { verdict: { ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>), verdict: "suspicious", confidence: 0.6 } },
      ["Suspicious · medium confidence", "Confirm with the sender another way"],
    ],
    [
      "safe",
      {
        verdict: {
          ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>),
          verdict: "safe",
          confidence: 0.95,
          actions: ["Pay as usual."],
        },
      },
      ["Safe · high confidence", "We found nothing wrong", "Pay as usual."],
    ],
  ] as const)
    it(`says a ${name} verdict in both parts, with the link and the footer`, () => {
      const { html, text } = draw(patch as Partial<ReplyDesign>);
      for (const part of [html, text]) {
        for (const w of words) expect(part, `${name}: ${w}`).toContain(w);
        expect(part).toContain("Karoo Couriers");
        expect(part).toContain("expires after 7 days");
        expect(part).toContain("Think we got it wrong? Tell us on the report page.");
      }
      expect(text).toContain(`The full report: ${BASE.reportUrl}`);
      expect(html).toContain(`href="${BASE.reportUrl.replaceAll("&", "&amp;")}"`);
      expect(html).toMatch(/>Open the full report<\/a>/);
    });

  it("says a reply with no verdict in the same frame, with buildReply's own words", () => {
    const { html, text } = draw({
      verdict: null,
      failure: {
        lead: "We could not finish checking this message, so we have no verdict on it yet.",
        advice: "Please forward the message again in a few minutes.",
      },
    });
    for (const part of [html, text]) {
      expect(part).toContain("We could not finish checking this message, so we have no verdict on it yet.");
      expect(part).toContain("Please forward the message again in a few minutes.");
    }
    expect(html).toContain("Check failed · no verdict");
    expect(html).not.toContain("What to do now");
  });

  it("says when checks did not all finish, in both parts", () => {
    const { html, text } = draw({
      coverage: [
        { check: "auth.spf", outcome: "ran" },
        { check: "domain.age", outcome: "failed" },
        { check: "content.hidden_text", outcome: "partial" },
      ],
    });
    for (const part of [html, text]) expect(part).toContain("2 checks did not finish or read only part of the message");
    expect(draw({}).text).not.toContain("did not finish");
  });

  it("puts a fixed action given seventh first, then cuts to three", () => {
    const actions = ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", bankChangeAction("011 555 0142")];
    const { html, text } = draw({ verdict: { ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>), actions } });
    expect(text).toContain(`1. ${bankChangeAction("011 555 0142")}\n2. One.\n3. Two.`);
    expect(text).not.toContain("Three.");
    expect(html.indexOf("Confirm by phoning the supplier")).toBeLessThan(html.indexOf("One."));
  });

  it("draws a pill only for a reason that cites evidence on the case, and counts the rest once", () => {
    const plain = draw({});
    expect(plain.html).not.toMatch(/border-radius: 999px[^>]*>E\d/);
    expect(plain.text).toContain("3 more findings are in the full report.");
    const cited = draw({
      verdict: {
        ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>),
        reasons: [
          { text: "A lookalike domain.", evidenceIds: ["E1", "E2"] },
          { text: "The same lookalike again.", evidenceIds: ["E1"] },
          { text: "Cites a card this case lacks.", evidenceIds: ["E9"] },
        ],
      },
    });
    expect(cited.html).toMatch(
      new RegExp(`background: ${COLOURS.themes.light["mal-wash"]}; color: ${COLOURS.themes.light.mal}[^>]*>E1</span>`),
    );
    expect(cited.html).not.toContain(">E9</span>");
    expect(cited.text).toContain("- E1: A lookalike domain.");
    expect(cited.text).toContain("- Cites a card this case lacks.");
    expect(cited.text).toContain("1 more finding is in the full report.");
    const none = draw({
      evidence: [{ id: "E1", severity: "critical" }],
      verdict: {
        ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>),
        reasons: [{ text: "All of it.", evidenceIds: ["E1"] }],
      },
    });
    expect(none.text).not.toContain("more finding");
  });

  it("says Headers checked only from the authentication results, and keeps buildReply's notes", () => {
    expect(draw({}).text).not.toContain("Headers checked");
    const { html, text } = draw({
      headers: { spf: "pass", dkim: "pass", dmarc: "fail" },
      notes: ["Your forward held more than one message and we checked only the first."],
    });
    for (const part of [html, text]) {
      expect(part).toContain("Headers checked.");
      expect(part).toContain("SPF passed, DKIM passed, DMARC failed.");
      expect(part).toContain("we checked only the first");
    }
  });

  it("escapes hostile words in every part of the HTML", () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const { html, text } = draw({
      organisation: hostile,
      verdict: {
        ...(BASE.verdict as NonNullable<ReplyDesign["verdict"]>),
        headline: hostile,
        reasons: [hostile],
        actions: [hostile],
      },
      notes: [hostile],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(text).toContain(hostile);
  });

  it("passes the email-safety lint in every variant, and the lint catches what clients drop", () => {
    for (const patch of [
      {},
      { verdict: null },
      { headers: { spf: "pass", dkim: "pass", dmarc: "pass" } as const, notes: ["A note."] },
    ])
      expect(emailLint(draw(patch as Partial<ReplyDesign>).html)).toEqual([]);
    const { html } = draw({});
    expect(emailLint(html.replace("display: block", "display:flex"))).not.toEqual([]);
    expect(emailLint(html.replace('alt="IsItLegit"', ""))).not.toEqual([]);
    expect(emailLint(html.replace(COLOURS.themes.light.accent, "#123456"))).not.toEqual([]);
  });
});
