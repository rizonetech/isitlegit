// The sign-in link, invitation and verification code emails in N2, N3 and N4's design (D07 T08 §6; design/SPEC.md,
// boards `Email-Signin`, `Email-Invite`, `Email-DomainCode`), built like the verdict reply (./reply.ts): tables with inline
// styles from the tokens, the PNG logo, every value that came from outside escaped, and a complete plain text beside the
// HTML. The one link in each is the real one, the first URL of the text; nothing is wrapped or tracked. The sender, kind,
// send key and subject stay with the callers (src/auth/auth.ts, src/auth/claim-mail.ts); the expiries are passed in by the
// code that owns them.
import COLOURS from "../../../design/tokens/colors.json";
import { EMAIL_LOGO } from "../../web/assets";

const C = COLOURS.themes.light;
const FONT = "font-family: 'Exo 2', 'Segoe UI', Helvetica, Arial, sans-serif";
const HEAD = "font-family: 'Exo', 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "font-family: Consolas, 'SFMono-Regular', Menlo, monospace";
const LEGAL =
  "IsItLegit by Rizonetech (Pty) Ltd, George, South Africa. We never ask for passwords, PINs or bank details by email.";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const SAST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// "Wed 29 Oct 2026 at 10:02 SAST" and "09:29 SAST".
function sastParts(at: Date) {
  return Object.fromEntries(SAST.formatToParts(at).map(({ type, value }) => [type, value])) as Record<string, string>;
}
export const sastDateTime = (at: Date) => {
  const p = sastParts(at);
  return `${p.weekday} ${p.day} ${p.month} ${p.year} at ${p.hour}:${p.minute} SAST`;
};
export const sastClock = (at: Date) => {
  const p = sastParts(at);
  return `${p.hour}:${p.minute} SAST`;
};

// A word too long for its line (an organisation or a name) wraps instead of widening the email.
const para = (inner: string, style = "") =>
  `<p style="margin: 0; ${FONT}; overflow-wrap: anywhere; word-break: break-word; font-size: 15px; line-height: 1.55; color: ${C.ink}; ${style}">${inner}</p>`;
