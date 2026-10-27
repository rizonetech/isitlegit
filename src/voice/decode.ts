// Voice notes and voicemail attachments to the audio Muse Voice Transcribe takes (D01 T03 §2; spec 4.2a): 16 kHz mono
// 16-bit PCM WAV, at most 10 minutes per request. Ogg Opus (as WhatsApp saves voice notes) and PCM 16-bit WAV are
// decoded in the Worker; MP3 and M4A are refused until D01 T03 §7 and §8 decode them.
//
// Decoding is a stream, so memory holds the input, one chunk and a few seconds of decoded audio, never the whole
// recording (25 minutes at 48 kHz as 32-bit floats would be 288 MB, past a Worker's 128 MB). An Ogg file is checked
// whole before anything is decoded: every page's capture pattern, size, checksum and sequence number, one logical
// stream with an OpusHead, an end-of-stream page, and every Opus packet's own length and duration (from its TOC byte,
// RFC 6716 3.1), whose sum is the recording's length, so a file cannot claim to be shorter than it is and audio over
// 30 minutes is refused unread. The packets are then decoded in batches of at most 5 seconds by libopus itself at 16
// kHz (its own filtered rate conversion), mixed down and written into the current chunk, which is yielded when full.
// A WAV is checked the same way and resampled linearly (`Resampler`). Damaged audio of any kind is refused with
// `CorruptAudio`, never passed on as complete; anything the decoder throws becomes `CorruptAudio` too.
//
// The Opus decoder's WebAssembly is imported as a module, compiled at deploy (a Worker refuses to compile it at
// runtime, which is what the package does by default), and handed to the decoder through `OpusDecoder.module`.
import { OpusDecoder } from "opus-decoder";
import opusModule from "./opus-decoder.wasm?module";

(OpusDecoder as unknown as { module?: WebAssembly.Module }).module = opusModule;

export const TARGET_RATE = 16_000;
export const CHUNK_SECONDS = 600;
export const MAX_SECONDS = 1_800;
const OPUS_RATE = 48_000;
// Opus packets decoded at a time, by their duration at 48 kHz, and WAV frames read at a time.
const BATCH_SAMPLES = 5 * OPUS_RATE;
const WAV_BLOCK_FRAMES = 64 * 1024;
// opus-decoder 0.7.12 copies each packet into an input buffer of 3,840 bytes per channel (256 kbit/s for 120 ms).
const MAX_PACKET_BYTES_PER_CHANNEL = 3_840;

const OGG_TYPES = new Set(["audio/ogg", "audio/opus"]);
const WAV_TYPES = new Set(["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"]);

export class UnsupportedAudio extends Error {
  override name = "UnsupportedAudio";
  constructor(readonly type: string) {
    super(`audio of type ${type} cannot be decoded yet; Ogg Opus and WAV voice notes can`);
  }
}
export class CorruptAudio extends Error {
  override name = "CorruptAudio";
}
export class AudioTooLong extends Error {
  override name = "AudioTooLong";
  constructor(readonly seconds: number) {
    super(`the recording is ${Math.round(seconds / 60)} minutes long; at most ${MAX_SECONDS / 60} minutes are taken`);
  }
}

type Decoded = { channelData: Float32Array[]; samplesDecoded: number; errors: { message: string }[] };
export type OpusLayout = { channels: number; preSkip: number };
export type OpusStream = {
  ready: Promise<void>;
  decodeFrames: (packets: Uint8Array[]) => Decoded;
  free: () => void;
};
export type DecodeOptions = { chunkSeconds?: number; opusDecoder?: (layout: OpusLayout) => OpusStream };

// libopus decoding straight to 16 kHz. The OpusHead's pre-skip counts 48 kHz samples (RFC 7845 5.1), while
// opus-decoder 0.7.12 skips that many samples of its output, so it is scaled to the output rate.
export const createOpusDecoder = ({ channels, preSkip }: OpusLayout): OpusStream =>
  new OpusDecoder({
    sampleRate: TARGET_RATE,
    channels,
    streamCount: 1,
    coupledStreamCount: channels === 2 ? 1 : 0,
    channelMappingTable: channels === 2 ? [0, 1] : [0],
    preSkip: Math.round((preSkip * TARGET_RATE) / OPUS_RATE),
  });

