// A raw LZMA1 decoder for 7z's compressed headers (D02 T04 §7): a port of the LZMA SDK's reference decoder,
// `LzmaSpec.cpp` by Igor Pavlov, which its author placed in the public domain. It decodes one stream of a known
// unpacked size into a buffer that is also its window, so memory is that size and no more; every bound is the
// caller's: the packed bytes it is given, the size it asks for (refused past `maxOutput`), and the properties byte
// (`lc + lp` at most 4, as the SDK's own decoder refuses). Damaged input throws LzmaError, never a short result.
export class LzmaError extends Error {
  override name = "LzmaError";
}

const PROB_BITS = 11;
const PROB_INIT = 1 << (PROB_BITS - 1);
const MOVE_BITS = 5;
const TOP = 2 ** 24;
const STATES = 12;
const POS_BITS_MAX = 4;
const LEN_LOW_BITS = 3;
const LEN_MID_BITS = 3;
const LEN_HIGH_BITS = 8;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >>> 1);
const ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;

const probs = (n: number) => new Uint16Array(n).fill(PROB_INIT);

class Range {
  private range = 0xffffffff;
  private code = 0;
  private at: number;
  private readonly input: Uint8Array;
  constructor(input: Uint8Array, start: number) {
    this.input = input;
    this.at = start;
    if (this.next() !== 0) throw new LzmaError("the stream does not start with a zero byte");
    for (let i = 0; i < 4; i++) this.code = ((this.code * 256) >>> 0) + this.next();
    if (this.code === this.range) throw new LzmaError("the stream is damaged");
  }
  // The stream is whole: the coder's last value is zero and every byte it was given was read (the SDK's IsFinishedOK,
  // with the packed size exact as 7z gives it).
  finished(): boolean {
    return this.code === 0 && this.at === this.input.length;
  }
  private next(): number {
    const b = this.input[this.at++];
    if (b === undefined) throw new LzmaError("the stream ends early");
    return b;
  }
  private normalize() {
    if (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code * 256) >>> 0) + this.next();
    }
  }
  direct(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i++) {
      this.range = this.range >>> 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      if (this.code === this.range) throw new LzmaError("the stream is damaged");
      this.normalize();
      result = ((result * 2) >>> 0) + bit;
    }
    return result;
  }
  bit(p: Uint16Array, i: number): number {
    const v = p[i] as number;
    const bound = (this.range >>> PROB_BITS) * v;
    let symbol: number;
    if (this.code < bound) {
      p[i] = v + (((1 << PROB_BITS) - v) >>> MOVE_BITS);
      this.range = bound;
      symbol = 0;
    } else {
      p[i] = v - (v >>> MOVE_BITS);
      this.code -= bound;
      this.range -= bound;
      symbol = 1;
    }
    this.normalize();
    return symbol;
  }
  tree(p: Uint16Array, base: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(p, base + m);
    return m - (1 << bits);
  }
  reverse(p: Uint16Array, base: number, bits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(p, base + m);
      m = (m << 1) + b;
      symbol |= b << i;
    }
    return symbol;
  }
}

class Lengths {
  private choice = probs(2);
  private low = probs((1 << POS_BITS_MAX) << LEN_LOW_BITS);
  private mid = probs((1 << POS_BITS_MAX) << LEN_MID_BITS);
  private high = probs(1 << LEN_HIGH_BITS);
  decode(rc: Range, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << LEN_LOW_BITS, LEN_LOW_BITS);
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << LEN_MID_BITS, LEN_MID_BITS);
    return 16 + rc.tree(this.high, 0, LEN_HIGH_BITS);
  }
}

// The properties byte as 7z's coder properties give it: `lc + lp * 9 + pb * 45`.
export function lzmaProperties(byte: number): { lc: number; lp: number; pb: number } {
  if (byte >= 9 * 5 * 5) throw new LzmaError("its properties are out of range");
  const lc = byte % 9;
  const lp = Math.floor(byte / 9) % 5;
  const pb = Math.floor(byte / 45);
  if (lc + lp > 4) throw new LzmaError("its literal properties are past what is decoded");
  return { lc, lp, pb };
}

