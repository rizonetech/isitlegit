// A PDF's text, for the instruction phrases (D02 T05 §4; ISO 32000-1). Read statically and bounded: the objects are
// indexed (object streams included), each page's content streams read through the page tree with inherited resources,
// a Form XObject's content with its own resources, and every string shown decoded through the font in use: its
// `/ToUnicode` CMap when it has one, else its simple encoding (WinAnsi, MacRoman, Standard, with `/Differences`). Text is
// assembled as a reader sees it: a move to a new line is a line break, a wide gap a space. What could not be read is
// named, never dropped; an encrypted document is said to be one.

export const MAX_PDF_OBJECTS = 5000;
export const MAX_PDF_STREAMS = 500;
export const MAX_PDF_EXPANDED = 16 * 1024 * 1024;
export const MAX_XOBJECT_DEPTH = 4;
export const MAX_XOBJECTS = 200;
// The work a document may take, counted in content tokens read (workerd's clock does not move while code runs).
export const MAX_PDF_OPERATIONS = 2_000_000;
// Content bytes read in all, repeated references included, and CMap entries in all (completion review: a stream
// referred to a thousand times, or a CMap of many ranges, must not take memory past these).
export const MAX_PDF_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_CMAP_ENTRIES = 100_000;

export type PdfText = { text: string; unread: string[]; encrypted: boolean };

type Ref = { ref: number };
type Name = { name: string };
type Dict = { dict: Map<string, Value> };
type Value = number | boolean | null | Uint8Array | Name | Ref | Dict | Value[] | { op: string };
type Stream = { dict: Map<string, Value>; start: number; length: number };

const isName = (v: Value | undefined): v is Name => typeof v === "object" && v !== null && "name" in v;
const isRef = (v: Value | undefined): v is Ref => typeof v === "object" && v !== null && "ref" in v;
const isDict = (v: Value | undefined): v is Dict => typeof v === "object" && v !== null && "dict" in v;
const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};
const WS = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const DELIM = (c: number) => "()<>[]{}/%".includes(String.fromCharCode(c));

class Lexer {
  pos: number;
  readonly s: string;
  constructor(s: string, start = 0) {
    this.s = s;
    this.pos = start;
  }
  skip() {
    for (;;) {
      while (this.pos < this.s.length && WS(this.s.charCodeAt(this.pos))) this.pos++;
      if (this.s[this.pos] !== "%") return;
      while (this.pos < this.s.length && this.s[this.pos] !== "\n" && this.s[this.pos] !== "\r") this.pos++;
    }
  }
  // One value or operator, or undefined at the end. Depth bounds nesting on hostile input.
  value(depth = 0): Value | undefined {
    if (depth > 64) throw new Error("nesting");
    this.skip();
    const s = this.s;
    const c = s[this.pos];
    if (c === undefined) return undefined;
    if (c === "<" && s[this.pos + 1] === "<") {
      this.pos += 2;
      const map = new Map<string, Value>();
      for (;;) {
        this.skip();
        if (s[this.pos] === ">" && s[this.pos + 1] === ">") {
          this.pos += 2;
          return { dict: map };
        }
        const key = this.value(depth + 1);
        if (!isName(key)) throw new Error("dict key");
        const val = this.value(depth + 1);
        if (val === undefined) throw new Error("dict end");
        map.set(key.name, val);
      }
    }
    if (c === "[") {
      this.pos++;
      const arr: Value[] = [];
      for (;;) {
        this.skip();
        if (s[this.pos] === "]") {
          this.pos++;
          return arr;
        }
        const v = this.value(depth + 1);
        if (v === undefined) throw new Error("array end");
        arr.push(v);
      }
    }
    if (c === "(") return this.literal();
    if (c === "<") {
      const end = s.indexOf(">", this.pos);
      if (end < 0) throw new Error("hex end");
      const hex = s.slice(this.pos + 1, end).replace(/\s+/g, "");
      this.pos = end + 1;
      if (!/^[0-9a-f]*$/i.test(hex)) throw new Error("hex");
      const padded = hex.length % 2 ? `${hex}0` : hex;
      const out = new Uint8Array(padded.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    if (c === "/") {
      let end = this.pos + 1;
      while (end < s.length && !WS(s.charCodeAt(end)) && !DELIM(s.charCodeAt(end))) end++;
      const name = s
        .slice(this.pos + 1, end)
        .replace(/#([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
      this.pos = end;
      return { name };
    }
    let end = this.pos;
    while (end < s.length && !WS(s.charCodeAt(end)) && !DELIM(s.charCodeAt(end))) end++;
    if (end === this.pos) {
      // A stray delimiter (`)`, `>`, `{`, `}`): skipped as an operator of its own.
      this.pos++;
      return { op: c };
    }
    const word = s.slice(this.pos, end);
    this.pos = end;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // `n g R`: a reference, read by looking ahead.
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        const m = /^\s+(\d+)\s+R(?![^\s()<>[\]{}/%])/.exec(s.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos = save + m[0].length;
          return { ref: n };
        }
      }
      return n;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  }
  private literal(): Uint8Array {
    const s = this.s;
    let depth = 0;
    const out: number[] = [];
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos] as string;
      this.pos++;
      if (c === "\\") {
        const n = s[this.pos] as string;
        this.pos++;
        const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
        if (n in map) out.push(map[n] as number);
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] ?? "")) oct += s[this.pos++];
          out.push(Number.parseInt(oct, 8) & 0xff);
        } else if (n === "\r") {
          if (s[this.pos] === "\n") this.pos++;
        } else if (n !== "\n") out.push(n.charCodeAt(0));
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        if (depth === 0) return Uint8Array.from(out);
        depth--;
      }
      out.push(c.charCodeAt(0) & 0xff);
    }
    throw new Error("string end");
  }
}