// Linear interpolation from the source rate to 16 kHz over a stream of blocks: the position and the last sample carry
// from one block to the next, so block boundaries leave no seam. Output k sits at source position k * rate / 16000,
// computed from k rather than added up step by step, so rounding never drifts and N source samples always give
// ceil(N * 16000 / rate) outputs, however the input is split.
export class Resampler {
  private readonly step: number;
  private k = 0;
  private consumed = 0;
  private prev = 0;
  constructor(
    sourceRate: number,
    private readonly emit: (sample: number) => void,
  ) {
    this.step = sourceRate / TARGET_RATE;
  }
  push(mono: Float32Array): void {
    const n = mono.length;
    if (n === 0) return;
    const last = this.consumed + n - 1;
    for (let t = this.k * this.step, i = Math.floor(t); i + 1 <= last; t = this.k * this.step, i = Math.floor(t)) {
      const a = i < this.consumed ? this.prev : (mono[i - this.consumed] as number);
      const b = mono[i + 1 - this.consumed] as number;
      this.emit(a + (b - a) * (t - i));
      this.k++;
    }
    this.prev = mono[n - 1] as number;
    this.consumed = last + 1;
  }
  // The outputs that fall after the last source sample but before the input ends hold that sample: there is nothing
  // after it to interpolate towards.
  end(): void {
    while (this.consumed > 0 && this.k * this.step < this.consumed) {
      this.emit(this.prev);
      this.k++;
    }
  }
}

export function wavHeader(samples: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return header;
}

// 16 kHz samples gathered into WAV chunks of at most `capacity` samples, each written in place behind its header.
class ChunkWriter {
  private buffer: Uint8Array | null = null;
  private view: DataView | null = null;
  private n = 0;
  readonly ready: Uint8Array[] = [];
  total = 0;
  constructor(
    private readonly capacity: number,
    private expected: number,
  ) {}
  put = (sample: number): void => {
    if (!this.buffer || this.n === this.size()) {
      if (this.buffer && this.n === this.capacity) this.finish();
      this.grow();
    }
    const v = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
    (this.view as DataView).setInt16(44 + 2 * this.n, v, true);
    this.n++;
    this.total++;
  };
  private size(): number {
    return this.buffer ? (this.buffer.length - 44) / 2 : 0;
  }
  // A new chunk sized for what is still expected, or a full one; grown (rarely, when a decoder gives a little more
  // than its container said) up to the chunk limit.
  private grow(): void {
    const wanted = Math.min(this.capacity, Math.max(this.n + 1, this.size() * 2, this.expected - this.total + 1024));
    const next = new Uint8Array(44 + 2 * wanted);
    if (this.buffer) next.set(this.buffer.subarray(0, 44 + 2 * this.n));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }
  finish(): void {
    if (!this.buffer || this.n === 0) return;
    this.buffer.set(wavHeader(this.n));
    this.ready.push(this.buffer.subarray(0, 44 + 2 * this.n));
    this.buffer = null;
    this.view = null;
    this.n = 0;
  }
  *drain(): Generator<Uint8Array> {
    while (this.ready.length) yield this.ready.shift() as Uint8Array;
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});
// Ogg's page checksum (RFC 3533), computed with the page's own checksum field read as zero.
function pageCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const b = i >= start + 22 && i < start + 26 ? 0 : (bytes[i] as number);
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] as number)) >>> 0;
  }
  return crc;
}

// An Opus packet's duration at 48 kHz from its TOC byte (RFC 6716 3.1, 3.2), or null when the packet is malformed.
export function opusPacketSamples(packet: Uint8Array): number | null {
  if (packet.length === 0) return null;
  const toc = packet[0] as number;
  const config = toc >> 3;
  // SILK 10, 20, 40, 60 ms; hybrid 10, 20 ms; CELT 2.5, 5, 10, 20 ms (in 48 kHz samples).
  const frame =
    config < 12
      ? ([480, 960, 1920, 2880][config & 3] as number)
      : config < 16
        ? ([480, 960][config & 1] as number)
        : ([120, 240, 480, 960][config & 3] as number);
  const code = toc & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (packet.length < 2) return null;
    frames = (packet[1] as number) & 0x3f;
    if (frames === 0) return null;
  }
  const samples = frames * frame;
  return samples > 5_760 ? null : samples; // at most 120 ms
}

type OggPacket = { packet: Uint8Array; index: number; page: number; granule: bigint };

