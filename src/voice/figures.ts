// D01 T03 §15: read a whole numeric run before classifying it. A quote is only a selection
// boundary after parsing the original transcript, never a fresh input from which to invent figures.
export type Figure = {
  kind: "amount" | "account";
  raw: string;
  start: number;
  end: number;
  value: string;
  currency: string | null;
};
export type PaymentFigures = { quoteStart: number; quoteEnd: number; items: Figure[] };
const WORD = /[\p{L}\p{M}\p{N}\p{Cf}_]/u;
const SPACE = /\s/u;
const RUN = /[\d.,/+:\s\p{Pd}\p{Sm}\u066b\u066c'’]/u;
const PREFIX = /(?:ZAR|USD|EUR|GBP|R|[$€£])$/i;
const SUFFIX = /^\s*(rands?|dollars?|euros?|pounds?|ZAR|USD|EUR|GBP)(?=$|[^\p{L}\p{N}_])/iu;
const MAGNITUDE = /^\s+(hundred|thousand|million|billion|trillion)(?=$|[^\p{L}\p{N}_])/iu;
const POWERS: Record<string, number> = { hundred: 2, thousand: 3, million: 6, billion: 9, trillion: 12 };

// Unsupported English compound numbers are consumed as one rejected expression, so a
// later numeric component cannot reappear as a separate amount. This recognizes boundaries,
// not values: the original quote remains the only reading of such a compound.
const NUMBER_WORDS =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|half|quarter|dozen";
const CURRENCY_COMPONENT = String.raw`(?:R|ZAR|USD|EUR|GBP)(?=\s|[0-9\p{Pd}\p{Sm}])`;
const CURRENCY_TERM = new RegExp(`^${CURRENCY_COMPONENT}`, "iu");
const NUMBER_START = new RegExp(
  `^(?:(?:[\\p{Pd}\\p{Sm}]|(?:minus|negative)\\b)\\s*)*(?:[0-9$€£]|${CURRENCY_COMPONENT}|(?:${NUMBER_WORDS})\\b|a\\s+(?:half|quarter|dozen|hundred|thousand)\\b)`,
  "iu",
);
const NUMBER_TERM = new RegExp(
  `^(?:${NUMBER_WORDS}|and|minus|negative|a|rands?|dollars?|euros?|pounds?|cents?|pence)\\b`,
  "iu",
);
function compositeEnd(transcript: string, end: number): number | null {
  const join = /^(?:\s+and\s+|\s*&\s*)/i.exec(transcript.slice(end));
  if (!join || !NUMBER_START.test(transcript.slice(end + join[0].length))) return null;
  let at = end + join[0].length;
  while (at < transcript.length) {
    const tail = transcript.slice(at);
    const token = /^[\s\d.,/%:&$€£\p{Pd}\p{Sm}]+/u.exec(tail) ?? NUMBER_TERM.exec(tail) ?? CURRENCY_TERM.exec(tail);
    if (!token) break;
    at += token[0].length;
  }
  return at;
}

// Ordinary decimal/grouping syntax, with an explicit whole-run rejection on ambiguity. A
// single separator followed by three digits is grouping, never an inferred three-place decimal.
function decimal(text: string): { value: string; marked: boolean } | null {
  let integer = text;
  let fraction: string | null = null;
  const dots = [...text.matchAll(/[.,]/g)];
  if (dots.length) {
    const last = dots.at(-1);
    if (!last || last.index === undefined) return null;
    const tail = text.slice(last.index + 1);
    if (/^\d{1,2}$/.test(tail)) {
      fraction = tail;
      integer = text.slice(0, last.index);
      // The decimal character cannot also group the integer part.
      if (integer.includes(last[0])) return null;
    }
  }
  if (!/^\d+$/.test(integer)) {
    const groups = integer.split(/[.,\s]/u);
    const separators = integer.match(/[.,\s]/gu) ?? [];
    if (
      groups.length < 2 ||
      !/^[1-9]\d{0,2}$/.test(groups[0] ?? "") ||
      !groups.slice(1).every((g) => /^\d{3}$/.test(g))
    )
      return null;
    const kinds = new Set(separators.map((s) => (SPACE.test(s) ? "space" : s)));
    if (kinds.size !== 1) return null;
    integer = groups.join("");
  }
  if (!/^\d+$/.test(integer) || integer.length > 128) return null;
  integer = integer.replace(/^0+(?=\d)/, "");
  return { value: fraction === null ? integer : `${integer}.${fraction}`, marked: dots.length > 0 };
}
function multiplied(value: string, power: number): string {
  const [integer = "", fraction = ""] = value.split(".");
  const digits = (BigInt(integer + fraction) * 10n ** BigInt(power)).toString().padStart(fraction.length + 1, "0");
  if (!fraction.length) return digits;
  return `${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`.replace(/0+$/, "").replace(/\.$/, "");
}

export function figuresOf(transcript: string): Figure[] {
  const figures: Figure[] = [];
  const numbers = /\d+/g;
  for (let found = numbers.exec(transcript); found; found = numbers.exec(transcript)) {
    const numberStart = found.index;
    let scanEnd = numberStart + found[0].length;
    while (scanEnd < transcript.length && RUN.test(transcript[scanEnd] ?? "")) scanEnd++;
    numbers.lastIndex = scanEnd;
    let numberEnd = scanEnd;
    while (numberEnd > numberStart && SPACE.test(transcript[numberEnd - 1] ?? "")) numberEnd--;
    // A sentence/clause terminator is outside the figure. Multiple trailing separators,
    // signs, slashes and colons remain in the run and make it invalid rather than a fragment.
    if (/[.,]/.test(transcript[numberEnd - 1] ?? "") && /\d/.test(transcript[numberEnd - 2] ?? "")) numberEnd--;
    const numeric = transcript.slice(numberStart, numberEnd);
    let currencyEnd = numberStart;
    while (currencyEnd > 0 && SPACE.test(transcript[currencyEnd - 1] ?? "")) currencyEnd--;
    const possiblePrefix = PREFIX.exec(transcript.slice(Math.max(0, currencyEnd - 3), currencyEnd));
    const possibleStart = currencyEnd - (possiblePrefix?.[0].length ?? 0);
    const prefix =
      possiblePrefix && !WORD.test([...transcript.slice(Math.max(0, possibleStart - 2), possibleStart)].at(-1) ?? "")
        ? possiblePrefix
        : null;
    const start = prefix ? currencyEnd - prefix[0].length : numberStart;
    const currencyBefore = prefix ? prefix[0].trim() : null;
    let end = numberEnd;
    const magnitude = MAGNITUDE.exec(transcript.slice(end));
    if (magnitude) end += magnitude[0].length;
    const suffix = SUFFIX.exec(transcript.slice(end));
    if (suffix) end += suffix[0].length;
    numbers.lastIndex = Math.max(scanEnd, end);
    const compoundEnd = compositeEnd(transcript, end);
    if (compoundEnd !== null) {
      numbers.lastIndex = Math.max(numbers.lastIndex, compoundEnd);
      continue;
    }
    const before = transcript.slice(Math.max(0, start - 2), start);
    const lastBefore = [...before].at(-1) ?? "";
    const next = transcript.slice(end, end + 2);
    const firstAfter = [...next][0] ?? "";
    if (WORD.test(lastBefore) || /[\p{Pd}\p{Sm}%/:]/u.test(lastBefore) || WORD.test(firstAfter)) continue;
    if (currencyBefore && suffix) continue;
    let wordEnd = start;
    while (wordEnd > 0 && SPACE.test(transcript[wordEnd - 1] ?? "")) wordEnd--;
    if (/(?:^|[^\p{L}\p{N}_])(?:minus|negative)$/iu.test(transcript.slice(Math.max(0, wordEnd - 10), wordEnd)))
      continue;
    if (/[\p{Pd}\p{Sm}]/u.test(transcript[wordEnd - 1] ?? "")) continue;
    if (
      MAGNITUDE.test(transcript.slice(end)) ||
      /^\s*(?:%|percent\b|per\s+cent\b|cents?\b|pence\b|penn(?:y|ies)\b)/i.test(transcript.slice(end))
    )
      continue;
    const raw = transcript.slice(start, end);
    // Bounds reject the entire run, never shorten its digits. A quote remains available
    // for unsupported forms; these are deterministic numeric readings, not bank validation.
    if (raw.length > 2048 || numeric.replace(/\D/g, "").length > 128) continue;
    const currency = currencyBefore ?? suffix?.[1] ?? null;
    const power = magnitude ? POWERS[(magnitude[1] ?? "").toLowerCase()] : undefined;
    // Account-like digit runs have no currency, decimal punctuation or magnitude. Keep
    // leading zeros, including grouped accounts; do not reinterpret a malformed amount.
    if (!currency && power === undefined && /^\d+(?:\s+\d+)*$/.test(numeric)) {
      const digits = numeric.replace(/\s/g, "");
      if (digits.length >= 6 && digits.length <= 34)
        figures.push({ kind: "account", raw, start, end, value: digits, currency: null });
      continue;
    }
    const parsed = decimal(numeric);
    if (!parsed || (!currency && power === undefined && !parsed.marked)) continue;
    figures.push({
      kind: "amount",
      raw,
      start,
      end,
      value: power === undefined ? parsed.value : multiplied(parsed.value, power),
      currency,
    });
  }
  return figures;
}

// The same whole-string lowercasing and collapsed whitespace as quote support, plus a map
// back to original UTF-16 offsets. Lowercase expansions (for example dotted I) retain their
// original span; whole-string casing also preserves contextual forms such as final sigma.
function normalized(text: string): { text: string; starts: number[]; ends: number[] } {
  const lower = text.toLowerCase();
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let offset = 0;
  for (const char of text) {
    for (let n = 0; n < char.toLowerCase().length; n++) {
      sourceStarts.push(offset);
      sourceEnds.push(offset + char.length);
    }
    offset += char.length;
  }
  if (sourceStarts.length !== lower.length) return { text: "", starts: [], ends: [] };
  const chars: string[] = [],
    starts: number[] = [],
    ends: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i] ?? "";
    if (SPACE.test(char)) {
      if (!chars.length) continue;
      if (chars.at(-1) === " ") {
        ends[ends.length - 1] = sourceEnds[i] ?? 0;
        continue;
      }
      chars.push(" ");
    } else chars.push(char);
    starts.push(sourceStarts[i] ?? 0);
    ends.push(sourceEnds[i] ?? 0);
  }
  if (chars.at(-1) === " ") {
    chars.pop();
    starts.pop();
    ends.pop();
  }
  return { text: chars.join(""), starts, ends };
}
export function figuresWithinQuote(transcript: string, quote: string): PaymentFigures | null {
  const source = normalized(transcript),
    selected = normalized(quote).text;
  if (selected.length < 3) return null;
  const at = source.text.indexOf(selected);
  if (at < 0) return null;
  const quoteStart = source.starts[at],
    quoteEnd = source.ends[at + selected.length - 1];
  if (quoteStart === undefined || quoteEnd === undefined) return null;
  return {
    quoteStart,
    quoteEnd,
    items: figuresOf(transcript).filter((f) => f.start >= quoteStart && f.end <= quoteEnd),
  };
}
