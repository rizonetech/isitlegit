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

const minutesWords = (seconds: number) => {
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
  const life = minutesWords(input.lifetimeSeconds);
  const times = `Expires in ${life}, at ${sastClock(expires)}. Requested at ${sastClock(input.requestedAt)}.`;
  const text = [
    `Sign in to IsItLegit as ${input.email} with this link. It works once, for ${life}:`,
    "",
    input.link,
    "",
    `Or type this code in the browser where you asked for the link (it works only there, once, for the same ${life}):`,
    "",
    input.code,
    "",
    times,
    "",
    "Did not ask for this? Ignore it. Nobody can sign in without this link, and we never ask for a password.",
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
      row(para(escapeHtml(times), `font-weight: 700`)),
      row(
        para(
          "Did not ask for this? Ignore it. Nobody can sign in without this link, and we never ask for a password.",
          `color: ${C.muted}`,
        ),
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
  expiresAt: Date;
}): { text: string; html: string } {
  const heading = `${input.inviter} invited you to ${input.organisation} on IsItLegit`;
  const what = `IsItLegit checks suspicious emails, invoices and proof of payment for ${input.organisation}. As ${/^[aeiou]/i.test(input.role) ? "an" : "a"} ${input.role} you can forward anything you are unsure of to check@isitlegit.co.za and see the team's cases.`;
  const until = `Expires in 48 hours, on ${sastDateTime(input.expiresAt)}. You sign in with a link sent to this address or a passkey, never a password.`;
  const ignore = `Not expecting this? Ignore it, or ask ${input.inviter} at ${input.organisation} on a number you already have.`;
  const why = `You received this because a ${input.organisation} owner or admin invited this address.`;
  const text = [
    heading,
    "",
    what,
    "",
    "Accept the invitation:",
    "",
    input.link,
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
      row(para(escapeHtml(until), "font-weight: 700")),
      row(para(escapeHtml(ignore), `color: ${C.muted}`), "0 40px 24px"),
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
  lifetimeSeconds: number;
  issuedAt: Date;
}): { text: string; html: string } {
  const expires = new Date(input.issuedAt.getTime() + input.lifetimeSeconds * 1000);
  const life = minutesWords(input.lifetimeSeconds);
  const grouped = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;
  const heading = `Your verification code for ${input.what}`;
  const lead = `Someone at an organisation on IsItLegit is proving it controls ${input.what}. Once it is connected, mail forwarded from ${input.kind === "domain" ? "this domain" : "this address"} is checked.`;
  const how = "Type it on the Domains page at app.isitlegit.co.za. There is nothing to click in this email.";
  const until = `Expires in ${life}, at ${sastClock(expires)}. Three wrong tries lock verification for an hour.`;
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
        `<p style="margin: 0; ${MONO}; font-size: 36px; line-height: 1.2; font-weight: 700; letter-spacing: 0.14em; color: ${C.ink}">${escapeHtml(grouped)}</p>`,
      ),
      row(para(escapeHtml(how))),
      row(para(escapeHtml(until), "font-weight: 700")),
      row(para(escapeHtml(ignore), `color: ${C.muted}`), "0 40px 24px"),
    ],
  });
  return { text, html };
}
