// A bounded PDF object reader for the payment document forensics (D06 T02 §1; ISO 32000-1). It reads what forensics
// needs: the cross-reference chain from the last `startxref` back through `/Prev` and `/XRefStm` (tables 7.5.4, streams
// 7.5.8, hybrid files 7.5.8.4), with free entries and generations honoured, so each object number resolves to the
// definition the newest revision names; the objects packed in compressed object streams (7.5.7); the trailers; and
// FlateDecode stream data through the Workers `DecompressionStream`. Only when the chain is damaged does it fall back to
// scanning for `N G obj`, and it says so, since a scan cannot tell a replaced object from its replacement's predecessor.
//
// The file is hostile. Every loop is bounded by the caps below and by one `Budget` the content reader shares, nesting is
// capped, references are followed a bounded number of steps, and what the reader could not read is a named reason in
// `unread`, never a throw, so the forensics can say "not fully checked" rather than fail or pass silently. Its
// synchronous work is linear in the file's size (a Worker cannot interrupt synchronous JavaScript, D02 T01 §2).

import { fileKey, objectKey, rc4 } from "./pdf-crypt.ts";
import { ascii85Decode, asciiHexDecode, type Decoded, lzwDecode, runLengthDecode, untiff } from "./pdf-filters.ts";

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // the largest upload or attachment the intake keeps
export const MAX_OBJECTS = 50_000;
export const MAX_SECTIONS = 256;
export const MAX_STREAM_DECODED = 8 * 1024 * 1024;
export const MAX_TOTAL_DECODED = 48 * 1024 * 1024;
// Filters in one stream's chain: more is no real writer's, and each stage is a pass over the data.
export const MAX_FILTERS = 4;
export const MAX_DEPTH = 32;
export const MAX_OBJECT_STREAMS = 1_000;
export const MAX_TOKENS = 2_000_000;
export const MAX_HEX = 1024 * 1024;
export const MAX_ENDOBJ_TRIES = 3;
export const MAX_STRING = 4 * 1024 * 1024;

export type PdfName = { kind: "name"; name: string };
// Each character one byte (0 to 255).
export type PdfString = { kind: "string"; bytes: string };
export type PdfRef = { kind: "ref"; num: number; gen: number };
export type PdfDict = { kind: "dict"; entries: Map<string, PdfValue> };
export type PdfOperator = { kind: "op"; op: string };
export type PdfValue = null | boolean | number | PdfName | PdfString | PdfRef | PdfDict | PdfValue[];
// `owner` is the object a stream was read as (number and generation), which an encrypted file's stream key needs.
export type PdfStream = {
  kind: "stream";
  dict: PdfDict;
  start: number;
  end: number;
  owner?: { num: number; gen: number };
};
export type PdfObject = PdfValue | PdfStream;

// One cross-reference section: the objects that revision defined, newest section first in `PdfFile.sections`.
export type XrefSection = {
  offset: number;
  kind: "table" | "stream";
  defines: number[];
  // This section's own entry for each number it names, so an update's object can be compared with what it replaced.
  entries: Map<number, Entry>;
  trailer: PdfDict;
};

// The work one analysis may do, shared by the reader and the content reader so a file cannot spend each cap in turn.
export type Budget = { tokens: number; decoded: number; entries: number };
export const newBudget = (): Budget => ({ tokens: 0, decoded: 0, entries: 0 });
// Cross-reference entries across the whole chain, counted as each is made, so neither many ranges in one section nor
// many sections can allocate past it (round 1).
export const MAX_ENTRIES = 200_000;
function countEntry(file: PdfFile): void {
  if (++file.budget.entries > MAX_ENTRIES) throw new OverBudget(`more than ${MAX_ENTRIES} cross-reference entries`);
}

export type PdfFile = {
  // The file as one byte-per-character string: an index into it is a byte offset.
  text: string;
  bytes: Uint8Array;
  objects: Map<number, PdfObject>;
  // Each object's generation (7.3.10): a reference naming another generation resolves to nothing.
  generations: Map<number, number>;
  // The cross-reference chain, newest first; empty when the chain could not be read and objects were scanned.
  sections: XrefSection[];
  // The newest trailer (the cross-reference stream's dictionary in a file that has one).
  trailer: PdfDict | null;
  scanned: boolean;
  // Encrypted and not opened: a password is needed, or the handler is not one this reads (D06 T02 §5). A file opened
  // with the empty user password is `decrypted` instead, and read like any other.
  encrypted: boolean;
  decrypted: boolean;
  // The file key and the encryption dictionary's own object (never decrypted), once opened.
  crypt: { key: Uint8Array; skip: number | null } | null;
  linearized: { length: number; firstPageEnd: number } | null;
  unread: string[];
  budget: Budget;
};

const has = (v: unknown, kind: string) => typeof v === "object" && v !== null && (v as { kind?: string }).kind === kind;
export const isName = (v: unknown, name?: string): v is PdfName =>
  has(v, "name") && (name === undefined || (v as PdfName).name === name);
export const isDict = (v: unknown): v is PdfDict => has(v, "dict");
export const isRef = (v: unknown): v is PdfRef => has(v, "ref");
export const isString = (v: unknown): v is PdfString => has(v, "string");
export const isStream = (v: unknown): v is PdfStream => has(v, "stream");
export const isOp = (v: unknown, op?: string): v is PdfOperator =>
  has(v, "op") && (op === undefined || (v as PdfOperator).op === op);

// The file as a string whose character codes are its bytes, built in chunks (a spread of 25 MiB overflows the stack).
// A string of the given byte values, built in chunks like `byteString`.
export function charCodes(codes: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += 0x8000) parts.push(String.fromCharCode(...codes.slice(i, i + 0x8000)));
  return parts.join("");
}

// Widened to UTF-16 code units and decoded as UTF-16LE, so each character's code is exactly its byte (TextDecoder's
// "latin1" is Windows-1252, which moves 0x80 to 0x9F).
export function byteString(bytes: Uint8Array): string {
  const wide = new Uint16Array(bytes.length);
  wide.set(bytes);
  return new TextDecoder("utf-16le").decode(wide);
}

