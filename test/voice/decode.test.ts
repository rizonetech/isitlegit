import { describe, expect, it } from "vitest";
import {
  AudioTooLong,
  CorruptAudio,
  createOpusDecoder,
  decodeToWavChunks,
  type OpusLayout,
  type OpusStream,
  Resampler,
  UnsupportedAudio,
} from "../../src/voice/decode";
import { toneOgg, toneStereoOgg, toneWav } from "../fixtures/audio/load";
import {
  BOS,
  concat,
  EOS,
  oggCrc,
  oggPackets,
  oggPage,
  oggRawPage,
  oggStream,
  tone,
  wavFile,
} from "../fixtures/audio/ogg";

// D01 T03 §2: voice notes decoded to 16 kHz mono 16-bit WAV, checked by their sound, not only their headers.

type Wav = { format: number; channels: number; rate: number; bits: number; riffSize: number; samples: Int16Array };
function readWav(chunk: Uint8Array): Wav {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const ascii = (at: number) => String.fromCharCode(...chunk.subarray(at, at + 4));
  expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
  const dataSize = view.getUint32(40, true);
  expect(dataSize).toBe(chunk.length - 44);
  return {
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    riffSize: view.getUint32(4, true),
    samples: new Int16Array(chunk.slice(44).buffer),
  };
}

async function decodeAll(bytes: Uint8Array, type: string, options = {}): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of decodeToWavChunks(bytes, type, options)) out.push(chunk);
  return out;
}

const rms = (s: Int16Array, from = 0, to = s.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (s[i] as number) ** 2;
  return Math.sqrt(sum / (to - from));
};
// Frequency from zero crossings over a stretch clear of the start and the end.
const frequency = (s: Int16Array, rate: number) => {
  const from = Math.floor(rate * 0.25);
  const to = s.length - Math.floor(rate * 0.25);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if ((s[i - 1] as number) < 0 !== (s[i] as number) < 0) crossings++;
  return crossings / 2 / ((to - from) / rate);
};

// The fixture's Opus packets, and a stream of `repeats` copies of them (granules and checksums rebuilt).
const fixture = oggPackets(toneOgg);
const headers = fixture.slice(0, 2).map((p) => p.packet);
const audio = fixture.slice(2).map((p) => p.packet);
const repeated = (repeats: number) => oggStream(headers, Array.from({ length: repeats }, () => audio).flat(), 960);

// The real decoder, as decode.ts makes it, counting what it is asked to do.
const counting = () => {
  const seen = { made: 0, freed: 0, batches: 0, largest: 0, total: 0 };
  const make = (layout: OpusLayout): OpusStream => {
    seen.made++;
    const decoder = createOpusDecoder(layout);
    return {
      ready: decoder.ready,
      decodeFrames: (packets) => {
        const out = decoder.decodeFrames(packets);
        seen.batches++;
        seen.largest = Math.max(seen.largest, out.samplesDecoded);
        seen.total += out.samplesDecoded;
        return out;
      },
      free: () => {
        seen.freed++;
        decoder.free();
      },
    };
  };
  return { seen, make };
};

describe("Resampler", () => {
  const run = (rate: number, blocks: Float32Array[]) => {
    const out: number[] = [];
    const resampler = new Resampler(rate, (s) => out.push(s));
    for (const block of blocks) resampler.push(block);
    resampler.end();
    return out;
  };
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i / n);
  const split = (whole: Float32Array, sizes: number[]) => {
    const blocks: Float32Array[] = [];
    let at = 0;
    for (let i = 0; at < whole.length; i++) {
      const size = sizes[i % sizes.length] as number;
      blocks.push(whole.subarray(at, at + size));
      at += size;
    }
    return blocks;
  };

  it("gives the same samples however the input is split into blocks", () => {
    for (const rate of [48_000, 44_100, 44_101, 22_050, 8_000]) {
      const input = ramp(rate);
      const whole = run(rate, [input]);
      expect(run(rate, split(input, [1, 7, 960, 13, 2]))).toEqual(whole);
      expect(whole).toHaveLength(16_000);
    }
  });

  it("runs into silence at both ends: a constant input's first output holds the window's centre and one side", () => {
    for (const rate of [48_000, 44_100, 44_101]) {
      const out = run(rate, [new Float32Array(rate).fill(0.5)]);
      expect(out.every(Number.isFinite), `${rate}`).toBe(true);
      // The taps sum to 1; at the first output only the centre tap, h(0) = 2 x cut-off (0.95 of 8 kHz, in cycles per
      // input sample), and the side after it see the signal: (1 + h(0)) / 2 of it.
      const centre = (2 * 0.95 * 8_000) / rate;
      expect(out[0], `${rate} first`).toBeCloseTo(((1 + centre) / 2) * 0.5, 2);
      expect(out[8_000], `${rate} middle`).toBeCloseTo(0.5, 3);
      expect(out.at(-1), `${rate} last`).toBeGreaterThan(0.15);
    }
  });

  it("gives exactly ceil(N x 16000 / rate) outputs at an unusual rate, with no stray last sample (§9 round 1)", () => {
    // 600 s at 8,008 Hz: 4,804,800 inputs, exactly 9,600,000 outputs (a floating-point position once made 9,600,001).
    let count = 0;
    const r = new Resampler(8_008, () => {
      count++;
    });
    const block = new Float32Array(48_048);
    for (let i = 0; i < 100; i++) r.push(block);
    r.end();
    expect(count).toBe(9_600_000);
  });

  it("refuses a rate outside 8 to 192 kHz itself, whoever builds it (final review)", () => {
    for (const rate of [4_294_967_295, 192_001, 7_999, 44_100.5])
      expect(() => new Resampler(rate, () => {}), `${rate}`).toThrow(UnsupportedAudio);
  });

  it("keeps every sample, the last included, when the rate is already 16 kHz", () => {
    const input = ramp(1_000);
    expect(run(16_000, split(input, [3, 1, 250]))).toEqual([...input]);
  });
});