// --- The document: objects, streams, decoding ---------------------------------------------------------------------

class Doc {
  readonly s: string;
  readonly objects = new Map<number, Value>();
  readonly streams = new Map<number, Stream>();
  expanded = 0;
  streamsRead = 0;
  unread = new Set<string>();
  private readonly decoded = new Map<number, Uint8Array | null>();

  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.s = latin1(bytes);
  }

  index(): void {
    let count = 0;
    let from = 0;
    for (let header = this.header(from); header; header = this.header(from)) {
      from = header.end;
      if (++count > MAX_PDF_OBJECTS) {
        this.unread.add("it holds more objects than are read");
        break;
      }
      const num = header.num;
      const lex = new Lexer(this.s, header.end);
      let value: Value | undefined;
      try {
        value = lex.value();
      } catch {
        this.unread.add("an object of it could not be read");
        continue;
      }
      from = lex.pos;
      if (value === undefined) continue;
      this.objects.set(num, value);
      lex.skip();
      if (isDict(value) && this.s.startsWith("stream", lex.pos)) {
        let start = lex.pos + 6;
        if (this.s[start] === "\r") start++;
        if (this.s[start] === "\n") start++;
        const declared = value.dict.get("Length");
        let length = typeof declared === "number" ? declared : -1;
        if (length < 0 || !this.s.startsWith("endstream", this.after(start + length))) {
          const end = this.s.indexOf("endstream", start);
          length = end < 0 ? -1 : end - start;
          while (length > 0 && (this.s[start + length - 1] === "\n" || this.s[start + length - 1] === "\r")) length--;
        }
        if (length >= 0) this.streams.set(num, { dict: value.dict, start, length });
      }
      // Past a stream's data, never into it: text in a stream that reads like `4 0 obj` declares nothing (completion
      // review).
      const stream = this.streams.get(num);
      from = stream && stream.dict === (isDict(value) ? value.dict : null) ? stream.start + stream.length : lex.pos;
    }
  }

  // The next object header (`<num> <gen> obj`) at or after `from`, found in linear time: each `obj` keyword is found
  // with indexOf and its two numbers read backwards over a bounded span, never by a pattern that retries its digits at
  // every position (round 3: an unanchored regex was quadratic on a long run of digits).
  private header(from: number): { num: number; end: number } | null {
    const s = this.s;
    for (let at = s.indexOf("obj", from); at >= 0; at = s.indexOf("obj", at + 3)) {
      const after = s.charCodeAt(at + 3);
      if (at + 3 < s.length && !WS(after) && !DELIM(after)) continue;
      let p = at - 1;
      const digitsBack = (max: number) => {
        const end = p;
        while (p >= 0 && end - p < max && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) p--;
        return end - p;
      };
      const spaceBack = () => {
        const end = p;
        while (p >= 0 && end - p < 16 && WS(s.charCodeAt(p))) p--;
        return end - p;
      };
      if (spaceBack() === 0) continue;
      if (digitsBack(6) === 0) continue;
      if (spaceBack() === 0) continue;
      const numEnd = p;
      if (digitsBack(11) === 0) continue;
      if (p >= 0 && !WS(s.charCodeAt(p)) && !DELIM(s.charCodeAt(p))) continue;
      return { num: Number(s.slice(p + 1, numEnd + 1)), end: at + 3 };
    }
    return null;
  }
  private after(at: number) {
    let p = at;
    while (p < this.s.length && WS(this.s.charCodeAt(p))) p++;
    return p;
  }

  // Objects inside object streams (`/Type /ObjStm`), added where the file defines none of that number itself.
  async objectStreams(): Promise<void> {
    for (const [num, stream] of this.streams) {
      const type = stream.dict.get("Type");
      if (!isName(type) || type.name !== "ObjStm") continue;
      const data = await this.data(num);
      if (!data) continue;
      const text = latin1(data);
      const n = stream.dict.get("N");
      const first = stream.dict.get("First");
      if (typeof n !== "number" || typeof first !== "number" || n > MAX_PDF_OBJECTS) continue;
      const head = new Lexer(text);
      for (let i = 0; i < n; i++) {
        const id = head.value();
        const off = head.value();
        if (typeof id !== "number" || typeof off !== "number") break;
        if (this.objects.has(id)) continue;
        try {
          const v = new Lexer(text, first + off).value();
          if (v !== undefined) this.objects.set(id, v);
        } catch {
          this.unread.add("an object of it could not be read");
        }
      }
    }
  }

  get(v: Value | undefined, seen = 0): Value | undefined {
    if (isRef(v)) return seen > 16 ? undefined : this.get(this.objects.get(v.ref), seen + 1);
    return v;
  }
  dictOf(v: Value | undefined): Map<string, Value> | undefined {
    const d = this.get(v);
    return isDict(d) ? d.dict : undefined;
  }

  // A stream's decoded bytes (FlateDecode or none), within the limits; null, and the reason named, when not read.
  async data(num: number): Promise<Uint8Array | null> {
    if (this.decoded.has(num)) return this.decoded.get(num) ?? null;
    const stream = this.streams.get(num);
    let out: Uint8Array | null = null;
    // A stream that was referred to but cannot be found (cut short, its end missing) is damage, never nothing to read.
    if (!stream) this.unread.add("a stream of it could not be found");
    if (stream) {
      if (++this.streamsRead > MAX_PDF_STREAMS) this.unread.add("it holds more streams than are read");
      else {
        const raw = this.bytes.subarray(stream.start, stream.start + stream.length);
        const filter = this.get(stream.dict.get("Filter"));
        const filters = Array.isArray(filter) ? filter.map((f) => this.get(f)) : filter === undefined ? [] : [filter];
        if (filters.length === 0) out = raw;
        else if (filters.length === 1 && isName(filters[0]) && filters[0].name === "FlateDecode") {
          if (this.dictOf(stream.dict.get("DecodeParms"))?.get("Predictor") !== undefined)
            this.unread.add("a stream is encoded in a way that is not read");
          else out = await this.inflate(raw);
        } else this.unread.add("a stream is encoded in a way that is not read");
      }
    }
    this.decoded.set(num, out);
    return out;
  }
  private async inflate(raw: Uint8Array): Promise<Uint8Array | null> {
    const reader = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        this.expanded += value.byteLength;
        if (this.expanded > MAX_PDF_EXPANDED) {
          this.unread.add("it expands past the limit read");
          return null;
        }
        chunks.push(value);
      }
    } catch {
      this.unread.add("a stream of it is damaged");
      if (total === 0) return null;
    } finally {
      await reader.cancel().catch(() => {});
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

// --- Fonts ----------------------------------------------------------------------------------------------------------

// A font: its text for some bytes, and how far they advance, in thousandths of the font size (its `/Widths`, or a
// composite font's `/W`, 500 when it gives none).
type Font = { decode: (bytes: Uint8Array) => string | null; advance: (bytes: Uint8Array) => number };

// Glyph names to text: letters, digits and common punctuation by their Adobe names, and `uniXXXX` / `uXXXX`.
const GLYPHS: Record<string, string> = {
  space: " ",
  period: ".",
  comma: ",",
  colon: ":",
  semicolon: ";",
  hyphen: "-",
  exclam: "!",
  question: "?",
  quotesingle: "'",
  quotedbl: '"',
  parenleft: "(",
  parenright: ")",
  slash: "/",
  at: "@",
  ampersand: "&",
  underscore: "_",
  numbersign: "#",
  bracketleft: "[",
  bracketright: "]",
  less: "<",
  greater: ">",
  equal: "=",
  plus: "+",
  asterisk: "*",
  percent: "%",
  dollar: "$",
  bar: "|",
  backslash: "\\",
  quoteleft: "‘",
  quoteright: "’",
  quotedblleft: "“",
  quotedblright: "”",
  endash: "–",
  emdash: "—",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const glyph = (name: string): string | null => {
  if (/^[A-Za-z]$/.test(name)) return name;
  if (name in GLYPHS) return GLYPHS[name] as string;
  const uni = /^uni([0-9A-F]{4})$/.exec(name) ?? /^u([0-9A-F]{4,6})$/.exec(name);
  if (!uni) return null;
  // A code point outside Unicode, or a surrogate, names no character: the glyph is unreadable, never a throw (round 1).
  const code = Number.parseInt(uni[1] as string, 16);
  return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? null : String.fromCodePoint(code);
};
const WINANSI = new TextDecoder("windows-1252");
const MACROMAN = (() => {
  try {
    return new TextDecoder("macintosh");
  } catch {
    return null;
  }
})();

// A `/ToUnicode` CMap's codes: its code lengths (codespace ranges) and `bfchar` / `bfrange` mappings.
function toUnicode(cmap: string, advance: (bytes: Uint8Array) => number): Font | null {
  const lengths = new Set<number>();
  for (const block of cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))
    for (const m of (block[1] as string).matchAll(/<([0-9a-f]+)>\s*<[0-9a-f]+>/gi))
      lengths.add((m[1] as string).length / 2);
  const map = new Map<string, string>();
  const utf16 = (hex: string) => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of (block[1] as string).matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi))
      map.set((m[1] as string).toLowerCase(), utf16(m[2] as string));
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of (block[1] as string).matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
      const lo = Number.parseInt(m[1] as string, 16);
      const hi = Number.parseInt(m[2] as string, 16);
      const width = (m[1] as string).length;
      // A code is at most four bytes (ISO 32000-1 9.10.3); a wider one would pass 2^53, where a counter stops moving
      // (round 1: a range of such codes looped without end). The map is then not read.
      if (width > 8 || (m[2] as string).length !== width) return null;
      if (hi < lo || hi - lo > 65535) continue;
      if (map.size + (hi - lo) > MAX_CMAP_ENTRIES) return null;
      const dst = m[3] as string;
      const list = dst.startsWith("[") ? [...dst.matchAll(/<([0-9a-f]*)>/gi)].map((d) => d[1] as string) : null;
      const base = list ? 0 : Number.parseInt(dst.slice(1, -1).slice(-4) || "0", 16);
      const prefix = list ? "" : dst.slice(1, -1).slice(0, -4);
      for (let c = lo; c <= hi; c++) {
        const key = c.toString(16).padStart(width, "0");
        const text = list ? utf16(list[c - lo] ?? "") : utf16(prefix) + String.fromCharCode(base + (c - lo));
        map.set(key, text);
      }
    }
  if (map.size === 0) return null;
  const sizes = [...(lengths.size ? lengths : new Set([2]))].sort((a, b) => a - b);
  return {
    advance,
    decode: (bytes) => {
      let out = "";
      let i = 0;
      while (i < bytes.length) {
        let found: string | undefined;
        for (const n of sizes) {
          const key = Array.from(bytes.subarray(i, i + n), (b) => b.toString(16).padStart(2, "0")).join("");
          found = map.get(key);
          if (found !== undefined) {
            i += n;
            break;
          }
        }
        if (found === undefined) return null;
        out += found;
      }
      return out;
    },
  };
}