export function note(file: { unread: string[] }, reason: string): void {
  if (!file.unread.includes(reason) && file.unread.length < 32) file.unread.push(reason);
}

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const regular = (c: number) => !Number.isNaN(c) && !WHITE.has(c) && !DELIM.has(c);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

// Malformed syntax in a hostile file is ordinary, so it is thrown as a plain value, not an Error: capturing a stack for
// each of tens of thousands of malformed objects cost seconds (completion review's hostile files). It never leaves
// this module; every caller turns it into a named reason in `unread`.
export class PdfSyntax {
  readonly name = "PdfSyntax";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}
export class OverBudget extends Error {
  override name = "OverBudget";
}

// A lexer and object parser over a byte string (7.2, 7.3). `pos` only moves forward, every token is counted against
// the budget, and nesting is capped, so a parse is linear in what it reads and never recurses without bound.
export class Lexer {
  pos: number;
  readonly s: string;
  readonly budget: Budget;
  readonly end: number;
  // Plain fields, not parameter properties, so Node runs this file as it is (test/node/make-pdf-forensics.ts).
  constructor(s: string, budget: Budget, start = 0, end = s.length) {
    this.s = s;
    this.budget = budget;
    this.pos = start;
    this.end = end;
  }

  private code(i = this.pos) {
    return i < this.end ? this.s.charCodeAt(i) : Number.NaN;
  }

