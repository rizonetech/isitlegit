// The verdict reply in N1's design (D07 T03 §7; design/SPEC.md N1, board `Email-Reply`, member variant): the report's
// first screen as an email. The band (the verdict, its confidence in words, the headline and what it means), What to do
// now (the report's order: a fixed action first, then at most three), Why we say so (at most three, a pill for a reason
// that cites its evidence), the further findings, what the checks did not cover, Open the full report with the link to
// paste, Headers checked when the authentication results are known, `buildReply`'s own notes, and the footer. A reply
// with no verdict takes the same frame with the failure's words. Built as tables with inline styles (email clients drop
// stylesheets and most layout) and PNG images (Gmail and Outlook show no SVG), its colours, type sizes and spacing the tokens (design/tokens), the section titles
// headings and the actions and reasons lists to a screen reader (the layout tables otherwise read as nothing). The plain text stays
// `buildReply`'s own words (src/mail/reply.ts, the checks lane's), which takes the shared lines below for what the
// design adds; it passes its notes, advice and subject in here.
import COLOURS from "../../../design/tokens/colors.json";
import { EMAIL_ART, EMAIL_LOGO } from "../../web/assets";
import { CHECK_WORDS } from "../../web/components/evidence/check-words";
import {
  cited as citedOf,
  confidenceWords,
  meaningOf,
  orderedActions,
  reasonsOf,
} from "../../web/pages/report-verdict";

const C = COLOURS.themes.light;
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type AuthState = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
export type ReplyDesign = {
  appUrl: string;
  reportUrl: string;
  organisation: string | null;
  verdict: {
    verdict: "malicious" | "suspicious" | "safe";
    headline: string;
    confidence: number;
    reasons: readonly (string | { text: string; evidenceIds: string[] })[];
    actions: readonly string[];
    meaning?: string | null;
  } | null;
  // The case's evidence, for the pills' colours and the count of findings the reasons do not cite.
  evidence: readonly { id: string; severity: Severity }[];
  voice: boolean;
  // The stored check outcomes (D02 T01 §3); null when none were stored.
  coverage: readonly { check: string; outcome: "ran" | "partial" | "skipped" | "failed" }[] | null;
  // The authentication results (D01 T02 §11), when the checks read them.
  // Each method's result as the receiving system reported it; a method it did not report is absent (D07 T03 §34).
  // `domains`: the From domain and the domain each method passed for, as the producer gives them (D07 T03 §36).
  headers?: {
    spf?: AuthState;
    dkim?: AuthState;
    dmarc?: AuthState;
    domains?: { from?: string; spf?: string; dkim?: string };
  };
  // `buildReply`'s own words: its notes, and for a reply with no verdict its lead and advice.
  notes: readonly string[];
  failure?: { lead: string; advice: string };
  // The message's subject, `buildReply`'s, as the HTML document's title.
  title?: string;
  // `buildReply`'s advice for a verdict that stored no actions, drawn in their place.
  fallbackActions?: readonly string[];
};