// --- Content ------------------------------------------------------------------------------------------------------

class Reader {
  text = "";
  // The last character appended, kept apart: asking a string built by `+=` for its end flattens it every time, which
  // made a long document's reading quadratic.
  private last = 0;
  append(t: string): void {
    if (!t) return;
    this.text += t;
    this.last = t.charCodeAt(t.length - 1);
  }
  private get spaced(): boolean {
    return this.last === 0 || this.last === 32 || this.last === 10 || this.last === 9 || this.last === 13;
  }
  newline(): void {
    if (this.last !== 0 && this.last !== 10) this.append("\n");
  }
  operations = 0;
  xobjects = 0;
  private readonly doc: Doc;
  constructor(doc: Doc) {
    this.doc = doc;
  }
  // Cached by the font dictionary itself, so two scopes' `/F1` stay two fonts (completion review).
  private readonly fonts = new Map<Map<string, Value>, Font | null>();
  contentBytes = 0;

  async font(resources: Map<string, Value> | undefined, name: string): Promise<Font | null> {
    const dict = this.doc.dictOf(this.doc.dictOf(resources?.get("Font"))?.get(name));
    if (!dict) return null;
    if (this.fonts.has(dict)) return this.fonts.get(dict) ?? null;
    let font: Font | null = null;
    const subtype = this.doc.get(dict.get("Subtype"));
    const composite = isName(subtype) && subtype.name === "Type0";
    const tu = dict.get("ToUnicode");
    if (isRef(tu)) {
      const data = await this.doc.data(tu.ref);
      if (data)
        font = toUnicode(latin1(data), composite ? compositeAdvance(this.doc, dict) : simpleAdvance(this.doc, dict));
    }
    if (!font && !composite) font = simple(this.doc, dict);
    this.fonts.set(dict, font);
    return font;
  }

