// Lookalike primitives (D02 T03 §1; spec 4.3 Domains, 4.11 the monitor reuses them): a label's UTS #39 skeleton, which
// two labels share when they look alike; the optimal string alignment distance between two labels; and the added-word
// pattern (`fynbosfreight-payments`). Each takes one Unicode label, lowercased: `unicodeLabel` makes one from what a
// header or a link gives (an A-label such as `xn--pypal-4ve`, or Unicode), and §2 passes every candidate and target
// through it. The Unicode data is generated from the vendored tables by scripts/build-confusables.ts.
import MAP from "./confusables-map.json";

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

// One label, lowercased and in Unicode: an A-label decoded (and refused when invalid, or when it decodes to plain ASCII,
// which IDNA forbids), anything else as given. Null for an empty label, one holding a dot, or one longer than DNS allows.
export function unicodeLabel(label: string): string | null {
  const lower = label.toLowerCase();
  if (lower.length === 0 || lower.includes(".")) return null;
  if (!lower.startsWith("xn--")) return lower;
  if (lower.length > 63 || !/^[a-z0-9-]+$/.test(lower)) return null;
  const decoded = punycodeDecode(lower.slice(4));
  if (decoded === null || Array.from(decoded).every((c) => (c.codePointAt(0) as number) < 0x80)) return null;
  return decoded.normalize("NFC").toLowerCase();
}

// The optimal string alignment distance (Damerau-Levenshtein restricted to adjacent transpositions), in code points.
export function distance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
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

// The added word when the candidate is exactly the base with one word before or after it, joined by `-` or nothing.
export function addedWords(candidate: string, base: string): AddedWord | null {
  if (base.length === 0 || candidate === base) return null;
  for (const word of ADDED_WORDS)
    for (const join of ["-", ""]) {
      if (candidate === `${base}${join}${word}`) return { word, side: "after" };
      if (candidate === `${word}${join}${base}`) return { word, side: "before" };
    }
  return null;
}
