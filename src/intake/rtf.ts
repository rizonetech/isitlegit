// Compressed RTF bodies (D01 T01 §13; [MS-OXRTFCP] decompression, [MS-OXRTFEX] de-encapsulation): an Outlook
// message whose only body is `PidTagRtfCompressed`. Decompression is bounded before it allocates and as it
// writes, and a stream that lies about its size, fails its CRC or ends early is refused, never partly read.
// Extraction is deterministic: destinations that carry no body (fonts, colours, pictures) are skipped, and the
// text keeps its line breaks, tabs and Unicode.
import { ParseError } from "./mime";

const HEADER = 16;
const TYPE_COMPRESSED = 0x75465a4c; // "LZFu"
const TYPE_UNCOMPRESSED = 0x414c454d; // "MELA"
const DICTIONARY_SIZE = 4096;

// The dictionary's initial contents ([MS-OXRTFCP] 2.1.2.1), 207 bytes: back-references may reach into it, so a
// walk of the token stream alone never has to guess what precedes the first literal.
export const INITIAL_DICTIONARY =
  "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript " +
  "\\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n" +
  "\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// The stream's CRC ([MS-OXRTFCP] 2.1.2.3): the table above over the compressed bytes, seeded with zero.
export function rtfCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return crc >>> 0;
}

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] as number) |
    ((bytes[at + 1] as number) << 8) |
    ((bytes[at + 2] as number) << 16) |
    ((bytes[at + 3] as number) << 24)) >>>
  0;

// Decompress a `PidTagRtfCompressed` stream to the RTF bytes, refusing anything past `maxOutput` (the body
// limit the caller enforces): the declared size is checked before allocating, the output before every write,
// and the finished size against the declaration.
export function decompressRtf(input: Uint8Array, maxOutput: number): Uint8Array {
  if (input.length < HEADER) throw new ParseError("the compressed RTF stream is cut off in its header");
  const compSize = u32(input, 0);
  const rawSize = u32(input, 4);
  const type = u32(input, 8);
  const crc = u32(input, 12);
  if (rawSize > maxOutput) throw new ParseError("the compressed RTF claims a body past the limit, so it is not read");
  if (type === TYPE_UNCOMPRESSED) {
    if (compSize - 12 !== rawSize || input.length < HEADER + rawSize)
      throw new ParseError("the uncompressed RTF stream does not hold the body it declares");
    return input.slice(HEADER, HEADER + rawSize);
  }
  if (type !== TYPE_COMPRESSED) throw new ParseError("the RTF stream's compression type is not one Outlook writes");
  if (input.length < HEADER + Math.max(0, compSize - 12)) throw new ParseError("the compressed RTF stream is cut off");
  const payload = input.subarray(HEADER, HEADER + Math.max(0, compSize - 12));
  if (rtfCrc(payload) !== crc) throw new ParseError("the compressed RTF stream fails its checksum");
  const dictionary = new Uint8Array(DICTIONARY_SIZE);
  const initial = new TextEncoder().encode(INITIAL_DICTIONARY);
  dictionary.set(initial);
  let write = initial.length;
  const out: number[] = [];
  const emit = (byte: number) => {
    if (out.length >= rawSize) throw new ParseError("the compressed RTF writes past its declared size");
    out.push(byte);
    dictionary[write] = byte;
    write = (write + 1) % DICTIONARY_SIZE;
  };
  let at = 0;
  let ended = false;
  while (at < payload.length && !ended) {
    const flags = payload[at++] as number;
    for (let bit = 0; bit < 8 && at <= payload.length; bit++) {
      if (flags & (1 << bit)) {
        if (at + 1 >= payload.length) throw new ParseError("the compressed RTF ends inside a reference");
        const first = payload[at] as number;
        const second = payload[at + 1] as number;
        at += 2;
        const offset = ((first << 4) | (second >> 4)) & (DICTIONARY_SIZE - 1);
        if (offset === write) {
          ended = true;
          break;
        }
        const length = (second & 0x0f) + 2;
        for (let n = 0; n < length; n++) emit(dictionary[(offset + n) % DICTIONARY_SIZE] as number);
      } else {
        if (at >= payload.length) throw new ParseError("the compressed RTF ends inside a literal");
        emit(payload[at++] as number);
      }
    }
  }
  // The stream ends at its terminator ([MS-OXRTFCP]): a reference to the current write position. A stream
  // that merely runs out of bytes, even at the declared size, never stated it was finished.
  if (!ended) throw new ParseError("the compressed RTF ends without its terminator");
  if (out.length !== rawSize) throw new ParseError("the compressed RTF ends before the body it declares");
  return new Uint8Array(out);
}