const WORD = { malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" } as const;
const BAND = { malicious: C["mal-band"], suspicious: C["sus-band"], safe: C["safe-band"] } as const;
const PILL: Record<Severity, [string, string]> = {
  critical: [C["mal-wash"], C.mal],
  high: [C["mal-wash"], C.mal],
  medium: [C["sus-wash"], C.sus],
  low: [C["partial-wash"], C.partial],
  info: [C["safe-wash"], C.safe],
};
const AUTH: Record<AuthState, string> = {
  pass: "passed",
  fail: "failed",
  softfail: "soft-failed",
  neutral: "gave no answer",
  // Each method's own `none` is worded in `noneWords` below; this is never shown.
  none: "found nothing to check",
  temperror: "could not be checked",
  permerror: "is broken",
};
const FONT = "font-family: 'Exo 2', 'Segoe UI', Helvetica, Arial, sans-serif";
const HEAD = "font-family: 'Exo', 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "font-family: Consolas, 'SFMono-Regular', Menlo, monospace";
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Every paragraph wraps a word too long for its line (a long organisation name, headline or domain), so nothing a
// sender or an organisation chose can push the email wider than a phone.
const para = (text: string, style: string) =>
  `<p style="margin: 0; ${FONT}; overflow-wrap: anywhere; word-break: break-word; ${style}">${text}</p>`;
const heading = (text: string) =>
  `<h2 style="margin: 0; padding: 0 0 12px; ${FONT}; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.muted}">${escapeHtml(text)}</h2>`;
const row = (cell: string, padding = "0 40px 24px") => `<tr><td style="padding: ${padding}">${cell}</td></tr>`;
const table = (inner: string, style = "") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${style ? ` style="${style}"` : ""}>${inner}</table>`;
// A layout table a screen reader reads as a list: each row an item, its cells no table.
const list = (items: string[]) =>
  `<table role="list" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody role="none">${items.map((cells) => `<tr role="listitem">${cells}</tr>`).join("")}</tbody></table>`;
// The verdict's art in its white tile: 40 px in 8 px of padding, the 56 px the column holds.
const tile = (src: string) =>
  table(
    `<tr><td style="background: ${C["on-band"]}; border-radius: 12px; padding: 8px"><img src="${src}" width="40" height="40" alt="" style="display: block"></td></tr>`,
    "width: auto",
  );

export function replyDesign(input: ReplyDesign): { html: string } {
  const asset = (path: string) => new URL(path, input.appUrl).toString();
  const v = input.verdict;
  const severity = new Map(input.evidence.map((e) => [e.id, e.severity]));
  const html: string[] = [];

  if (v) {
    const eyebrowWords = `${WORD[v.verdict]} · ${confidenceWords(v.confidence)} confidence`;
    // The stored actions, or `buildReply`'s fallback for a verdict with none, so the HTML never drops the advice.
    html.push(
      row(
        table(
          `<tr><td width="80" valign="top" style="padding: 24px 0 24px 24px">${tile(asset(EMAIL_ART[v.verdict]))}</td><td valign="top" style="padding: 24px 24px 24px 16px">${para(escapeHtml(eyebrowWords), `padding: 0 0 8px; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C["on-band"]}`)}<h1 style="margin: 0; padding: 0 0 8px; ${HEAD}; font-size: 22px; line-height: 1.25; font-weight: 800; color: ${C["on-band"]}; word-break: break-word">${escapeHtml(v.headline)}</h1>${para(escapeHtml(meaningOf(v)), `font-size: 15px; line-height: 1.55; color: ${C["on-band"]}`)}</td></tr>`,
          `background: ${BAND[v.verdict]}; border-radius: 16px`,
        ),
        "0 40px 28px",
      ),
    );

    const { actions } = orderedActions(v.actions.length ? v.actions : (input.fallbackActions ?? []), input.voice);
    if (actions.length) {
      html.push(
        row(
          heading("What to do now") +
            list(
              actions.map(
                (a, i) =>
                  `<td role="none" width="36" valign="top" style="padding: 0 0 12px"><span style="display: inline-block; width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 12px; background: ${C.dark}; color: ${C["on-dark"]}; ${FONT}; font-size: 13px; font-weight: 700">${i + 1}</span></td><td role="none" valign="top" style="padding: 0 0 12px">${para(escapeHtml(a), `font-size: 15px; line-height: 1.55; color: ${C.ink}`)}</td>`,
              ),
            ),
          "0 40px 16px",
        ),
      );
    }

    const reasons = reasonsOf(v.reasons).slice(0, 3);
    if (reasons.length) {
      html.push(
        row(
          heading("Why we say so") +
            list(
              reasons.map((r) => {
                const id = r.evidenceIds[0];
                const level = id ? severity.get(id) : undefined;
                const [wash, ink] = level ? PILL[level] : ["", ""];
                const pill =
                  id && level
                    ? `<span style="display: inline-block; padding: 4px 8px; border-radius: 999px; background: ${wash}; color: ${ink}; ${FONT}; font-size: 13px; font-weight: 700">${escapeHtml(id)}</span>`
                    : "";
                return `${pill ? `<td role="none" width="56" valign="top" style="padding: 0 12px 12px 0">${pill}</td>` : ""}<td role="none" valign="top" style="padding: 0 0 12px"${pill ? "" : ' colspan="2"'}>${para(escapeHtml(r.text), `font-size: 15px; line-height: 1.55; color: ${C.ink}; word-break: break-word`)}</td>`;
              }),
            ),
          "0 40px 12px",
        ),
      );
    }

    const moreWords = moreFindingsWords(v, input.evidence);
    const gapWords = coverageWords(input.coverage);
    const extra = [moreWords, gapWords].filter(Boolean);
    html.push(
      row(
        extra
          .map((w) => para(escapeHtml(w), `padding: 0 0 20px; font-size: 15px; line-height: 1.55; color: ${C.muted}`))
          .join("") + button(input.reportUrl),
      ),
    );
  } else {
    const failure = input.failure ?? { lead: "We could not finish checking this message.", advice: "" };
    html.push(
      row(
        table(
          `<tr><td width="80" valign="top" style="padding: 24px 0 24px 24px">${tile(asset(EMAIL_ART.question))}</td><td valign="top" style="padding: 24px 24px 24px 16px">${para("Check failed · no verdict", `padding: 0 0 8px; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C["on-band"]}`)}<h1 style="margin: 0; padding: 0 0 8px; ${HEAD}; font-size: 22px; line-height: 1.25; font-weight: 800; color: ${C["on-band"]}">${escapeHtml(failure.lead)}</h1>${failure.advice ? para(escapeHtml(failure.advice), `font-size: 15px; line-height: 1.55; color: ${C["on-band"]}`) : ""}</td></tr>`,
          `background: ${C["partial-band"]}; border-radius: 16px`,
        ),
        "0 40px 28px",
      ) + row(button(input.reportUrl)),
    );
  }

  // The link to paste, the authentication results when known, the notes and the footer.
  const paste = `Or paste this link into your browser:<br><span style="${MONO}; font-size: 13px; color: ${C["ink-2"]}; word-break: break-all">${escapeHtml(input.reportUrl)}</span>`;
  html.push(row(para(paste, `font-size: 14px; line-height: 1.55; color: ${C.muted}`), "0 40px 24px"));
  const panels: string[] = [];
  // Drawn only when at least one method was reported: an empty sentence is no panel.
  const words = input.headers ? headersWords(input.headers) : "";
  if (words) panels.push(`<strong>Headers checked.</strong> ${escapeHtml(words)}`);
  for (const note of input.notes) {
    panels.push(escapeHtml(note));
  }
  if (panels.length)
    html.push(
      row(
        table(
          `<tr><td style="padding: 20px">${panels.map((p, i) => para(p, `${i ? "padding: 12px 0 0; " : ""}font-size: 14px; line-height: 1.55; color: ${C["ink-2"]}`)).join("")}</td></tr>`,
          `background: ${C.subtle}; border: 1px solid ${C.line}; border-radius: 12px`,
        ),
        "0 40px 32px",
      ),
    );
  return memberFrame({
    appUrl: input.appUrl,
    ...(input.title ? { title: input.title } : {}),
    organisation: input.organisation,
    reportUrl: input.reportUrl,
    rows: html,
  });
}

// The 600 px member email frame (design/SPEC.md section 8, N1): the logo at top, the caller's rows, and the linked
// dispute footer. Shared by the single reply and the grouped reply (D01 T01 §12).
export function memberFrame(input: {
  appUrl: string;
  title?: string;
  organisation: string | null;
  reportUrl: string;
  rows: readonly string[];
}): { html: string } {
  const asset = (path: string) => new URL(path, input.appUrl).toString();
  const [why, legal] = footerWords(input.organisation, input.reportUrl);
  // The dispute address as a link in the HTML part (D07 T03 §22), its words as in the plain part.
  const whyHtml = escapeHtml(why).replace(
    `Tell us on the report page: ${escapeHtml(disputeUrl(input.reportUrl))}.`,
    `<a href="${escapeHtml(disputeUrl(input.reportUrl))}" style="color: ${C["orange-text"]}">Tell us on the report page</a>.`,
  );
  const footer = `<tr><td style="padding: 20px 40px 24px; border-top: 1px solid ${C.line}">${para(whyHtml, `padding: 0 0 12px; font-size: 13px; line-height: 1.55; color: ${C.muted}`)}${para(escapeHtml(legal), `font-size: 13px; line-height: 1.55; color: ${C.muted}`)}</td></tr>`;

  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title ?? "Your IsItLegit verdict")}</title></head><body style="margin: 0; padding: 24px 0 32px; background: ${C.light}">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="width: 600px; max-width: 100%; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 16px; border-collapse: separate">
<tr><td style="padding: 28px 40px 20px"><img src="${asset(EMAIL_LOGO)}" width="108" height="32" alt="IsItLegit" style="display: block; height: 32px; width: auto"></td></tr>
${[...input.rows, footer].join("\n")}
</table></body></html>`;
  return { html: body };
}

