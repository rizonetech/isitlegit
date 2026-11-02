// N9's feedback notice to the operator (D07 T03 §6; design/SPEC.md N9, board `Email-Operator-Feedback`): the
// organisation, the verdict given with its confidence in words, what the member says, the listings the verdict
// leaned on (provider and evidence id), the feedback still waiting, and "Open the feedback queue" (X4, D07 T08 §5).
// Never the member's note, which stays in the app. Both parts, the designed HTML and its plain text, say the same.
import COLOURS from "../../../design/tokens/colors.json";
import { LOGO, MOTION } from "../assets";
import { confidenceWords } from "./report-verdict";

export type NoticeFacts = {
  appUrl: string;
  at: Date;
  organisation: string;
  verdict: "malicious" | "suspicious" | "safe" | null;
  confidence: number | null;
  kind: "false_alarm" | "missed";
  listings: { provider: string; id: string }[];
  waiting: number;
};

// The reputation providers' names (D02 T06's `REPUTATION_PROVIDERS` ids); an id this does not know is said as itself.
const PROVIDER: Record<string, string> = {
  "google-web-risk": "Google Web Risk",
  "cloudflare-security-dns": "Cloudflare Security DNS",
  tranco: "Tranco",
  "majestic-million": "Majestic Million",
};
const VERDICT = { malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" } as const;
const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const C = COLOURS.themes.light;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export function feedbackNotice(facts: NoticeFacts): { subject: string; text: string; html: string } {
  const queue = new URL("/admin/feedback", facts.appUrl).toString();
  const asset = (path: string) => new URL(path, facts.appUrl).toString();
  const verdict = facts.verdict
    ? `${VERDICT[facts.verdict]}${facts.confidence === null ? "" : `, ${confidenceWords(facts.confidence)} confidence`}`
    : "Not recorded";
  const says = facts.kind === "false_alarm" ? "It is safe (false alarm)" : "It is a scam (missed)";
  const leaned = facts.listings.length
    ? facts.listings.map((l) => `${PROVIDER[l.provider] ?? l.provider} listing (${l.id})`).join(", ")
    : "No reputation listing";
  const rows: [string, string][] = [
    ["Organisation", facts.organisation],
    ["Verdict given", verdict],
    ["Member says", says],
    ["Verdict leaned on", leaned],
    ["Open feedback", `${facts.waiting} waiting`],
  ];
  const at = `${time.format(facts.at)} SAST`;
  const subject = "Feedback: a member marked a verdict wrong";
  const lead = "A member says a verdict is wrong.";
  const unchanged =
    "The case and its evidence are unchanged. Any note the member wrote stays in the app, not in this email.";
  const feeds =
    "Feedback never edits a case. It feeds the eval set and the false-alarm count of the provider the verdict leaned on.";
  const why =
    "You received this because you are the IsItLegit operator. Budget cap notices come from the same address.";
  const legal =
    "IsItLegit by Rizonetech (Pty) Ltd, George, South Africa. We never ask for passwords, PINs or bank details by email.";
  const text = [
    lead,
    unchanged,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    feeds,
    "",
    `Open the feedback queue: ${queue}`,
    "",
    why,
    legal,
  ].join("\n");
  const font = "font-family: 'Exo 2', 'Segoe UI', Helvetica, Arial, sans-serif";
  const cell = (k: string, v: string, first: boolean) =>
    `<tr><td width="38%" valign="top" style="${first ? "" : `border-top: 1px solid ${C.line}; `}padding: 10px 12px 10px 0; ${font}; font-size: 14px; color: ${C.muted}">${escapeHtml(k)}</td><td valign="top" style="${first ? "" : `border-top: 1px solid ${C.line}; `}padding: 10px 0; ${font}; font-size: 14px; color: ${C.ink}; font-weight: 600">${escapeHtml(v)}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin: 0; padding: 24px 0 32px; background: ${C.light}">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="width: 600px; max-width: 100%; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 16px; border-collapse: separate">
<tr><td style="padding: 28px 40px 20px"><img src="${asset(LOGO)}" width="148" height="32" alt="IsItLegit" style="display: block; height: 32px; width: auto"></td></tr>
<tr><td style="padding: 0 40px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${C["sus-band"]}; border-radius: 16px"><tr><td width="64" valign="top" style="padding: 24px 0 24px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background: ${C.surface}; border-radius: 12px; padding: 6px"><img src="${asset(MOTION.suspicious)}" width="44" height="44" alt="" style="display: block"></td></tr></table></td><td valign="top" style="padding: 24px 24px 24px 16px"><p style="margin: 0; padding: 0 0 6px; ${font}; font-size: 12px; line-height: 1.4; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C["on-band"]}">Feedback · ${escapeHtml(at)}</p><h1 style="margin: 0; padding: 0 0 6px; font-family: 'Exo', 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 21px; line-height: 1.25; font-weight: 800; color: ${C["on-band"]}">${escapeHtml(lead)}</h1><p style="margin: 0; ${font}; font-size: 15px; line-height: 1.55; color: ${C["on-band"]}">${escapeHtml(unchanged)}</p></td></tr></table></td></tr>
<tr><td style="padding: 0 40px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${C.subtle}; border: 1px solid ${C.line}; border-radius: 12px"><tr><td style="padding: 18px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map(([k, v], i) => cell(k, v, i === 0)).join("")}</table></td></tr></table></td></tr>
<tr><td style="padding: 0 40px 32px"><p style="margin: 0; padding: 0 0 20px; ${font}; font-size: 14px; line-height: 1.55; color: ${C["ink-2"]}">${escapeHtml(feeds)}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate"><tr><td style="background: ${C.accent}; border-radius: 10px"><a href="${escapeHtml(queue)}" style="display: inline-block; padding: 14px 24px; ${font}; font-size: 16px; font-weight: 700; line-height: 1; color: ${C["on-accent"]}; text-decoration: none">Open the feedback queue</a></td></tr></table></td></tr>
<tr><td style="padding: 20px 40px 24px; border-top: 1px solid ${C.line}"><p style="margin: 0; padding: 0 0 10px; ${font}; font-size: 13px; line-height: 1.55; color: ${C.muted}">${escapeHtml(why)}</p><p style="margin: 0; ${font}; font-size: 13px; line-height: 1.55; color: ${C.muted}">${escapeHtml(legal)}</p></td></tr>
</table></body></html>`;
  return { subject, text, html };
}
