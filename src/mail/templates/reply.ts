// The verdict reply in N1's design (D07 T03 §7; design/SPEC.md N1, board `Email-Reply`, member variant): the report's
// first screen as an email. The band (the verdict, its confidence in words, the headline and what it means), What to do
// now (the report's order: a fixed action first, then at most three), Why we say so (at most three, a pill for a reason
// that cites its evidence), the further findings, what the checks did not cover, Open the full report with the link to
// paste, Headers checked when the authentication results are known, `buildReply`'s own notes, and the footer. A reply
// with no verdict takes the same frame with the failure's words. Built as tables with inline styles (email clients drop
// stylesheets and most layout), its colours the light theme's tokens (design/tokens/colors.json). The plain text stays
// `buildReply`'s own words (src/mail/reply.ts, the checks lane's), which takes the shared lines below for what the
// design adds; it passes its notes, advice and subject in here.
import COLOURS from "../../../design/tokens/colors.json";
import { LOGO, MOTION } from "../../web/assets";
import { confidenceWords, MEANING, orderedActions, reasonsOf } from "../../web/pages/report-verdict";

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
  } | null;
  // The case's evidence, for the pills' colours and the count of findings the reasons do not cite.
  evidence: readonly { id: string; severity: Severity }[];
  voice: boolean;
  // The stored check outcomes (D02 T01 §3); null when none were stored.
  coverage: readonly { check: string; outcome: "ran" | "partial" | "skipped" | "failed" }[] | null;
  // The authentication results (D01 T02 §11), when the checks read them.
  headers?: { spf: AuthState; dkim: AuthState; dmarc: AuthState };
  // `buildReply`'s own words: its notes, and for a reply with no verdict its lead and advice.
  notes: readonly string[];
  failure?: { lead: string; advice: string };
  // The message's subject, `buildReply`'s, as the HTML document's title.
  title?: string;
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
  none: "not set up",
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
const para = (text: string, style: string) => `<p style="margin: 0; ${FONT}; ${style}">${text}</p>`;
const eyebrow = (text: string) =>
  `<p style="margin: 0; padding: 0 0 10px; ${FONT}; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.muted}">${escapeHtml(text)}</p>`;
