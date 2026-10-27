// MP3 voice notes and voicemail attachments (D01 T03 §7; spec 4.2a), for `decodeToWavChunks` in `./decode`.
//
// The file is walked before anything is decoded, as Ogg is: an ID3v2 tag at the start (its syncsafe size counts
// neither its 10-byte header nor the 10-byte footer its flags may announce, ID3v2.4 3.1) and an ID3v1 or APE tag at the
// end are set aside, and every frame between them must be MPEG 1, 2 or 2.5 Layer III with a defined bitrate and sample
// rate (not free format), keep the first frame's sample rate and channel count, and start where the one before it
// ends, the last ending with the audio. A Xing/Info frame first is metadata, not audio: when it declares a frame count
// the walk must find exactly that many (which catches a file cut at a frame boundary), and a LAME tag in it gives the
// encoder delay and end padding to drop, as minimp3's own minimp3_ex.h does (delay + 529, padding - 529). An MP3
// without that count, cut exactly at a frame boundary, cannot be told from a shorter recording: MP3 carries no other
// length or checksum.
//
// Decoding is minimp3 (CC0), vendored in native/minimp3 with a binding of our own that decodes one frame per call and
// reports minimp3's result for it, compiled to WebAssembly by scripts/build-wasm.py and imported as a module,
// so nothing is compiled at runtime and a frame minimp3 refuses is never passed on as silence. Licence:
// `minimp3.wasm.LICENSE`.
import { CorruptAudio, UnsupportedAudio } from "./errors";
import minimp3Module from "./minimp3.wasm?module";

// Layer III bitrates (kbit/s) by bitrate index, for MPEG 1 and for MPEG 2 and 2.5 (ISO/IEC 11172-3, 13818-3).
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = {
  1: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  25: [11_025, 12_000, 8_000],
};
// The decoder's own delay, which a LAME tag's figures leave out (minimp3_ex.h).
const DECODER_DELAY = 528 + 1;

type Frame = { version: 1 | 2 | 25; rate: number; channels: number; samples: number; length: number; crc: boolean };

export type Mp3Layout = {
  // The audio frames, without the tags or the Xing/Info frame, and the samples a channel each decodes to.
  audio: Uint8Array;
  frames: number;
  frameSamples: number;
  rate: number;
  channels: number;
  // Samples a channel to drop at the start, and to keep after them.
  skip: number;
  keep: number;
};

export type Mp3Block = { pcm: Int16Array; channels: number; samples: number };
export type Mp3Stream = { decode: (seconds: number) => Mp3Block };

function frameAt(bytes: Uint8Array, at: number): Frame {
  const b1 = bytes[at + 1] as number;
  const b2 = bytes[at + 2] as number;
  if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0)
    throw new CorruptAudio(`the MP3 has data that is not a frame at byte ${at} (junk, or a damaged frame header)`);
  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0)
    throw new CorruptAudio(`the MP3's frame header at byte ${at} is damaged (a reserved version or layer)`);
  if (layerBits !== 1) throw new UnsupportedAudio(`audio/mpeg Layer ${4 - layerBits} (only Layer III is MP3)`);
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0) throw new UnsupportedAudio("audio/mpeg in free format");
  if (bitrateIndex === 15 || rateIndex === 3)
    throw new CorruptAudio(`the MP3's frame header at byte ${at} is damaged (a reserved bitrate or sample rate)`);
  const kbps = (version === 1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] as number;
  const rate = (RATES[version] as number[])[rateIndex] as number;
  const samples = version === 1 ? 1_152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1_000) / rate) + ((b2 >> 1) & 1);
  const channels = (bytes[at + 3] as number) >> 6 === 3 ? 1 : 2;
  return { version, rate, channels, samples, length, crc: (b1 & 1) === 0 };
}

const ascii = (bytes: Uint8Array, at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));

