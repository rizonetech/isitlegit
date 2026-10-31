// The stream filters a bank or accounting system writes besides FlateDecode (D06 T02 §5; ISO 32000-1 section 7.4):
// LZWDecode (7.4.4, with EarlyChange), ASCII85Decode (7.4.3), ASCIIHexDecode (7.4.2) and RunLengthDecode (7.4.5), and
// TIFF predictor 2 (7.4.4.4). Each decoder writes at most `limit` bytes and answers "too-large" the moment it would
// write more, so an expansion costs at most the budget it was given, never a buffer past it; damaged input is null.

export type Decoded = Uint8Array | null | "too-large";

// A growing output that refuses to pass its limit.
class Out {
  private buf: Uint8Array;
  length = 0;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
    this.buf = new Uint8Array(Math.min(limit, 64 * 1024) || 1);
  }
  // False once the limit would be passed.
  push(byte: number): boolean {
    if (this.length >= this.limit) return false;
    if (this.length === this.buf.length) {
      const next = new Uint8Array(Math.min(this.limit, this.buf.length * 2));
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = byte;
    return true;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

// 7.4.2: pairs of hex digits, white space ignored, ">" ends it; an odd last digit is followed by an implied 0.
export function asciiHexDecode(data: Uint8Array, limit: number): Decoded {
  const out = new Out(limit);
  let high = -1;
  for (const c of data) {
    if (isWhite(c)) continue;
    if (c === 0x3e) break;
    const v =
      c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) return null;
    if (high < 0) high = v;
    else {
      if (!out.push((high << 4) | v)) return "too-large";
      high = -1;
    }
  }
  if (high >= 0 && !out.push(high << 4)) return "too-large";
  return out.bytes();
}

// 7.4.3: groups of five characters from "!" to "u" for four bytes, "z" for four zero bytes, white space ignored, "~>"
// ends it; a final partial group of n characters gives n - 1 bytes.
export function ascii85Decode(data: Uint8Array, limit: number): Decoded {
  const out = new Out(limit);
  const group: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (isWhite(c)) continue;
    if (c === 0x7e) {
      if (data[i + 1] !== 0x3e) return null;
      break;
    }
    if (c === 0x7a) {
      if (group.length) return null;
      for (let k = 0; k < 4; k++) if (!out.push(0)) return "too-large";
      continue;
    }
    if (c < 0x21 || c > 0x75) return null;
    group.push(c - 0x21);
    if (group.length === 5) {
      const v = group.reduce((acc, d) => acc * 85 + d, 0);
      if (v > 0xffffffff) return null;
      for (const shift of [24, 16, 8, 0]) if (!out.push((v >>> shift) & 0xff)) return "too-large";
      group.length = 0;
    }
  }
  // A writer that omits "~>" still has its data taken to the end.
  if (group.length === 1) return null;
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    const v = group.reduce((acc, d) => acc * 85 + d, 0);
    if (v > 0xffffffff) return null;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < n - 1; k++) if (!out.push(bytes[k] as number)) return "too-large";
  }
  return out.bytes();
}

// 7.4.5: a length byte 0 to 127 copies the next n + 1 bytes, 129 to 255 repeats the next byte 257 - n times, 128 ends.
export function runLengthDecode(data: Uint8Array, limit: number): Decoded {
  const out = new Out(limit);
  let i = 0;
  while (i < data.length) {
    const n = data[i++] as number;
    if (n === 128) return out.bytes();
    if (n < 128) {
      if (i + n + 1 > data.length) return null;
      for (let k = 0; k <= n; k++) if (!out.push(data[i + k] as number)) return "too-large";
      i += n + 1;
    } else {
      if (i >= data.length) return null;
      const b = data[i++] as number;
      for (let k = 0; k < 257 - n; k++) if (!out.push(b)) return "too-large";
    }
  }
  return out.bytes();
}

// 7.4.4: LZW with 9- to 12-bit codes, 256 clears the table and 257 ends the data; EarlyChange 1 (the default) widens the
// code one entry early. Each table entry is its prefix code and its last byte (at most 4096 of them), and a code is
// expanded by walking its prefixes into a scratch buffer, so the work per code is its own output length, which the
// output's limit already bounds.
export function lzwDecode(data: Uint8Array, limit: number, earlyChange = 1): Decoded {
  const out = new Out(limit);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lengthOf = new Int32Array(4096);
  for (let c = 0; c < 256; c++) {
    prefix[c] = -1;
    suffix[c] = c;
    lengthOf[c] = 1;
  }
  const scratch = new Uint8Array(4096);
  let next = 258;
  let width = 9;
  let previous = -1;
  let bits = 0;
  let buffer = 0;
  let at = 0;
  // The first byte of a code's string, and the string written to the output.
  const firstOf = (code: number) => {
    let c = code;
    while ((prefix[c] as number) >= 0) c = prefix[c] as number;
    return suffix[c] as number;
  };
  const emit = (code: number): boolean => {
    const len = lengthOf[code] as number;
    let c = code;
    for (let k = len - 1; k >= 0; k--) {
      scratch[k] = suffix[c] as number;
      c = prefix[c] as number;
    }
    for (let k = 0; k < len; k++) if (!out.push(scratch[k] as number)) return false;
    return true;
  };
  for (;;) {
    while (bits < width) {
      if (at >= data.length) return out.bytes();
      buffer = ((buffer << 8) | (data[at++] as number)) & 0xffffff;
      bits += 8;
    }
    const code = (buffer >>> (bits - width)) & ((1 << width) - 1);
    bits -= width;
    if (code === 256) {
      next = 258;
      width = 9;
      previous = -1;
      continue;
    }
    if (code === 257) return out.bytes();
    if (previous < 0) {
      if (code > 255) return null;
      if (!out.push(code)) return "too-large";
      previous = code;
      continue;
    }
    let first: number;
    if (code < next) {
      first = firstOf(code);
      if (!emit(code)) return "too-large";
    } else if (code === next) {
      // The string not yet in the table: the previous string followed by its own first byte.
      first = firstOf(previous);
      if (!emit(previous)) return "too-large";
      if (!out.push(first)) return "too-large";
    } else return null;
    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      lengthOf[next] = (lengthOf[previous] as number) + 1;
      next++;
    }
    previous = code;
    if (next + earlyChange >= 1 << width && width < 12) width++;
  }
}

// 7.4.4.4, TIFF predictor 2: each sample after the first in a row is stored as its difference from the one before;
// only 8-bit components are read (any other depth is null, named as unread by the caller).
export function untiff(data: Uint8Array, columns: number, colors: number, bitsPerComponent: number): Uint8Array | null {
  if (bitsPerComponent !== 8 || columns <= 0 || colors <= 0) return null;
  const width = columns * colors;
  if (width > 1 << 20 || data.length % width !== 0) return null;
  const out = data.slice();
  for (let row = 0; row < out.length; row += width)
    for (let i = colors; i < width; i++)
      out[row + i] = ((out[row + i] as number) + (out[row + i - colors] as number)) & 0xff;
  return out;
}