// A tone's amplitude at `hz` in 16 kHz output, by the Goertzel algorithm over the middle of the signal, as a fraction
// of full scale.
function amplitudeAt(samples: Int16Array, hz: number, rate = 16_000): number {
  const from = Math.floor(samples.length * 0.2);
  const to = Math.floor(samples.length * 0.8);
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = (samples[i] as number) / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(power, 0))) / (to - from);
}
const dB = (ratio: number) => 20 * Math.log10(ratio);
// What is left of a 16 kHz signal after the least-squares sinusoid at `hz` is taken out, over the middle of the
// signal, in dB against a 0.5-amplitude tone: the filter's noise and distortion, which a level alone does not show.
function residualDb(samples: Int16Array, hz: number): number {
  const from = Math.floor(samples.length * 0.2);
  const to = Math.floor(samples.length * 0.8);
  const w = (2 * Math.PI * hz) / 16_000;
  let cc = 0;
  let ss = 0;
  let cs = 0;
  let xc = 0;
  let xs = 0;
  for (let i = from; i < to; i++) {
    const c = Math.cos(w * i);
    const n = Math.sin(w * i);
    const x = (samples[i] as number) / 32768;
    cc += c * c;
    ss += n * n;
    cs += c * n;
    xc += x * c;
    xs += x * n;
  }
  const det = cc * ss - cs * cs;
  const a = (xc * ss - xs * cs) / det;
  const b = (xs * cc - xc * cs) / det;
  let rest = 0;
  for (let i = from; i < to; i++)
    rest += ((samples[i] as number) / 32768 - a * Math.cos(w * i) - b * Math.sin(w * i)) ** 2;
  return dB(Math.sqrt(rest / (to - from)) / (0.5 * Math.SQRT1_2));
}
const toneAt = (rate: number, hz: number) => wavFile(tone(rate, 1, hz, 0.5), rate, 1);
async function resampled(rate: number, hz: number): Promise<Int16Array> {
  const out: Uint8Array[] = [];
  for await (const chunk of decodeToWavChunks(toneAt(rate, hz), "audio/wav")) out.push(chunk);
  return new Int16Array((out[0] as Uint8Array).slice(44).buffer);
}

describe("the resampler's filter (D01 T03 §9)", () => {
  // 44,101 Hz has 16,000 output phases, more than are held one per phase: the kernel blends its table's sets. 96 and
  // 192 kHz are the top of the range taken (the final review).
  for (const rate of [48_000, 44_100, 44_101, 96_000, 192_000])
    it(`keeps the passband flat and folds nothing back from ${rate} Hz`, async () => {
      // The passband, to 0.4 of the output rate: within 0.5 dB of the input's 0.5 amplitude.
      for (const hz of [300, 1_000, 3_000, 6_400]) {
        const level = dB(amplitudeAt(await resampled(rate, hz), hz) / 0.5);
        expect(Math.abs(level), `${hz} Hz`).toBeLessThan(0.5);
      }
      // Noise and distortion around the tone: at most -80 dB at 6.4 kHz (a timing error of 1/512 of a sample, from
      // reading the wrong tap set, leaves about -66 dB; the filter as built, about -90 dB). Final review.
      expect(residualDb(await resampled(rate, 6_400), 6_400), `${rate} Hz residual`).toBeLessThan(-80);
      // The stopband: what a tone above 8 kHz would fold into is at least 60 dB down.
      for (const [hz, alias] of [
        [9_000, 7_000],
        [12_000, 4_000],
        [20_000, 4_000],
      ] as const) {
        const leak = dB(amplitudeAt(await resampled(rate, hz), alias) / 0.5);
        expect(leak, `${hz} Hz folding to ${alias} Hz`).toBeLessThan(-60);
      }
    });

  it("upsamples 8 kHz with the passband kept and no image", async () => {
    const out = await resampled(8_000, 3_000);
    expect(Math.abs(dB(amplitudeAt(out, 3_000) / 0.5))).toBeLessThan(0.5);
    // The image of 3 kHz around the input's 4 kHz Nyquist: 5 kHz.
    expect(dB(amplitudeAt(out, 5_000) / 0.5)).toBeLessThan(-60);
  });
});

