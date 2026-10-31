// HTML character references, decoded for the hidden-text scanner and the AI-instruction phrases (D02 T05 §1, §2).
// Character references decoded (round 1): numeric ones, and the named ones mail text uses; an unknown name stays as is.
// Named references, case-sensitive as HTML defines them: every one the WHATWG table maps to an ASCII character (what the
// checks' signatures are made of: `https:`, `data:`, base64, instruction words; D02 T04 §2's round 4), and the common
// typographic ones. A name outside this set stays as written.
const ENTITIES: Record<string, string> = {
  // The invisible characters HTML names (WHATWG named character references), so a hidden run spelled by name is read
  // as the run it is (D02 T05 §3's round 1: `&ZeroWidthSpace;` three times split an instruction unseen).
  ZeroWidthSpace: "\u200b",
  NegativeVeryThinSpace: "\u200b",
  NegativeThinSpace: "\u200b",
  NegativeMediumSpace: "\u200b",
  NegativeThickSpace: "\u200b",
  lrm: "\u200e",
  rlm: "\u200f",
  NoBreak: "\u2060",
  af: "\u2061",
  ApplyFunction: "\u2061",
  it: "\u2062",
  InvisibleTimes: "\u2062",
  ic: "\u2063",
  InvisibleComma: "\u2063",
  Tab: "\t",
  NewLine: "\n",
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
  fjlig: "fj",
  nbsp: "\u00a0",
  shy: "\u00ad",
  zwnj: "\u200c",
  zwj: "\u200d",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  euro: "\u20ac",
  pound: "\u00a3",
  middot: "\u00b7",
};
export function decodeEntities(text: string): string {
  // A numeric reference needs no closing semicolon (WHATWG HTML, numeric character reference states: a parse error,
  // still decoded), so `pass&#119ord` reads `password`; a named one keeps its semicolon (D02 T04 §2, round 2).
  // A numeric reference takes its whole run of digits, leading zeros and all (round 3: `&#00000119;` is `w`); a value of
  // zero, past U+10FFFF or a surrogate reads as U+FFFD, as HTML reads it.
  return text.replace(/&(#\d+;?|#x[0-9a-f]+;?|[a-z][a-z0-9]{1,31};)/gi, (whole, raw: string) => {
    const ref = raw.replace(/;$/, "");
    if (ref.startsWith("#")) {
      const hex = ref[1] === "x" || ref[1] === "X";
      const digits = (hex ? ref.slice(2) : ref.slice(1)).replace(/^0+/, "") || "0";
      const code = digits.length > 8 ? Number.POSITIVE_INFINITY : Number.parseInt(digits, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "\ufffd";
    }
    return Object.hasOwn(ENTITIES, ref) ? (ENTITIES[ref] as string) : whole;
  });
}