// Destinations whose text is not body text ([MS-OXRTFEX]): skipped whole, nested groups included. The font
// table is read for its charsets before it is skipped, so its entry text never reaches the body either.
const SKIP_DESTINATIONS = new Set([
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "footer",
  "headerl",
  "headerr",
  "headerf",
  "footerl",
  "footerr",
  "footerf",
  "footnote",
  "annotation",
  "xmlnstbl",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
  "datafield",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "wgrffmtfilter",
]);

const FONT_CHARSETS: Record<number, string> = {
  0: "windows-1252",
  1: "windows-1252",
  128: "shift_jis",
  129: "windows-949",
  134: "gbk",
  136: "big5",
  161: "windows-1253",
  162: "windows-1254",
  163: "windows-1258",
  177: "windows-1255",
  178: "windows-1256",
  186: "windows-1257",
  204: "windows-1251",
  222: "windows-874",
  238: "windows-1250",
};

type Frame = {
  skipped: boolean;
  suppressed: boolean;
  fontTable: boolean;
  // The group-scoped reading state: a \uc, \f or \ansicpg inside a group ends with it.
  fallback: number;
  font: number | null;
  label: string;
};

const isLetter = (b: number) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122);

// One pass over the RTF bytes, calling `text` for each body byte run (decoded later, in its font's code page)
// and `unicode` for each \u code point, so a caller builds plain text or encapsulated HTML from the same walk.
function walkRtf(
  rtf: Uint8Array,
  ansiLabel: string,
  sink: { text: (bytes: Uint8Array, label: string) => void; unicode: (cp: number) => void; html: boolean },
): { fromHtml: boolean } {
  let fromHtml = false;
  const fonts = new Map<number, string>();
  const base: Frame = {
    skipped: false,
    suppressed: false,
    fontTable: false,
    fallback: 1,
    font: null,
    label: ansiLabel,
  };
  const stack: Frame[] = [base];
  const frame = () => stack[stack.length - 1] as Frame;
  const active = () => !frame().skipped && !frame().suppressed;
  let run: number[] = [];
  const flush = () => {
    if (run.length && active()) sink.text(new Uint8Array(run), fonts.get(frame().font ?? -1) ?? frame().label);
    run = [];
  };
  let i = 0;
  while (i < rtf.length) {
    const b = rtf[i] as number;
    if (b === 0x7b) {
      flush();
      stack.push({ ...frame() });
      i++;
      continue;
    }
    if (b === 0x7d) {
      flush();
      if (stack.length === 1) throw new ParseError("the RTF body closes a group it did not open");
      stack.pop();
      i++;
      continue;
    }
    if (b === 0x0d || b === 0x0a) {
      i++;
      continue;
    }
    if (b !== 0x5c) {
      if (frame().fontTable) {
        i++;
        continue;
      }
      run.push(b);
      i++;
      continue;
    }
    // A control sequence.
    const next = rtf[i + 1];
    if (next === undefined) throw new ParseError("the RTF body ends inside a control sequence");
    if (next === 0x27) {
      // \'xx: one byte in the current code page.
      const hex = new TextDecoder().decode(rtf.subarray(i + 2, i + 4));
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ParseError("the RTF body holds a malformed byte escape");
      if (!frame().fontTable) run.push(parseInt(hex, 16));
      i += 4;
      continue;
    }
    if (!isLetter(next)) {
      flush();
      if (next === 0x5c || next === 0x7b || next === 0x7d) {
        if (active()) sink.text(new Uint8Array([next]), frame().label);
      } else if (next === 0x2a) {
        frame().skipped = true; // \*: the group is a destination the reader does not know.
      } else if (next === 0x7e && active()) {
        sink.text(new TextEncoder().encode("\u00a0"), "utf-8");
      }
      i += 2;
      continue;
    }
    let j = i + 1;
    while (j < rtf.length && isLetter(rtf[j] as number)) j++;
    const word = new TextDecoder().decode(rtf.subarray(i + 1, j));
    let k = j;
    let sign = 1;
    if (rtf[k] === 0x2d) {
      sign = -1;
      k++;
    }
    let digits = "";
    while (k < rtf.length && (rtf[k] as number) >= 48 && (rtf[k] as number) <= 57)
      digits += String.fromCharCode(rtf[k++] as number);
    const arg = digits ? sign * parseInt(digits, 10) : null;
    if (rtf[k] === 0x20) k++;
    flush();
    switch (word) {
      case "fromhtml":
        if (arg === 1) fromHtml = true;
        break;
      case "htmlrtf":
        frame().suppressed = arg !== 0;
        break;
      case "htmltag":
        // Its text is literal HTML: in HTML mode it ends a starred destination's skip; as plain text it is
        // markup, not body text, and stays skipped.
        if (sink.html) frame().skipped = false;
        break;
      case "fonttbl":
        frame().fontTable = true;
        frame().skipped = true;
        break;
      case "fcharset": {
        const current = frame();
        if (current.fontTable && current.font !== null && arg !== null)
          fonts.set(current.font, FONT_CHARSETS[arg] ?? current.label);
        break;
      }
      case "f":
        frame().font = arg;
        break;
      case "deff":
        // The document's default font, which text without a font switch reads in.
        frame().font = arg;
        break;
      case "bin":
        // \binN's payload is raw bytes, never text: consumed whole, so braces or escapes inside it can
        // neither change the group scope nor reach the body.
        if (arg !== null && arg > 0) k += arg;
        break;
      case "ansicpg":
        if (arg !== null)
          frame().label = arg === 932 ? "shift_jis" : arg === 936 ? "gbk" : arg === 950 ? "big5" : `windows-${arg}`;
        break;
      case "uc":
        frame().fallback = arg ?? 1;
        break;
      case "u": {
        if (arg !== null && active() && !frame().fontTable) {
          sink.unicode(arg < 0 ? arg + 65536 : arg);
        }
        // Skip the fallback the writer left for readers without Unicode, one whole RTF token at a time
        // (a \'xx escape, an escaped character, a control word, or one plain character), so a fallback
        // never eats half a token and the stream stays validated as it is skipped.
        let skip = frame().fallback;
        while (skip > 0 && k < rtf.length) {
          // A group delimiter is never fallback: it closes or opens a group, and the fallback simply ends.
          if (rtf[k] === 0x7b || rtf[k] === 0x7d) break;
          if (rtf[k] === 0x5c && rtf[k + 1] === 0x27) {
            const hex = new TextDecoder().decode(rtf.subarray(k + 2, k + 4));
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ParseError("the RTF body holds a malformed byte escape");
            k += 4;
          } else if (rtf[k] === 0x5c && isLetter(rtf[k + 1] as number)) {
            let w = k + 1;
            while (w < rtf.length && isLetter(rtf[w] as number)) w++;
            const name = new TextDecoder().decode(rtf.subarray(k + 1, w));
            k = w;
            let payload = 0;
            if (rtf[k] === 0x2d) k++;
            while (k < rtf.length && (rtf[k] as number) >= 48 && (rtf[k] as number) <= 57) {
              payload = payload * 10 + ((rtf[k] as number) - 48);
              k++;
            }
            if (rtf[k] === 0x20) k++;
            // \binN's payload is part of the same fallback character: consumed, never body text.
            if (name === "bin") k += payload;
          } else if (rtf[k] === 0x5c) {
            k += 2;
          } else {
            k++;
          }
          skip--;
        }
        break;
      }
      case "par":
      case "line":
        if (!sink.html && active()) sink.text(new TextEncoder().encode("\n"), "utf-8");
        break;
      case "tab":
        if (!sink.html && active()) sink.text(new TextEncoder().encode("\t"), "utf-8");
        break;
      default:
        if (SKIP_DESTINATIONS.has(word)) frame().skipped = true;
        break;
    }
    i = k;
  }
  flush();
  if (stack.length !== 1) throw new ParseError("the RTF body's groups do not close");
  return { fromHtml };
}