  skipSpace(): void {
    while (this.pos < this.end) {
      const c = this.code();
      if (WHITE.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.end && this.code() !== 0x0a && this.code() !== 0x0d) this.pos++;
      } else break;
    }
  }

  // The next value, or an operator (a bare keyword or a stray delimiter); undefined at the end. With `content`, an
  // integer pair before `R` stays two numbers and an `R`, as in a content stream, which has no references.
  next(content = false, depth = 0): PdfValue | PdfOperator | undefined {
    if (++this.budget.tokens > MAX_TOKENS) throw new OverBudget(`more than ${MAX_TOKENS} tokens`);
    if (depth > MAX_DEPTH) throw new PdfSyntax("nested too deeply");
    this.skipSpace();
    if (this.pos >= this.end) return undefined;
    const c = this.code();
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literal();
    if (c === 0x3c) return this.code(this.pos + 1) === 0x3c ? this.dict(content, depth) : this.hex();
    if (c === 0x5b) {
      this.pos++;
      const items: PdfValue[] = [];
      for (;;) {
        this.skipSpace();
        if (this.pos >= this.end) throw new PdfSyntax("unterminated array");
        if (this.code() === 0x5d) {
          this.pos++;
          return items;
        }
        const item = this.next(content, depth + 1);
        if (item === undefined) throw new PdfSyntax("unterminated array");
        if (!isOp(item)) items.push(item);
      }
    }
    if (!regular(c)) {
      this.pos++;
      return { kind: "op", op: String.fromCharCode(c) };
    }
    return this.word(content);
  }

  private name(): PdfName {
    this.pos++;
    const start = this.pos;
    while (this.pos < this.end && regular(this.code())) this.pos++;
    const raw = this.s.slice(start, this.pos);
    // #xx escapes (7.3.5).
    const name = raw.includes("#")
      ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
      : raw;
    return { kind: "name", name };
  }

  // A literal string (7.3.4.2), read in runs: the text between two special characters (`\\`, `(`, `)`) is taken as
  // one slice, so a long string costs a few allocations, not one per character (round 6: 12 MiB of text in one string
  // reached 530 MiB). Each escape and parenthesis is charged to the budget, and a string longer than MAX_STRING ends
  // the object as malformed.
  private literal(): PdfString {
    this.pos++;
    let depth = 1;
    let length = 0;
    const out: string[] = [];
    const special = /[\\()]/g;
    const take = (text: string) => {
      length += text.length;
      if (length > MAX_STRING) throw new PdfSyntax("a string is too long");
      if (text) out.push(text);
    };
    while (this.pos < this.end) {
      special.lastIndex = this.pos;
      const m = special.exec(this.s);
      const at = m && m.index < this.end ? m.index : this.end;
      take(this.s.slice(this.pos, at));
      if (at >= this.end) break;
      if (++this.budget.tokens > MAX_TOKENS) throw new OverBudget(`more than ${MAX_TOKENS} tokens`);
      const ch = this.s[at] as string;
      this.pos = at + 1;
      if (ch === "(") {
        depth++;
        take(ch);
      } else if (ch === ")") {
        if (--depth === 0) return { kind: "string", bytes: out.join("") };
        take(ch);
      } else {
        const e = this.s[this.pos++];
        if (e === undefined || this.pos > this.end) break;
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (simple[e] !== undefined) take(simple[e]);
        else if (e === "\r") {
          if (this.s[this.pos] === "\n") this.pos++;
        } else if (e === "\n") {
          // A line continuation.
        } else if (e >= "0" && e <= "7") {
          let oct = e;
          while (oct.length < 3 && this.pos < this.end && /[0-7]/.test(this.s[this.pos] as string))
            oct += this.s[this.pos++];
          take(String.fromCharCode(Number.parseInt(oct, 8) & 0xff));
        } else take(e);
      }
    }
    throw new PdfSyntax("unterminated string");
  }

  private hex(): PdfString {
    this.pos++;
    // Hex digits and white space up to `>` (7.3.4.3); any other character ends it as unterminated, so a hex string never
    // runs into the objects after it and each is read in time linear in its own length.
    const out: number[] = [];
    let high = -1;
    while (this.pos < this.end) {
      const c = this.code();
      this.pos++;
      if (c === 0x3e) {
        if (high >= 0) out.push(high << 4);
        return { kind: "string", bytes: charCodes(out) };
      }
      if (WHITE.has(c)) continue;
      const v =
        c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
      if (v < 0 || out.length >= MAX_HEX) throw new PdfSyntax("unterminated hex string");
      if (high < 0) high = v;
      else {
        out.push((high << 4) | v);
        high = -1;
      }
    }
    throw new PdfSyntax("unterminated hex string");
  }

  private dict(content: boolean, depth: number): PdfDict {
    this.pos += 2;
    const entries = new Map<string, PdfValue>();
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.end) throw new PdfSyntax("unterminated dictionary");
      if (this.code() === 0x3e && this.code(this.pos + 1) === 0x3e) {
        this.pos += 2;
        return { kind: "dict", entries };
      }
      const key = this.next(content, depth + 1);
      if (key === undefined) throw new PdfSyntax("unterminated dictionary");
      if (!isName(key)) continue;
      this.skipSpace();
      if (this.code() === 0x3e && this.code(this.pos + 1) === 0x3e) break;
      const value = this.next(content, depth + 1);
      if (value === undefined) throw new PdfSyntax("unterminated dictionary");
      if (!isOp(value)) entries.set(key.name, value);
    }
    this.pos += 2;
    return { kind: "dict", entries };
  }

  private word(content: boolean): PdfValue | PdfOperator {
    const start = this.pos;
    while (this.pos < this.end && regular(this.code())) this.pos++;
    const w = this.s.slice(start, this.pos);
    if (NUMBER.test(w)) {
      // An integer, an integer and `R` is a reference (7.3.10).
      if (!content && /^\d+$/.test(w)) {
        const m = /^[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+R(?![^\0\t\n\f\r ()<>[\]{}/%])/.exec(
          this.s.slice(this.pos, Math.min(this.end, this.pos + 16)),
        );
        if (m) {
          this.pos += m[0].length;
          return { kind: "ref", num: Number(w), gen: Number(m[1]) };
        }
      }
      return Number(w);
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    return { kind: "op", op: w };
  }
}

// An indirect object at `offset` (7.3.10): `N G obj`, its value, and its stream data's extent when it has one.
function objectAt(file: PdfFile, offset: number, expect?: number): { num: number; gen: number; value: PdfObject } {
  const s = file.text;
  const head = /^[\0\t\n\f\r ]*(\d{1,10})[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/.exec(
    s.slice(offset, offset + 40),
  );
  if (!head) throw new PdfSyntax("no object at the offset");
  const num = Number(head[1]);
  if (expect !== undefined && num !== expect) throw new PdfSyntax("the offset names another object");
  // The object is read only up to its own `endobj`, so a string or dictionary left open cannot run into the objects
  // after it: every object is read in time linear in its own length, and the file in time linear in its size.
  // An `endobj` inside a string or a comment is not the object's end: the read is tried up to each of the next
  // MAX_ENDOBJ_TRIES `endobj`s in turn, so a valid object still reads and a hostile one costs a bounded multiple.
  const start = offset + head[0].length;
  let end = start;
  for (let tries = 0; ; tries++) {
    const endobj = nextOf(file, "endobj", end);
    const lex = new Lexer(s, file.budget, start, endobj < 0 ? s.length : endobj);
    try {
      const v = lex.next();
      let value: PdfObject = v === undefined || isOp(v) ? null : v;
      if (isDict(value)) {
        lex.skipSpace();
        if (s.startsWith("stream", lex.pos)) value = streamAt(file, value, lex.pos + 6);
      }
      if (isStream(value)) value.owner = { num, gen: Number(head[2]) };
      return { num, gen: Number(head[2]), value };
    } catch (error) {
      if (!(error instanceof PdfSyntax) || endobj < 0 || tries + 1 >= MAX_ENDOBJ_TRIES) throw error;
      end = endobj + 6;
    }
  }
}

// A stream's data runs from the line after `stream` for `/Length` bytes when `endstream` follows them (a direct
// length, or a reference already read), else to the next `endstream` (7.3.8.1).
function streamAt(file: PdfFile, dict: PdfDict, after: number): PdfStream {
  const s = file.text;
  let start = after;
  if (s[start] === "\r") start++;
  if (s[start] === "\n") start++;
  const length = lengthOf(file, dict.entries.get("Length"));
  if (typeof length === "number" && Number.isInteger(length) && length >= 0 && start + length <= s.length) {
    if (/^[\r\n\0\t\f ]*endstream/.test(s.slice(start + length, start + length + 24)))
      return { kind: "stream", dict, start, end: start + length };
  }
  let end = nextOf(file, "endstream", start);
  if (end < 0) throw new PdfSyntax("unterminated stream");
  if (s[end - 1] === "\n") end--;
  if (s[end - 1] === "\r") end--;
  return { kind: "stream", dict, start, end: Math.max(start, end) };
}

// Every position of `endstream` and of `endobj` in the file, found once: a stream without a usable /Length ends at the
// next `endstream`, and an object is read up to the next `endobj`, each found by binary search, so many such objects
// cost one pass over the file rather than one each.
const positions = new WeakMap<PdfFile, Map<string, number[]>>();
// A trailer is read up to the `startxref` after it, never into the rest of the file.
function untilStartxref(file: PdfFile, from: number): number {
  const at = nextOf(file, "startxref", from);
  return at < 0 ? file.text.length : at;
}

function nextOf(file: PdfFile, word: "endstream" | "endobj" | "startxref", from: number): number {
  const byWord = positions.get(file) ?? new Map<string, number[]>();
  positions.set(file, byWord);
  let list = byWord.get(word);
  if (!list) {
    list = [];
    for (let i = file.text.indexOf(word); i >= 0; i = file.text.indexOf(word, i + word.length)) list.push(i);
    byWord.set(word, list);
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as number) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? (list[lo] as number) : -1;
}

export type Entry =
  | { type: "free" }
  | { type: "offset"; offset: number; gen: number }
  | { type: "packed"; stream: number; index: number };

// Reads the file. Never throws on malformed input: what it cannot read is a named reason in `unread`.
export async function readPdf(bytes: Uint8Array, budget: Budget = newBudget()): Promise<PdfFile> {
  const file: PdfFile = {
    text: "",
    bytes,
    objects: new Map(),
    generations: new Map(),
    sections: [],
    trailer: null,
    scanned: false,
    encrypted: false,
    decrypted: false,
    crypt: null,
    linearized: null,
    unread: [],
    budget,
  };
  if (bytes.length > MAX_PDF_BYTES) {
    note(file, `the file is larger than ${MAX_PDF_BYTES / 1024 / 1024} MiB`);
    return file;
  }
  file.text = byteString(bytes);
  if (!file.text.slice(0, 1024).includes("%PDF-")) {
    note(file, "the file has no PDF header");
    return file;
  }
  try {
    const entries = await readChain(file);
    // The handler is opened before the objects load, so an object stream's container is decrypted when it is read; a
    // scan opens it once it has found the trailer (scanObjects), never before (round 1).
    if (entries) {
      await openEncryption(file, entries);
      await loadObjects(file, entries);
    } else await scanObjects(file);
    file.linearized = linearization(file);
  } catch (error) {
    if (error instanceof OverBudget) note(file, `the file needs more work to read than allowed (${error.message})`);
    else throw error;
  }
  return file;
}

// The cross-reference chain, newest section first, with each object number's entry from the newest section that names
// it; null when the chain is damaged (no `startxref`, an offset that holds no section, a loop).
// The encryption dictionary (7.6.1), if any, opened with the empty user password (D06 T02 §5): RC4 revisions 2 and 3 of
// the standard security handler. A file that needs a password, or uses a handler or revision not read here, stays
// `encrypted`, its reason named; one that opens is `decrypted`, its key kept for the objects and streams read after.
async function openEncryption(file: PdfFile, entries: Map<number, Entry> | null): Promise<void> {
  const ref = file.trailer?.entries.get("Encrypt");
  if (ref === undefined) return;
  file.encrypted = true;
  let dict: PdfDict | null = null;
  let skip: number | null = null;
  if (isRef(ref)) {
    skip = ref.num;
    const e = entries?.get(ref.num);
    try {
      if (e?.type === "offset") {
        const v = objectAt(file, e.offset, ref.num).value;
        dict = isDict(v) ? v : null;
      } else if (!entries) {
        // A scan has read the dictionary as found; its strings are never encrypted (7.6.1).
        const v = file.objects.get(ref.num);
        dict = isDict(v) ? v : null;
      }
    } catch (error) {
      if (error instanceof OverBudget) throw error;
    }
  } else if (isDict(ref)) dict = ref;
  const shut = (reason: string) =>
    note(file, `the file is encrypted, so its text and metadata were not read (${reason})`);
  if (!dict) return shut("its encryption dictionary could not be read");
  const num = (k: string) => {
    const v = dict?.entries.get(k);
    return typeof v === "number" ? v : null;
  };
  const v = num("V") ?? 0;
  const r = num("R");
  if (!isName(dict.entries.get("Filter"), "Standard")) return shut("a security handler other than the standard one");
  if (v >= 4 || (r !== null && r >= 4)) return shut("AES encryption, which is not read yet");
  if ((v !== 1 && v !== 2) || (r !== 2 && r !== 3)) return shut("an unsupported encryption version");
  const o = dict.entries.get("O");
  const u = dict.entries.get("U");
  const p = num("P");
  const ids = file.trailer?.entries.get("ID");
  const id = Array.isArray(ids) && isString(ids[0]) ? ids[0].bytes : "";
  const lengthBits = num("Length") ?? 40;
  if (!isString(o) || !isString(u) || p === null || o.bytes.length !== 32 || u.bytes.length !== 32)
    return shut("its encryption dictionary is malformed");
  if (lengthBits < 40 || lengthBits > 128 || lengthBits % 8 !== 0)
    return shut("its encryption dictionary is malformed");
  const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const key = await fileKey({
    revision: r,
    keyLength: lengthBits / 8,
    owner: bytes(o.bytes),
    user: bytes(u.bytes),
    permissions: p,
    id: bytes(id),
  });
  if (!key) return shut("it needs a password to open");
  file.crypt = { key, skip };
  file.encrypted = false;
  file.decrypted = true;
}

// An encrypted file's value with its strings decrypted under its object's key (7.6.2); the encryption dictionary itself
// is left as it is. A stream keeps its data as read: `streamData` decrypts it.
async function decryptValue(file: PdfFile, value: PdfObject, num: number, gen: number): Promise<PdfObject> {
  if (!file.crypt || num === file.crypt.skip) return value;
  const key = await objectKey(file.crypt.key, num, gen);
  const walk = (v: PdfObject, depth: number): PdfObject => {
    if (depth > MAX_DEPTH) return v;
    if (isString(v))
      return {
        kind: "string",
        bytes: byteString(
          rc4(
            key,
            Uint8Array.from(v.bytes, (c) => c.charCodeAt(0) & 0xff),
          ),
        ),
      };
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1) as PdfValue);
    if (isStream(v)) return { ...v, dict: walk(v.dict, depth + 1) as PdfDict };
    if (isDict(v))
      return { kind: "dict", entries: new Map([...v.entries].map(([k, x]) => [k, walk(x, depth + 1) as PdfValue])) };
    return v;
  };
  return walk(value, 0);
}