  async content(data: Uint8Array, resources: Map<string, Value> | undefined, depth: number): Promise<void> {
    const lex = new Lexer(latin1(data));
    const stack: Value[] = [];
    let font: Font | null = null;
    let size = 12;
    // The text font and size belong to the graphics state, saved by `q` and restored by `Q` (ISO 32000-1 8.4.2; round
    // 1: text after a restore was decoded with the font the saved state had replaced).
    const saved: { font: Font | null; size: number }[] = [];
    let fontUnreadable = false;
    // Where text is drawn, in text space: the current line's start and the point the last text ended, so a move on
    // the same baseline past a fifth of the font size is a space, a move within it joins the fragments (a word drawn
    // in pieces stays one word), and a move to another baseline is a line break (completion review).
    let lineX = 0;
    let lineY = 0;
    let atX = Number.NaN;
    let atY = Number.NaN;
    let leading = 0;
    let fresh = false;
    const moveTo = (x: number, y: number) => {
      fresh = false;
      if (!Number.isNaN(atY)) {
        if (Math.abs(y - atY) > size * 0.5) line();
        else if (Math.abs(x - atX) > size * 0.2 && !this.spaced) this.append(" ");
      }
      lineX = x;
      lineY = y;
      atX = x;
      atY = y;
    };
    const show = (bytes: Uint8Array) => {
      if (fresh) moveTo(lineX, lineY);
      if (Number.isNaN(atY)) {
        atX = lineX;
        atY = lineY;
      }
      if (!font) {
        fontUnreadable = true;
        return;
      }
      const t = font.decode(bytes);
      if (t === null) fontUnreadable = true;
      else this.append(t);
      atX += (font.advance(bytes) * size) / 1000;
    };
    const line = () => {
      this.newline();
    };
    for (;;) {
      if (++this.operations > MAX_PDF_OPERATIONS) {
        this.doc.unread.add("it takes more work to read than is allowed");
        return;
      }
      let v: Value | undefined;
      try {
        v = lex.value();
      } catch {
        this.doc.unread.add("its content could not be read past a point");
        return;
      }
      if (v === undefined) break;
      if (!(typeof v === "object" && v !== null && "op" in v)) {
        if (stack.length < 64) stack.push(v);
        continue;
      }
      const op = v.op;
      const args = stack.splice(0);
      if (op === "BI") {
        // An inline image: its data runs to `EI`, never text.
        const end = lex.s.indexOf("EI", lex.pos);
        lex.pos = end < 0 ? lex.s.length : end + 2;
      } else if (op === "q") {
        if (saved.length < 64) saved.push({ font, size });
      } else if (op === "Q") {
        const back = saved.pop();
        if (back) ({ font, size } = back);
      } else if (op === "Tf") {
        const n = args[0];
        size = typeof args[1] === "number" ? Math.abs(args[1]) || 12 : 12;
        font = isName(n) ? await this.font(resources, n.name) : null;
      } else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") moveTo(lineX, lineY - leading);
        const s = args[args.length - 1];
        if (s instanceof Uint8Array) show(s);
      } else if (op === "TJ") {
        const arr = args[0];
        if (Array.isArray(arr))
          for (const part of arr) {
            if (part instanceof Uint8Array) show(part);
            else if (typeof part === "number") {
              // A number moves the next glyph back by that many thousandths: a wide move left is a word gap.
              if (part < -200 && !this.spaced) this.append(" ");
              atX -= (part * size) / 1000;
            }
          }
      } else if (op === "Td" || op === "TD") {
        const [tx, ty] = args;
        if (typeof tx === "number" && typeof ty === "number") {
          if (op === "TD") leading = -ty;
          moveTo(lineX + tx, lineY + ty);
        }
      } else if (op === "TL" && typeof args[0] === "number") leading = args[0];
      else if (op === "T*") moveTo(lineX, lineY - leading);
      else if (op === "Tm") {
        const e = args[4];
        const f = args[5];
        if (typeof e === "number" && typeof f === "number") moveTo(e, f);
      } else if (op === "BT") {
        // A text object starts at the origin; where it lands is decided by its first move, against the last text.
        lineX = 0;
        lineY = 0;
        fresh = true;
      } else if (op === "Do" && isName(args[0])) {
        const ref = this.doc.dictOf(resources?.get("XObject"))?.get(args[0].name);
        const stream = isRef(ref) ? this.doc.streams.get(ref.ref) : undefined;
        if (!isRef(ref) || !stream) {
          // A drawing it names but does not hold: what it would have shown is unread (completion review).
          this.doc.unread.add("a drawing it refers to could not be found");
          continue;
        }
        const sub = this.doc.get(stream.dict.get("Subtype"));
        if (!isName(sub) || sub.name !== "Form") continue;
        if (depth >= MAX_XOBJECT_DEPTH || ++this.xobjects > MAX_XOBJECTS) {
          this.doc.unread.add("it nests more drawings than are read");
          continue;
        }
        const data2 = await this.doc.data(ref.ref);
        // A form has its own space: its text is set apart from the page's by line breaks, never run into it.
        if (data2) {
          line();
          await this.content(data2, this.doc.dictOf(stream.dict.get("Resources")) ?? resources, depth + 1);
          line();
          atY = Number.NaN;
        }
      }
    }
    if (fontUnreadable) this.doc.unread.add("some of its text uses a font that cannot be decoded");
  }
}

