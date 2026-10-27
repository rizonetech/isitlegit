// Ogg pages for audio fixtures (RFC 3533; Opus mapping RFC 7845), plain TypeScript so both the fixture generator in
// Node and the decoder's tests in workerd can build and rebuild streams: a long recording made by repeating a short
// one's packets, a page with flipped bytes, a stream cut short.

// Ogg's CRC-32: polynomial 0x04c11db7, not reflected, initial value 0.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});
export const oggCrc = (bytes: Uint8Array) => {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] as number)) >>> 0;
  return crc;
};

export const BOS = 0x02;
export const EOS = 0x04;
const SERIAL = 0x49534c47;

// One page holding one whole packet.
export function oggPage(packet: Uint8Array, flags: number, granule: bigint, sequence: number): Uint8Array {
  const lacing: number[] = [];
  for (let left = packet.length; ; left -= 255) {
    lacing.push(Math.min(left, 255));
    if (left < 255) break;
  }
  const page = new Uint8Array(27 + lacing.length + packet.length);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  view.setUint8(5, flags);
  view.setBigInt64(6, granule, true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, sequence, true);
  view.setUint8(26, lacing.length);
  page.set(lacing, 27);
  page.set(packet, 27 + lacing.length);
  view.setUint32(22, oggCrc(page), true);
  return page;
}

export type OggPacket = { packet: Uint8Array; granule: bigint; flags: number };

// The packets of a stream written one per page (as the fixtures are), with each page's granule and flags.
export function oggPackets(stream: Uint8Array): OggPacket[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const out: OggPacket[] = [];
  for (let at = 0; at < stream.length; ) {
    const segments = stream[at + 26] as number;
    let size = 0;
    for (let i = 0; i < segments; i++) size += stream[at + 27 + i] as number;
    const start = at + 27 + segments;
    out.push({
      packet: stream.slice(start, start + size),
      granule: view.getBigInt64(at + 6, true),
      flags: stream[at + 5] as number,
    });
    at = start + size;
  }
  return out;
}

// A stream of the given header packets followed by the audio packets, granules counted from `preSkip` in steps of
// `frame` samples, the last page marked end of stream.
export function oggStream(headers: Uint8Array[], audio: Uint8Array[], preSkip: number, frame: number): Uint8Array {
  const pages = headers.map((h, i) => oggPage(h, i === 0 ? BOS : 0, 0n, i));
  audio.forEach((packet, i) => {
    const last = i === audio.length - 1;
    pages.push(oggPage(packet, last ? EOS : 0, BigInt(preSkip + (i + 1) * frame), headers.length + i));
  });
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A 16-bit PCM WAV file of the given interleaved samples.
export function wavFile(samples: Int16Array, rate: number, channels: number, format = 1): Uint8Array {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => out.set(new TextEncoder().encode(text), at);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.byteLength, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + 2 * i, samples[i] as number, true);
  return out;
}

// A tone of `hz` at `gain` of full scale, `seconds` long at `rate`.
export const tone = (rate: number, seconds: number, hz = 440, gain = 0.5) =>
  Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) =>
    Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * gain * 32767),
  );
