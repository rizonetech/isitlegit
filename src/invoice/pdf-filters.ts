// The stream filters a bank or accounting system writes besides FlateDecode (D06 T02 §5; ISO 32000-1 section 7.4):
// LZWDecode (7.4.4, with EarlyChange), ASCII85Decode (7.4.3), ASCIIHexDecode (7.4.2) and RunLengthDecode (7.4.5), and
// TIFF predictor 2 (7.4.4.4). Each decoder writes at most `limit` bytes and stops with "too-large" the moment it would
// write more, so an expansion costs at most the budget it was given, never a buffer past it. A failure says how many
// bytes it wrote first, so the caller charges that work whether the data ended well or not (completion review), and a
// success says whether the filter's end-of-data marker closed it: data that stops without one may be cut short.

export type Decoded =
  | { ok: true; data: Uint8Array; ended: boolean }
  | { ok: false; reason: "damaged" | "too-large"; written: number };

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
  done(ended: boolean): Decoded {
    return { ok: true, data: this.buf.slice(0, this.length), ended };
  }
  fail(reason: "damaged" | "too-large"): Decoded {
    return { ok: false, reason, written: this.length };
  }
}

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

// 7.4.2: pairs of hex digits, white space ignored, ">" ends it; an odd last digit is followed by an implied 0.
export function asciiHexDecode(data: Uint8Array, limit: number): Decoded {
  const out = new Out(limit);
  let high = -1;
  let ended = false;
  for (const c of data) {
    if (isWhite(c)) continue;
    if (c === 0x3e) {
      ended = true;
      break;
    }
    const v =
      c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) return out.fail("damaged");
    if (high < 0) high = v;
    else {
      if (!out.push((high << 4) | v)) return out.fail("too-large");
      high = -1;
    }
  }
  if (high >= 0 && !out.push(high << 4)) return out.fail("too-large");
  return out.done(ended);
}

// 7.4.3: groups of five characters from "!" to "u" for four bytes, "z" for four zero bytes, white space ignored, "~>"
// ends it; a final partial group of n characters gives n - 1 bytes.
export function ascii85Decode(data: Uint8Array, limit: number): Decoded {
  const out = new Out(limit);
  const group: number[] = [];
  let ended = false;
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (isWhite(c)) continue;
    if (c === 0x7e) {
      if (data[i + 1] !== 0x3e) return out.fail("damaged");
      ended = true;
      break;
    }
    if (c === 0x7a) {
      if (group.length) return out.fail("damaged");
      for (let k = 0; k < 4; k++) if (!out.push(0)) return out.fail("too-large");
      continue;
    }
    if (c < 0x21 || c > 0x75) return out.fail("damaged");
    group.push(c - 0x21);
    if (group.length === 5) {
      const v = group.reduce((acc, d) => acc * 85 + d, 0);
      if (v > 0xffffffff) return out.fail("damaged");
      for (const shift of [24, 16, 8, 0]) if (!out.push((v >>> shift) & 0xff)) return out.fail("too-large");
      group.length = 0;
    }
  }
  if (group.length === 1) return out.fail("damaged");
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    const v = group.reduce((acc, d) => acc * 85 + d, 0);
    if (v > 0xffffffff) return out.fail("damaged");
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < n - 1; k++) if (!out.push(bytes[k] as number)) return out.fail("too-large");
  }
  return out.done(ended);
}

// 7.4.5: a length byte 0 to 127 copies the next n + 1 bytes, 129 to 255 repeats the next byte 257 - n times, 128 ends.
export function runLengthDecode(data: Uint8Array, limit: number): Decoded {
  const out = new Out(limit);
  let i = 0;
  while (i < data.length) {
    const n = data[i++] as number;
    if (n === 128) return out.done(true);
    if (n < 128) {
      if (i + n + 1 > data.length) return out.fail("damaged");
      for (let k = 0; k <= n; k++) if (!out.push(data[i + k] as number)) return out.fail("too-large");
      i += n + 1;
    } else {
      if (i >= data.length) return out.fail("damaged");
      const b = data[i++] as number;
      for (let k = 0; k < 257 - n; k++) if (!out.push(b)) return out.fail("too-large");
    }
  }
  return out.done(false);
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
      if (at >= data.length) return out.done(false);
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
    if (code === 257) return out.done(true);
    if (previous < 0) {
      if (code > 255) return out.fail("damaged");
      if (!out.push(code)) return out.fail("too-large");
      previous = code;
      continue;
    }
    let first: number;
    if (code < next) {
      first = firstOf(code);
      if (!emit(code)) return out.fail("too-large");
    } else if (code === next) {
      // The string not yet in the table: the previous string followed by its own first byte.
      first = firstOf(previous);
      if (!emit(previous)) return out.fail("too-large");
      if (!out.push(first)) return out.fail("too-large");
    } else return out.fail("damaged");
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

// 7.4.4.4, TIFF predictor 2: each sample after the first in a row is stored as its difference from the sample of the
// same colour component before it, modulo 2 to the component depth. Every depth the standard permits (1, 2, 4, 8 and
// 16 bits) is read; rows are padded to whole bytes, so the data is a whole number of rows or it is damaged (null).
export const TIFF_DEPTHS = [1, 2, 4, 8, 16] as const;
export function untiff(data: Uint8Array, columns: number, colors: number, bitsPerComponent: number): Uint8Array | null {
  if (!(TIFF_DEPTHS as readonly number[]).includes(bitsPerComponent) || columns <= 0 || colors <= 0) return null;
  const samples = columns * colors;
  if (samples > 1 << 20) return null;
  const rowBytes = Math.ceil((samples * bitsPerComponent) / 8);
  if (data.length % rowBytes !== 0) return null;
  const out = data.slice();
  for (let row = 0; row < out.length; row += rowBytes) {
    if (bitsPerComponent === 8) {
      for (let i = colors; i < samples; i++)
        out[row + i] = ((out[row + i] as number) + (out[row + i - colors] as number)) & 0xff;
    } else if (bitsPerComponent === 16) {
      for (let i = colors; i < samples; i++) {
        const at = row + 2 * i;
        const before = row + 2 * (i - colors);
        const v =
          ((((out[at] as number) << 8) | (out[at + 1] as number)) +
            (((out[before] as number) << 8) | (out[before + 1] as number))) &
          0xffff;
        out[at] = v >> 8;
        out[at + 1] = v & 0xff;
      }
    } else {
      // Sub-byte samples, most significant bits first (7.4.4.4 and 8.9.3): each read, summed and written back in turn,
      // so a sample's predecessor is already its decoded value.
      const mask = (1 << bitsPerComponent) - 1;
      const read = (i: number) => {
        const bit = i * bitsPerComponent;
        return ((out[row + (bit >> 3)] as number) >> (8 - bitsPerComponent - (bit & 7))) & mask;
      };
      for (let i = colors; i < samples; i++) {
        const v = (read(i) + read(i - colors)) & mask;
        const bit = i * bitsPerComponent;
        const shift = 8 - bitsPerComponent - (bit & 7);
        const at = row + (bit >> 3);
        out[at] = ((out[at] as number) & ~(mask << shift)) | (v << shift);
      }
    }
  }
  return out;
}
