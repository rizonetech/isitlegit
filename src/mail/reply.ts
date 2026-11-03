// The member's answer, as a reply in the forward's own thread (D01 T02 §3; design spec 4.1): the verdict, its headline,
// up to three reasons, what to do now and the signed report link, or for a case that could not finish, a plain notice
// of that and what to try. Subject, recipient and wording come from code; the verdict's fields are stored text, put in
// the HTML only escaped (design spec 4.6a). The final visual design is D07 T03 §7; this is the plain version.
import PostalMime from "postal-mime";
import { asciiDomain } from "../checks/auth";
import type { Evidence } from "../checks/evidence";
import { ConfigError } from "../config";
import type { VerdictView } from "../db/verdicts";
import { orderedActions } from "../web/pages/report-verdict";
import { messageIds } from "./rfc5322";
import {
  type AuthState,
  coverageWords,
  footerWords,
  headersWords,
  meaningWords,
  moreFindingsWords,
  type ReplyDesign,
  replyDesign,
} from "./templates/reply";

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
  // N1's design (D07 T03 §7): the app's origin for the email's images, the organisation, the case's evidence (the
  // reasons' pills and the further findings), its stored check outcomes, whether it is a voice note (whose call-back
  // leads), and the authentication results (D01 T02 §11). Each but the origin is optional: without them it draws less.
  design: {
    appUrl: string;
    organisation?: string | null;
    evidence?: ReplyDesign["evidence"];
    coverage?: ReplyDesign["coverage"];
    voice?: boolean;
    headers?: ReplyDesign["headers"];
  };
};

// The authentication results for the reply's Headers checked panel (D01 T02 §11, §16), read from the run's stored
// `auth.spf`, `auth.dkim` and `auth.dmarc` evidence (src/checks/auth.ts): each method's overall state, told apart by
// the raw RFC 8601 values its results carry. Only the methods the receiver reported are returned (D07 T03 §34 draws
// the rest as not reported); `{}` when none was, so no panel. A reported DKIM `none` is passed as `none` again: the
// template words it "found no signature" (D07 T03 §35), apart from a DKIM the receiver did not report.
const AUTH_STATES: readonly AuthState[] = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"];
export function replyHeaders(evidence: readonly Pick<Evidence, "check" | "detail">[]): {
  spf?: AuthState;
  dkim?: AuthState;
  dmarc?: AuthState;
  domains?: { from?: string; spf?: string; dkim?: string };
} {
  const one = (method: "spf" | "dkim" | "dmarc"): AuthState | null => {
    const item = evidence.find((e) => e.check === `auth.${method}`);
    if (!item) return null;
    const detail = item.detail as { state?: unknown; results?: unknown };
    const raw = (Array.isArray(detail.results) ? detail.results : [])
      .map((r) => (r && typeof r === "object" ? (r as { result?: unknown }).result : null))
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.toLowerCase());
    switch (detail.state) {
      case "passed":
        return "pass";
      case "failed":
        return raw.includes("softfail") && !raw.includes("fail") ? "softfail" : "fail";
      case "inconclusive":
        return (raw.find((r) => r === "temperror" || r === "permerror" || r === "neutral") as AuthState) ?? "temperror";
      case "unavailable":
        // A reported `none` (or Microsoft's DMARC `bestguesspass`) is a result: SPF found no record to check,
        // DKIM found no signature on this message, DMARC found no policy to apply (D07 T03 §35). No result at
        // all is the receiver not reporting the method, so it is left out for the template's not-reported words.
        return raw.some((r) => r === "none" || r === "bestguesspass") ? "none" : null;
      default:
        return null;
    }
  };
  const headers: {
    spf?: AuthState;
    dkim?: AuthState;
    dmarc?: AuthState;
    domains?: { from?: string; spf?: string; dkim?: string };
  } = {};
  for (const method of ["spf", "dkim", "dmarc"] as const) {
    const state = one(method);
    if (state && AUTH_STATES.includes(state)) headers[method] = state;
  }
  // The domains for the panel (D01 T02 §17, D07 T03 §36): the From domain DMARC was evaluated for, and the domain
  // each SPF and DKIM pass was for. A domain is message data, so it is kept only as a whole valid domain name
  // (`asciiDomain`, lower-cased in A-label form, at most the DNS name limit of 253 characters, RFC 1035 section
  // 2.3.4); anything else is left out, never cleaned into a domain it is not.
  const domain = (value: unknown): string | null => {
    if (typeof value !== "string" || value.length === 0 || value.length > 253) return null;
    // Nothing but domain characters in the value as stored: a control, space, bidi mark or separator is a
    // malformed identifier, omitted as it stands, never trimmed or cleaned into a domain it is not.
    if (/[^\p{L}\p{N}\p{M}.-]/u.test(value)) return null;
    const ascii = asciiDomain(value);
    // The limits hold on the converted name, not the input: IDNA can lengthen it past both (RFC 1035 section 2.3.4).
    if (!ascii || ascii.length > 253 || ascii.split(".").some((label) => label.length === 0 || label.length > 63))
      return null;
    return ascii;
  };
  const passing = (method: "spf" | "dkim"): string | null => {
    const item = evidence.find((e) => e.check === `auth.${method}`);
    const detail = item?.detail as { results?: unknown } | undefined;
    for (const r of Array.isArray(detail?.results) ? detail.results : []) {
      if (!r || typeof r !== "object") continue;
      const { result, identifier } = r as { result?: unknown; identifier?: unknown };
      if (typeof result !== "string" || result.toLowerCase() !== "pass") continue;
      // The first passing result that names a valid domain; a passing result naming none never borrows another's.
      const named = domain(identifier);
      if (named) return named;
    }
    return null;
  };
  const dmarcDetail = evidence.find((e) => e.check === "auth.dmarc")?.detail as { from?: unknown } | undefined;
  const domains: { from?: string; spf?: string; dkim?: string } = {};
  const from = domain(dmarcDetail?.from);
  if (from) domains.from = from;
  const spfDomain = passing("spf");
  if (spfDomain) domains.spf = spfDomain;
  const dkimDomain = passing("dkim");
  if (dkimDomain) domains.dkim = dkimDomain;
  if (Object.keys(domains).length) headers.domains = domains;
  return headers;
}

