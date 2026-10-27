// Synthetic audio fixtures for the voice decoder (D01 T03 §2): a 3-second 440 Hz tone, no voice, as an Ogg Opus voice
// note (`tone.ogg`, mono, 48 kHz, as WhatsApp saves them), as a stereo Ogg Opus file with the tone on the left and
// silence on the right (`tone-stereo.ogg`, so mixing down must average the channels), and as a WAV attachment
// (`tone.wav`, stereo, 44.1 kHz, 16-bit, so decoding must both resample and mix down). Opus is encoded with libopus
// (`opusscript`) and wrapped in Ogg pages by `test/fixtures/audio/ogg.ts` (RFC 7845: OpusHead, OpusTags, then audio,
// one packet per page). The output is the same on every run.
//
//   node scripts/fixtures/make-audio.ts [--out <dir>]
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import OpusScript from "opusscript";
import { oggStream, tone, wavFile } from "../../test/fixtures/audio/ogg.ts";

const SECONDS = 3;
const OPUS_RATE = 48_000;
const FRAME = 960; // 20 ms at 48 kHz
const PRE_SKIP = 312;
const WAV_RATE = 44_100;

export function oggOpusTone(channels: 1 | 2 = 1): Uint8Array {
  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1; // version
  head[9] = channels;
  headView.setUint16(10, PRE_SKIP, true);
  headView.setUint32(12, OPUS_RATE, true);
  const vendor = new TextEncoder().encode("isitlegit fixtures");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const encoder = new OpusScript(OPUS_RATE, channels, OpusScript.Application.AUDIO);
  const mono = tone(OPUS_RATE, SECONDS);
  // Interleaved: the tone on the first channel, silence on the second.
  const pcm = new Int16Array(mono.length * channels);
  mono.forEach((v, i) => {
    pcm[i * channels] = v;
  });
  const packets: Uint8Array[] = [];
  for (let at = 0; at < pcm.length; at += FRAME * channels) {
    const frame = new Int16Array(FRAME * channels);
    frame.set(pcm.subarray(at, at + FRAME * channels));
    packets.push(new Uint8Array(encoder.encode(Buffer.from(frame.buffer), FRAME)));
  }
  encoder.delete();
  return oggStream([head, tags], packets, FRAME);
}

export function wavTone(): Uint8Array {
  const mono = tone(WAV_RATE, SECONDS);
  const stereo = new Int16Array(mono.length * 2);
  mono.forEach((v, i) => {
    stereo[2 * i] = v;
    stereo[2 * i + 1] = v;
  });
  return wavFile(stereo, WAV_RATE, 2);
}

const atomic = (path: string, bytes: Uint8Array) => {
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
};

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { out: { type: "string", default: "test/fixtures/audio" } } });
  const out = values.out as string;
  mkdirSync(out, { recursive: true });
  atomic(join(out, "tone.ogg"), oggOpusTone());
  atomic(join(out, "tone-stereo.ogg"), oggOpusTone(2));
  atomic(join(out, "tone.wav"), wavTone());
  console.log(`make-audio: wrote tone.ogg, tone-stereo.ogg and tone.wav in ${out}`);
}