// A Xing/Info frame's declared frame count and its LAME tag's delay and padding (minimp3_ex.h, mp3dec_check_vbrtag),
// or null when the frame is audio.
function vbrTag(bytes: Uint8Array, at: number, frame: Frame) {
  const sideInfo = frame.version === 1 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const end = at + frame.length;
  // LAME writes the tag right after the side information even when the frame announces a CRC (its VbrTag.c keeps
  // the offset fixed), while a CRC-aware writer puts it 2 bytes later: both are looked for.
  const isTag = (tag: number) => tag + 8 <= end && ["Xing", "Info"].includes(ascii(bytes, tag, 4));
  const plain = at + 4 + sideInfo;
  let tag = isTag(plain) ? plain : frame.crc && isTag(plain + 2) ? plain + 2 : -1;
  if (tag < 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[tag + 7] as number;
  tag += 8;
  let frames: number | null = null;
  if (flags & 1) {
    if (tag + 4 > end) throw new CorruptAudio("the MP3's Xing header is cut short");
    frames = view.getUint32(tag, false);
    tag += 4;
  }
  tag += (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
  let delay = 0;
  let padding = 0;
  // An encoder tag (LAME, Lavc, ...) after the Xing fields, 36 bytes, with the delay and padding at bytes 21 to 23.
  if (frames !== null && tag + 36 <= end && bytes[tag] !== 0) {
    const d0 = bytes[tag + 21] as number;
    const d1 = bytes[tag + 22] as number;
    const d2 = bytes[tag + 23] as number;
    delay = ((d0 << 4) | (d1 >> 4)) + DECODER_DELAY;
    padding = (((d1 & 0x0f) << 8) | d2) - DECODER_DELAY;
  }
  return { frames, delay, padding };
}

export function scanMp3(bytes: Uint8Array): Mp3Layout {
  if (bytes.length === 0) throw new CorruptAudio("the MP3 file is empty");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  let end = bytes.length;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.length < 10) throw new CorruptAudio("the MP3's ID3v2 tag is cut short");
    let size = 0;
    for (let i = 6; i < 10; i++) {
      const b = bytes[i] as number;
      if (b & 0x80) throw new CorruptAudio("the MP3's ID3v2 tag size is not syncsafe");
      size = (size << 7) | b;
    }
    start = 10 + size + ((bytes[5] as number) & 0x10 ? 10 : 0);
    if (start > bytes.length) throw new CorruptAudio("the MP3's ID3v2 tag runs past the end of the file");
  }
  if (end - start >= 128 && ascii(bytes, end - 128, 3) === "TAG") end -= 128;
  if (end - start >= 32 && ascii(bytes, end - 32, 8) === "APETAGEX") {
    // The APE size counts its items and footer; a header, when its flags say so, comes before them.
    const size = view.getUint32(end - 32 + 12, true);
    const header = view.getUint32(end - 32 + 20, true) & 0x80000000 ? 32 : 0;
    const tagStart = end - size - header;
    if (tagStart < start) throw new CorruptAudio("the MP3's APE tag runs past the start of the audio");
    end = tagStart;
  }
  if (start >= end) throw new CorruptAudio("the MP3 file holds tags but no audio");

  let first: Frame | null = null;
  let audioStart = start;
  let declared: number | null = null;
  let delay = 0;
  let padding = 0;
  let frames = 0;
  for (let at = start; at < end; ) {
    if (at + 4 > end) throw new CorruptAudio("the MP3 is cut short in a frame header");
    const frame = frameAt(bytes, at);
    if (at + frame.length > end) throw new CorruptAudio("the MP3 is cut short in the middle of a frame");
    if (!first) {
      first = frame;
      const tag = vbrTag(bytes, at, frame);
      if (tag) {
        ({ frames: declared, delay, padding } = tag);
        at += frame.length;
        audioStart = at;
        continue;
      }
    } else if (frame.rate !== first.rate || frame.channels !== first.channels) {
      throw new CorruptAudio(`the MP3 changes its sample rate or channels at byte ${at}`);
    }
    frames++;
    at += frame.length;
  }
  if (!first || frames === 0) throw new CorruptAudio("the MP3 holds no audio frames");
  if (declared !== null && declared !== frames)
    throw new CorruptAudio(
      `the MP3 has ${frames} frames where its Xing header declares ${declared} (cut short or padded)`,
    );
  const total = frames * first.samples;
  const keep = total - delay - Math.max(0, padding);
  if (keep <= 0) throw new CorruptAudio("the MP3's LAME tag trims away all of its audio");
  return {
    audio: bytes.subarray(audioStart, end),
    frames,
    frameSamples: first.samples,
    rate: first.rate,
    channels: first.channels,
    skip: delay,
    keep,
  };
}

// The binding's exports (native/minimp3/decoder.c): one frame decoded per call, with minimp3's own result.
type Minimp3 = {
  memory: WebAssembly.Memory;
  input_offset: () => number;
  set_input_size: (size: number) => number;
  decode_frame: (offset: number) => number;
  frame_bytes: () => number;
  frame_channels: () => number;
  frame_rate: () => number;
  pcm_offset: () => number;
};

// A decoder over the audio frames, one instance per recording: each `decode` gives the next stretch of at most
// `seconds` (whole frames) as interleaved PCM. A frame minimp3 refuses (invalid side information, a bit reservoir it
// cannot restore) is `CorruptAudio`, never silence.
export function createMp3Decoder(audio: Uint8Array): Mp3Stream {
  const wasm = new WebAssembly.Instance(minimp3Module, {}).exports as unknown as Minimp3;
  if (!wasm.set_input_size(audio.length)) throw new CorruptAudio("the MP3 is too large for the decoder's memory");
  new Uint8Array(wasm.memory.buffer, wasm.input_offset(), audio.length).set(audio);
  let offset = 0;
  let frame = 0;
  return {
    decode: (seconds) => {
      // Room for `seconds` of the largest frames (1,152 samples, two channels), filled frame by frame in place.
      let pcm = new Int16Array((Math.ceil((seconds * 48_000) / 1_152) + 1) * 1_152 * 2);
      let total = 0;
      let channels = 0;
      let rate = 0;
      // Whole frames up to `seconds`, never past it (at least one frame, so a decode always moves on).
      let frameSamples = 0;
      while (offset < audio.length && (total === 0 || total + frameSamples <= seconds * rate)) {
        const samples = wasm.decode_frame(offset);
        if (samples === 0) throw new CorruptAudio(`MP3 frame ${frame} does not decode (minimp3 refuses its contents)`);
        frameSamples = samples;
        channels = wasm.frame_channels();
        rate = wasm.frame_rate();
        const values = samples * channels;
        if ((total + samples) * channels > pcm.length) {
          const grown = new Int16Array(pcm.length * 2);
          grown.set(pcm);
          pcm = grown;
        }
        pcm.set(new Int16Array(wasm.memory.buffer, wasm.pcm_offset(), values), total * channels);
        total += samples;
        offset += wasm.frame_bytes();
        frame++;
      }
      return { pcm: pcm.subarray(0, total * channels), channels, samples: total };
    },
  };
}