// The packets of a checked Ogg stream, in order, each with the page it ends on. A packet within one page is a view of
// the input; one that runs on into the next page is copied together. A page must say it continues a packet exactly
// when the page before it left one open (RFC 3533 6, RFC 7845 3): otherwise part of a packet is missing.
function* oggPackets(bytes: Uint8Array): Generator<OggPacket> {
  let index = 0;
  let pending: Uint8Array[] = [];
  for (let at = 0, page = 0; at < bytes.length; page++) {
    const continued = ((bytes[at + 5] as number) & 0x01) !== 0;
    if (continued && !pending.length)
      throw new CorruptAudio(`Ogg page ${page} continues a packet the page before it did not leave open`);
    if (!continued && pending.length)
      throw new CorruptAudio(`Ogg page ${page} starts afresh while the page before it left a packet unfinished`);
    const segments = bytes[at + 26] as number;
    const granule = new DataView(bytes.buffer, bytes.byteOffset + at + 6, 8).getBigInt64(0, true);
    let start = at + 27 + segments;
    let size = 0;
    for (let i = 0; i < segments; i++) {
      const lacing = bytes[at + 27 + i] as number;
      size += lacing;
      if (lacing < 255) {
        const piece = bytes.subarray(start, start + size);
        let packet = piece;
        if (pending.length) {
          pending.push(piece);
          packet = new Uint8Array(pending.reduce((n, p) => n + p.length, 0));
          let o = 0;
          for (const p of pending) {
            packet.set(p, o);
            o += p.length;
          }
          pending = [];
        }
        yield { packet, index: index++, page, granule };
        start += size;
        size = 0;
      }
    }
    if (size > 0) pending.push(bytes.subarray(start, start + size));
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[at + 27 + i] as number;
    at += 27 + segments + body;
  }
  if (pending.length) throw new CorruptAudio("the Ogg stream ends inside a packet");
}