// A simple font's encoding: a named base (WinAnsi, MacRoman, Standard) and its `/Differences`.
function simple(doc: Doc, dict: Map<string, Value>): Font | null {
  const encoding = doc.get(dict.get("Encoding"));
  let base = "StandardEncoding";
  const differences = new Map<number, string>();
  if (isName(encoding)) base = encoding.name;
  else if (isDict(encoding)) {
    const b = doc.get(encoding.dict.get("BaseEncoding"));
    if (isName(b)) base = b.name;
    const diff = doc.get(encoding.dict.get("Differences"));
    if (Array.isArray(diff)) {
      let code = 0;
      for (const d of diff) {
        const v = doc.get(d);
        if (typeof v === "number") code = v;
        else if (isName(v)) differences.set(code++, v.name);
      }
    }
  }
  const baseDecoder =
    base === "MacRomanEncoding" ? MACROMAN : base === "WinAnsiEncoding" || base === "StandardEncoding" ? WINANSI : null;
  if (!baseDecoder) return null;
  // Each code's text, worked out once for the font: its `/Differences` glyph, else its base encoding's character;
  // null for a glyph name that cannot be read (the per-byte decoder call this replaces made a long text slow).
  const table: (string | null)[] = Array.from({ length: 256 }, (_, b) => {
    const named = differences.get(b);
    return named !== undefined ? glyph(named) : baseDecoder.decode(Uint8Array.of(b));
  });
  return {
    advance: simpleAdvance(doc, dict),
    decode: (bytes) => {
      let out = "";
      for (const b of bytes) {
        const t = table[b];
        if (t === null || t === undefined) return null;
        out += t;
      }
      return out;
    },
  };
}

