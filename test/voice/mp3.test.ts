import { describe, expect, it } from "vitest";
import { AudioTooLong, CorruptAudio, decodeToWavChunks, UnsupportedAudio } from "../../src/voice/decode";
import { createMp3Decoder, type Mp3Stream, scanMp3 } from "../../src/voice/mp3";
import { tone8kMp3, tone12kMp3, tone16kMp3, tone128kMp3, toneMp3, toneStereoMp3 } from "../fixtures/audio/load";
import { concat } from "../fixtures/audio/ogg";

// D01 T03 §7: MP3 voice notes and voicemail attachments, walked frame by frame before minimp3 decodes them.

async function decodeAll(bytes: Uint8Array, options = {}): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of decodeToWavChunks(bytes, "audio/mpeg", options)) out.push(chunk);
  return out;
}
const samples = (chunk: Uint8Array) => new Int16Array(chunk.slice(44).buffer);
const joined = (chunks: Uint8Array[]) => Int16Array.from(chunks.flatMap((c) => [...samples(c)]));
const refusal = (bytes: Uint8Array, options = {}): Promise<Error> =>
  decodeAll(bytes, options).then(
    () => new Error("decoded"),
    (e: unknown) => e as Error,
  );
const rms = (s: Int16Array, from = 0, to = s.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (s[i] as number) ** 2;
  return Math.sqrt(sum / (to - from));
};
const frequency = (s: Int16Array) => {
  const from = 8_000;
  const to = s.length - 8_000;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if ((s[i - 1] as number) < 0 !== (s[i] as number) < 0) crossings++;
  return crossings / 2 / ((to - from) / 16_000);
};
const concatPcm = (blocks: Int16Array[]) => {
  const out = new Int16Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};
// The tone at half of full scale, as 16-bit RMS.
const TONE_RMS = 0.5 * 32768 * Math.SQRT1_2;

// minimp3's own output level for a file, before resampling: what the pipeline after it must keep.
function nativeRms(mp3: Uint8Array): number {
  const decoder = createMp3Decoder(mp3);
  let sum = 0;
  let count = 0;
  let position = 0;
  for (let block = decoder.decode(5); block.samples > 0; block = decoder.decode(5)) {
    for (let i = 0; i < block.samples; i++, position++)
      if (position >= 22_050 && position < 110_250) {
        sum += (block.pcm[i] as number) ** 2;
        count++;
      }
  }
  return Math.sqrt(sum / count);
}

// A stream's frames, split by their headers' lengths (MPEG 1 Layer III here: 144 x bitrate / rate + padding).
function framesOf(mp3: Uint8Array): Uint8Array[] {
  const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const out: Uint8Array[] = [];
  for (let at = 0; at < mp3.length; ) {
    const b2 = mp3[at + 2] as number;
    const length = Math.floor((144 * (kbps[b2 >> 4] as number) * 1_000) / 44_100) + ((b2 >> 1) & 1);
    out.push(mp3.subarray(at, at + length));
    at += length;
  }
  return out;
}
const toneFrames = framesOf(toneMp3);
// `count` frames of the tone, its frames repeated in order.
const repeated = (count: number) =>
  concat(Array.from({ length: count }, (_, i) => toneFrames[i % toneFrames.length] as Uint8Array));

// A Xing/Info frame for the 44.1 kHz mono stream, declaring `frames`, with a LAME tag of `delay` and `padding`; with
// `crc`, its header announces a CRC and the tag stays where LAME writes it, right after the side information.
function infoFrame(frames: number, delay?: number, padding?: number, crc = false): Uint8Array {
  const frame = new Uint8Array(208);
  frame.set((toneFrames[0] as Uint8Array).subarray(0, 4));
  frame[2] = (frame[2] as number) & ~0x02; // no padding byte: 208 bytes
  if (crc) frame[1] = (frame[1] as number) & ~0x01; // protection bit 0: a CRC follows the header
  const tag = 4 + 17;
  frame.set(new TextEncoder().encode("Info"), tag);
  const view = new DataView(frame.buffer);
  view.setUint32(tag + 4, 1, false); // frame count present
  view.setUint32(tag + 8, frames, false);
  if (delay !== undefined && padding !== undefined) {
    const lame = tag + 12;
    frame.set(new TextEncoder().encode("LAME3.100"), lame);
    frame[lame + 21] = delay >> 4;
    frame[lame + 22] = ((delay & 0x0f) << 4) | (padding >> 8);
    frame[lame + 23] = padding & 0xff;
  }
  return frame;
}

