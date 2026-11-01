// A synthetic two-speaker voice note for the transcription client (D01 T03 §3): the turns of
// `test/fixtures/audio/director-urgent-payment.json` (a fictional caller asking an accounts clerk to pay a new account
// today), each spoken by the Windows voice it names through System.Speech, offline, on this machine (WSL calls
// `powershell.exe`; no account, no network, no voice clone). Each turn is synthesised as 48 kHz mono 16-bit PCM, the
// turns joined with half a second of silence, and the whole encoded as an Ogg Opus voice note (as WhatsApp saves them)
// with libopus (`opusscript`) in the pages of `test/fixtures/audio/ogg.ts`, as `make-audio.ts` makes its tones. Its
// provenance is recorded in `eval/DATASETS.md`.
//
//   node scripts/fixtures/make-voice.ts [--out <dir>]
//
// Needs WSL with Windows' David and Zira voices; anywhere else it says so and writes nothing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import OpusScript from "opusscript";
import { oggStream } from "../../test/fixtures/audio/ogg.ts";

const RATE = 48_000;
const FRAME = 960; // 20 ms at 48 kHz
const PRE_SKIP = 312;
const GAP_SECONDS = 0.5;

type Script = { turns: { voice: string; text: string }[] };

// The PCM samples of a RIFF/WAVE file System.Speech wrote: 16-bit mono at RATE, refused otherwise.
function pcmOf(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let format: { channels: number; rate: number; bits: number } | null = null;
  while (at + 8 <= wav.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ")
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    if (id === "data") {
      if (!format || format.channels !== 1 || format.rate !== RATE || format.bits !== 16)
        throw new Error(`unexpected WAV format ${JSON.stringify(format)}`);
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(body + i * 2, true);
      return samples;
    }
    at = body + size + (size % 2);
  }
  throw new Error("the WAV has no data chunk");
}

// One turn spoken by `voice`, through a text file so no quoting reaches the shell.
function speak(dir: string, index: number, voice: string, text: string): Int16Array {
  const textPath = join(dir, `turn-${index}.txt`);
  const wavPath = join(dir, `turn-${index}.wav`);
  writeFileSync(textPath, text, "utf8");
  const win = (path: string) => execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.SelectVoice('${voice.replace(/'/g, "''")}')`,
    `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$s.SetOutputToWaveFile('${win(wavPath).replace(/'/g, "''")}', $f)`,
    `$s.Speak([System.IO.File]::ReadAllText('${win(textPath).replace(/'/g, "''")}'))`,
    "$s.Dispose()",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
  return pcmOf(new Uint8Array(readFileSync(wavPath)));
}

export function voiceNote(script: Script, synthesise = speak): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "make-voice-"));
  try {
    const gap = new Int16Array(Math.round(GAP_SECONDS * RATE));
    const parts = script.turns.flatMap((turn, i) => [...(i ? [gap] : []), synthesise(dir, i, turn.voice, turn.text)]);
    const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      pcm.set(part, at);
      at += part.length;
    }
    const head = new Uint8Array(19);
    const headView = new DataView(head.buffer);
    head.set(new TextEncoder().encode("OpusHead"));
    head[8] = 1;
    head[9] = 1;
    headView.setUint16(10, PRE_SKIP, true);
    headView.setUint32(12, RATE, true);
    const vendor = new TextEncoder().encode("isitlegit fixtures");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(new TextEncoder().encode("OpusTags"));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    const encoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
    const packets: Uint8Array[] = [];
    for (let start = 0; start < pcm.length; start += FRAME) {
      const frame = new Int16Array(FRAME);
      frame.set(pcm.subarray(start, start + FRAME));
      packets.push(new Uint8Array(encoder.encode(Buffer.from(frame.buffer), FRAME)));
    }
    encoder.delete();
    return oggStream([head, tags], packets, FRAME);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: "string", default: "test/fixtures/audio" } } });
  const out = values.out as string;
  const script = JSON.parse(readFileSync(join(out, "director-urgent-payment.json"), "utf8")) as Script;
  const path = join(out, "director-urgent-payment.ogg");
  writeFileSync(`${path}.tmp`, voiceNote(script));
  renameSync(`${path}.tmp`, path);
  console.log(`wrote ${path}`);
}
