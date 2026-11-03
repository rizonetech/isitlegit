// Compressed RTF (D01 T01 §13): MS-OXRTFCP decompression bounded before and during the write, MS-OXRTFEX
// extraction with destinations skipped and Unicode kept. The compressed fixture is built here with a greedy
// compressor over the same initial dictionary, so its back-references are real.
import { describe, expect, it } from "vitest";
import { ParseError } from "../../src/intake/mime";
import { decompressRtf, INITIAL_DICTIONARY, rtfCrc, rtfToHtml, rtfToText } from "../../src/intake/rtf";

const LIMIT = 2 * 1024 * 1024;
const enc = (s: string) => new TextEncoder().encode(s);

function header(compSize: number, rawSize: number, type: number, crc: number, payload: Uint8Array) {
  const out = new Uint8Array(16 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, compSize, true);
  view.setUint32(4, rawSize, true);
  view.setUint32(8, type, true);
  view.setUint32(12, crc, true);
  out.set(payload, 16);
  return out;
}
const mela = (rtf: string) => {
  const body = enc(rtf);
  return header(body.length + 12, body.length, 0x414c454d, 0, body);
};

// A greedy LZFu compressor for the fixture: literals and dictionary back-references, packed eight to a
// control byte, ended by a reference to the current write position.
function compress(rtf: string): Uint8Array {
  const input = enc(rtf);
  const dictionary = new Uint8Array(4096);
  const initial = enc(INITIAL_DICTIONARY);
  dictionary.set(initial);
  let write = initial.length;
  const tokens: ({ literal: number } | { offset: number; length: number })[] = [];
  const emitToDict = (byte: number) => {
    dictionary[write] = byte;
    write = (write + 1) % 4096;
  };
  let at = 0;
  while (at < input.length) {
    let best = { offset: 0, length: 0 };
    for (let offset = 0; offset < 4096; offset++) {
      let length = 0;
      while (length < 17 && at + length < input.length && dictionary[(offset + length) % 4096] === input[at + length])
        length++;
      // A match may not read bytes the walk has not written yet, except the ones it is writing now.
      if (length > best.length && length >= 3) best = { offset, length };
    }
    if (best.length >= 3) {
      tokens.push(best);
      for (let n = 0; n < best.length; n++) emitToDict(input[at++] as number);
    } else {
      tokens.push({ literal: input[at] as number });
      emitToDict(input[at++] as number);
    }
  }
  tokens.push({ offset: write, length: 2 });
  const payload: number[] = [];
  for (let group = 0; group < tokens.length; group += 8) {
    const slice = tokens.slice(group, group + 8);
    let flags = 0;
    slice.forEach((token, n) => {
      if ("offset" in token) flags |= 1 << n;
    });
    payload.push(flags);
    for (const token of slice) {
      if ("offset" in token) payload.push(token.offset >> 4, ((token.offset & 0xf) << 4) | (token.length - 2));
      else payload.push(token.literal);
    }
  }
  const bytes = new Uint8Array(payload);
  return header(bytes.length + 12, input.length, 0x75465a4c, rtfCrc(bytes), bytes);
}

describe("decompressRtf", () => {
  it("reads an uncompressed MELA stream and a compressed LZFu stream to the same RTF", () => {
    const rtf = "{\\rtf1\\ansi Please pay invoice 77 today.\\par Please pay invoice 77 today.\\par}";
    expect(decompressRtf(mela(rtf), LIMIT)).toEqual(enc(rtf));
    expect(decompressRtf(compress(rtf), LIMIT)).toEqual(enc(rtf));
  });

  it("refuses a declared size past the limit before reading, and a stream that writes past its declaration", () => {
    const huge = header(24, 50 * 1024 * 1024, 0x414c454d, 0, enc("x".repeat(8)));
    expect(() => decompressRtf(huge, LIMIT)).toThrow(ParseError);
    // Declares four bytes, then writes ten literals.
    const payload = new Uint8Array([0, ...enc("0123456789")]);
    const lying = header(payload.length + 12, 4, 0x75465a4c, rtfCrc(payload), payload);
    expect(() => decompressRtf(lying, LIMIT)).toThrow(/past its declared size/);
  });

  it("refuses a MELA stream whose sizes disagree and an LZFu stream with no terminator", () => {
    const body = enc("abcdef");
    expect(() => decompressRtf(header(body.length + 12, 3, 0x414c454d, 0, body), LIMIT)).toThrow(ParseError);
    // Eight literals in one control group declaring exactly eight bytes, and nothing ends the stream:
    // reaching the declared size is not termination.
    const payload = new Uint8Array([0, ...enc("12345678")]);
    const unterminated = header(payload.length + 12, 8, 0x75465a4c, rtfCrc(payload), payload);
    expect(() => decompressRtf(unterminated, LIMIT)).toThrow(/terminator/);
  });

  it("refuses a bad checksum, a cut-off stream and an unknown compression type", () => {
    const good = compress("{\\rtf1\\ansi Pay.}");
    const badCrc = new Uint8Array(good);
    badCrc[12] = (badCrc[12] as number) ^ 0xff;
    expect(() => decompressRtf(badCrc, LIMIT)).toThrow(/checksum/);
    expect(() => decompressRtf(good.subarray(0, 10), LIMIT)).toThrow(ParseError);
    const payload = enc("{\\rtf1}");
    expect(() => decompressRtf(header(payload.length + 12, payload.length, 0x12345678, 0, payload), LIMIT)).toThrow(
      ParseError,
    );
  });
});