export function groupedReplyDesign(input: {
  appUrl: string;
  title?: string;
  organisation: string | null;
  reportUrl: string;
  blocks: readonly { subject: string; verdict: string; advice: string | null; reportUrl: string }[];
  notCheckedNote: string | null;
}): { html: string } {
  const rows: string[] = [
    row(
      para(
        "We checked the messages in your forward. Each has its own report:",
        `font-size: 15px; line-height: 1.55; color: ${C.ink}`,
      ),
      "0 40px 16px",
    ),
    row(
      list(
        input.blocks.map(
          (block, index) =>
            `<td role="none" style="padding: 12px 0; border-top: 1px solid ${C.line}">${para(`${index + 1}. ${escapeHtml(block.subject)}`, `padding: 0 0 4px; font-size: 15px; line-height: 1.55; font-weight: 700; color: ${C.ink}`)}${para(escapeHtml(block.verdict), `padding: 0 0 4px; font-size: 15px; line-height: 1.55; color: ${C.ink}`)}${block.advice ? para(escapeHtml(block.advice), `padding: 0 0 4px; font-size: 14px; line-height: 1.55; color: ${C["ink-2"]}`) : ""}${para(`<a href="${escapeHtml(block.reportUrl)}" style="color: ${C["orange-text"]}">The full report</a>`, `font-size: 14px; line-height: 1.55; color: ${C.muted}`)}</td>`,
        ),
      ),
      "0 40px 20px",
    ),
  ];
  if (input.notCheckedNote) {
    rows.push(
      row(
        para(escapeHtml(input.notCheckedNote), `font-size: 14px; line-height: 1.55; color: ${C["ink-2"]}`),
        "0 40px 24px",
      ),
    );
  }
  return memberFrame({
    appUrl: input.appUrl,
    ...(input.title ? { title: input.title } : {}),
    organisation: input.organisation,
    reportUrl: input.reportUrl,
    rows,
  });
}

