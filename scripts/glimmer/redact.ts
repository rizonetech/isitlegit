// Redaction of sample mail before anything is rendered or stored (D03 T04 §7): the pilot client's people and numbers
// are replaced with fixed placeholders in the HTML itself, so the screenshot shows the placeholders too. Brand names
// and link host names stay, because they are what Loupe learns from.
//
// Names come from the recipient headers (To, Cc, Delivered-To: the client's people) and `samples/client-names.txt`,
// never from the sender: a phishing sender's display name is the brand it fakes. Every image is replaced by a blank
// box before the render (`stripImages`): a signature image or a personalised attachment can carry what no text rule
// sees, so no picture from a sample reaches a screenshot.

export const PLACEHOLDER = {
  email: "[email]",
  name: "[name]",
  domain: "[domain]",
  phone: "[phone]",
  number: "[number]",
} as const;

// Mailbox roles, not people: `accounts@`, `Accounts Payable`. Taking them for names would redact `accounts.google.com`
// and `Google Accounts` out of the very lures Loupe learns from.
const ROLE_WORDS = new Set(
  "accounts account payable receivable info admin administrator support sales billing noreply reply office reception finance hr enquiries enquiry contact hello team mail email service services help orders order invoices invoice accounting marketing helpdesk security notifications notification alerts news newsletter postmaster webmaster mailer daemon bookings booking careers jobs legal compliance procurement purchasing payroll credit debtors creditors operations dispatch logistics user users staff general".split(
    " ",
  ),
);

// A recipient's name pieces: the display name's words (a capitalised two-letter name such as `Jo` included) and the
// address's local part split at dots, dashes and underscores (three letters or more), mailbox roles left out.
export function namePieces(display: string | undefined, address: string | undefined): string[] {
  const local = (address ?? "").split("@")[0] ?? "";
  const shown = (display ?? "").split(/[\s,."'()]+/).filter((piece) => /^(\p{L}{3,}|\p{Lu}\p{Ll})$/u.test(piece));
  const parts = local.split(/[._\-+0-9]+/).filter((piece) => /^\p{L}{3,}$/u.test(piece));
  return [...shown, ...parts].filter((piece) => !ROLE_WORDS.has(piece.toLowerCase()));
}

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// South African numbers (+27 or 0, then nine digits in any grouping, the area code in brackets too) and other
// international numbers.
export const PHONE =
  /\(0\d{2}\)[\s-]?\d{3}[\s-]?\d{4}\b|(?:\+27|\b0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}\b/g;
// Nine or more digits in a run (single spaces or dashes allowed between): South African account numbers (9 to 11
// digits), ID numbers (13) and card numbers (13 to 19). Eight stops short, so a date like 2026-10-31 stays.
export const LONG_NUMBER = /\b\d(?:[ -]?\d){8,}\b/g;
const DATA_URI = /data:[^"')\s>]+/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s"'<>()]+/gi;
// Characters that hide inside a word without showing: a soft hyphen or a zero-width space splits `Tha­ndi` for a
// text rule while the render shows `Thandi`.
const INVISIBLE = /[­​-‍⁠﻿]/g;
const LETTER_ENTITIES: Record<string, string> = {
  aacute: "á",
  agrave: "à",
  acirc: "â",
  auml: "ä",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  iuml: "ï",
  oacute: "ó",
  ocirc: "ô",
  ouml: "ö",
  uacute: "ú",
  uuml: "ü",
  ccedil: "ç",
  ntilde: "ñ",
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Character references written for what is plain text (`Th&#97;ndi`, `&eacute;`) read as the characters they render
// as, so a rule sees what the viewer sees. The markup's own (`&lt;`, `&amp;`, quotes) are kept.
export function decodeTextEntities(html: string): string {
  return html
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (whole, code: string) => {
      const point = code[0] === "x" || code[0] === "X" ? Number.parseInt(code.slice(1), 16) : Number(code);
      if (!Number.isFinite(point) || point < 0x20 || point > 0x10ffff) return whole;
      const char = String.fromCodePoint(point);
      return /[<>&"']/.test(char) ? whole : char;
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      const lower = LETTER_ENTITIES[name.toLowerCase()];
      if (!lower) return whole;
      return name[0] === name[0]?.toUpperCase() ? lower.toUpperCase() : lower;
    })
    .replace(INVISIBLE, "");
}

const IMAGE_TAG = /<(?:img|image|object|embed|picture|source|video|audio|input\s[^>]*type\s*=\s*["']?image)\b[^>]*>/gi;

// Every picture out of the HTML before it is rendered: an `<img>` becomes a grey box of its size (so the layout a lure
// draws stays), other embedded media go, and CSS images and `background` attributes are dropped.
export function stripImages(html: string): string {
  return html
    .replace(IMAGE_TAG, (tag) => {
      if (!/^<img\b/i.test(tag)) return "";
      const size = (name: string, fallback: number, most: number) => {
        const value = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(tag)?.[1];
        return Math.min(most, Math.max(1, value ? Number(value) : fallback));
      };
      return `<span style="display:inline-block;width:${size("width", 120, 1280)}px;height:${size("height", 40, 600)}px;background:#d0d0d0;vertical-align:middle"></span>`;
    })
    .replace(/url\(\s*(["']?)[^)]*\1\s*\)/gi, "none")
    .replace(/\s(?:background|poster|srcset)\s*=\s*(["'])[^"']*\1/gi, "");
}

// Whether any picture is left for a render to draw: checked before every render, so a rule `stripImages` missed is a
// refusal, never a stored screenshot.
export function hasImages(html: string): boolean {
  return /<(?:img|image|object|embed|picture|source|video|audio)\b|url\(\s*["']?\s*(?:data:|cid:|https?:)/i.test(html);
}

// `text` with every address, client domain, name, phone and long number replaced. Names are left alone inside a URL
// (a lure's link host is what Loupe learns from); addresses and the client's domains are replaced everywhere.
// Embedded `data:` URIs are left as they are, since a digit run inside base64 is not a number.
export function redact(text: string, names: Iterable<string>, domains: Iterable<string> = []): string {
  const unique = [...new Set([...names].map((n) => n.trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  const nameRule = unique.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${unique.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;
  const owned = [...new Set([...domains].map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const domainRule = owned.length
    ? new RegExp(`(?<![\\p{L}\\p{N}.-])(?:${owned.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}-])`, "giu")
    : null;
  const source = decodeTextEntities(text);
  const pieces: string[] = [];
  let last = 0;
  for (const match of source.matchAll(DATA_URI)) {
    pieces.push(clean(source.slice(last, match.index)), match[0]);
    last = (match.index ?? 0) + match[0].length;
  }
  pieces.push(clean(source.slice(last)));
  return pieces.join("");

  function clean(part: string): string {
    let out = part.replace(EMAIL, PLACEHOLDER.email);
    if (domainRule) out = out.replace(domainRule, PLACEHOLDER.domain);
    if (nameRule) {
      const rule = nameRule;
      let named = "";
      let from = 0;
      for (const url of out.matchAll(URL)) {
        named += out.slice(from, url.index).replace(rule, PLACEHOLDER.name) + url[0];
        from = (url.index ?? 0) + url[0].length;
      }
      out = named + out.slice(from).replace(rule, PLACEHOLDER.name);
    }
    return out.replace(PHONE, PLACEHOLDER.phone).replace(LONG_NUMBER, PLACEHOLDER.number);
  }
}
