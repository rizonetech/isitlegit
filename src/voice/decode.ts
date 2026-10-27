// Voice notes and voicemail attachments to the audio Muse Voice Transcribe takes (D01 T03 §2; spec 4.2a): 16 kHz mono
// 16-bit PCM WAV, at most 10 minutes per request. Ogg Opus (as WhatsApp saves voice notes) and PCM 16-bit WAV are
// decoded in the Worker; MP3 and M4A are refused until D01 T03 §7 and §8 decode them.
//
// Decoding is a stream, so memory holds the input, one chunk and the decoder's buffers, never the whole recording (25
// minutes at 48 kHz as 32-bit floats would be 288 MB, past a Worker's 128 MB): the input is fed in slices, each
// decoded block is mixed down and resampled at once into the current chunk, and each chunk is yielded when full. Length
// is read from the container before anything is decoded, so audio over 30 minutes is refused unread, and damaged audio
// (a failed checksum, a stream cut short, frames the decoder reports as bad, a malformed WAV) is refused, never passed
// on as complete.
//
// The Opus decoder's WebAssembly is imported as a module, compiled at deploy (a Worker refuses to compile it at
// runtime, which is what the package does by default), and handed to the decoder through `OpusDecoder.module`.
import { OggOpusDecoder } from "ogg-opus-decoder";
import { OpusDecoder } from "opus-decoder";
import opusModule from "./opus-decoder.wasm?module";

(OpusDecoder as unknown as { module?: WebAssembly.Module }).module = opusModule;

export const TARGET_RATE = 16_000;
export const CHUNK_SECONDS = 600;
export const MAX_SECONDS = 1_800;
const OPUS_RATE = 48_000;
// Compressed bytes fed to the Opus decoder at a time, and WAV frames read at a time.
const SLICE_BYTES = 64 * 1024;
const WAV_BLOCK_FRAMES = 64 * 1024;

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
export type OpusStream = {
  ready: Promise<void>;
  // A promise, though `ogg-opus-decoder` 1.7.5's declarations say otherwise: its `decode` is an async method.
  decode: (data: Uint8Array) => Decoded | Promise<Decoded>;
  flush: () => Promise<Decoded>;
  free: () => void;
};
export type DecodeOptions = { chunkSeconds?: number; opusDecoder?: () => OpusStream };

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

// Every page checked (capture pattern, sizes, checksum), the OpusHead read, and the length taken from the last
// page's granule position, all before any decoding.
function scanOgg(bytes: Uint8Array): { samples: number } {
  if (bytes.length === 0) throw new CorruptAudio("the Ogg file is empty");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  let page = 0;
  let preSkip = 0;
  let granule = 0n;
  let flags = 0;
  while (at < bytes.length) {
    if (at + 27 > bytes.length) throw new CorruptAudio(`the Ogg stream is cut short in page ${page}`);
    if (view.getUint32(at, false) !== 0x4f676753) throw new CorruptAudio(`Ogg page ${page} does not start with OggS`);
    const segments = bytes[at + 26] as number;
    if (at + 27 + segments > bytes.length) throw new CorruptAudio(`the Ogg stream is cut short in page ${page}`);
    let size = 0;
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i] as number;
    const start = at + 27 + segments;
    const end = start + size;
    if (end > bytes.length) throw new CorruptAudio(`the Ogg stream is cut short in page ${page}`);
    if (pageCrc(bytes, at, end) !== view.getUint32(at + 22, true))
      throw new CorruptAudio(`Ogg page ${page} fails its checksum`);
    if (page === 0) {
      const magic = String.fromCharCode(...bytes.subarray(start, start + 8));
      if (size < 19 || magic !== "OpusHead") throw new CorruptAudio("the Ogg stream is not Opus (no OpusHead)");
      if (bytes[start + 9] === 0) throw new CorruptAudio("the Opus stream has no channels");
      preSkip = view.getUint16(start + 10, true);
    }
    granule = view.getBigInt64(at + 6, true);
    flags = bytes[at + 5] as number;
    at = end;
    page++;
  }
  if (!(flags & 0x04)) throw new CorruptAudio("the Ogg stream is cut short (its last page does not end the stream)");
  const samples = Number(granule) - preSkip;
  if (samples <= 0) throw new CorruptAudio("the Ogg stream holds no audio");
  return { samples };
}

type WavLayout = { channels: number; rate: number; start: number; frames: number };

// The RIFF chunks walked and every size checked against the file before anything is read or allocated.
function scanWav(bytes: Uint8Array): WavLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE")
    throw new CorruptAudio("the file is not a RIFF WAVE file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { start: number; size: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > bytes.length)
      throw new CorruptAudio(`the WAV's ${id.trim()} chunk runs past the end of the file`);
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
  const frames = Math.floor(data.size / (fmt.channels * 2));
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
    const { samples } = scanOgg(bytes);
    tooLong(samples / OPUS_RATE);
    const chunks = new ChunkWriter(capacity, Math.ceil((samples * TARGET_RATE) / OPUS_RATE));
    const resampler = new Resampler(OPUS_RATE, chunks.put);
    const take = (out: Decoded) => {
      if (out.errors.length > 0)
        throw new CorruptAudio(`the Opus stream has damaged frames (${out.errors[0]?.message ?? "decoder error"})`);
      if (out.samplesDecoded > 0) resampler.push(mixdown(out.channelData));
    };
    const decoder = (options.opusDecoder ?? (() => new OggOpusDecoder()))();
    try {
      await decoder.ready;
      for (let at = 0; at < bytes.length; at += SLICE_BYTES) {
        take(await decoder.decode(bytes.subarray(at, at + SLICE_BYTES)));
        yield* chunks.drain();
      }
      take(await decoder.flush());
      resampler.end();
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