describe("decodeToWavChunks", () => {
  it("decodes an Ogg Opus voice note to the tone it holds, with nothing compiled at runtime", async () => {
    // A Worker refuses runtime compilation anyway; this proves the decoder never asks for it.
    // The Workers types leave `compile` out, since the runtime refuses it.
    const wasm = WebAssembly as unknown as { compile: (bytes: BufferSource) => Promise<WebAssembly.Module> };
    const compile = wasm.compile;
    let compiles = 0;
    wasm.compile = () => {
      compiles++;
      throw new Error("runtime compilation");
    };
    let chunks: Uint8Array[];
    try {
      chunks = await decodeAll(toneOgg, "audio/ogg");
    } finally {
      wasm.compile = compile;
    }
    expect(compiles).toBe(0);
    expect(chunks).toHaveLength(1);
    const wav = readWav(chunks[0] as Uint8Array);
    expect([wav.format, wav.channels, wav.rate, wav.bits]).toEqual([1, 1, 16_000, 16]);
    expect(wav.riffSize).toBe(36 + wav.samples.length * 2);
    // 150 packets of 20 ms, less the 312-sample pre-skip (48 kHz), which is 104 samples at 16 kHz.
    expect(wav.samples.length).toBe(48_000 - 104);
    expect(Math.abs(frequency(wav.samples, 16_000) - 440)).toBeLessThan(2);
    // The tone at half of full scale: RMS 0.5 / sqrt(2) of 32768, within 10% after lossy coding.
    expect(rms(wav.samples, 4_000, 44_000) / (0.5 * 32768 * Math.SQRT1_2)).toBeCloseTo(1, 1);
  });

  it("resamples and mixes down a 44.1 kHz stereo WAV, keeping the tone's pitch and level", async () => {
    const chunks = await decodeAll(toneWav, "audio/wav");
    expect(chunks).toHaveLength(1);
    const wav = readWav(chunks[0] as Uint8Array);
    expect([wav.format, wav.channels, wav.rate, wav.bits]).toEqual([1, 1, 16_000, 16]);
    expect(wav.samples.length).toBe(48_000);
    expect(Math.abs(frequency(wav.samples, 16_000) - 440)).toBeLessThan(2);
    const source = tone(44_100, 3);
    expect(Math.abs(rms(wav.samples) / rms(source) - 1)).toBeLessThan(0.05);
  });

  it("averages channels: the tone against its inverse mixes down to silence", async () => {
    const left = tone(44_100, 1);
    const stereo = new Int16Array(left.length * 2);
    left.forEach((v, i) => {
      stereo[2 * i] = v;
      stereo[2 * i + 1] = -v;
    });
    const wav = readWav((await decodeAll(wavFile(stereo, 44_100, 2), "audio/wav"))[0] as Uint8Array);
    expect(rms(wav.samples)).toBeLessThan(2);
  });

  it("averages an Opus file's channels: the tone on one side and silence on the other comes out at half level", async () => {
    const mono = readWav((await decodeAll(toneOgg, "audio/ogg"))[0] as Uint8Array).samples;
    const stereo = readWav((await decodeAll(toneStereoOgg, "audio/ogg"))[0] as Uint8Array).samples;
    expect(stereo.length).toBe(mono.length);
    expect(rms(stereo, 4_000, 44_000) / rms(mono, 4_000, 44_000)).toBeCloseTo(0.5, 1);
    expect(Math.abs(frequency(stereo, 16_000) - 440)).toBeLessThan(2);
  });

  it("splits into chunks with no sample lost or repeated at a boundary", async () => {
    const whole = readWav((await decodeAll(toneWav, "audio/wav"))[0] as Uint8Array).samples;
    const chunks = await decodeAll(toneWav, "audio/wav", { chunkSeconds: 0.1 });
    expect(chunks).toHaveLength(30);
    const parts = chunks.map((c) => readWav(c).samples);
    expect(parts.every((p) => p.length === 1_600)).toBe(true);
    const joined = new Int16Array(whole.length);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    expect(at).toBe(whole.length);
    expect(joined).toEqual(whole);
    // The same through the Opus path, whose decoder gives its blocks in other sizes.
    const opusWhole = readWav((await decodeAll(toneOgg, "audio/ogg"))[0] as Uint8Array).samples;
    const opusParts = (await decodeAll(toneOgg, "audio/ogg", { chunkSeconds: 0.37 })).map((c) => readWav(c).samples);
    expect(opusParts.reduce((n, p) => n + p.length, 0)).toBe(opusWhole.length);
    expect(Int16Array.from(opusParts.flatMap((p) => [...p]))).toEqual(opusWhole);
  });

  it("decodes a 25-minute recording into three 10-minute chunks", { timeout: 180_000 }, async () => {
    const long = repeated(500); // 500 x 3 s
    expect(long.length).toBeLessThan(25 * 1024 * 1024);
    const lengths: number[] = [];
    const started = performance.now();
    const at: number[] = [];
    for await (const chunk of decodeToWavChunks(long, "audio/ogg")) {
      at.push(performance.now() - started);
      const wav = readWav(chunk);
      expect([wav.channels, wav.rate, wav.bits]).toEqual([1, 16_000, 16]);
      lengths.push(wav.samples.length);
    }
    expect(lengths).toEqual([9_600_000, 9_600_000, 4_800_000 - 104]);
    // The measured times (completion review: first chunk and completion), for the section's evidence.
    console.log(`decode timing: first chunk ${Math.round(at[0] ?? 0)} ms, all ${Math.round(at.at(-1) ?? 0)} ms`);
  });

  it("refuses a recording over 30 minutes before decoding any of it", async () => {
    const { seen, make } = counting();
    await expect(decodeAll(repeated(620), "audio/ogg", { opusDecoder: make })).rejects.toBeInstanceOf(AudioTooLong);
    expect(seen.made).toBe(0);
  });

  it("frees the decoder when the caller stops after the first chunk", async () => {
    const { seen, make } = counting();
    for await (const _chunk of decodeToWavChunks(toneOgg, "audio/ogg", { opusDecoder: make, chunkSeconds: 0.5 })) break;
    expect(seen).toMatchObject({ made: 1, freed: 1 });
  });

  it("decodes in batches of at most 5 seconds, never the whole file", async () => {
    const { seen, make } = counting();
    await decodeAll(repeated(10), "audio/ogg", { opusDecoder: make }); // 30 s
    expect(seen.batches).toBe(6);
    expect(seen.largest).toBeLessThanOrEqual(5 * 16_000);
  });

  it("keeps a highly compressed stereo stream within its batches (completion review)", {
    timeout: 180_000,
  }, async () => {
    // 2-byte packets of six empty 20 ms CELT frames each (TOC code 3, stereo): 120 ms of audio per packet, the most
    // audio per byte Opus allows. 29 minutes in about 450 KB: decoded whole at 48 kHz it would need 668 MB.
    const stereoHead = (headers[0] as Uint8Array).slice();
    stereoHead[9] = 2;
    const packets = Array.from({ length: 14_500 }, () => Uint8Array.from([0xff, 0x06]));
    const dense = oggStream([stereoHead, headers[1] as Uint8Array], packets, 5_760);
    expect(dense.length).toBeLessThan(500_000);
    const { seen, make } = counting();
    const lengths = (await decodeAll(dense, "audio/ogg", { opusDecoder: make })).map((c) => readWav(c).samples.length);
    expect(lengths).toEqual([9_600_000, 9_600_000, 29 * 60 * 16_000 - 104 - 19_200_000]);
    // No batch decodes more than 5 seconds plus one packet: 2 channels x 81,920 floats, 655 KB.
    expect(seen.largest).toBeLessThanOrEqual(5 * 16_000 + 1_920);
    expect(seen.total).toBe(29 * 60 * 16_000 - 104);
  });

  it("refuses M4A by type until D01 T03 §10 decodes it, naming the formats it takes", async () => {
    const m4a = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    const refusal = await decodeAll(m4a, "audio/mp4").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(UnsupportedAudio);
    expect((refusal as UnsupportedAudio).type).toBe("audio/mp4");
    // In the member's terms, with the next step and the formats taken (D01 T03 §8's completion review).
    const message = (refusal as Error).message;
    expect(message).toMatch(/^This recording is M4A \(AAC, as iPhone voice memos are\)/);
    expect(message).toMatch(/Export it as MP3 or WAV, or send it as a WhatsApp voice note \(Ogg Opus\)/);
    for (const type of ["audio/x-m4a", "audio/aac"])
      expect(new UnsupportedAudio(type).message).toMatch(/^This recording is M4A/);
    expect(new UnsupportedAudio("audio/flac").message).toBe(
      "Audio of type audio/flac cannot be checked. Upload it as Ogg Opus, WAV or MP3.",
    );
  });

  describe("damaged audio is refused, never passed on", () => {
    const refusal = async (bytes: Uint8Array, type: string, options = {}) => {
      const error = await decodeAll(bytes, type, options).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CorruptAudio);
      return (error as Error).message;
    };

    it("an Ogg cut short, empty, without audio, or not Opus", async () => {
      expect(await refusal(toneOgg.slice(0, Math.floor(toneOgg.length * 0.6)), "audio/ogg")).toMatch(/cut short/);
      expect(await refusal(new Uint8Array(0), "audio/ogg")).toMatch(/empty/);
      // Cut exactly at a page boundary: every page is whole, but the stream never ends.
      const pages = [oggPage(headers[0] as Uint8Array, BOS, 0n, 0), oggPage(headers[1] as Uint8Array, 0, 0n, 1)];
      audio.slice(0, 50).forEach((p, i) => {
        pages.push(oggPage(p, 0, BigInt((i + 1) * 960), i + 2));
      });
      const atBoundary = Uint8Array.from(pages.flatMap((p) => [...p]));
      expect(await refusal(atBoundary, "audio/ogg")).toMatch(/does not end the stream/);
      expect(await refusal(oggStream(headers, [], 960), "audio/ogg")).toMatch(/cut short|no audio/);
      const tagsLast = oggStream([headers[0] as Uint8Array], [headers[1] as Uint8Array], 0);
      expect(await refusal(tagsLast, "audio/ogg")).toMatch(/no audio/);
      const notOpus = oggStream([new TextEncoder().encode("OpusHeadless______")], audio.slice(0, 3), 960);
      expect(await refusal(notOpus, "audio/ogg")).toMatch(/OpusHead|not Opus/);
    });

    it("an Ogg page with flipped bytes fails its checksum", async () => {
      const flipped = toneOgg.slice();
      const middle = Math.floor(flipped.length / 2);
      flipped[middle] = (flipped[middle] as number) ^ 0xff;
      expect(await refusal(flipped, "audio/ogg")).toMatch(/fails its checksum/);
      // The test's own checksum agrees with the decoder's on an intact stream.
      expect(oggCrc(new Uint8Array(0))).toBe(0);
    });

    it("an Opus frame the decoder reports as bad, in pages whose checksums are intact", async () => {
      // TOC code 1 (two frames of equal size) over an odd payload: a valid duration, but libopus refuses it.
      const bad = audio.map((p, i) => (i === 75 ? Uint8Array.from([0xf9, 0x00]) : p));
      expect(await refusal(oggStream(headers, bad, 960), "audio/ogg")).toMatch(/damaged frames/);
    });

    it("a malformed Opus packet: no frames, too long, or larger than the decoder takes (completion review)", async () => {
      const withPacket = (packet: Uint8Array) =>
        oggStream(
          headers,
          audio.map((p, i) => (i === 75 ? packet : p)),
          960,
        );
      expect(await refusal(withPacket(Uint8Array.from([0x03, 0x00])), "audio/ogg")).toMatch(/packet 75 is malformed/);
      // Code 3 asking for 7 frames of 20 ms: 140 ms, past Opus's 120 ms.
      expect(await refusal(withPacket(Uint8Array.from([0xfb, 0x07])), "audio/ogg")).toMatch(/packet 75 is malformed/);
      const huge = new Uint8Array(5_000);
      huge[0] = 0xf8;
      expect(await refusal(withPacket(huge), "audio/ogg")).toMatch(/packet 75 is larger/);
    });

    it("anything the decoder throws, as a typed refusal (completion review)", async () => {
      const throwing = (): OpusStream => ({
        ready: Promise.resolve(),
        decodeFrames: () => {
          throw new RangeError("offset is out of bounds");
        },
        free: () => {},
      });
      expect(await refusal(toneOgg, "audio/ogg", { opusDecoder: throwing })).toMatch(
        /RangeError: offset is out of bounds/,
      );
    });

    it("an Ogg with a page taken out, its checksums all intact (completion review)", async () => {
      const pages = oggPackets(toneOgg).map((p, i) => oggPage(p.packet, p.flags, p.granule, i));
      pages.splice(80, 1);
      expect(await refusal(Uint8Array.from(pages.flatMap((p) => [...p])), "audio/ogg")).toMatch(/page 80 is missing/);
    });

    it("an Opus stream that decodes to nothing", async () => {
      const silent = (): OpusStream => {
        const none = { channelData: [], samplesDecoded: 0, errors: [] };
        return { ready: Promise.resolve(), decodeFrames: () => none, free: () => {} };
      };
      expect(await refusal(toneOgg, "audio/ogg", { opusDecoder: silent })).toMatch(/decoded to no audio/);
    });

    it("a WAV with a bad format code, a chunk past the end, no channels, or no RIFF header", async () => {
      const samples = tone(16_000, 0.1);
      expect(await refusal(wavFile(samples, 16_000, 1, 3), "audio/wav")).toMatch(/format 3/);
      const long = wavFile(samples, 16_000, 1);
      new DataView(long.buffer).setUint32(40, samples.byteLength * 10, true);
      expect(await refusal(long, "audio/wav")).toMatch(/runs past the end/);
      expect(await refusal(wavFile(samples, 16_000, 0), "audio/wav")).toMatch(/no channels/);
      expect(await refusal(new TextEncoder().encode("not a wave file at all"), "audio/wav")).toMatch(/RIFF WAVE/);
      // A second data chunk after 31 minutes of audio at 1 Hz (round 3): read as the only one, it would hide the length
      // and drop the rest, so it is refused; a second fmt chunk too.
      const thirtyOne = wavFile(tone(1, 1_860, 0.1), 1, 1);
      const extra = Uint8Array.from([0x64, 0x61, 0x74, 0x61, 2, 0, 0, 0, 1, 0]); // "data", 2 bytes, one sample
      const twoData = concat([thirtyOne, extra]);
      new DataView(twoData.buffer).setUint32(4, twoData.length - 8, true);
      expect(await refusal(twoData, "audio/wav")).toMatch(/more than one data chunk/);
      const fmtAgain = concat([thirtyOne.subarray(0, 36), thirtyOne.subarray(12, 36), thirtyOne.subarray(36)]);
      new DataView(fmtAgain.buffer).setUint32(4, fmtAgain.length - 8, true);
      expect(await refusal(fmtAgain, "audio/wav")).toMatch(/more than one fmt chunk/);
      // The RIFF header says the file is longer than it is: cut short, though every inner chunk fits (round 1).
      const cut = toneWav.slice();
      new DataView(cut.buffer).setUint32(4, cut.length + 1_000, true);
      expect(await refusal(cut, "audio/wav")).toMatch(/cut short/);
    });

    it("a WAV whose sample rate no recording has, before any filter is built (§9's completion review)", async () => {
      // A header can claim 4,294,967,295 Hz: a filter for that would need gigabytes.
      for (const rate of [4_294_967_295, 192_001, 7_999, 1]) {
        const file = wavFile(tone(8_000, 0.01), 8_000, 1);
        new DataView(file.buffer).setUint32(24, rate, true);
        const error = await decodeAll(file, "audio/wav").catch((e: unknown) => e as Error);
        expect(error, `${rate}`).toBeInstanceOf(UnsupportedAudio);
        expect((error as Error).message, `${rate}`).toMatch(new RegExp(`audio/wav at ${rate} Hz`));
      }
      for (const rate of [8_000, 192_000]) {
        const file = wavFile(tone(rate, 0.05), rate, 1);
        expect((await decodeAll(file, "audio/wav")).length, `${rate}`).toBe(1);
      }
    });

    it("a WAV whose data ends partway through a sample or a frame (completion review)", async () => {
      const mono = wavFile(tone(16_000, 0.1), 16_000, 1);
      const view = new DataView(mono.buffer);
      view.setUint32(40, view.getUint32(40, true) - 1, true); // 199 bytes of 16-bit samples, and so on
      expect(await refusal(mono, "audio/wav")).toMatch(/partway through a sample frame/);
      const stereo = wavFile(tone(16_000, 0.2).slice(0, 1_601), 16_000, 2); // an odd count of samples in two channels
      expect(await refusal(stereo, "audio/wav")).toMatch(/partway through a sample frame/);
    });
  });

  describe("Ogg Opus as RFC 7845 defines it (round 1)", () => {
    const opusSamples = async (bytes: Uint8Array) =>
      readWav((await decodeAll(bytes, "audio/ogg"))[0] as Uint8Array).samples;

    it("keeps only what the last page's granule position keeps: end trimming", async () => {
      // 150 packets of 960 samples hold 144,000; a final granule 480 lower trims the end: 143,520 less the
      // 312-sample pre-skip is 143,208 at 48 kHz, 47,736 at 16 kHz.
      expect((await opusSamples(oggStream(headers, audio, 960, 143_520n))).length).toBe(47_736);
      // A position past the packets, or a trim larger than the last page, is damage.
      await expect(decodeAll(oggStream(headers, audio, 960, 144_001n), "audio/ogg")).rejects.toThrow(
        /claims more audio than its packets hold/,
      );
      await expect(decodeAll(oggStream(headers, audio, 960, 144_000n - 961n), "audio/ogg")).rejects.toThrow(
        /trims more audio than its last page holds/,
      );
    });

    it("takes a recording of exactly 30 minutes, end-trimmed to the sample", { timeout: 180_000 }, async () => {
      // 90,001 packets of 20 ms, trimmed by 648 samples at the end: 1,800 s after the pre-skip.
      const packets = Array.from({ length: 90_001 }, (_, i) => audio[i % audio.length] as Uint8Array);
      const exact = oggStream(headers, packets, 960, 86_400_312n);
      const lengths = (await decodeAll(exact, "audio/ogg")).map((c) => readWav(c).samples.length);
      expect(lengths).toEqual([9_600_000, 9_600_000, 9_600_000]);
    });

    it("starts a cropped or live recording where its first page says, not at zero (round 2)", async () => {
      const shifted = oggPackets(toneOgg).map((p, i) =>
        oggPage(p.packet, p.flags, i < 2 ? p.granule : p.granule + 48_000n, i),
      );
      expect((await opusSamples(concat(shifted))).length).toBe(47_896);
      // A first audio page whose position is below the audio on it, with pages after it, is damage.
      const below = oggPackets(toneOgg).map((p, i) => oggPage(p.packet, p.flags, i === 2 ? 100n : p.granule, i));
      await expect(decodeAll(concat(below), "audio/ogg")).rejects.toThrow(/first audio page claims less audio/);
    });

    it("refuses an OpusTags header cut short (round 2)", async () => {
      const tags = headers[1] as Uint8Array;
      const view = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
      const vendor = view.getUint32(8, true);
      const comments = tags.slice();
      new DataView(comments.buffer).setUint32(12 + vendor, 3, true); // three comments that are not there
      for (const cut of [tags.slice(0, 8), tags.slice(0, 12 + vendor), comments]) {
        await expect(decodeAll(oggStream([headers[0] as Uint8Array, cut], audio, 960), "audio/ogg")).rejects.toThrow(
          /OpusTags header is cut short/,
        );
      }
      // One comment whose stated length runs past the packet.
      const overrun = new Uint8Array(tags.length + 4);
      overrun.set(tags);
      new DataView(overrun.buffer).setUint32(12 + vendor, 1, true);
      new DataView(overrun.buffer).setUint32(16 + vendor, 10_000, true);
      await expect(decodeAll(oggStream([headers[0] as Uint8Array, overrun], audio, 960), "audio/ogg")).rejects.toThrow(
        /OpusTags header is cut short/,
      );
      const longVendor = tags.slice();
      new DataView(longVendor.buffer).setUint32(8, 10_000, true);
      await expect(
        decodeAll(oggStream([headers[0] as Uint8Array, longVendor], audio, 960), "audio/ogg"),
      ).rejects.toThrow(/OpusTags header is cut short/);
    });

    it("follows RFC 3533's page rules and RFC 7845's header layout, each refused by name (round 4)", async () => {
      const fixturePages = oggPackets(toneOgg);
      // The fixture with one byte of page `index` set, checksums rebuilt.
      const rebuilt = (index: number, offset: number, value: number) =>
        concat(
          fixturePages.map((p, i) => {
            const page = oggPage(p.packet, p.flags, p.granule, i);
            if (i === index) {
              page[offset] = value;
              new DataView(page.buffer).setUint32(22, 0, true);
              new DataView(page.buffer).setUint32(22, oggCrc(page), true);
            }
            return page;
          }),
        );
      // The error a decode ends with, or one saying it decoded.
      const refused = (bytes: Uint8Array): Promise<Error> =>
        decodeAll(bytes, "audio/ogg").then(
          () => new Error("decoded"),
          (e: unknown) => e as Error,
        );
      // Audio after a page that ended the stream.
      const tenth = fixturePages[10] as { flags: number };
      expect((await refused(rebuilt(10, 5, tenth.flags | EOS))).message).toMatch(
        /goes on after page 10, which ended it/,
      );
      expect((await refused(rebuilt(5, 4, 1))).message).toMatch(/unknown version/);
      expect((await refused(rebuilt(5, 5, 0x08))).message).toMatch(/does not define/);
      expect((await refused(rebuilt(0, 5, 0))).message).toMatch(/does not begin the stream/);
      // Header pages at a position other than 0.
      expect((await refused(rebuilt(1, 6, 5))).message).toMatch(/granule position 0/);
      // OpusHead version 1.0 (16): a layout this decoder does not know.
      const v16 = (headers[0] as Uint8Array).slice();
      v16[8] = 16;
      const unknown = await refused(oggStream([v16, headers[1] as Uint8Array], audio, 960));
      expect(unknown).toBeInstanceOf(UnsupportedAudio);
      expect(unknown.message).toMatch(/header version 16/);
      // OpusHead and OpusTags sharing the first page; OpusTags and the first audio packet sharing a page.
      const [head, tags] = [headers[0] as Uint8Array, headers[1] as Uint8Array];
      const shared = (pages: Uint8Array[]) => refused(concat(pages));
      const audioPages = (from: number, sequence: number) =>
        audio
          .slice(from)
          .map((p, i) =>
            oggPage(p, from + i === audio.length - 1 ? EOS : 0, BigInt((from + i + 1) * 960), sequence + i),
          );
      expect(
        (await shared([oggRawPage([head.length, tags.length], concat([head, tags]), BOS, 0n, 0), ...audioPages(0, 1)]))
          .message,
      ).toMatch(/OpusTags does not start the second page/);
      // An OpusHead (with trailing bytes, 300 in all) split over the first two pages.
      const longHead = new Uint8Array(300);
      longHead.set(head);
      expect(
        (
          await shared([
            oggRawPage([255], longHead.subarray(0, 255), BOS, -1n, 0),
            oggRawPage([45], longHead.subarray(255), 0x01, 0n, 1),
            oggPage(tags, 0, 0n, 2),
            ...audioPages(0, 3),
          ])
        ).message,
      ).toMatch(/OpusHead is not alone on its first page/);
      const first = audio[0] as Uint8Array;
      expect(
        (
          await shared([
            oggPage(head, BOS, 0n, 0),
            oggRawPage([tags.length, first.length], concat([tags, first]), 0, 960n, 1),
            ...audioPages(1, 2),
          ])
        ).message,
      ).toMatch(/header pages are not at granule position 0|audio starts on the page its OpusTags ends/);
      expect(
        (
          await shared([
            oggPage(head, BOS, 0n, 0),
            oggRawPage([tags.length, first.length], concat([tags, first]), 0, 0n, 1),
            ...audioPages(1, 2),
          ])
        ).message,
      ).toMatch(/audio starts on the page its OpusTags ends/);
    });

    it("applies the OpusHead's output gain", async () => {
      const quiet = (headers[0] as Uint8Array).slice();
      new DataView(quiet.buffer).setInt16(16, -5_120, true); // -20 dB in Q7.8
      const plain = await opusSamples(toneOgg);
      const lowered = await opusSamples(oggStream([quiet, headers[1] as Uint8Array], audio, 960));
      expect(rms(lowered, 4_000, 44_000) / rms(plain, 4_000, 44_000)).toBeCloseTo(0.1, 2);
    });

    it("joins a packet split across two pages, and refuses a page that misstates the split", async () => {
      // The stereo fixture's packets are longer than 255 bytes, so one can be split after its first 255.
      const stereo = oggPackets(toneStereoOgg);
      const stereoHeaders = stereo.slice(0, 2).map((p) => p.packet);
      const stereoAudio = stereo.slice(2).map((p) => p.packet);
      const long = stereoAudio.findIndex((p) => p.length > 255 && p.length < 510);
      expect(long).toBeGreaterThanOrEqual(0);
      const pages: Uint8Array[] = stereoHeaders.map((h, i) => oggPage(h, i === 0 ? BOS : 0, 0n, i));
      let sequence = 2;
      stereoAudio.forEach((p, i) => {
        const granule = BigInt((i + 1) * 960);
        const flags = i === stereoAudio.length - 1 ? EOS : 0;
        if (i !== long) {
          pages.push(oggPage(p, flags, granule, sequence++));
          return;
        }
        // The first 255 bytes on one page (no packet ends there: granule -1), the rest on the next, marked continued.
        pages.push(oggRawPage([255], p.subarray(0, 255), 0, -1n, sequence++));
        pages.push(oggRawPage([p.length - 255], p.subarray(255), 0x01 | flags, granule, sequence++));
      });
      const split = concat(pages);
      expect(await opusSamples(split)).toEqual(await opusSamples(toneStereoOgg));
      // The same pages with the continuation flag taken off the second half.
      const unflagged = pages.map((page) => {
        const rebuilt = page.slice();
        if (rebuilt[5] === 0x01) {
          rebuilt[5] = 0;
          new DataView(rebuilt.buffer).setUint32(22, 0, true);
          new DataView(rebuilt.buffer).setUint32(22, oggCrc(rebuilt), true);
        }
        return rebuilt;
      });
      await expect(decodeAll(concat(unflagged), "audio/ogg")).rejects.toThrow(/left a packet unfinished/);
      // And a continuation flag on a page whose predecessor ended its packet.
      const flagged = oggPackets(toneOgg).map((p, i) =>
        oggPage(p.packet, i === 10 ? p.flags | 0x01 : p.flags, p.granule, i),
      );
      await expect(decodeAll(concat(flagged), "audio/ogg")).rejects.toThrow(/continues a packet/);
    });
  });

  describe("streams this decoder does not take", () => {
    it("chained Ogg streams, each under 30 minutes, are refused before any decoding (completion review)", async () => {
      const { seen, make } = counting();
      const chained = Uint8Array.from([...repeated(320), ...repeated(320)]); // two 16-minute streams
      const refusal = await decodeAll(chained, "audio/ogg", { opusDecoder: make }).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(UnsupportedAudio);
      expect((refusal as Error).message).toMatch(/chained or multiple streams/);
      expect(seen.made).toBe(0);
    });

    it("more than two channels", async () => {
      const head = (headers[0] as Uint8Array).slice();
      head[9] = 6;
      const refusal = await decodeAll(oggStream([head, headers[1] as Uint8Array], audio, 960), "audio/ogg").catch(
        (e: unknown) => e,
      );
      expect(refusal).toBeInstanceOf(UnsupportedAudio);
      expect((refusal as Error).message).toMatch(/6 channels/);
    });
  });
});
