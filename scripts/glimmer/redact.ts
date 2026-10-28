// Redaction of sample mail before anything is rendered or stored (D03 T04 §7): the pilot client's people and numbers
// are replaced with fixed placeholders in the HTML itself, so the screenshot shows the placeholders too. Brand names
// and link host names stay, because they are what Loupe learns from.
//
// Names come from the recipient headers (To, Cc, Delivered-To: the client's people) and `samples/client-names.txt`,
// never from the sender: a phishing sender's display name is the brand it fakes.

export const PLACEHOLDER = {
  email: "[email]",
  name: "[name]",
  phone: "[phone]",
  number: "[number]",
} as const;

// A recipient's name pieces: the display name's words and the address's local part split at dots, dashes and
// underscores, three letters or more, so initials and short words are not taken for names.
export function namePieces(display: string | undefined, address: string | undefined): string[] {
  const local = (address ?? "").split("@")[0] ?? "";
  return [...(display ?? "").split(/[\s,."'()]+/), ...local.split(/[._\-+0-9]+/)]
    .map((piece) => piece.trim())
    .filter((piece) => /^\p{L}{3,}$/u.test(piece));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// South African numbers (+27 or 0, then nine digits in any grouping) and other international numbers.
const PHONE = /(?:\+27|\b0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}\b/g;
// Nine or more digits in a run (single spaces or dashes allowed between): South African account numbers (9 to 11
// digits), ID numbers (13) and card numbers (13 to 19). Eight stops short, so a date like 2026-10-31 stays.
const LONG_NUMBER = /\b\d(?:[ -]?\d){8,}\b/g;
const DATA_URI = /data:[^"')\s>]+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `text` with every address, name, phone and long number replaced. Embedded `data:` URIs (inline images) are left
// as they are, since a digit run inside base64 is not a number.
export function redact(text: string, names: Iterable<string>): string {
  const unique = [...new Set([...names].map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  const nameRule = unique.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${unique.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;
  const pieces: string[] = [];
  let last = 0;
  for (const match of text.matchAll(DATA_URI)) {
    pieces.push(clean(text.slice(last, match.index)), match[0]);
    last = (match.index ?? 0) + match[0].length;
  }
  pieces.push(clean(text.slice(last)));
  return pieces.join("");

  function clean(part: string): string {
    let out = part.replace(EMAIL, PLACEHOLDER.email);
    if (nameRule) out = out.replace(nameRule, PLACEHOLDER.name);
    return out.replace(PHONE, PLACEHOLDER.phone).replace(LONG_NUMBER, PLACEHOLDER.number);
  }
}