describe("rtfToText", () => {
  it("extracts the text with destinations skipped, escapes and Unicode intact", () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1252 {\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red255\\green0\\blue0;}" +
      "\\f0 Pay \\'e9\\par Second \\u8217?s \\tab end \\{ok\\}}";
    expect(rtfToText(enc(rtf), "windows-1252")).toBe("Pay é\nSecond ’s \tend {ok}");
  });

  it("reads a non-ASCII byte in its code page and skips the picture destination", () => {
    const rtf = "{\\rtf1\\ansi\\ansicpg1251 {\\pict\\pngblip abc}Privet \\'f1}";
    // windows-1251 byte 0xf1 is с; the picture's bytes never reach the text.
    expect(rtfToText(enc(rtf), "windows-1252")).toBe("Privet с");
  });
});

describe("rtfToHtml", () => {
  it("de-encapsulates HTML with htmlrtf regions left out", () => {
    const rtf =
      "{\\rtf1\\ansi\\fromhtml1 {\\fonttbl{\\f0 Arial;}}\\f0 <html><body>Pay <b>now</b>" +
      "{\\htmlrtf <i>formatting only</i>} please</body></html>}";
    expect(rtfToHtml(enc(rtf), "windows-1252")).toBe("<html><body>Pay <b>now</b> please</body></html>");
    expect(rtfToHtml(enc("{\\rtf1\\ansi Plain.}"), "windows-1252")).toBeNull();
  });

  it("reads starred htmltag destinations as the tags they carry", () => {
    const rtf = "{\\rtf1\\fromhtml1{\\*\\htmltag1 <p>}Pay{\\*\\htmltag1 </p>}}";
    expect(rtfToHtml(enc(rtf), "windows-1252")).toBe("<p>Pay</p>");
  });
});

describe("scoped state and syntax", () => {
  it("reads the default font and skips a Unicode fallback one token at a time", () => {
    expect(rtfToText(enc("{\\rtf1\\ansi\\deff1{\\fonttbl{\\f1\\fcharset204 Arial;}}\\'f1}"), "windows-1252")).toBe("с");
    // The fallback is an escaped backslash: skipped whole, the X after it is text.
    expect(rtfToText(enc("{\\rtf1\\uc1\\u945\\\\X}"), "windows-1252")).toBe("αX");
    expect(() => rtfToText(enc("{\\rtf1\\u945\\'zz}"), "windows-1252")).toThrow(ParseError);
    // A group delimiter is never fallback, and a \bin payload is one fallback character, not body text.
    expect(rtfToText(enc("{\\rtf1{\\u945}Pay now}"), "windows-1252")).toBe("αPay now");
    expect(rtfToText(enc("{\\rtf1\\uc1\\u945\\bin3 abcX}"), "windows-1252")).toBe("αX");
  });

  it("keeps the Unicode fallback count and the font inside their group", () => {
    expect(rtfToText(enc("{\\rtf1\\uc1 {\\uc0\\u945}\\u946?X}"), "windows-1252")).toBe("αβX");
    expect(rtfToText(enc("{\\rtf1\\ansi\\u-254 ?}"), "windows-1252")).toBe("\uFF02");
    // The Cyrillic font applies inside its group only: the same byte after it reads as Western again.
    const fonts = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}{\\f1\\fcharset204 Arial;}}{\\f1 \\'f1} \\'f1}";
    expect(rtfToText(enc(fonts), "windows-1252")).toBe("с ñ");
  });

  it("refuses unbalanced groups and malformed escapes instead of reading them as text", () => {
    expect(() => rtfToText(enc("{\\rtf1 Pay"), "windows-1252")).toThrow(ParseError);
    expect(() => rtfToText(enc("{\\rtf1 Pay \\'zz}"), "windows-1252")).toThrow(ParseError);
    expect(rtfToText(enc("{\\rtf1\\ansi}"), "windows-1252")).toBe("");
  });
});
