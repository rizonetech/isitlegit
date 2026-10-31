// Text with its default-ignorable characters taken out, for matching only (D02 T05 §5): one or two zero-width
// characters inside a word (`ig` U+200B `nore previous instructions`) split an instruction that a reader sees whole.
// Every Default_Ignorable_Code_Point (`isIgnorable`, UAX #44) is taken out, with three exceptions a script or an emoji
// needs: U+200C and U+200D between two letters or marks of one joining script, or between two emoji; U+FE0E and U+FE0F
// right after an emoji; U+034F between two combining marks. The text kept is never changed: this feeds a second
// reading, and `withoutInstructions` maps its matches back to the spans they cover.
import { isIgnorable } from "./invisible-unicode";

// Scripts whose letters join or change shape, where U+200C and U+200D carry meaning.
const JOINING: readonly [string, RegExp][] = [
  "Arabic",
  "Syriac",
  "Mongolian",
  "Nko",
  "Mandaic",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Oriya",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Khmer",
  "Myanmar",
  "Tibetan",
].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")]);
const EMOJI = /\p{Extended_Pictographic}/u;
const MARK = /\p{M}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const scriptOf = (ch: string) => JOINING.find(([, pattern]) => pattern.test(ch))?.[0] ?? null;

// Whether an ignorable character `ch` between `before` and `after` is one a script or an emoji needs.
function needed(ch: string, before: string, after: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0x200c || code === 0x200d) {
    if (EMOJI.test(before) && EMOJI.test(after)) return true;
    if (!LETTER_OR_MARK.test(before) || !LETTER_OR_MARK.test(after)) return false;
    const script = scriptOf(before);
    return script !== null && script === scriptOf(after);
  }
  if (code === 0xfe0e || code === 0xfe0f) return EMOJI.test(before);
  if (code === 0x034f) return MARK.test(before) && MARK.test(after);
  return false;
}

// The positions of a text's characters that matching keeps: every character but an ignorable one not needed.
export function kept(text: string, before = "", after = ""): number[] {
  const chars = Array.from(text);
  const positions: number[] = [];
  let at = 0;
  let last = before;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const code = ch.codePointAt(0) ?? 0;
    if (isIgnorable(code)) {
      let j = i + 1;
      while (j < chars.length && isIgnorable(chars[j]?.codePointAt(0) ?? 0)) j++;
      const next = j < chars.length ? (chars[j] as string) : after;
      if (needed(ch, last, next)) positions.push(at);
    } else {
      positions.push(at);
      last = ch;
    }
    at += ch.length;
  }
  return positions;
}

// The text matching reads: `kept`'s characters only.
export function stripIgnorable(text: string, before = "", after = ""): string {
  const chars = kept(text, before, after);
  let out = "";
  for (const at of chars) {
    const code = text.codePointAt(at) ?? 0;
    out += String.fromCodePoint(code);
  }
  return out;
}

// A stream of chunks stripped as they come: a run of ignorable characters at a chunk's end waits for the character
// after it, which decides whether a joiner is needed.
export class IgnorableStripper {
  private held = "";
  private last = "";

  feed(chunk: string): string {
    const text = this.held + chunk;
    const chars = Array.from(text);
    let cut = chars.length;
    while (cut > 0 && isIgnorable(chars[cut - 1]?.codePointAt(0) ?? 0)) cut--;
    const ready = chars.slice(0, cut).join("");
    this.held = chars.slice(cut).join("");
    const out = stripIgnorable(ready, this.last);
    const lastKept = Array.from(ready)
      .reverse()
      .find((c) => !isIgnorable(c.codePointAt(0) ?? 0));
    if (lastKept) this.last = lastKept;
    return out;
  }

  end(): string {
    const rest = this.held;
    this.held = "";
    return stripIgnorable(rest, this.last);
  }
}