// Decodes `size` bytes of a raw LZMA1 stream (no header) with the properties byte given. The stream must end right
// after them, with or without an end marker; one before them is a stream shorter than declared, and refused.
export function decodeLzma(input: Uint8Array, propsByte: number, size: number, maxOutput: number): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxOutput) throw new LzmaError("its size is past what is read");
  const { lc, lp, pb } = lzmaProperties(propsByte);
  const out = new Uint8Array(size);
  if (size === 0) return out;
  const rc = new Range(input, 0);
  const literals = probs(0x300 << (lc + lp));
  const isMatch = probs(STATES << POS_BITS_MAX);
  const isRep = probs(STATES);
  const isRepG0 = probs(STATES);
  const isRepG1 = probs(STATES);
  const isRepG2 = probs(STATES);
  const isRep0Long = probs(STATES << POS_BITS_MAX);
  const posSlot = probs(4 << 6);
  const posDecoders = probs(1 + FULL_DISTANCES - END_POS_MODEL_INDEX);
  const align = probs(1 << ALIGN_BITS);
  const lengths = new Lengths();
  const repLengths = new Lengths();
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let pos = 0;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  // A match's distance: a 6-bit slot by its length, then its extra bits.
  const distance = (len: number): number => {
    const slot = rc.tree(posSlot, Math.min(len, 3) << 6, 6);
    if (slot < 4) return slot;
    const direct = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << direct) >>> 0;
    if (slot < END_POS_MODEL_INDEX) dist += rc.reverse(posDecoders, dist - slot, direct);
    else {
      dist += rc.direct(direct - ALIGN_BITS) * 2 ** ALIGN_BITS;
      dist += rc.reverse(align, 0, ALIGN_BITS);
    }
    return dist >>> 0;
  };
  const byteAt = (dist: number) => {
    if (dist >= pos) throw new LzmaError("a match reaches before the start");
    return out[pos - dist - 1] as number;
  };
  while (pos < size) {
    const posState = pos & pbMask;
    if (rc.bit(isMatch, (state << POS_BITS_MAX) + posState) === 0) {
      // A literal, decoded against the byte at rep0 after a match.
      const prev = pos > 0 ? (out[pos - 1] as number) : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let match = byteAt(rep0);
        do {
          const matchBit = (match >>> 7) & 1;
          match <<= 1;
          const bit = rc.bit(literals, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literals, base + symbol);
      out[pos++] = symbol - 0x100;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len: number;
    if (rc.bit(isRep, state) !== 0) {
      if (pos === 0) throw new LzmaError("a repeat comes before any output");
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
          // A one-byte repeat of rep0.
          state = state < 7 ? 9 : 11;
          out[pos] = byteAt(rep0);
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(isRepG1, state) === 0) dist = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) dist = rep2;
          else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLengths.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lengths.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      rep0 = distance(len);
      // The end marker: the stream ended before its declared size.
      if (rep0 === 0xffffffff) throw new LzmaError("the stream ends before its declared size");
    }
    len += MATCH_MIN_LEN;
    if (rep0 >= pos) throw new LzmaError("a match reaches before the start");
    if (len > size - pos) throw new LzmaError("a match runs past the declared size");
    for (let i = 0; i < len; i++) {
      out[pos] = out[pos - rep0 - 1] as number;
      pos++;
    }
  }
  // The declared size is reached: the stream must end here, as written without an end marker (the coder finished,
  // every byte read) or with one (a match of distance 0xFFFFFFFF, then finished). Output that is right but comes from a
  // stream cut short, or one with more after it, is refused (§7 round 1; the SDK's lzma.txt on finishing a stream).
  if (!rc.finished()) {
    const posState = pos & pbMask;
    if (rc.bit(isMatch, (state << POS_BITS_MAX) + posState) === 0 || rc.bit(isRep, state) !== 0)
      throw new LzmaError("the stream goes on past its declared size");
    if (distance(lengths.decode(rc, posState)) !== 0xffffffff)
      throw new LzmaError("the stream goes on past its declared size");
    if (!rc.finished()) throw new LzmaError("the stream does not end where it should");
  }
  return out;
}