async function readChain(file: PdfFile): Promise<Map<number, Entry> | null> {
  const s = file.text;
  const last = s.lastIndexOf("startxref");
  const m = last < 0 ? null : /^startxref[\0\t\n\f\r ]+(\d{1,10})/.exec(s.slice(last, last + 32));
  if (!m) {
    note(file, "the file has no cross-reference start, so its objects were found by scanning");
    return null;
  }
  const entries = new Map<number, Entry>();
  const seen = new Set<number>();
  let offset: number | null = Number(m[1]);
  while (offset !== null) {
    if (seen.has(offset) || seen.size >= MAX_SECTIONS) {
      note(file, "the cross-reference chain loops or is too long, so its objects were found by scanning");
      return null;
    }
    seen.add(offset);
    const section = await readSection(file, offset);
    if (!section) {
      note(file, "a cross-reference section is damaged, so the file's objects were found by scanning");
      return null;
    }
    const defines: number[] = [];
    for (const [num, entry] of section.entries) {
      if (entry.type !== "free") defines.push(num);
      if (!entries.has(num)) entries.set(num, entry);
    }
    file.sections.push({ offset, kind: section.kind, defines, entries: section.entries, trailer: section.trailer });
    file.trailer ??= section.trailer;
    const prev = section.trailer.entries.get("Prev");
    offset = typeof prev === "number" && Number.isInteger(prev) && prev >= 0 ? prev : null;
  }
  return entries;
}

