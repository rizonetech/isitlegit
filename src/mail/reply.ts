// The member's answer, as a reply in the forward's own thread (D01 T02 §3; design spec 4.1): the verdict, its headline,
// up to three reasons, what to do now and the signed report link, or for a case that could not finish, a plain notice
// of that and what to try. Subject, recipient and wording come from code; the verdict's fields are stored text, put in
// the HTML only escaped (design spec 4.6a). The final visual design is D07 T03 §7; this is the plain version.
import PostalMime from "postal-mime";
import { ConfigError } from "../config";
import type { VerdictView } from "../db/verdicts";
import { messageIds } from "./rfc5322";

export const REPLY_FROM = "IsItLegit <check@isitlegit.co.za>";
export const FALLBACK_SUBJECT = "Re: your IsItLegit check";
const SUBJECT_LIMIT = 120;
// The header block is read only this far into the stored forward: its headers, never its body.
const HEADER_BYTES = 64 * 1024;

export type ParentHeaders = {
  subject: string | null;
  messageId: string | null;
  references: string | null;
  inReplyTo: string | null;
};

// The report link's origin from PUBLIC_ORIGIN: https, and nothing but the origin, never a request's Host.
export function reportOrigin(configured: string | undefined): string {
  let url: URL;
  try {
    url = new URL(configured ?? "");
  } catch {
    throw new ConfigError("PUBLIC_ORIGIN is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new ConfigError("PUBLIC_ORIGIN must be an https origin with no path, query or credentials");
  return url.origin;
}

const ids = (value: string | null) => (value ? messageIds(value) : []);

// RFC 5322 section 3.6.4: In-Reply-To is the parent's Message-ID; References is the parent's References (or, without
// them, its In-Reply-To when that holds one id) followed by its Message-ID. A parent with none gives neither.
export function threading(
  parent: Pick<ParentHeaders, "messageId" | "references" | "inReplyTo">,
): Record<string, string> {
  const messageId = ids(parent.messageId)[0] ?? null;
  const replied = ids(parent.inReplyTo);
  const before = ids(parent.references).length ? ids(parent.references) : replied.length === 1 ? replied : [];
  const references = [...before, ...(messageId ? [messageId] : [])];
  return {
    ...(messageId ? { "In-Reply-To": messageId } : {}),
    ...(references.length ? { References: references.join(" ") } : {}),
  };
}

// The forward's own headers from the start of its stored bytes, or null when they cannot be read. The header block goes
// to postal-mime as bytes, so a UTF-8 subject (RFC 6532) is read as written, not as Latin-1.
export async function parentHeaders(head: Uint8Array | null): Promise<ParentHeaders | null> {
  if (!head) return null;
  const bytes = head.subarray(0, HEADER_BYTES);
  let end = -1;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && (bytes[i + 1] === 0x0a || (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a))) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const block = new Uint8Array(end + 5);
  block.set(bytes.subarray(0, end + 1));
  block.set([0x0d, 0x0a, 0x0d, 0x0a], end + 1);
  try {
    const email = await PostalMime.parse(block);
    const header = (name: string) => email.headers.find((h) => h.key === name)?.value ?? null;
    return {
      subject: email.subject ?? null,
      messageId: header("message-id"),
      references: header("references"),
      inReplyTo: header("in-reply-to"),
    };
  } catch {
    return null;
  }
}
export const HEADER_RANGE = HEADER_BYTES;

export function replySubject(parentSubject: string | null): string {
  const subject = parentSubject?.replace(/[\r\n]+/g, " ").trim();
  if (!subject) return FALLBACK_SUBJECT;
  const full = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  // Cut by code point, so a character outside the BMP (an emoji) is never split into half a surrogate pair.
  const points = Array.from(full);
  return points.length > SUBJECT_LIMIT ? `${points.slice(0, SUBJECT_LIMIT - 1).join("")}…` : full;
}

// What to do, by verdict, when the verdict names no actions of its own.
const DEFAULT_ACTIONS: Record<VerdictView["verdict"], string> = {
  safe: "Nothing points to fraud, but if it asks for money or details you did not expect, check with the sender first.",
  suspicious:
    "Do not pay, click or reply until you have checked with the sender on a phone number you already have, not one in the message.",
  malicious: "Do not pay, click or reply. Delete it, and warn whoever else may have received it.",
};
const VERDICT_WORDS: Record<VerdictView["verdict"], string> = {
  safe: "Looks legitimate",
  suspicious: "Suspicious",
  malicious: "Fraud",
};

export type ReplyReport =
  | { status: "ready"; view: VerdictView }
  | { status: "partial"; failedStep: string; errorClass: string };
export type ReplyInput = {
  parentSubject: string | null;
  headersAvailable: boolean;
  otherOriginals: number;
  report: ReplyReport;
  reportUrl: string;
};

// A stored field on one line in the text body, so it cannot start a line of its own (a second "The full report:").
const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").trim();

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function buildReply(input: ReplyInput): { subject: string; text: string; html: string } {
  const notes: string[] = [];
  if (!input.headersAvailable)
    notes.push(
      "We could not see the original message's headers, so the sender checks could not run. Next time, forward it as an attachment. In Outlook, select the message, then choose Forward as attachment (in the Forward menu, or under More actions). In Gmail on a computer, tick the message in your inbox list, then choose More (the three dots) and Forward as attachment; the Gmail phone app cannot do this.",
    );
  if (input.otherOriginals > 0)
    notes.push(
      "Your forward held more than one message and we checked only the first. Forward each of the others on its own to have it checked.",
    );

  let lines: string[];
  let blocks: string[];
  if (input.report.status === "ready") {
    const { view } = input.report;
    const reasons = view.reasons.slice(0, 3);
    const actions = view.actions.length ? view.actions : [DEFAULT_ACTIONS[view.verdict]];
    lines = [
      `${VERDICT_WORDS[view.verdict]}: ${oneLine(view.headline)}`,
      ...(reasons.length ? ["", "Why:", ...reasons.map((r) => `- ${oneLine(r)}`)] : []),
      "",
      "What to do now:",
      ...actions.map((a) => `- ${oneLine(a)}`),
    ];
    blocks = [
      `<p><strong>${escapeHtml(VERDICT_WORDS[view.verdict])}</strong>: ${escapeHtml(view.headline)}</p>`,
      ...(reasons.length ? [`<p>Why:</p><ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`] : []),
      `<p>What to do now:</p><ul>${actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`,
    ];
  } else {
    // The message itself could not be read (the parsers refused it) only on a ParseError; any other failure, the
    // stored message gone or a service fault included, is ours, and forwarding it again is the advice.
    const unreadable = input.report.failedStep === "parse" && input.report.errorClass === "ParseError";
    // The model budget refused the check (D03 T01 §2, `budget:<cap>:<model>`): forwarding again in a few minutes would
    // be refused too, so the advice names when checks resume.
    const budget = /^budget:(day|total|reserve):/.exec(input.report.errorClass)?.[1];
    const advice = unreadable
      ? "We could not read the message you forwarded. Forward it again as an attachment; if it was an Outlook .msg file, save it as .eml first."
      : budget === "day"
        ? "Today's checking capacity is used up. Forward the message again tomorrow. Until it is checked, do not pay, click or reply."
        : budget
          ? "Checking is paused while we top up our capacity. Forward the message again later; until it is checked, do not pay, click or reply."
          : "Please forward the message again in a few minutes. Until it is checked, do not pay, click or reply.";
    lines = ["We could not finish checking this message, so we have no verdict on it yet.", "", advice];
    blocks = [
      "<p>We could not finish checking this message, so we have no verdict on it yet.</p>",
      `<p>${escapeHtml(advice)}</p>`,
    ];
  }

  const text = [...lines, ...notes.flatMap((n) => ["", n]), "", `The full report: ${input.reportUrl}`, ""].join("\n");
  const html = [
    ...blocks,
    ...notes.map((n) => `<p>${escapeHtml(n)}</p>`),
    `<p><a href="${escapeHtml(input.reportUrl)}">Open the full report</a></p>`,
  ].join("\n");
  return { subject: replySubject(input.parentSubject), text, html };
}