// A simple font's advance for bytes, from its `/FirstChar` and `/Widths` (500 for a code it gives none).
function simpleAdvance(doc: Doc, dict: Map<string, Value>): (bytes: Uint8Array) => number {
  const widths = doc.get(dict.get("Widths"));
  const first = doc.get(dict.get("FirstChar"));
  return (bytes) =>
    bytes.reduce((n, b) => {
      const w = Array.isArray(widths) && typeof first === "number" ? doc.get(widths[b - first]) : undefined;
      return n + (typeof w === "number" ? w : 500);
    }, 0);
}

// A composite font's advance for two-byte codes, from its descendant's `/W` (`c [w1 w2 ...]` or `c1 c2 w`) and `/DW`.
function compositeAdvance(doc: Doc, dict: Map<string, Value>): (bytes: Uint8Array) => number {
  const descendants = doc.get(dict.get("DescendantFonts"));
  const cid = Array.isArray(descendants) ? doc.dictOf(descendants[0]) : undefined;
  const dw = doc.get(cid?.get("DW"));
  const fallback = typeof dw === "number" ? dw : 1000;
  const table = new Map<number, number>();
  const w = doc.get(cid?.get("W"));
  // A CID is an integer of at most two bytes (ISO 32000-1 9.7.4): one outside that, at 2^53 say, would stop a counter
  // moving, so it ends the table; and every entry written counts, however often one is rewritten (rounds 1 and 2).
  const isCid = (n: Value | undefined): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffff;
  let written = 0;
  if (Array.isArray(w))
    for (let i = 0; i < w.length && written < MAX_CMAP_ENTRIES; ) {
      const c = doc.get(w[i]);
      const next = doc.get(w[i + 1]);
      if (!isCid(c)) break;
      if (Array.isArray(next)) {
        for (let k = 0; k < next.length && c + k <= 0xffff && written < MAX_CMAP_ENTRIES; k++, written++) {
          const n = doc.get(next[k]);
          if (typeof n === "number") table.set(c + k, n);
        }
        i += 2;
      } else {
        const width = doc.get(w[i + 2]);
        if (!isCid(next) || next < c || typeof width !== "number") break;
        for (let k = c; k <= next && written < MAX_CMAP_ENTRIES; k++, written++) table.set(k, width);
        i += 3;
      }
    }
  return (bytes) => {
    let n = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2)
      n += table.get(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)) ?? fallback;
    return n;
  };
}

