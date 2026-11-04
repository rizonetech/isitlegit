// Lookalike primitives (D02 T03 §1; spec 4.3 Domains, 4.11 the monitor reuses them): a label's UTS #39 skeleton, which
// two labels share when they look alike; the optimal string alignment distance between two labels; and the added-word
// pattern (`fynbosfreight-payments`). A label is compared in its one normal form, `unicodeLabel`'s, whichever form it
// arrives in (an A-label such as `xn--pypal-4ve`, Unicode, capitals): `labelSkeleton` and `addedWords` normalise what
// they are given, `distance` is bounded to a label's length, and `skeleton` is UTS #39's own function on any text. The
// Unicode data is generated from the vendored tables by scripts/build-confusables.ts; NFD and Default_Ignorable_Code_Point
// are the runtime's own (the plan's correction 6).
import MAP from "./confusables-map.json" with { type: "json" };

const PROTOTYPES: Record<string, string> = MAP.prototypes;
const RTL = MAP.rtl as [number, number][];
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// Whether a code point has Bidi_Class R or AL (the vendored DerivedBidiClass.txt), by binary search.
function rightToLeft(codePoint: number): boolean {
  let low = 0;
  let high = RTL.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last] = RTL[middle] as [number, number];
    if (codePoint < first) high = middle - 1;
    else if (codePoint > last) low = middle + 1;
    else return true;
  }
  return false;
}

// UTS #39 section 4 (revision 34): skeleton(X) is bidiSkeleton(LTR, X), whose reordering changes nothing for a label with
// no right-to-left character, leaving internalSkeleton: NFD, Default_Ignorable_Code_Point removed, each character's
// prototype, NFD again. A label holding an R or AL character is not compared (null), rather than compared wrongly.
export function skeleton(label: string): string | null {
  for (const character of label) if (rightToLeft(character.codePointAt(0) as number)) return null;
  let mapped = "";
  for (const character of label.normalize("NFD").replace(IGNORABLE, "")) mapped += PROTOTYPES[character] ?? character;
  return mapped.normalize("NFD");
}