async function readSection(
  file: PdfFile,
  offset: number,
  hybridOf: number | null = null,
): Promise<{ kind: "table" | "stream"; entries: Map<number, Entry>; trailer: PdfDict } | null> {
  const s = file.text;
  if (offset >= s.length) return null;
  const at = offset + (/^[\0\t\n\f\r ]*/.exec(s.slice(offset, offset + 16))?.[0].length ?? 0);
  try {
    if (s.startsWith("xref", at)) {
      if (hybridOf !== null) return null;
      const entries = new Map<number, Entry>();
      let pos = at + 4;
      for (;;) {
        const sub = /^[\0\t\n\f\r ]*(\d{1,10})[ ]+(\d{1,10})[ \t]*\r?\n?/.exec(s.slice(pos, pos + 32));
        if (!sub) break;
        const first = Number(sub[1]);
        const count = Number(sub[2]);
        pos += sub[0].length;
        if (count > MAX_OBJECTS) return null;
        for (let i = 0; i < count; i++) {
          const row = /^[\0\t\n\f\r ]*(\d{10})[ ](\d{5})[ ]([nf])/.exec(s.slice(pos, pos + 24));
          if (!row) return null;
          pos += row[0].length;
          countEntry(file);
          if (!entries.has(first + i))
            entries.set(
              first + i,
              row[3] === "f" ? { type: "free" } : { type: "offset", offset: Number(row[1]), gen: Number(row[2]) },
            );
        }
      }
      const t = s.indexOf("trailer", pos);
      if (t < 0 || t > pos + 64) return null;
      const trailer = new Lexer(s, file.budget, t + 7, untilStartxref(file, t)).next();
      if (!isDict(trailer)) return null;
      // A hybrid file's cross-reference stream (7.5.8.4) adds the packed objects the table does not name.
      // Followed once: the stream it names is a stream, never another table with its own /XRefStm.
      const hybrid = trailer.entries.get("XRefStm");
      if (typeof hybrid === "number" && hybridOf === null) {
        const extra = await readSection(file, hybrid, offset);
        // The stream names the objects a table written for older readers leaves out or marks free (7.5.8.4): its entry
        // replaces a free or missing table entry, and an in-use table entry stands.
        if (extra) for (const [num, e] of extra.entries) if (entries.get(num)?.type !== "offset") entries.set(num, e);
      }
      return { kind: "table", entries, trailer };
    }
    const obj = objectAt(file, at);
    if (!isStream(obj.value) || !isName(obj.value.dict.entries.get("Type"), "XRef")) return null;
    return { kind: "stream", entries: await xrefStreamEntries(file, obj.value), trailer: obj.value.dict };
  } catch (error) {
    if (error instanceof OverBudget) throw error;
    return null;
  }
}

async function xrefStreamEntries(file: PdfFile, stream: PdfStream): Promise<Map<number, Entry>> {
  const data = await streamData(file, stream);
  if (!data) throw new PdfSyntax("unreadable cross-reference stream");
  const d = stream.dict.entries;
  const w = d.get("W");
  if (!Array.isArray(w) || w.length !== 3 || !w.every((n) => typeof n === "number" && n >= 0 && n <= 8))
    throw new PdfSyntax("bad /W");
  const [w0, w1, w2] = w as [number, number, number];
  const size = d.get("Size");
  const index = d.get("Index");
  const ranges: number[] =
    Array.isArray(index) && index.every((n) => typeof n === "number") ? (index as number[]) : [0, Number(size) || 0];
  const row = w0 + w1 + w2;
  if (row === 0) throw new PdfSyntax("a cross-reference stream's rows are empty");
  const entries = new Map<number, Entry>();
  const field = (at: number, width: number) => {
    let v = 0;
    for (let i = 0; i < width; i++) v = v * 256 + (data[at + i] ?? 0);
    return v;
  };
  let at = 0;
  for (let r = 0; r + 1 < ranges.length; r += 2) {
    const first = ranges[r] as number;
    const count = ranges[r + 1] as number;
    if (count > MAX_OBJECTS) throw new PdfSyntax("too many entries");
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0)
      throw new PdfSyntax("a cross-reference stream's index is not a range of object numbers");
    for (let i = 0; i < count && at + row <= data.length; i++, at += row) {
      countEntry(file);
      const type = w0 === 0 ? 1 : field(at, w0);
      const a = field(at + w0, w1);
      const b = field(at + w0 + w1, w2);
      if (entries.has(first + i)) continue;
      if (type === 0) entries.set(first + i, { type: "free" });
      else if (type === 1) entries.set(first + i, { type: "offset", offset: a, gen: b });
      else if (type === 2) entries.set(first + i, { type: "packed", stream: a, index: b });
    }
  }
  return entries;
}

async function loadObjects(file: PdfFile, entries: Map<number, Entry>): Promise<void> {
  let failed = 0;
  pending.set(file, entries);
  if (entries.size > MAX_OBJECTS) note(file, `objects after the first ${MAX_OBJECTS} were not read`);
  let count = 0;
  for (const [num, e] of entries) {
    if (e.type !== "offset" || file.objects.has(num)) continue;
    if (++count > MAX_OBJECTS) break;
    if (directObject(file, num, e.offset) === undefined) failed++;
  }
  pending.delete(file);
  // An encrypted file not opened: the objects packed in its object streams are ciphertext, named as unread already.
  if (file.encrypted) {
    if (failed) note(file, `${failed} object${failed === 1 ? "" : "s"} could not be read`);
    return;
  }
  // An encrypted file's directly read objects have their strings decrypted; objects packed in an object stream come
  // from the decrypted container and are not decrypted again.
  if (file.crypt)
    for (const [num, e] of entries) {
      const value = file.objects.get(num);
      if (e.type === "offset" && value !== undefined)
        file.objects.set(num, await decryptValue(file, value, num, e.gen));
    }
  const streams = new Map<number, Packed | null>();
  for (const [num, e] of entries) {
    if (e.type !== "packed" || file.objects.has(num)) continue;
    if (!streams.has(e.stream)) {
      if (streams.size >= MAX_OBJECT_STREAMS) {
        note(file, `objects in more than ${MAX_OBJECT_STREAMS} object streams were not read`);
        break;
      }
      const container = file.objects.get(e.stream);
      streams.set(e.stream, isStream(container) ? await objectStream(file, container) : null);
    }
    const value = packedObject(file, streams.get(e.stream) ?? null, e.index, num);
    if (value === undefined) failed++;
    else file.objects.set(num, value);
  }
  if (failed) note(file, `${failed} object${failed === 1 ? "" : "s"} could not be read`);
}

