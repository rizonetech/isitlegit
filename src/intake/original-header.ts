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

// Whether a From field is, in shape, one mailbox (RFC 5322 3.4): a bare addr-spec, or a display name and one angle
// address with nothing after it. The parser recovers from anything else ("Accounts <a@b> <x@y>", "Accounts a@b x@y"),
// so its one result is not proof (completion review, round 1). Quoted strings (with their quoted pairs) and comments
// are set aside first; the address itself is validated by `mailbox`.
function oneMailboxField(field: string): boolean {
  let bare = "";
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    if (c === "\\" && (quoted || depth > 0)) i++;
    else if (quoted) {
      if (c === '"') quoted = false;
      // A quoted string is one word whatever it holds: an "@" in it is no mailbox syntax (round 2).
      else bare += "q";
    } else if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (depth > 0) continue;
    else if (c === '"') quoted = true;
    else bare += c;
  }
  if (quoted || depth > 0) return false;
  const open = bare.indexOf("<");
  if (open < 0) return /^\s*[^\s<>@]+@[^\s<>@]+\s*$/.test(bare);
  const close = bare.indexOf(">", open);
  return (
    close > open &&
    bare.indexOf("<", open + 1) < 0 &&
    !bare.slice(0, open).includes("@") &&
    !bare.slice(0, open).includes(">") &&
    /^[^\s<>@]+@[^\s<>@]+$/.test(bare.slice(open + 1, close).trim()) &&
    !bare.slice(close + 1).trim()
  );
}

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
    // Only a field shaped as one mailbox, whatever the parser recovered from it.
    if (parsed.length === 1 && parsed[0] && oneMailboxField(unfolded)) {
      // The parser has decoded the name's encoded words already; decoding again would turn a literal "=?...?=" into
      // another name (completion review).
      fromName = oneLine(parsed[0].name);
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