const muted = (inner: string) => para(inner, `font-size: 13px; color: ${C.muted}`);
const row = (cell: string, padding = "0 40px 20px") => `<tr><td style="padding: ${padding}">${cell}</td></tr>`;
// The boards' information panel: a bordered, tinted box holding the expiry and the safety advice (and N4's code).
const panel = (inner: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${C.subtle}; border: 1px solid ${C.line}; border-radius: 12px; border-collapse: separate"><tr><td style="padding: 16px 20px">${inner}</td></tr></table>`;
const gap = '<div style="height: 10px; line-height: 10px">&nbsp;</div>';
const button = (url: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate"><tr><td style="background: ${C.accent}; border-radius: 10px"><a href="${escapeHtml(url)}" style="display: inline-block; padding: 16px 24px; ${FONT}; font-size: 16px; font-weight: 700; line-height: 1; color: ${C["on-accent"]}; text-decoration: none">${escapeHtml(label)}</a></td></tr></table>`;
const pasteLink = (url: string) =>
  `${para("Or paste this link into your browser:", `padding: 0 0 6px; color: ${C.muted}`)}<p style="margin: 0; ${MONO}; font-size: 13px; line-height: 1.5; color: ${C.ink}; overflow-wrap: anywhere; word-break: break-all"><a href="${escapeHtml(url)}" style="color: ${C["orange-text"]}">${escapeHtml(url)}</a></p>`;

function frame(input: { appUrl: string; title: string; heading: string; rows: string[]; why: string }) {
  const logo = new URL(EMAIL_LOGO, input.appUrl).toString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)}</title></head><body style="margin: 0; padding: 24px 0 32px; background: ${C.light}">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="width: 600px; max-width: 100%; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 16px; border-collapse: separate">
<tr><td style="padding: 28px 40px 20px"><img src="${logo}" width="108" height="32" alt="IsItLegit" style="display: block; height: 32px; width: auto"></td></tr>
${row(`<h1 style="margin: 0; ${HEAD}; font-size: 24px; line-height: 1.25; font-weight: 800; color: ${C.ink}; overflow-wrap: anywhere; word-break: break-word">${escapeHtml(input.heading)}</h1>`, "0 40px 16px")}
${input.rows.join("\n")}
<tr><td style="padding: 20px 40px 24px; border-top: 1px solid ${C.line}">${muted(escapeHtml(input.why))}<div style="height: 12px; line-height: 12px">&nbsp;</div>${muted(escapeHtml(LEGAL))}</td></tr>
</table></body></html>`;
}

// A lifetime in words: whole hours when it is, else minutes ("48 hours", "15 minutes").
const lifeWords = (seconds: number) => {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
};

// N2: the sign-in link, and the six digits that sign in only the browser that asked.
export function signinEmail(input: {
  appUrl: string;
  email: string;
  link: string;
  code: string;
  lifetimeSeconds: number;
  requestedAt: Date;
}): { text: string; html: string } {
  const expires = new Date(input.requestedAt.getTime() + input.lifetimeSeconds * 1000);
  const life = lifeWords(input.lifetimeSeconds);
  const times = `Expires in ${life}, at ${sastClock(expires)}. Requested at ${sastClock(input.requestedAt)}.`;
  const safety =
    "Did not ask for this? Ignore it. The link and the code each sign in, so never pass either on: the code works only in the browser that asked, and we never ask for a password or for the code.";
  // The link comes first in the text, ahead of anything that came from outside.
  const text = [
    `Sign in to IsItLegit with this link. It works once, for ${life}:`,
    "",
    input.link,
    "",
    `This is for ${input.email}.`,
    "",
    `Or type this code in the browser where you asked for the link (it works only there, once, for the same ${life}):`,
    "",
    input.code,
    "",
    times,
    "",
    safety,
    "",
    "You received this because someone asked to sign in to IsItLegit with this address.",
    LEGAL,
  ].join("\n");
  const html = frame({
    appUrl: input.appUrl,
    title: "Your IsItLegit sign-in link",
    heading: "Sign in to IsItLegit",
    why: "You received this because someone asked to sign in to IsItLegit with this address.",
    rows: [
      row(para(`Use the button below to sign in as ${escapeHtml(input.email)}. It works once.`)),
      row(button(input.link, "Sign in to IsItLegit")),
      row(pasteLink(input.link)),
      row(
        `${para("Or type this code in the browser where you asked for the link. It works only there, once.", `padding: 0 0 8px; color: ${C.muted}`)}<p style="margin: 0; ${MONO}; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: 0.12em; color: ${C.ink}">${escapeHtml(input.code)}</p>`,
      ),
      row(
        panel(`${para(escapeHtml(times), "font-weight: 700")}${gap}${para(escapeHtml(safety), `color: ${C.muted}`)}`),
        "0 40px 24px",
      ),
    ],
  });
  return { text, html };
}

// N3: an invitation, with who sent it, for which organisation and as what.
export function inviteEmail(input: {
  appUrl: string;
  inviter: string;
  organisation: string;
  role: string;
  link: string;
  // The invitation's own deadline and how long it was made to last (its stored `createdAt` and `expiresAt`).
  expiresAt: Date;
  lifetimeSeconds: number;
}): { text: string; html: string } {
  const heading = `${input.inviter} invited you to ${input.organisation} on IsItLegit`;
  const what = `IsItLegit checks suspicious emails, invoices and proof of payment for ${input.organisation}. As ${/^[aeiou]/i.test(input.role) ? "an" : "a"} ${input.role} you can forward anything you are unsure of to check@isitlegit.co.za and see the team's cases.`;
  const until = `Expires in ${lifeWords(input.lifetimeSeconds)}, on ${sastDateTime(input.expiresAt)}. You sign in with a link sent to this address or a passkey, never a password.`;
  const ignore = `Not expecting this? Ignore it, or ask ${input.inviter} at ${input.organisation} on a number you already have.`;
  const why = `You received this because a ${input.organisation} owner or admin invited this address.`;
  // The link comes first in the text: a name that is itself a URL (names are free text) is never the first one.
  const text = [
    "Accept the invitation:",
    "",
    input.link,
    "",
    heading,
    "",
    what,
    "",
    until,
    "",
    ignore,
    "",
    why,
    LEGAL,
  ].join("\n");
  const html = frame({
    appUrl: input.appUrl,
    title: heading,
    heading,
    why,
    rows: [
      row(para(escapeHtml(what))),
      row(button(input.link, "Accept the invitation")),
      row(pasteLink(input.link)),
      row(
        panel(`${para(escapeHtml(until), "font-weight: 700")}${gap}${para(escapeHtml(ignore), `color: ${C.muted}`)}`),
        "0 40px 24px",
      ),
    ],
  });
  return { text, html };
}