// Every page checked (capture pattern, sizes, checksum, sequence, one logical stream, end of stream) and every packet
// (the OpusHead and OpusTags headers, then audio packets of a valid length and duration), before any decoding. The
// packets' durations bound how much audio there is; the granule positions say how much of it the recording keeps: from
// the first audio page's position less the audio ending on it (a cropped or live recording starts above zero, RFC 7845
// 4.5) to the last page's (the end may be trimmed, only within the last page, 4.4), less the pre-skip. `gain` is the
// OpusHead's output gain (5.1) as a factor.
function scanOgg(bytes: Uint8Array): OpusLayout & { samples: number; gain: number } {
  if (bytes.length === 0) throw new CorruptAudio("the Ogg file is empty");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let page = 0;
  let serial = 0;
  let sequence = 0;
  let flags = 0;
  let granule = 0n;
  for (let at = 0; at < bytes.length; page++) {
    if (at + 27 > bytes.length) throw new CorruptAudio(`the Ogg stream is cut short in page ${page}`);
    if (view.getUint32(at, false) !== 0x4f676753) throw new CorruptAudio(`Ogg page ${page} does not start with OggS`);
    const segments = bytes[at + 26] as number;
    if (at + 27 + segments > bytes.length) throw new CorruptAudio(`the Ogg stream is cut short in page ${page}`);
    let size = 0;
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i] as number;
    const end = at + 27 + segments + size;
    if (end > bytes.length) throw new CorruptAudio(`the Ogg stream is cut short in page ${page}`);
    if (pageCrc(bytes, at, end) !== view.getUint32(at + 22, true))
      throw new CorruptAudio(`Ogg page ${page} fails its checksum`);
    flags = bytes[at + 5] as number;
    granule = view.getBigInt64(at + 6, true);
    const pageSerial = view.getUint32(at + 14, true);
    const pageSequence = view.getUint32(at + 18, true);
    if (page === 0) {
      serial = pageSerial;
      sequence = pageSequence;
    } else {
      if (pageSerial !== serial || flags & 0x02)
        throw new UnsupportedAudio("audio/ogg with chained or multiple streams");
      if (pageSequence !== sequence + 1)
        throw new CorruptAudio(`Ogg page ${page} is missing (the stream skips a page)`);
      sequence = pageSequence;
    }
    at = end;
  }
  if (!(flags & 0x04)) throw new CorruptAudio("the Ogg stream is cut short (its last page does not end the stream)");

  const lastPage = page - 1;
  let layout: OpusLayout | null = null;
  let gain = 1;
  let total = 0;
  let onLastPage = 0;
  let firstPage = -1;
  let firstGranule = 0n;
  let onFirstPage = 0;
  for (const { packet, index, page: endsOn, granule: pageGranule } of oggPackets(bytes)) {
    if (index === 0) {
      const magic = String.fromCharCode(...packet.subarray(0, 8));
      if (packet.length < 19 || magic !== "OpusHead")
        throw new CorruptAudio("the Ogg stream is not Opus (no OpusHead)");
      const channels = packet[9] as number;
      if (channels === 0) throw new CorruptAudio("the Opus stream has no channels");
      if (channels > 2 || packet[18] !== 0)
        throw new UnsupportedAudio(`audio/ogg with ${channels} channels (mapping family ${packet[18]})`);
      layout = { channels, preSkip: (packet[10] as number) | ((packet[11] as number) << 8) };
      // Q7.8 decibels, signed.
      gain = 10 ** (new DataView(packet.buffer, packet.byteOffset + 16, 2).getInt16(0, true) / 256 / 20);
    } else if (index === 1) {
      checkOpusTags(packet);
    } else {
      const samples = opusPacketSamples(packet);
      if (samples === null) throw new CorruptAudio(`Opus packet ${index - 2} is malformed`);
      if (packet.length > MAX_PACKET_BYTES_PER_CHANNEL * (layout as OpusLayout).channels)
        throw new CorruptAudio(`Opus packet ${index - 2} is larger than any real recording's (${packet.length} bytes)`);
      total += samples;
      if (endsOn === lastPage) onLastPage += samples;
      if (firstPage < 0) {
        firstPage = endsOn;
        firstGranule = pageGranule;
      }
      if (endsOn === firstPage) onFirstPage += samples;
    }
  }
  if (!layout) throw new CorruptAudio("the Ogg stream is not Opus (no OpusHead)");
  if (firstPage < 0) throw new CorruptAudio("the Ogg stream holds no audio");
  // Where the recording's first sample sits. Below zero is allowed only on a one-page stream, whose end trimming
  // covers it (RFC 7845 4.5).
  let origin = firstGranule - BigInt(onFirstPage);
  if (origin < 0n) {
    if (firstPage !== lastPage)
      throw new CorruptAudio("the Ogg stream's first audio page claims less audio than it holds");
    origin = 0n;
  }
  const span = granule - origin;
  if (granule < 0n || span > BigInt(total))
    throw new CorruptAudio("the Ogg stream's last position claims more audio than its packets hold");
  if (BigInt(total) - span > BigInt(onLastPage))
    throw new CorruptAudio("the Ogg stream trims more audio than its last page holds");
  const samples = Number(span) - layout.preSkip;
  if (samples <= 0) throw new CorruptAudio("the Ogg stream holds no audio");
  return { ...layout, samples, gain };
}

// The OpusTags header (RFC 7845 5.2): its vendor string and every comment within the packet's length.
function checkOpusTags(packet: Uint8Array): void {
  if (String.fromCharCode(...packet.subarray(0, 8)) !== "OpusTags")
    throw new CorruptAudio("the Opus stream has no OpusTags header");
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const field = (at: number) => {
    if (at + 4 > packet.length) throw new CorruptAudio("the Opus stream's OpusTags header is cut short");
    return view.getUint32(at, true);
  };
  let at = 12 + field(8);
  const comments = field(at);
  at += 4;
  for (let i = 0; i < comments; i++) at += 4 + field(at);
  if (at > packet.length) throw new CorruptAudio("the Opus stream's OpusTags header is cut short");
}

type WavLayout = { channels: number; rate: number; start: number; frames: number };