// The entries still being loaded, so a stream's /Length that refers to a later object is read when first needed.
const pending = new WeakMap<PdfFile, Map<number, Entry>>();
const loading = new WeakMap<PdfFile, Set<number>>();
function directObject(file: PdfFile, num: number, offset: number): PdfObject | undefined {
  const busy = loading.get(file) ?? new Set<number>();
  loading.set(file, busy);
  if (busy.has(num)) return undefined;
  busy.add(num);
  try {
    const obj = objectAt(file, offset, num);
    file.objects.set(num, obj.value);
    file.generations.set(num, obj.gen);
    return obj.value;
  } catch (error) {
    if (error instanceof OverBudget) throw error;
    return undefined;
  } finally {
    busy.delete(num);
  }
}
function lengthOf(file: PdfFile, declared: PdfValue | undefined): PdfValue | undefined {
  if (!isRef(declared)) return declared;
  if (file.objects.has(declared.num)) return file.objects.get(declared.num) as PdfValue;
  const e = pending.get(file)?.get(declared.num);
  const v = e?.type === "offset" ? directObject(file, declared.num, e.offset) : undefined;
  return isStream(v) ? undefined : v;
}

// An object stream's objects (7.5.7): its header read once into numbers and offsets, each object read only up to the
// next one's offset, so a stream of many objects is read in time linear in its length.
type Packed = { text: string; first: number; nums: number[]; offsets: number[]; ends: number[] };
async function objectStream(file: PdfFile, stream: PdfStream): Promise<Packed | null> {
  if (!isName(stream.dict.entries.get("Type"), "ObjStm")) return null;
  const n = stream.dict.entries.get("N");
  const first = stream.dict.entries.get("First");
  if (typeof n !== "number" || typeof first !== "number" || n < 0 || first < 0) return null;
  const data = await streamData(file, stream);
  if (!data) return null;
  const text = byteString(data);
  if (first > text.length) return null;
  const header = new Lexer(text, file.budget, 0, first);
  const nums: number[] = [];
  const offsets: number[] = [];
  try {
    for (let i = 0; i < n && i < MAX_OBJECTS; i++) {
      const num = header.next(true);
      const off = header.next(true);
      if (typeof num !== "number" || typeof off !== "number" || off < 0) break;
      nums.push(num);
      offsets.push(off);
    }
  } catch (error) {
    if (error instanceof OverBudget) throw error;
    note(file, "an object stream's header is damaged");
    return null;
  }
  // Each object ends where the next offset in the stream begins (offsets sorted once).
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const next = new Map(
    sorted.map((o, i) => [o, i + 1 < sorted.length ? first + (sorted[i + 1] as number) : text.length]),
  );
  const ends = offsets.map((o) => Math.min(next.get(o) ?? text.length, text.length));
  return { text, first, nums, offsets, ends };
}

function packedObject(file: PdfFile, packed: Packed | null, index: number, num: number): PdfObject | undefined {
  if (!packed || packed.nums[index] !== num) return undefined;
  const start = packed.first + (packed.offsets[index] as number);
  const end = packed.ends[index] as number;
  if (start > end) return undefined;
  try {
    const v = new Lexer(packed.text, file.budget, start, end).next();
    return v === undefined || isOp(v) ? null : v;
  } catch (error) {
    if (error instanceof OverBudget) throw error;
    return undefined;
  }
}

// The fallback for a damaged chain: every `N G obj` in file order, the last definition winning, skipping stream data
// so bytes inside a stream are never read as objects; then the packed objects of every object stream found.
const OBJ = /(\d{1,10})[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/g;
async function scanObjects(file: PdfFile): Promise<void> {
  file.scanned = true;
  const s = file.text;
  const re = new RegExp(OBJ.source, "g");
  let failed = 0;
  let resume = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index < resume) continue;
    if (file.objects.size >= MAX_OBJECTS) {
      note(file, `objects after the first ${MAX_OBJECTS} were not read`);
      break;
    }
    try {
      const obj = objectAt(file, m.index);
      file.objects.set(obj.num, obj.value);
      file.generations.set(obj.num, obj.gen);
      if (isStream(obj.value)) {
        resume = obj.value.end;
        re.lastIndex = Math.max(re.lastIndex, resume);
        if (isName(obj.value.dict.entries.get("Type"), "XRef")) file.trailer = obj.value.dict;
      }
    } catch (error) {
      if (error instanceof OverBudget) throw error;
      failed++;
    }
  }
  for (const m of s.matchAll(/trailer[\0\t\n\f\r ]*<</g)) {
    try {
      const t = new Lexer(s, file.budget, m.index + 7, untilStartxref(file, m.index)).next();
      if (isDict(t)) file.trailer = t;
    } catch (error) {
      if (error instanceof OverBudget) throw error;
    }
  }
  // The trailer is known now, so an encrypted file is opened (or named as unread) before any object stream is unpacked;
  // directly read objects have their strings decrypted, packed ones come from the decrypted container (round 1).
  await openEncryption(file, null);
  if (file.encrypted) {
    if (failed) note(file, `${failed} object${failed === 1 ? "" : "s"} could not be read`);
    return;
  }
  if (file.crypt)
    for (const [num, value] of [...file.objects])
      file.objects.set(num, await decryptValue(file, value, num, file.generations.get(num) ?? 0));
  let streams = 0;
  for (const [, value] of [...file.objects]) {
    if (!isStream(value) || !isName(value.dict.entries.get("Type"), "ObjStm")) continue;
    if (++streams > MAX_OBJECT_STREAMS) break;
    const packed = await objectStream(file, value);
    if (!packed) continue;
    packed.nums.forEach((num, i) => {
      if (file.objects.has(num) || file.objects.size >= MAX_OBJECTS) return;
      const v = packedObject(file, packed, i, num);
      if (v !== undefined) file.objects.set(num, v);
    });
  }
  if (failed) note(file, `${failed} object${failed === 1 ? "" : "s"} could not be read`);
}