// The words both parts say for incomplete coverage, the footer and the authentication results (`buildReply`'s text uses them).
// Each check that did not run whole, named as the report names it (D07 T03 §3), so the reader need not open it.
export function coverageWords(coverage: ReplyDesign["coverage"]): string {
  const gaps = (coverage ?? []).filter((o) => o.outcome !== "ran");
  if (!gaps.length) return "";
  const named = gaps.map(
    (o) =>
      `${CHECK_WORDS[o.check] ?? "A check"} ${o.outcome === "partial" ? "read only part of its input" : "did not run"}`,
  );
  return `${plural(gaps.length, "check")} did not finish or read only part of the message, so this verdict rests on the checks that did: ${named.join("; ")}.`;
}
// The findings the report counts as more (`cited`, D07 T03 §2: the first item each of the first three reasons cites),
// each once, nothing at zero, so the email and the report always give the same number.
export function moreFindingsWords(
  verdict: NonNullable<ReplyDesign["verdict"]>,
  evidence: ReplyDesign["evidence"],
): string {
  const ids = new Set(evidence.map((e) => e.id));
  const cited = new Set(citedOf(verdict).filter((id) => ids.has(id)));
  const more = evidence.length - cited.size;
  return more > 0 ? `${plural(more, "more finding")} ${more === 1 ? "is" : "are"} in the full report.` : "";
}
// The band's confidence and what the verdict means, for the plain text, which names the verdict in its own words.
export function meaningWords(v: NonNullable<ReplyDesign["verdict"]>): string {
  const level = confidenceWords(v.confidence);
  return `${level.charAt(0).toUpperCase()}${level.slice(1)} confidence. ${meaningOf(v)}`;
}
// The report address carrying the dispute intent (D07 T03 §22): a member opening it, signed in or after signing in,
// lands on the one-press dispute, focused; the plain report link carries no intent.
export const disputeUrl = (reportUrl: string) => `${reportUrl}${reportUrl.includes("?") ? "&" : "?"}dispute=1`;
export function footerWords(org: string | null, reportUrl?: string): [string, string] {
  const tell = reportUrl
    ? `Think we got it wrong? Tell us on the report page: ${disputeUrl(reportUrl)}.`
    : "Think we got it wrong? Tell us on the report page.";
  return [
    org
      ? `You received this because you forwarded an email to check@isitlegit.co.za from ${org}. The report link is signed for ${org} and expires after 7 days. ${tell}`
      : `You received this because you forwarded an email to check@isitlegit.co.za. The report link expires after 7 days. ${tell}`,
    "IsItLegit by Rizonetech (Pty) Ltd, George, South Africa. We never ask for passwords, PINs or bank details by email.",
  ];
}
// What `none` means for each method (D07 T03 §35): DKIM found no signature on the message (RFC 8601 §2.7.1), not that
// the domain has no DKIM; SPF found no record to check (RFC 8601 §2.7.2, RFC 7208 §2.6.1); DMARC found no policy
// to apply (RFC 7489 §11.2: none was published, or no aligned identifier could be extracted to look one up).
const NONE_WORDS = { spf: "found no record to check", dkim: "found no signature", dmarc: "found no policy to apply" };
// Each method named once, its result or that the receiving system did not report it; empty when none was reported.
const METHODS = [
  ["spf", "SPF"],
  ["dkim", "DKIM"],
  ["dmarc", "DMARC"],
] as const;
export function headersWords(h: NonNullable<ReplyDesign["headers"]>): string {
  if (!METHODS.some(([key]) => h[key])) return "";
  const results = METHODS.map(([key, name]) => {
    const state = h[key];
    if (!state) return `${name} not reported by the receiving system`;
    return `${name} ${state === "none" ? NONE_WORDS[key] : AUTH[state]}`;
  });
  // The receiving system's record, never a claim of who sent the message (D07 T03 §36).
  const record = `You forwarded the email as an attachment, so we could read the checks the receiving system recorded: ${results.join(", ")}.`;
  const aligned = alignmentWords(h);
  return [record, aligned, ROLES].filter(Boolean).join(" ");
}

