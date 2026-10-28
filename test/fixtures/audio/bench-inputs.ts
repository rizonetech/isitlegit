// The voice decoder's benchmark inputs (D01 T03 §9), built from the committed fixtures by plain functions so the Workers
// test (our decoder) and scripts/voice-bench.ts (FFmpeg, in Node) time exactly the same bytes. Each input carries the
// output it must give: `samples` at 16 kHz, or `refused` for a damaged file.
import { oggPackets, oggStream, tone, wavFile } from "./ogg";

export type BenchInput = { name: string; type: string; bytes: Uint8Array; samples?: number; refused?: true };

// MPEG-1 Layer III frames at 44.1 kHz, split by their headers' lengths.
function mp3Frames(mp3: Uint8Array): Uint8Array[] {
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

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// A mono 16-bit WAV of the tone filling the 25 MiB upload limit (D01 T03 §1) at `rate`: the largest WAV taken.
function uploadSizedWav(rate: number): { bytes: Uint8Array; frames: number } {
  const frames = Math.floor((25 * 1024 * 1024 - 44) / 2);
  return { bytes: wavFile(tone(rate, frames / rate), rate, 1), frames };
}

export function benchInputs(toneOgg: Uint8Array, toneMp3: Uint8Array, toneWav: Uint8Array): BenchInput[] {
  const packets = oggPackets(toneOgg);
  const headers = packets.slice(0, 2).map((p) => p.packet);
  const audio = packets.slice(2).map((p) => p.packet);
  const long = oggStream(headers, Array.from({ length: 500 }, () => audio).flat(), 960);
  const stereoHead = (headers[0] as Uint8Array).slice();
  stereoHead[9] = 2;
  const dense = oggStream(
    [stereoHead, headers[1] as Uint8Array],
    Array.from({ length: 14_500 }, () => Uint8Array.from([0xff, 0x06])),
    5_760,
  );
  const damaged = toneOgg.slice();
  const middle = Math.floor(damaged.length / 2);
  damaged[middle] = (damaged[middle] as number) ^ 0xff;
  const frames = mp3Frames(toneMp3);
  const longFrames = Math.ceil((25 * 60 * 44_100) / 1_152);
  const longMp3 = join(Array.from({ length: longFrames }, (_, i) => frames[i % frames.length] as Uint8Array));
  const mp3Samples = (count: number) => Math.ceil((count * 1_152 * 16_000) / 44_100);
  const wav48 = uploadSizedWav(48_000);
  const wav44 = uploadSizedWav(44_100);
  // An unusual rate: more phases than are held one per phase, so the kernel blends its table's sets.
  const wavOdd = uploadSizedWav(44_101);
  // A WAV whose data chunk claims more than the file holds.
  const badWav = toneWav.slice();
  new DataView(badWav.buffer).setUint32(40, badWav.length * 2, true);
  return [
    { name: "note (3 s, Ogg Opus)", type: "audio/ogg", bytes: toneOgg, samples: 48_000 - 104 },
    { name: "recording (25 min, Ogg Opus)", type: "audio/ogg", bytes: long, samples: 24_000_000 - 104 },
    { name: "dense stereo (29 min, Ogg Opus)", type: "audio/ogg", bytes: dense, samples: 29 * 60 * 16_000 - 104 },
    { name: "damaged (Ogg Opus)", type: "audio/ogg", bytes: damaged, refused: true },
    { name: "note (3 s, MP3)", type: "audio/mpeg", bytes: toneMp3, samples: mp3Samples(frames.length) },
    { name: "recording (25 min, MP3)", type: "audio/mpeg", bytes: longMp3, samples: mp3Samples(longFrames) },
    { name: "note (3 s, WAV 44.1 kHz stereo)", type: "audio/wav", bytes: toneWav, samples: 48_000 },
    {
      name: "upload-sized (25 MiB, WAV 48 kHz)",
      type: "audio/wav",
      bytes: wav48.bytes,
      samples: Math.ceil((wav48.frames * 16_000) / 48_000),
    },
    {
      name: "upload-sized (25 MiB, WAV 44.1 kHz)",
      type: "audio/wav",
      bytes: wav44.bytes,
      samples: Math.ceil((wav44.frames * 16_000) / 44_100),
    },
    {
      name: "upload-sized (25 MiB, WAV 44.101 kHz)",
      type: "audio/wav",
      bytes: wavOdd.bytes,
      samples: Math.ceil((wavOdd.frames * 16_000) / 44_101),
    },
    { name: "malformed (WAV)", type: "audio/wav", bytes: badWav, refused: true },
  ];
}