// A linearization dictionary (Annex F) is the first object of the file; its /L is the file's length when written and
// /E the end of the first page.
function linearization(file: PdfFile): PdfFile["linearized"] {
  const first = /%PDF-[^\n\r]*[\r\n]+(?:%[^\n\r]*[\r\n]+)*/.exec(file.text.slice(0, 2048));
  if (!first) return null;
  try {
    const obj = objectAt(file, first[0].length);
    if (!isDict(obj.value) || !obj.value.entries.has("Linearized")) return null;
    const l = obj.value.entries.get("L");
    const e = obj.value.entries.get("E");
    return { length: typeof l === "number" ? l : -1, firstPageEnd: typeof e === "number" ? e : -1 };
  } catch (error) {
    if (error instanceof OverBudget) throw error;
    return null;
  }
}

// The object a value refers to, followed through references a bounded number of steps.
export function resolve(file: PdfFile, value: PdfObject | undefined): PdfObject | undefined {
  let v = value;
  for (let i = 0; i < 8 && isRef(v); i++) {
    const gen = file.generations.get(v.num) ?? 0;
    if (v.gen !== gen) {
      note(file, "a reference names an object of another generation, which was not followed");
      return undefined;
    }
    v = file.objects.get(v.num);
  }
  return isRef(v) ? undefined : v;
}

export function dictOf(file: PdfFile, value: PdfObject | undefined): PdfDict | null {
  const v = resolve(file, value);
  if (isDict(v)) return v;
  if (isStream(v)) return v.dict;
  return null;
}

// A stream's decoded data, or null with the reason in `unread`: decrypted first when the file was opened with the
// empty user password (D06 T02 §5), then each filter of its chain in turn (7.4: FlateDecode, LZWDecode, ASCII85Decode,
// ASCIIHexDecode, RunLengthDecode), a PNG or TIFF predictor undone where a stage's parameters ask. Every stage's output
// is charged to the shared budget as it is written, so neither one stage nor a chain can decode past it. A filter not
// read here is named as unread, never guessed at.
export async function streamData(file: PdfFile, stream: PdfStream): Promise<Uint8Array | null> {
  let data = file.bytes.subarray(stream.start, stream.end);
  // 7.6.2: a cross-reference stream is never encrypted.
  const sealed = !isName(stream.dict.entries.get("Type"), "XRef") && !plainXmp(stream, data);
  // An encrypted file not opened: its streams are ciphertext, already named in `unread` as the reason, never decoded
  // as if they were data (which would add "damaged" reasons that are not the cause).
  if (file.encrypted && sealed) return null;
  if (file.crypt && stream.owner && sealed)
    data = rc4(await objectKey(file.crypt.key, stream.owner.num, stream.owner.gen), data);
  const filter = resolve(file, stream.dict.entries.get("Filter") ?? stream.dict.entries.get("F"));
  const filters = filter === undefined || filter === null ? [] : Array.isArray(filter) ? filter : [filter];
  if (filters.length === 0) return data;
  if (filters.length > MAX_FILTERS) {
    note(file, `a stream names more than ${MAX_FILTERS} filters`);
    return null;
  }
  const parmsValue = resolve(file, stream.dict.entries.get("DecodeParms") ?? stream.dict.entries.get("DP"));
  const parmsAt = (i: number) =>
    Array.isArray(parmsValue)
      ? dictOf(file, parmsValue[i])
      : i === filters.length - 1
        ? dictOf(file, parmsValue)
        : null;
  const FLATE = new Set(["FlateDecode", "Fl"]);
  const LZW = new Set(["LZWDecode", "LZW"]);
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const name = isName(f) ? f.name : "unnamed";
    const limit = Math.min(MAX_STREAM_DECODED, MAX_TOTAL_DECODED - file.budget.decoded);
    if (limit <= 0) {
      note(file, `stream data past ${MAX_TOTAL_DECODED / 1024 / 1024} MiB was not read`);
      return null;
    }
    const parms = parmsAt(i);
    let out: Decoded;
    if (FLATE.has(name)) {
      // Flate keeps what decoded before a damaged tail (inflate), so only an empty result is damaged; a bomb stops at
      // the limit, which is what it cost.
      const inflated = await inflate(data, limit);
      out =
        inflated === "too-large"
          ? { ok: false, reason: "too-large", written: limit }
          : inflated === null
            ? { ok: false, reason: "damaged", written: 0 }
            : { ok: true, data: inflated, ended: true };
    } else if (LZW.has(name)) out = lzwDecode(data, limit, parms?.entries.get("EarlyChange") === 0 ? 0 : 1);
    else if (name === "ASCII85Decode" || name === "A85") out = ascii85Decode(data, limit);
    else if (name === "ASCIIHexDecode" || name === "AHx") out = asciiHexDecode(data, limit);
    else if (name === "RunLengthDecode" || name === "RL") out = runLengthDecode(data, limit);
    else {
      note(file, `a stream uses a filter that is not read (${name.slice(0, 60)})`);
      return null;
    }
    // What a stage wrote is charged however it ended, so data that fails late still costs its expansion (completion
    // review: seven damaged RunLength streams had expanded 52.5 MiB uncharged).
    file.budget.decoded += out.ok ? out.data.length : out.written;
    if (!out.ok) {
      note(
        file,
        out.reason === "too-large"
          ? `a stream decodes to more than ${limit === MAX_STREAM_DECODED ? "8 MiB" : "the space left"}`
          : `a compressed stream is damaged (${name.slice(0, 40)})`,
      );
      return null;
    }
    // Data that stops without its filter's end-of-data marker is read, and named, since it may have been cut short.
    if (!out.ended)
      note(file, `a ${name.slice(0, 40)} stream ends without its end-of-data marker, so it may be cut short`);
    data = out.data;
    // A predictor belongs to the Flate or LZW stage whose parameters name it (7.4.4.4).
    const predictor = parms?.entries.get("Predictor");
    if (typeof predictor === "number" && predictor > 1 && (FLATE.has(name) || LZW.has(name))) {
      const columns = parms?.entries.get("Columns");
      const colors = parms?.entries.get("Colors");
      const bpc = parms?.entries.get("BitsPerComponent");
      const c = typeof columns === "number" ? columns : 1;
      const k = typeof colors === "number" ? colors : 1;
      const b = typeof bpc === "number" ? bpc : 8;
      const undone =
        predictor >= 10
          ? unpredict(data, Math.ceil((c * k * b) / 8), Math.max(1, Math.ceil((k * b) / 8)))
          : predictor === 2
            ? untiff(data, c, k, b)
            : null;
      if (!undone) {
        note(file, predictor >= 10 ? "a stream's PNG prediction is damaged" : "a stream's TIFF prediction is not read");
        return null;
      }
      data = undone;
    }
  }
  return data;
}