const row = (cell: string, padding = "0 40px 24px") => `<tr><td style="padding: ${padding}">${cell}</td></tr>`;
const table = (inner: string, style = "") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${style ? ` style="${style}"` : ""}>${inner}</table>`;

export function replyDesign(input: ReplyDesign): { html: string } {
  const asset = (path: string) => new URL(path, input.appUrl).toString();
  const v = input.verdict;
  const severity = new Map(input.evidence.map((e) => [e.id, e.severity]));
  const html: string[] = [];

  if (v) {
    const eyebrowWords = `${WORD[v.verdict]} · ${confidenceWords(v.confidence)} confidence`;
    html.push(
      row(
        table(
          `<tr><td width="64" valign="top" style="padding: 24px 0 24px 24px">${table(`<tr><td style="background: ${C["on-band"]}; border-radius: 12px; padding: 6px"><img src="${asset(MOTION[v.verdict])}" width="44" height="44" alt="" style="display: block"></td></tr>`, "width: auto")}</td><td valign="top" style="padding: 24px 24px 24px 16px">${para(escapeHtml(eyebrowWords), `padding: 0 0 6px; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C["on-band"]}`)}<h1 style="margin: 0; padding: 0 0 6px; ${HEAD}; font-size: 21px; line-height: 1.25; font-weight: 800; color: ${C["on-band"]}; word-break: break-word">${escapeHtml(v.headline)}</h1>${para(escapeHtml(MEANING[v.verdict]), `font-size: 15px; line-height: 1.55; color: ${C["on-band"]}`)}</td></tr>`,
          `background: ${BAND[v.verdict]}; border-radius: 16px`,
        ),
        "0 40px 28px",
      ),
    );

    const { actions } = orderedActions(v.actions, input.voice);
    if (actions.length) {
      html.push(
        row(
          eyebrow("What to do now") +
            table(
              actions
                .map(
                  (a, i) =>
                    `<tr><td width="34" valign="top" style="padding: 0 0 10px"><span style="display: inline-block; width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 12px; background: ${C.dark}; color: ${C["on-dark"]}; ${FONT}; font-size: 13px; font-weight: 700">${i + 1}</span></td><td valign="top" style="padding: 1px 0 10px">${para(escapeHtml(a), `font-size: 15px; line-height: 1.55; color: ${C.ink}`)}</td></tr>`,
                )
                .join(""),
            ),
          "0 40px 16px",
        ),
      );
    }

    const reasons = reasonsOf(v.reasons).slice(0, 3);
    if (reasons.length) {
      html.push(
        row(
          eyebrow("Why we say so") +
            table(
              reasons
                .map((r) => {
                  const id = r.evidenceIds[0];
                  const level = id ? severity.get(id) : undefined;
                  const [wash, ink] = level ? PILL[level] : ["", ""];
                  const pill =
                    id && level
                      ? `<span style="display: inline-block; padding: 3px 9px; border-radius: 999px; background: ${wash}; color: ${ink}; ${FONT}; font-size: 13px; font-weight: 700">${escapeHtml(id)}</span>`
                      : "";
                  return `<tr>${pill ? `<td width="52" valign="top" style="padding: 0 12px 12px 0">${pill}</td>` : ""}<td valign="top" style="padding: 0 0 12px"${pill ? "" : ' colspan="2"'}>${para(escapeHtml(r.text), `font-size: 15px; line-height: 1.55; color: ${C.ink}; word-break: break-word`)}</td></tr>`;
                })
                .join(""),
            ),
          "0 40px 12px",
        ),
      );
    }

    // The findings the drawn reasons do not cite, each once.
    const cited = new Set(reasons.flatMap((r) => r.evidenceIds).filter((id) => severity.has(id)));
    const more = input.evidence.length - cited.size;
    const moreWords =
      more > 0 ? `${plural(more, "more finding")} ${more === 1 ? "is" : "are"} in the full report.` : "";
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
          `<tr><td width="64" valign="top" style="padding: 24px 0 24px 24px">${table(`<tr><td style="background: ${C["on-band"]}; border-radius: 12px; padding: 6px"><img src="${asset(MOTION.question)}" width="44" height="44" alt="" style="display: block"></td></tr>`, "width: auto")}</td><td valign="top" style="padding: 24px 24px 24px 16px">${para("Check failed · no verdict", `padding: 0 0 6px; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C["on-band"]}`)}<h1 style="margin: 0; padding: 0 0 6px; ${HEAD}; font-size: 21px; line-height: 1.25; font-weight: 800; color: ${C["on-band"]}">${escapeHtml(failure.lead)}</h1>${failure.advice ? para(escapeHtml(failure.advice), `font-size: 15px; line-height: 1.55; color: ${C["on-band"]}`) : ""}</td></tr>`,
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
  if (input.headers) {
    const h = input.headers;
    const words = headersWords(h);
    panels.push(`<strong>Headers checked.</strong> ${escapeHtml(words)}`);
  }
  for (const note of input.notes) {
    panels.push(escapeHtml(note));
  }
  if (panels.length)
    html.push(
      row(
        table(
          `<tr><td style="padding: 18px 20px">${panels.map((p, i) => para(p, `${i ? "padding: 12px 0 0; " : ""}font-size: 14px; line-height: 1.55; color: ${C["ink-2"]}`)).join("")}</td></tr>`,
          `background: ${C.subtle}; border: 1px solid ${C.line}; border-radius: 12px`,
        ),
        "0 40px 32px",
      ),
    );
  const [why, legal] = footerWords(input.organisation);
  html.push(
    `<tr><td style="padding: 20px 40px 24px; border-top: 1px solid ${C.line}">${para(escapeHtml(why), `padding: 0 0 10px; font-size: 13px; line-height: 1.55; color: ${C.muted}`)}${para(escapeHtml(legal), `font-size: 13px; line-height: 1.55; color: ${C.muted}`)}</td></tr>`,
  );

  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title ?? "Your IsItLegit verdict")}</title></head><body style="margin: 0; padding: 24px 0 32px; background: ${C.light}">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="width: 600px; max-width: 100%; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 16px; border-collapse: separate">
<tr><td style="padding: 28px 40px 20px"><img src="${asset(LOGO)}" width="148" height="32" alt="IsItLegit" style="display: block; height: 32px; width: auto"></td></tr>
${html.join("\n")}
</table></body></html>`;
  return { html: body };
}

// The words both parts say for incomplete coverage, the footer and the authentication results (`buildReply`'s text uses them).
export function coverageWords(coverage: ReplyDesign["coverage"]): string {
  const gaps = (coverage ?? []).filter((o) => o.outcome !== "ran").length;
  return gaps > 0
    ? `${plural(gaps, "check")} did not finish or read only part of the message, so this verdict rests on the checks that did. The full report says which.`
    : "";
}
export function footerWords(org: string | null): [string, string] {
  return [
    org
      ? `You received this because you forwarded an email to check@isitlegit.co.za from ${org}. The report link is signed for ${org} and expires after 7 days. Think we got it wrong? Tell us on the report page.`
      : "You received this because you forwarded an email to check@isitlegit.co.za. The report link expires after 7 days. Think we got it wrong? Tell us on the report page.",
    "IsItLegit by Rizonetech (Pty) Ltd, George, South Africa. We never ask for passwords, PINs or bank details by email.",
  ];
}
export function headersWords(h: NonNullable<ReplyDesign["headers"]>): string {
  return `You forwarded the email as an attachment, so we could check who really sent it: SPF ${AUTH[h.spf]}, DKIM ${AUTH[h.dkim]}, DMARC ${AUTH[h.dmarc]}.`;
}

function button(url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate"><tr><td style="background: ${C.accent}; border-radius: 10px"><a href="${escapeHtml(url)}" style="display: inline-block; padding: 14px 24px; ${FONT}; font-size: 16px; font-weight: 700; line-height: 1; color: ${C["on-accent"]}; text-decoration: none">Open the full report</a></td></tr></table>`;
}