const decodeIn = (bytes: Uint8Array, label: string, fallbackLabel: string) => {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder(fallbackLabel).decode(bytes);
  }
};

// The plain text of an RTF body: destinations skipped, control words dropped, line breaks and tabs kept,
// \'xx decoded in its font's code page and \u read as the code point it names.
export function rtfToText(rtf: Uint8Array, ansiLabel: string): string {
  let out = "";
  walkRtf(rtf, ansiLabel, {
    html: false,
    text: (bytes, label) => {
      out += decodeIn(bytes, label, ansiLabel);
    },
    unicode: (cp) => {
      out += String.fromCodePoint(cp);
    },
  });
  return out;
}

// The HTML an RTF body encapsulates (\fromhtml1, [MS-OXRTFEX]), or null when it encapsulates none: the shared
// text is the HTML source, \htmlrtf regions and no-body destinations are left out, and \u becomes an entity so
// the bytes stay in the body's own code page.
export function rtfToHtml(rtf: Uint8Array, ansiLabel: string): string | null {
  let out = "";
  const { fromHtml } = walkRtf(rtf, ansiLabel, {
    html: true,
    text: (bytes, label) => {
      out += decodeIn(bytes, label, ansiLabel);
    },
    unicode: (cp) => {
      out += cp < 128 ? String.fromCodePoint(cp) : `&#${cp};`;
    },
  });
  return fromHtml ? out : null;
}