describe("MP3 decoding", () => {
  it("decodes the tone at 44.1 kHz to its pitch, level and the frame walk's length", async () => {
    const { frames, rate, keep } = scanMp3(toneMp3);
    expect([rate, keep]).toEqual([44_100, frames * 1_152]);
    const out = joined(await decodeAll(toneMp3));
    expect(out.length).toBe(Math.ceil((keep * 16_000) / 44_100));
    expect(Math.abs(frequency(out) - 440)).toBeLessThan(2);
    // LAME scales this tone to 0.950 of its level before minimp3 sees it (both fixtures, 64 and 128 kbit/s, measured
    // from minimp3's own output); the pipeline after the decoder must keep that level within 1 %.
    const native = nativeRms(toneMp3);
    expect(native / TONE_RMS).toBeCloseTo(0.95, 2);
    expect(Math.abs(rms(out, 8_000, 40_000) / native - 1)).toBeLessThan(0.01);
  });

  it("mixes a stereo file down: the tone on one side and silence on the other at half level", async () => {
    const mono = joined(await decodeAll(toneMp3));
    const stereo = joined(await decodeAll(toneStereoMp3));
    expect(rms(stereo, 8_000, 40_000) / rms(mono, 8_000, 40_000)).toBeCloseTo(0.5, 1);
  });

  it("decodes MPEG-2 (16 kHz), MPEG-2.5 (8 kHz) and a variable-bitrate stream", async () => {
    for (const [mp3, rate] of [
      [tone16kMp3, 16_000],
      [tone8kMp3, 8_000],
    ] as const) {
      const layout = scanMp3(mp3);
      expect([layout.rate, layout.frameSamples]).toEqual([rate, 576]);
      const out = joined(await decodeAll(mp3));
      expect(out.length).toBe(Math.ceil((layout.keep * 16_000) / rate));
      expect(Math.abs(frequency(out) - 440)).toBeLessThan(2);
    }
    // Two complete encodings at 64 and 128 kbit/s, joined: frames of two lengths in one stream.
    const vbr = concat([toneMp3, tone128kMp3]);
    const layout = scanMp3(vbr);
    expect(layout.frames).toBe(scanMp3(toneMp3).frames + scanMp3(tone128kMp3).frames);
    expect(joined(await decodeAll(vbr)).length).toBe(Math.ceil((layout.keep * 16_000) / 44_100));
  });

  it("does not fold a 12 kHz tone back into the 16 kHz output (D01 T03 §9)", async () => {
    // Goertzel amplitude at `hz` over the middle of a signal, as a fraction of full scale.
    const amplitude = (pcm: Int16Array, hz: number, rate: number) => {
      const from = Math.floor(pcm.length * 0.2);
      const to = Math.floor(pcm.length * 0.8);
      const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < to; i++) {
        const s0 = (pcm[i] as number) / 32768 + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return (2 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0))) / (to - from);
    };
    // The baseline: minimp3's own 44.1 kHz output still holds the tone, within 3 dB of the 0.5 amplitude encoded.
    const decoder = createMp3Decoder(scanMp3(tone12kMp3).audio);
    const blocks: Int16Array[] = [];
    for (let block = decoder.decode(5); block.samples > 0; block = decoder.decode(5)) blocks.push(block.pcm);
    const native = amplitude(concatPcm(blocks), 12_000, 44_100);
    expect(Math.abs(20 * Math.log10(native / 0.5))).toBeLessThan(3);
    // After resampling to 16 kHz, its alias at 4 kHz is at least 60 dB below that decoded level.
    const out = joined(await decodeAll(tone12kMp3));
    expect(20 * Math.log10(amplitude(out, 4_000, 16_000) / native)).toBeLessThan(-60);
  });

  it("sets tags aside: ID3v2.4 with its footer, ID3v1 and APE", async () => {
    const id3v2 = new Uint8Array(10 + 20 + 10);
    id3v2.set([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 20]); // "ID3" 2.4, footer flag, syncsafe size 20
    id3v2.set([0x33, 0x44, 0x49, 4, 0, 0x10, 0, 0, 0, 20], 30); // "3DI" footer
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]); // "TAG"
    const ape = new Uint8Array(32 + 10);
    ape.set(new TextEncoder().encode("APETAGEX"), 10);
    new DataView(ape.buffer).setUint32(10 + 12, 42, true); // items (10) and footer (32), no header
    const plain = joined(await decodeAll(toneMp3));
    expect(joined(await decodeAll(concat([id3v2, toneMp3, ape, id3v1])))).toEqual(plain);
  });

  it("gives the same samples whatever the decode batch and chunk sizes", async () => {
    const whole = joined(await decodeAll(toneMp3));
    const small = await decodeAll(toneMp3, { mp3BatchSeconds: 0.37, chunkSeconds: 0.1 });
    expect(small.length).toBeGreaterThan(20);
    expect(joined(small)).toEqual(whole);
  });

  it("decodes at most 5 seconds a call, and ends cleanly when the caller stops early", async () => {
    let largest = 0;
    const counting = (audio: Uint8Array): Mp3Stream => {
      const real = createMp3Decoder(audio);
      return {
        decode: (seconds) => {
          const block = real.decode(seconds);
          largest = Math.max(largest, block.samples);
          return block;
        },
      };
    };
    await decodeAll(repeated(toneFrames.length * 5), { mp3Decoder: counting }); // 15 s
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(5 * 44_100); // whole frames, never past 5 seconds (round 1)
    expect(largest).toBeGreaterThan(5 * 44_100 - 1_152);
    for await (const _chunk of decodeToWavChunks(toneMp3, "audio/mpeg", { chunkSeconds: 0.5 })) break;
  });

  it("decodes a 25-minute MP3 into three 10-minute chunks", { timeout: 180_000 }, async () => {
    const frames = Math.ceil((25 * 60 * 44_100) / 1_152);
    const lengths = (await decodeAll(repeated(frames))).map((c) => samples(c).length);
    expect(lengths.slice(0, 2)).toEqual([9_600_000, 9_600_000]);
    expect(lengths[2]).toBe(Math.ceil((frames * 1_152 * 16_000) / 44_100) - 19_200_000);
  });

  it("takes exactly 30 minutes by its LAME tag, and refuses 31 minutes before decoding", {
    timeout: 180_000,
  }, async () => {
    // 68,908 frames less the encoder delay (576) and padding (1,440): 79,380,000 samples, 1,800 s at 44.1 kHz.
    const exact = concat([infoFrame(68_908, 576, 1_440), repeated(68_908)]);
    expect(scanMp3(exact).keep).toBe(1_800 * 44_100);
    const lengths = (await decodeAll(exact)).map((c) => samples(c).length);
    expect(lengths).toEqual([9_600_000, 9_600_000, 9_600_000]);
    let made = 0;
    const counting = (audio: Uint8Array) => {
      made++;
      return createMp3Decoder(audio);
    };
    const longer = repeated(Math.ceil((31 * 60 * 44_100) / 1_152));
    expect(await refusal(longer, { mp3Decoder: counting })).toBeInstanceOf(AudioTooLong);
    expect(made).toBe(0);
  });

  it("drops the encoder delay and padding a LAME tag declares", async () => {
    const plain = joined(await decodeAll(toneMp3));
    const n = toneFrames.length;
    const tagged = joined(await decodeAll(concat([infoFrame(n, 576, 1_000), toneMp3])));
    expect(tagged.length).toBe(Math.ceil(((n * 1_152 - 576 - 1_000) * 16_000) / 44_100));
    expect(tagged.length).toBeLessThan(plain.length);
    // A Xing frame alone (no LAME tag) only counts frames: nothing is dropped.
    expect(joined(await decodeAll(concat([infoFrame(n), toneMp3]))).length).toBe(plain.length);
  });

  it("reads a LAME tag in a frame that announces a CRC, where LAME writes it (round 1)", async () => {
    const n = toneFrames.length;
    const tagged = joined(await decodeAll(concat([infoFrame(n, 576, 1_000, true), toneMp3])));
    expect(tagged.length).toBe(Math.ceil(((n * 1_152 - 576 - 1_000) * 16_000) / 44_100));
    const cut = await refusal(concat([infoFrame(n, 576, 1_000, true), concat(toneFrames.slice(0, -3))]));
    expect(cut.message).toMatch(/frames where its Xing header declares/);
  });

  describe("damage is refused by name", () => {
    const cases: [string, () => Uint8Array, RegExp][] = [
      [
        "cut in the middle of a frame",
        () => toneMp3.slice(0, toneMp3.length - 100),
        /cut short in the middle of a frame/,
      ],
      [
        "cut at a frame boundary, short of its Xing count",
        () => concat([infoFrame(toneFrames.length), concat(toneFrames.slice(0, -3))]),
        /frames where its Xing header declares/,
      ],
      [
        "a frame header with flipped bytes",
        () => {
          const b = toneMp3.slice();
          const at = toneFrames.slice(0, 10).reduce((n, f) => n + f.length, 0); // the eleventh frame's header
          b[at + 2] = 0xff; // bitrate index 15, sample rate index 3
          return b;
        },
        /frame header at byte \d+ is damaged/,
      ],
      [
        "junk between frames",
        () => concat([concat(toneFrames.slice(0, 10)), new Uint8Array(37), concat(toneFrames.slice(10))]),
        /not a frame at byte/,
      ],
      [
        "an ID3v2 tag whose size runs past the file",
        () => {
          const tag = new Uint8Array(10);
          tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]);
          return concat([tag, toneMp3]);
        },
        /ID3v2 tag runs past the end/,
      ],
      ["an empty file", () => new Uint8Array(0), /empty/],
      [
        "a file of tags only",
        () => {
          const tag = new Uint8Array(128);
          tag.set([0x54, 0x41, 0x47]);
          return tag;
        },
        /tags but no audio/,
      ],
    ];
    for (const [name, make, message] of cases)
      it(name, async () => {
        const error = await refusal(make());
        expect(error).toBeInstanceOf(CorruptAudio);
        expect(error.message).toMatch(message);
      });

    it("frames whose contents minimp3 refuses, with every header intact (completion review)", async () => {
      // The 17 bytes of mono MPEG-1 side information after each 4-byte header, set to 0xff: headers and lengths are
      // whole, so only the real decoder can tell.
      const damaged = (which: (index: number) => boolean) =>
        concat(
          toneFrames.map((frame, index) => {
            if (!which(index)) return frame;
            const copy = frame.slice();
            copy.fill(0xff, 4, 4 + 17);
            return copy;
          }),
        );
      const everywhere = await refusal(damaged(() => true));
      expect(everywhere).toBeInstanceOf(CorruptAudio);
      expect(everywhere.message).toMatch(/^MP3 frame 0 does not decode/);
      // Damage after valid audio: frame 50 alone.
      const later = await refusal(damaged((index) => index === 50));
      expect(later).toBeInstanceOf(CorruptAudio);
      expect(later.message).toMatch(/^MP3 frame 50 does not decode/);
    });

    it("Layer II and free-format files as unsupported", async () => {
      const layer2 = toneMp3.slice();
      layer2[1] = ((layer2[1] as number) & ~0x06) | 0x04; // layer bits 10: Layer II
      const free = toneMp3.slice();
      free[2] = (free[2] as number) & 0x0f; // bitrate index 0: free format
      for (const [bytes, message] of [
        [layer2, /Layer II/],
        [free, /free format/],
      ] as const) {
        const error = await refusal(bytes);
        expect(error).toBeInstanceOf(UnsupportedAudio);
        expect(error.message).toMatch(message);
      }
    });

    it("a decoder that throws, or stops before the frames are done", async () => {
      const throwing = (): Mp3Stream => ({
        decode: () => {
          throw new RangeError("memory access out of bounds");
        },
      });
      expect((await refusal(toneMp3, { mp3Decoder: throwing })).message).toMatch(/decoder failed \(RangeError/);
      const stalling = (): Mp3Stream => ({ decode: () => ({ pcm: new Int16Array(0), channels: 1, samples: 0 }) });
      expect((await refusal(toneMp3, { mp3Decoder: stalling })).message).toMatch(/decoder stopped after 0 of/);
      const failing = () => {
        throw new Error("instantiate failed");
      };
      expect((await refusal(toneMp3, { mp3Decoder: failing })).message).toMatch(/decoder failed/);
    });
  });
});