// WORKAROUND: Ghostscript's pdfwrite (10.06) stores the XMP metadata stream of an RC4 file unencrypted, although 7.6.1
// encrypts every stream below revision 4 (/EncryptMetadata exists only from V 4). An unfiltered metadata stream whose
// stored bytes already begin with an XMP packet is read as stored; RC4 output that happens to begin so is beyond chance.
function plainXmp(stream: PdfStream, data: Uint8Array): boolean {
  if (!isName(stream.dict.entries.get("Type"), "Metadata") || stream.dict.entries.has("Filter")) return false;
  return /^(\xef\xbb\xbf)?\s*(<\?xpacket|<x:xmpmeta)/.test(byteString(data.subarray(0, 64)));
}

// PNG prediction (RFC 2083 section 6): each row starts with its filter type.
// `rowBytes` is a row's width in bytes, ceil(Columns x Colors x BitsPerComponent / 8), and `bpp` the bytes of one pixel,
// at least 1, so sub-byte samples get the row width the standard gives them (7.4.4.4, round 1).
export function unpredict(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array | null {
  const width = rowBytes;
  if (width <= 0 || width > 1 << 20) return null;
  const rows = Math.floor(data.length / (width + 1));
  const out = new Uint8Array(rows * width);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (width + 1)];
    const src = r * (width + 1) + 1;
    const dst = r * width;
    for (let i = 0; i < width; i++) {
      const raw = data[src + i] as number;
      const left = i >= bpp ? (out[dst + i - bpp] as number) : 0;
      const up = r > 0 ? (out[dst - width + i] as number) : 0;
      const upLeft = r > 0 && i >= bpp ? (out[dst - width + i - bpp] as number) : 0;
      let v: number;
      if (type === 0) v = raw;
      else if (type === 1) v = raw + left;
      else if (type === 2) v = raw + up;
      else if (type === 3) v = raw + Math.floor((left + up) / 2);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else return null;
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

// zlib inflate (RFC 1950 and 1951) through the platform's DecompressionStream, stopped at `limit` bytes so a
// decompression bomb costs at most that much.
export async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null | "too-large"> {
  const reader = bytesStream(data).pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    // Many generators leave a damaged tail; what decoded before it is kept when there is any.
    if (total === 0) return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// A text string (7.9.2.2): UTF-16BE after its byte order mark, UTF-8 after its mark, else PDFDocEncoding, read here as
// Latin-1 (they agree on the letters, digits and punctuation metadata carries).
export function textOf(v: PdfObject | undefined): string | null {
  if (!isString(v)) return null;
  const b = v.bytes;
  if (b.charCodeAt(0) === 0xfe && b.charCodeAt(1) === 0xff) {
    const out: string[] = [];
    for (let i = 2; i + 1 < b.length; i += 2)
      out.push(String.fromCharCode((b.charCodeAt(i) << 8) | b.charCodeAt(i + 1)));
    return out.join("");
  }
  if (b.startsWith("\xef\xbb\xbf"))
    return new TextDecoder().decode(Uint8Array.from(b.slice(3), (c) => c.charCodeAt(0)));
  return b;
}

// An object as a given cross-reference section and the ones before it define it: `sectionIndex` counts from the newest
// (0) in `file.sections`, so `definitionAt(file, i + 1, n)` is what update `i` replaced. Undefined when no section from
// there back names the object, null when one frees it.
export async function definitionAt(
  file: PdfFile,
  sectionIndex: number,
  num: number,
  depth = 0,
): Promise<PdfObject | undefined | null> {
  for (let i = sectionIndex; i < file.sections.length; i++) {
    const e = (file.sections[i] as XrefSection).entries.get(num);
    if (!e) continue;
    if (e.type === "free") return null;
    try {
      if (e.type === "offset") {
        const read = objectAt(file, e.offset, num);
        return file.crypt ? decryptValue(file, read.value, num, read.gen) : read.value;
      }
      if (depth > 0) return undefined;
      const container = await definitionAt(file, i, e.stream, depth + 1);
      if (!isStream(container)) return undefined;
      return packedObject(file, await objectStream(file, container), e.index, num);
    } catch (error) {
      if (error instanceof OverBudget) throw error;
      return undefined;
    }
  }
  return undefined;
}

// A value written out in one canonical form, its stream data decoded, so two definitions compare equal exactly when
// they say the same thing, however each was compressed or spaced. A stream's /Length and /Filter are its encoding.
export async function canonical(file: PdfFile, v: PdfObject | undefined | null, depth = 0): Promise<string> {
  if (depth > MAX_DEPTH) return "…";
  if (v === undefined) return "undefined";
  if (v === null || typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${(await Promise.all(v.map((x) => canonical(file, x, depth + 1)))).join(" ")}]`;
  if (isName(v)) return `/${v.name}`;
  if (isString(v)) return JSON.stringify(v.bytes);
  if (isRef(v)) return `${v.num} ${v.gen} R`;
  if (isStream(v)) {
    const data = await streamData(file, v);
    const dict = new Map([...v.dict.entries].filter(([k]) => !["Length", "Filter", "DecodeParms"].includes(k)));
    return `${await canonical(file, { kind: "dict", entries: dict }, depth + 1)} stream ${data ? byteString(data) : "unreadable"}`;
  }
  const keys = [...v.entries.keys()].sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(`/${k} ${await canonical(file, v.entries.get(k), depth + 1)}`);
  return `<<${parts.join(" ")}>>`;
}

// One chunk of bytes as a stream, for a (de)compression stream to read (a Blob of a Uint8Array view does not type-check
// under Node's lib, which the fixture maker uses).
// The bytes are always over an ArrayBuffer here (read from a file or decoded), which the cast states.
function bytesStream(data: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
}