// N4: a verification code for a domain (mailed to admin@ or postmaster@ it) or for one address (mailed to it).
export function claimCodeEmail(input: {
  appUrl: string;
  kind: "domain" | "address";
  what: string;
  code: string;
  // The code's own deadline as stored when it was issued, and how long it lasts.
  expiresAt: Date;
  lifetimeSeconds: number;
}): { text: string; html: string } {
  const life = lifeWords(input.lifetimeSeconds);
  const grouped = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;
  const heading = `Your verification code for ${input.what}`;
  const lead = `Someone at an organisation on IsItLegit is proving it controls ${input.what}. Once it is connected, mail forwarded from ${input.kind === "domain" ? "this domain" : "this address"} is checked.`;
  const how = "Type it on the Domains page at app.isitlegit.co.za. There is nothing to click in this email.";
  const until = `Expires in ${life}, at ${sastClock(input.expiresAt)}. Three wrong tries lock verification for an hour.`;
  const ignore = "Did not expect this? Do not share the code with anyone. We will never phone or message you for it.";
  const why =
    input.kind === "domain"
      ? "You received this because it went to admin@ or postmaster@ for the domain someone asked to verify. Only those addresses can receive these codes."
      : "You received this because someone asked to verify this address. Only the address itself can receive its code.";
  // The text keeps the six digits whole (a mail client or a person copying them takes them as one); the HTML groups them as
  // the board does, and the verifier takes either (src/auth/domains.ts).
  const text = [heading, "", lead, "", input.code, "", how, "", until, "", ignore, "", why, LEGAL].join("\n");
  const html = frame({
    appUrl: input.appUrl,
    title: heading,
    heading,
    why,
    rows: [
      row(para(escapeHtml(lead))),
      row(
        panel(
          `<p style="margin: 0; ${MONO}; font-size: 36px; line-height: 1.2; font-weight: 700; letter-spacing: 0.14em; color: ${C.ink}">${escapeHtml(grouped)}</p>`,
        ),
      ),
      row(para(escapeHtml(how))),
      row(
        panel(`${para(escapeHtml(until), "font-weight: 700")}${gap}${para(escapeHtml(ignore), `color: ${C.muted}`)}`),
        "0 40px 24px",
      ),
    ],
  });
  return { text, html };
}