// --- The document's text --------------------------------------------------------------------------------------------

export async function pdfText(bytes: Uint8Array): Promise<PdfText> {
  const doc = new Doc(bytes);
  if (/\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(doc.s)) return { text: "", unread: [], encrypted: true };
  doc.index();
  await doc.objectStreams();
  const reader = new Reader(doc);
  const catalog = [...doc.objects.values()].find((v) => {
    const t = isDict(v) ? doc.get(v.dict.get("Type")) : undefined;
    return isName(t) && t.name === "Catalog";
  });
  const root = isDict(catalog) ? doc.dictOf(catalog.dict.get("Pages")) : undefined;
  if (!root) return { text: "", unread: [...doc.unread, "its pages could not be found"], encrypted: false };
  const visited = new Set<Map<string, Value>>();
  const walk = async (node: Map<string, Value>, inherited: Map<string, Value> | undefined, depth: number) => {
    if (visited.has(node)) return;
    if (depth > 32 || visited.size > MAX_PDF_OBJECTS) {
      doc.unread.add("its pages go deeper than is read");
      return;
    }
    visited.add(node);
    const resources = doc.dictOf(node.get("Resources")) ?? inherited;
    const kids = doc.get(node.get("Kids"));
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        const d = doc.dictOf(kid);
        if (d) await walk(d, resources, depth + 1);
        else doc.unread.add("a page of it could not be found");
      }
      return;
    }
    const contents = doc.get(node.get("Contents"));
    const refs = (Array.isArray(contents) ? contents : [node.get("Contents")]).filter(isRef);
    const parts: Uint8Array[] = [];
    for (const r of refs) {
      const data = await doc.data(r.ref);
      if (!data) continue;
      // Content bytes are counted as they are taken, repeated references included, before any copy is made.
      reader.contentBytes += data.length + 1;
      if (reader.contentBytes > MAX_PDF_CONTENT_BYTES) {
        doc.unread.add("its pages hold more content than is read");
        break;
      }
      parts.push(data, Uint8Array.of(10));
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    await reader.content(all, resources, 0);
    reader.newline();
  };
  await walk(root, undefined, 0);
  return { text: reader.text, unread: [...doc.unread], encrypted: false };
}