// D02 T03 §5: a separate comparison form, never a change to the UTS #39 skeleton.
export function foldAccents(label: string): string {
  return label.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

// RFC 3492's decoder, for an A-label's part after `xn--`; null when the input is not valid Punycode.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / 700) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + 38));
}
function digit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return BASE;
}
function punycodeDecode(input: string): string | null {
  const split = input.lastIndexOf("-");
  const output = split > 0 ? Array.from(input.slice(0, split), (c) => c.codePointAt(0) as number) : [];
  if (output.some((c) => c >= 0x80)) return null;
  let n = 0x80;
  let i = 0;
  let bias = 72;
  for (let at = split > 0 ? split + 1 : 0; at < input.length; ) {
    const old = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (at >= input.length) return null;
      const d = digit(input.charCodeAt(at++));
      if (d >= BASE || d > Math.floor((0x7fffffff - i) / w)) return null;
      i += d * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      if (w > Math.floor(0x7fffffff / (BASE - t))) return null;
      w *= BASE - t;
    }
    bias = adapt(i - old, output.length + 1, old === 0);
    if (Math.floor(i / (output.length + 1)) > 0x10ffff - n) return null;
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

// One label in its one Unicode form, whichever form it arrives in. The runtime's WHATWG URL host parser does what IDNA
// asks of a label (UTS #46 mapping: case folding, width and compatibility forms, NFC; and validity: a bad A-label, a
// forbidden or control character, an empty label are refused), giving its A-label; that is then decoded, so a Unicode
// label and its A-label give the same text (D02 T03 §1 completion review). Null when the label is refused, holds or maps
// to a dot, or is longer than DNS allows (63 octets as an A-label), or when an A-label decodes to plain ASCII, to text
// that is not NFC, or to a label whose own encoding differs (RFC 5891 5.4, 5.5).
export function unicodeLabel(label: string): string | null {
  if (label.length === 0 || label.length > 253 || /[./\\?#@:%\s]/.test(label)) return null;
  const normal = labelOf(label);
  // A registrable label (RFC 5891 4.2.3.1, 5.4): letters, marks, digits and hyphens, no hyphen first or last, and
  // `--` in the third and fourth places only for an A-label (final review: `-fynbosfreight` and `pay_pal` cannot be
  // registered, so they are not compared).
  if (normal === null || !/^[\p{L}\p{M}\p{N}-]+$/u.test(normal) || normal.startsWith("-") || normal.endsWith("-"))
    return null;
  return normal;
}

function labelOf(label: string): string | null {
  let host: string;
  try {
    host = new URL(`http://${label}.invalid`).hostname;
  } catch {
    return null;
  }
  const labels = host.split(".");
  const ace = labels[0] as string;
  if (labels.length !== 2 || labels[1] !== "invalid" || ace.length === 0 || ace.length > 63) return null;
  if (!ace.startsWith("xn--")) return ace.slice(2, 4) === "--" ? null : ace;
  const decoded = punycodeDecode(ace.slice(4));
  if (decoded === null || decoded.normalize("NFC") !== decoded) return null;
  if (Array.from(decoded).every((c) => (c.codePointAt(0) as number) < 0x80)) return null;
  // The A-label must be its U-label's own encoding (RFC 5891 5.4): decoded text that encodes back to another A-label,
  // or not at all, was never a valid one. The runtime's parser alone accepts some, such as `xn--a`.
  let again: string;
  try {
    again = new URL(`http://${decoded}.invalid`).hostname;
  } catch {
    return null;
  }
  return again === host ? decoded : null;
}

// The skeleton of a label in its normal form; null when the label is refused or right-to-left.
export function labelSkeleton(label: string): string | null {
  const normal = unicodeLabel(label);
  return normal === null ? null : skeleton(normal);
}

// The longest text `distance` compares: a DNS label is at most 63 octets, so 63 code points bound every label it is meant
// for, and the quadratic table it builds stays small (final review).
export const MAX_LABEL_CHARACTERS = 63;

// The optimal string alignment distance (Damerau-Levenshtein restricted to adjacent transpositions), in code points.
export function distance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length > MAX_LABEL_CHARACTERS || y.length > MAX_LABEL_CHARACTERS)
    throw new RangeError(`distance compares labels of at most ${MAX_LABEL_CHARACTERS} characters`);
  const rows = Array.from({ length: x.length + 1 }, (_, i) => {
    const row = new Array<number>(y.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= y.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= x.length; i++) {
    const row = rows[i] as number[];
    const above = rows[i - 1] as number[];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min((above[j] as number) + 1, (row[j - 1] as number) + 1, (above[j - 1] as number) + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1])
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      row[j] = best;
    }
  }
  return (rows[x.length] as number[])[y.length] as number;
}

// Words a lookalike adds to a real name (spec 4.3): matched whole, before or after the whole base.
export const ADDED_WORDS = [
  "pay",
  "payment",
  "payments",
  "invoice",
  "invoices",
  "billing",
  "account",
  "accounts",
  "secure",
  "security",
  "verify",
  "login",
  "online",
  "portal",
  "support",
  "za",
] as const;

export type AddedWord = { word: (typeof ADDED_WORDS)[number]; side: "before" | "after" };

// The added word when the candidate is exactly the base with one word before or after it, joined by `-` or nothing,
// both compared in their normal form (`FynbosFreight-Payments` is `fynbosfreight-payments`).
export function addedWords(given: string, givenBase: string): AddedWord | null {
  const candidate = unicodeLabel(given);
  const base = unicodeLabel(givenBase);
  if (candidate === null || base === null || candidate === base) return null;
  for (const word of ADDED_WORDS)
    for (const join of ["-", ""]) {
      if (candidate === `${base}${join}${word}`) return { word, side: "after" };
      if (candidate === `${word}${join}${base}`) return { word, side: "before" };
    }
  return null;
}