// A domain from the message, as shown: cut at the DNS name limit (253 characters, RFC 1035 §2.3.4).
const shown = (domain: string | undefined) => (domain ? domain.slice(0, 253) : undefined);
// Why DMARC failed although SPF or DKIM passed, said as the rule and nothing more: a pass counts toward DMARC only when
// it establishes the domain the message says it is from (RFC 7489 §3.1), and these did not. It never asserts why: an
// SPF pass for the HELO name, say, can be for the From domain and still not count (RFC 7489 §3.1.2). Every passing
// method is named, with its domain when the producer gives it, and the From domain when known. A pass for the From
// domain itself with DMARC failing is a record these results do not explain, and is said to be so.
function alignmentWords(h: NonNullable<ReplyDesign["headers"]>): string {
  const passed = (["spf", "dkim"] as const)
    .filter((key) => h[key] === "pass")
    .map((key) => ({ name: key.toUpperCase(), domain: shown(h.domains?.[key]) }));
  if (h.dmarc !== "fail" || !passed.length) return "";
  const from = shown(h.domains?.from);
  const named = passed.some((p) => p.domain);
  const list = named
    ? passed.map((p) => (p.domain ? `${p.name} passed for ${p.domain}` : `${p.name} passed`)).join(" and ")
    : `${passed.map((p) => p.name).join(" and ")} passed`;
  if (from && passed.some((p) => p.domain?.toLowerCase() === from.toLowerCase()))
    return `The receiving system recorded DMARC as failed although ${list}, and the message says it is from ${from}; these results do not explain that failure.`;
  return `DMARC failed although ${list}: a pass counts toward DMARC only when it establishes the domain the message says it is from${from ? ` (${from})` : ""}, and ${passed.length > 1 ? "these did" : "this one did"} not.`;
}
// What each method checks, once, so the results read without specialist knowledge.
const ROLES =
  "SPF checks that the sending server may send for a domain, DKIM checks a signature a domain put on the message, and DMARC checks that one of them passed for the domain the message says it is from.";

function button(url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate"><tr><td style="background: ${C.accent}; border-radius: 10px"><a href="${escapeHtml(url)}" style="display: inline-block; padding: 16px 24px; ${FONT}; font-size: 16px; font-weight: 700; line-height: 1; color: ${C["on-accent"]}; text-decoration: none">Open the full report</a></td></tr></table>`;
}