// The trial notices (D07 T08 §11): three days before the Protect trial ends, and after it has. Names the organisation (the
// recipient may belong to more than one, and the Plan page shows the one that is active), the exact end in SAST, which
// protection stops, and that free checks go on. No claim of billing: none is made during the launch.
export function trialNoticeEmail(input: {
  appUrl: string;
  kind: "ending" | "ended";
  organisation: string;
  endsAt: Date;
  link: string;
  freePerDay: number;
}): { subject: string; text: string; html: string } {
  const end = sastDateTime(input.endsAt);
  const day = end.split(" at ")[0] ?? end;
  const subject = (
    input.kind === "ending"
      ? `Your IsItLegit Protect trial for ${input.organisation} ends on ${day}`
      : `The IsItLegit Protect trial for ${input.organisation} ended on ${day}`
  ).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");
  // Dated, never counted down: a notice recovered a day late or sent to an owner added since still tells the truth.
  const heading =
    input.kind === "ending"
      ? `The Protect trial for ${input.organisation} ends on ${day}`
      : `The Protect trial for ${input.organisation} ended on ${day}`;
  const when = input.kind === "ending" ? `The trial ends on ${end}.` : `The trial ended on ${end}.`;
  const stops =
    input.kind === "ending"
      ? "When it ends, these stop: protected identity, impersonation alerts, staff inbox checks, invoice bank-change detection and the supplier ledger, closed-loop bank verification, the impersonation monitor and the payment document check."
      : "These are switched off now: protected identity, impersonation alerts, staff inbox checks, invoice bank-change detection and the supplier ledger, closed-loop bank verification, the impersonation monitor and the payment document check.";
  // What the organisation really keeps afterwards: its cap as the Plan page reads it (an operator's override included), and a
  // pause said as a pause.
  const free =
    input.freePerDay <= 0
      ? `Checking is paused for ${input.organisation} by IsItLegit, so no checks run until we turn it back on: tell us at support@isitlegit.co.za. Nothing is billed during the launch.`
      : `Free checks continue: verdicts on forwarded mail, up to ${input.freePerDay} a day. Nothing is billed during the launch, and we will ask before anything is charged.`;
  const switchFirst = `Open the Plan page for ${input.organisation}. If you belong to more than one organisation, switch to ${input.organisation} first.`;
  const why = `You received this because you are an owner of ${input.organisation} on IsItLegit.`;
  const text = [
    "See your plan:",
    "",
    input.link,
    "",
    heading,
    "",
    when,
    "",
    stops,
    "",
    free,
    "",
    switchFirst,
    "",
    why,
    LEGAL,
  ].join("\n");
  const html = frame({
    appUrl: input.appUrl,
    title: subject,
    heading,
    why,
    rows: [
      row(para(escapeHtml(when), "font-weight: 700")),
      row(panel(`${para(escapeHtml(stops))}${gap}${para(escapeHtml(free), `color: ${C.muted}`)}`)),
      row(button(input.link, "See your plan")),
      row(pasteLink(input.link)),
      row(para(escapeHtml(switchFirst), `color: ${C.muted}`), "0 40px 24px"),
    ],
  });
  return { subject, text, html };
}

// The Friday weekly counts for a member who opted in (D07 T04 §20, N10): the three Cases tiles' numbers for the
// week as it stands on Friday, the organisation named, a link to Cases and the one-step unsubscribe. Counts only,
// never a case's content.
export function weeklyReportEmail(input: {
  appUrl: string;
  organisation: string;
  checked: number;
  flagged: number;
  medianSeconds: number | null;
  casesLink: string;
  unsubscribeLink: string;
}): { subject: string; text: string; html: string } {
  const clean = (v: string) => v.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");
  const median =
    input.medianSeconds === null
      ? "No verdicts yet"
      : input.medianSeconds < 60
        ? `${input.medianSeconds} s`
        : `${Math.floor(input.medianSeconds / 60)} min ${input.medianSeconds % 60 ? `${input.medianSeconds % 60} s` : ""}`.trim();
  const subject = clean(`Your week so far at ${input.organisation}: ${input.checked} checked, ${input.flagged} malicious or suspicious`);
  const heading = clean(`Your week so far at ${input.organisation}`);
  const lines = [
    `Checked this week: ${input.checked}`,
    `Malicious or suspicious: ${input.flagged}`,
    `Median time to verdict: ${median}`,
  ];
  const why = clean(`You received this because you asked for ${input.organisation}'s weekly counts on IsItLegit.`);
  const text = [
    heading,
    "",
    ...lines,
    "",
    "Open your cases:",
    input.casesLink,
    "",
    "Stop these emails:",
    input.unsubscribeLink,
    "",
    why,
    LEGAL,
  ].join("\n");
  const html = frame({
    appUrl: input.appUrl,
    title: subject,
    heading,
    why,
    rows: [
      row(panel(lines.map((line) => para(escapeHtml(line))).join(gap))),
      row(button(input.casesLink, "Open your cases")),
      row(pasteLink(input.casesLink)),
      row(
        para(
          `Stop these emails: <a href="${escapeHtml(input.unsubscribeLink)}" style="color: ${C["orange-text"]}">unsubscribe</a>`,
          `color: ${C.muted}`,
        ),
        "0 40px 24px",
      ),
    ],
  });
  return { subject, text, html };
}
