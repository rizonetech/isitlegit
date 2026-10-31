import { describe, expect, it } from "vitest";
import COLOURS from "../../design/tokens/colors.json";
import type { VerdictView } from "../../src/db/verdicts";
import { bankChangeAction } from "../../src/invoice/fixed-actions";
import { buildReply, type ReplyInput } from "../../src/mail/reply";
import { type ReplyDesign, replyDesign } from "../../src/mail/templates/reply";

// The verdict reply in N1's design (D07 T03 §7), through `buildReply` as it is sent: each variant's content in both
// parts, the report's fixed-action order, the further findings counted once, coverage said, Headers checked only from
// the authentication results, buildReply's own notes and advice kept, hostile words escaped; the HTML free of what email
// clients drop; and the template's pills only for reasons that cite.
const L = COLOURS.themes.light;
const VIEW: VerdictView = {
  verdict: "malicious",
  headline: "This is a password-phishing email pretending to be NimbusMail.",
  confidence: 0.93,
  reasons: ["The link goes to a lookalike registered 3 days ago."],
  actions: ["Do not click the link or open the attachment.", "Delete the email and warn your team."],
  source: "rules",
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

// What email clients drop or mishandle: stylesheets, scripts, CSS layout, unlabelled images, untokened colours.
const TOKENS = new Set(Object.values(L).map((c) => c.toLowerCase()));
function emailLint(html: string): string[] {
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
      expect(html).toContain("Think we got it wrong? Tell us on the report page.");
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
      expect(part).toContain("Please forward the message again in a few minutes.");
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
    for (const part of [html, text]) expect(part).toContain("2 checks did not finish or read only part of the message");
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

  it("counts the findings the reasons do not cite, once, and says nothing at zero", () => {
    expect(send({}).html).toContain("3 more findings are in the full report.");
    expect(send({ design: { evidence: [] } }).html).not.toContain("more finding");
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

  it("escapes hostile words in every part of the HTML", () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const { html, text } = send({
      view: { headline: hostile, reasons: [hostile], actions: [hostile] },
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
  it("draws a pill only for a reason that cites evidence on the case, and counts repeated citations once", () => {
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
    expect(html).toContain("1 more finding is in the full report.");
    expect(replyDesign(BASE).html).not.toMatch(/border-radius: 999px[^>]*>E\d/);
  });
});