// The RIFF chunks walked and every size checked against the file before anything is read or allocated.
function scanWav(bytes: Uint8Array): WavLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE")
    throw new CorruptAudio("the file is not a RIFF WAVE file");
  // The RIFF chunk encloses all the others: its size says where the file ends.
  const end = 8 + view.getUint32(4, true);
  if (end > bytes.length)
    throw new CorruptAudio("the WAV is cut short (its RIFF header claims more bytes than it has)");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { start: number; size: number } | null = null;
  for (let at = 12; at + 8 <= end; ) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > end) throw new CorruptAudio(`the WAV's ${id.trim()} chunk runs past the end of the file`);
    if (id === "fmt ") {
      if (size < 16) throw new CorruptAudio("the WAV's fmt chunk is too short");
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") data = { start: body, size };
    at = body + size + (size & 1);
  }
  if (!fmt) throw new CorruptAudio("the WAV has no fmt chunk");
  if (!data) throw new CorruptAudio("the WAV has no data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16)
    throw new CorruptAudio(`the WAV is format ${fmt.format} at ${fmt.bits} bits; only PCM 16-bit is read`);
  if (fmt.channels === 0) throw new CorruptAudio("the WAV has no channels");
  if (fmt.rate === 0) throw new CorruptAudio("the WAV has no sample rate");
  if (data.size % (fmt.channels * 2) !== 0)
    throw new CorruptAudio("the WAV's data ends partway through a sample frame (cut short or mislabelled)");
  const frames = data.size / (fmt.channels * 2);
  if (frames === 0) throw new CorruptAudio("the WAV holds no audio");
  return { channels: fmt.channels, rate: fmt.rate, start: data.start, frames };
}

function mixdown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0] as Float32Array;
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const channel of channels) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) + (channel[i] as number);
  for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) / channels.length;
  return mono;
}

const tooLong = (seconds: number) => {
  if (seconds > MAX_SECONDS) throw new AudioTooLong(seconds);
};

export async function* decodeToWavChunks(
  bytes: Uint8Array,
  type: string,
  options: DecodeOptions = {},
): AsyncGenerator<Uint8Array> {
  const capacity = Math.round((options.chunkSeconds ?? CHUNK_SECONDS) * TARGET_RATE);
  if (OGG_TYPES.has(type)) {
    const { channels, preSkip, samples, gain } = scanOgg(bytes);
    // What the recording keeps at 16 kHz: anything the decoder gives past it is end trimming.
    const keep = Math.round((samples * TARGET_RATE) / OPUS_RATE);
    tooLong(samples / OPUS_RATE);
    const chunks = new ChunkWriter(capacity, Math.ceil((samples * TARGET_RATE) / OPUS_RATE));
    const decoder = (options.opusDecoder ?? createOpusDecoder)({ channels, preSkip });
    // The decoder throws on input it cannot take (a RangeError from a packet it cannot hold, say): damaged audio too.
    const decode = (batch: Uint8Array[]): Decoded => {
      try {
        return decoder.decodeFrames(batch);
      } catch (error) {
        throw new CorruptAudio(`the Opus decoder failed (${(error as Error).name}: ${(error as Error).message})`);
      }
    };
    try {
      await decoder.ready;
      let batch: Uint8Array[] = [];
      let batched = 0;
      const flush = () => {
        const out = decode(batch);
        batch = [];
        batched = 0;
        if (out.errors.length > 0)
          throw new CorruptAudio(`the Opus stream has damaged frames (${out.errors[0]?.message ?? "decoder error"})`);
        const mono = mixdown(out.channelData);
        const n = Math.min(out.samplesDecoded, keep - chunks.total);
        for (let i = 0; i < n; i++) chunks.put((mono[i] as number) * gain);
      };
      for (const { packet, index } of oggPackets(bytes)) {
        if (index < 2) continue;
        batch.push(packet);
        batched += opusPacketSamples(packet) as number;
        if (batched >= BATCH_SAMPLES) {
          flush();
          yield* chunks.drain();
        }
      }
      if (batch.length) flush();
      chunks.finish();
      if (chunks.total === 0) throw new CorruptAudio("the Opus stream decoded to no audio");
      yield* chunks.drain();
    } finally {
      decoder.free();
    }
    return;
  }
  if (WAV_TYPES.has(type)) {
    const { channels, rate, start, frames } = scanWav(bytes);
    tooLong(frames / rate);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = new ChunkWriter(capacity, Math.ceil((frames * TARGET_RATE) / rate));
    const resampler = new Resampler(rate, chunks.put);
    const block = new Float32Array(Math.min(WAV_BLOCK_FRAMES, frames));
    for (let first = 0; first < frames; first += block.length) {
      const n = Math.min(block.length, frames - first);
      for (let f = 0; f < n; f++) {
        let sum = 0;
        const offset = start + (first + f) * channels * 2;
        for (let c = 0; c < channels; c++) sum += view.getInt16(offset + 2 * c, true);
        block[f] = sum / channels / 32768;
      }
      resampler.push(block.subarray(0, n));
      yield* chunks.drain();
    }
    resampler.end();
    chunks.finish();
    yield* chunks.drain();
    return;
  }
  throw new UnsupportedAudio(type);
}