// A stored field on one line in the text body, so it cannot start a line of its own (a second "The full report:").
const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").trim();

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
  if (input.report.status === "ready") {
    const { view } = input.report;
    const reasons = view.reasons.slice(0, 3);
    // The report's order (D07 T03 §2): a fixed action anywhere among the stored ones first, then at most three.
    const actions = view.actions.length
      ? orderedActions(view.actions, input.design.voice ?? false).actions
      : [DEFAULT_ACTIONS[view.verdict]];
    const coverage = coverageWords(input.design.coverage ?? null);
    const more = moreFindingsWords(view, input.design.evidence ?? []);
    // The band's confidence and meaning (N1, D07 T03 §7) follow the verdict line, and the further findings the reasons.
    lines = [
      `${VERDICT_WORDS[view.verdict]}: ${oneLine(view.headline)}`,
      oneLine(meaningWords(view)),
      ...(reasons.length
        ? ["", "Why:", ...reasons.map((r) => `- ${oneLine(typeof r === "string" ? r : r.text)}`)]
        : []),
      ...(more ? ["", more] : []),
      "",
      "What to do now:",
      ...actions.map((a) => `- ${oneLine(a)}`),
      ...(coverage ? ["", coverage] : []),
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
  }

  const headers = input.design.headers ? headersWords(input.design.headers) : "";
  const text = [
    ...lines,
    ...(headers ? ["", `Headers checked. ${headers}`] : []),
    ...notes.flatMap((n) => ["", n]),
    "",
    `The full report: ${input.reportUrl}`,
    "",
    ...footerWords(input.design.organisation ?? null, input.reportUrl),
    "",
  ].join("\n");
  const subject = replySubject(input.parentSubject);
  // The designed HTML (N1, src/mail/templates/reply.ts), with this reply's own words passed in.
  const html = replyDesign({
    appUrl: input.design.appUrl,
    reportUrl: input.reportUrl,
    organisation: input.design.organisation ?? null,
    verdict: input.report.status === "ready" ? input.report.view : null,
    evidence: input.design.evidence ?? [],
    voice: input.design.voice ?? false,
    coverage: input.design.coverage ?? null,
    ...(input.design.headers ? { headers: input.design.headers } : {}),
    notes,
    ...(input.report.status === "ready" ? {} : { failure: { lead: lines[0] ?? "", advice: lines[2] ?? "" } }),
    title: subject,
    ...(input.report.status === "ready" ? { fallbackActions: [DEFAULT_ACTIONS[input.report.view.verdict]] } : {}),
  }).html;
  return { subject, text, html };
}
