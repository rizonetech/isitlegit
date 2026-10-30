// The checked original's subject and sender as the report header shows them (D01 T01 §16): from the original's own
// headers, or a .msg's properties when it carries no transport headers. Each is decoded (RFC 2047), made one line
// (control and bidirectional formatting characters removed, whitespace collapsed) and cut at HEADER_TEXT_LIMIT code
// points. The address is the canonical mailbox the checks compare (`mailbox`: A-label domain, case-folded), so a
// lookalike domain shows in the form that gives it away; null unless the From names exactly one valid mailbox.
import { addressParser, decodeWords } from "postal-mime";
import { mailbox } from "../checks/sender";
import type { ParsedMessage } from "./parse";

export const HEADER_TEXT_LIMIT = 300;

export type OriginalHeader = { subject: string | null; fromName: string | null; fromAddress: string | null };
// A .msg's own subject and sender (PidTagSubject, the sender's name and SMTP address), already decoded.
export type MsgSender = { subject: string | null; name: string | null; address: string | null };

export const NO_HEADER: OriginalHeader = { subject: null, fromName: null, fromAddress: null };

// C0 and C1 controls, and the bidirectional formatting characters that could reorder what the report shows.
const HIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;
export function oneLine(text: string | null | undefined): string | null {
  if (text == null) return null;
  const line = text.replace(HIDDEN, " ").replace(/\s+/gu, " ").trim();
  if (!line) return null;
  const points = [...line];
  return points.length <= HEADER_TEXT_LIMIT
    ? line
    : `${points
        .slice(0, HEADER_TEXT_LIMIT - 1)
        .join("")
        .trimEnd()}…`;
}

// An address shown as it is or not at all: at most 254 characters (RFC 5321's path limit) and with nothing hidden in it
// (a quoted local part may carry controls or bidirectional overrides), else null, never cut or rewritten.
export const ADDRESS_LIMIT = 254;
const safeMailbox = (address: string | null | undefined) => {
  const canonical = address ? mailbox(address.trim()) : null;
  if (!canonical || canonical.length > ADDRESS_LIMIT) return null;
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(canonical) ? null : canonical;
};

const fieldOf = (headers: ParsedMessage["headers"], name: string) => {
  const found = headers.filter((h) => h.name.trim().toLowerCase() === name);
  return found.length === 1 ? (found[0]?.value ?? null) : found.length ? undefined : null;
};

export function originalHeaderOf(headers: ParsedMessage["headers"], msg?: MsgSender): OriginalHeader {
  // A repeated Subject or From is not one value to show: nothing, rather than a guess.
  const subject = fieldOf(headers, "subject");
  const from = fieldOf(headers, "from");
  let fromName: string | null = null;
  let fromAddress: string | null = null;
  if (typeof from === "string") {
    const unfolded = from.replace(/\r?\n[ \t]*/g, " ");
    const parsed = addressParser(unfolded, { flatten: true });
    if (parsed.length === 1 && parsed[0]) {
      fromName = oneLine(decodeWords(parsed[0].name ?? ""));
      // The parser drops a control character silently ("a\u0007b" reads "ab"), which would show an address the message
      // never had: a field with anything hidden in it gives none.
      HIDDEN.lastIndex = 0;
      fromAddress = HIDDEN.test(unfolded.replace(/\t/g, " ")) ? null : safeMailbox(parsed[0].address);
    }
  } else if (from === null && msg) {
    fromName = oneLine(msg.name);
    fromAddress = safeMailbox(msg.address);
  }
  return {
    subject:
      typeof subject === "string"
        ? oneLine(decodeWords(subject.replace(/\r?\n[ \t]*/g, " ")))
        : subject === null
          ? oneLine(msg?.subject)
          : null,
    fromName,
    fromAddress,
  };
}
