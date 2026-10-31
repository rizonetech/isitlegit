// The live checkpoint of D01 T03 §3: the synthetic voice note `test/fixtures/audio/director-urgent-payment.ogg`
// transcribed once by Muse Voice Transcribe through src/meta/client.ts's metaRaw, the route the Worker takes, and the
// transcript checked against the fixture's own script (`expect` in director-urgent-payment.json): the payment request,
// the claimed identity and the deadline words in it, two speakers labelled, turns in time order. A blank or unrelated
// transcript fails.
//
// It spends under the smoke's guard (scripts/meta-smoke.ts, D00 T01 §7), as scripts/meta-client-live.ts does: the same
// lock, the same run and day caps and the same ledger outside every checkout, each attempt reserved there before it is
// sent and settled at Meta's reported length after; and under the Worker's caps through `localBudget` (D03 T01 §2). The
// Meta key and the gateway's Run token come from Conclave through conclave-op and are never printed.
//
// The Ogg Opus note is decoded here with libopus (`opusscript`) straight to 16 kHz mono, the format the Worker's
// decoder sends, and wrapped as a WAV.
//
// A second, near-limit recording (the note's speech repeated to 600 seconds, one full chunk) is timed too, so latency is
// measured on a short and a near-limit recording; each transcript is saved beside the ledger and read back before it is
// checked.
//
//   node scripts/voice-transcribe-live.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import OpusScript from "opusscript";
import { metaRaw } from "../src/meta/client.ts";
import { sastDay } from "../src/meta/day.ts";
import { NotSent } from "../src/meta/guard.ts";
import { oggPackets } from "../test/fixtures/audio/ogg.ts";
import { localBudget } from "./lib/meta-budget.ts";
import {
  DAY_CAP,
  GATEWAY_URL,
  metaLedger,
  RUN_CAP,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  type Spend,
  settleSpend,
  spentOn,
  takeLock,
} from "./meta-smoke.ts";

const MODEL = "muse-voice-transcribe-1.0";
const PER_SECOND = 0.18 / 3600;
const RATE = 16_000;
const FIXTURE = "test/fixtures/audio/director-urgent-payment";

// Each expected entry is a word or phrase, or a list of spellings any one of which counts: a name the synthetic voice
// says with English phonetics (an Afrikaans "Pieter Botha" heard as "Peter Bota") is heard, whatever its spelling.
type Heard = string | string[];
type Expect = { request: Heard[]; identity: Heard[]; urgency: Heard[]; speakers: number };
type Turn = { turnId: number; startMs: number; endMs: number; transcript: string; speaker?: string };

// The note as the Worker sends it: 16 kHz mono 16-bit PCM in a RIFF/WAVE file.
export function wavOfOgg(ogg: Uint8Array): Uint8Array<ArrayBuffer> {
  const packets = oggPackets(ogg).slice(2);
  const decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  const parts: Int16Array[] = [];
  for (const { packet } of packets) {
    const pcm = decoder.decode(Buffer.from(packet));
    parts.push(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2));
  }
  decoder.delete();
  // libopus's pre-skip (312 samples at 48 kHz, 104 at 16 kHz) is the encoder's delay, dropped as a player drops it.
  const samples = parts.reduce((n, p) => n + p.length, 0) - 104;
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  let at = 44;
  let skip = 104;
  for (const part of parts)
    for (const sample of part) {
      if (skip > 0) {
        skip--;
        continue;
      }
      view.setInt16(at, sample, true);
      at += 2;
    }
  return out;
}

// What the transcript must show, from the fixture's script; each failure named.
export function checkTranscript(answer: unknown, expect: Expect): string[] {
  const failures: string[] = [];
  const data = answer as { transcript?: unknown; turns?: unknown; audioDurationMs?: unknown };
  const text = typeof data.transcript === "string" ? data.transcript.toLowerCase() : "";
  if (!text.trim()) return ["the transcript is blank"];
  for (const [what, words] of [
    ["request", expect.request],
    ["identity", expect.identity],
    ["urgency", expect.urgency],
  ] as const)
    for (const word of words) {
      const spellings = typeof word === "string" ? [word] : word;
      if (!spellings.some((w) => text.includes(w.toLowerCase())))
        failures.push(`${what}: "${spellings.join('" or "')}" not heard`);
    }
  const turns = Array.isArray(data.turns) ? (data.turns as Turn[]) : [];
  const speakers = new Set(turns.map((t) => t.speaker).filter(Boolean));
  if (speakers.size < expect.speakers) failures.push(`${speakers.size} speaker(s) labelled, ${expect.speakers} spoke`);
  for (let i = 1; i < turns.length; i++)
    if ((turns[i] as Turn).startMs < (turns[i - 1] as Turn).startMs)
      failures.push(`turn ${i + 1} starts before turn ${i}`);
  return failures;
}

// A near-limit chunk for timing: the note's own speech repeated to 600 seconds, the decoder's chunk length.
export function nearLimit(wav: Uint8Array<ArrayBuffer>, seconds = 600): Uint8Array<ArrayBuffer> {
  const pcm = wav.subarray(44);
  const bytes = seconds * RATE * 2;
  const out = new Uint8Array(44 + bytes);
  out.set(wav.subarray(0, 44));
  const view = new DataView(out.buffer);
  view.setUint32(4, 36 + bytes, true);
  view.setUint32(40, bytes, true);
  for (let at = 0; at < bytes; at += pcm.length) out.set(pcm.subarray(0, Math.min(pcm.length, bytes - at)), 44 + at);
  return out;
}

// The transcript saved whole beside the ledger (temporary file, then replace) and read back: the check reads what was
// stored, not what is still in memory.
function saveAndReadBack(file: string, data: unknown): unknown {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 1)}\n`);
  renameSync(`${file}.tmp`, file);
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main(): Promise<number> {
  const script = JSON.parse(readFileSync(`${FIXTURE}.json`, "utf8")) as { expect: Expect };
  const note = wavOfOgg(new Uint8Array(readFileSync(`${FIXTURE}.ogg`)));
  const recordings = [
    { name: "director-urgent-payment", wav: note },
    { name: "near-limit-600s", wav: nearLimit(note) },
  ];
  const secondsOf = (wav: Uint8Array) => (wav.length - 44) / (RATE * 2);
  const estimates = recordings.map((r) => Math.ceil(secondsOf(r.wav)) * PER_SECOND);
  const today = sastDay();
  const ledgerFile = metaLedger();
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const unlock = takeLock(`${ledgerFile}.lock`);
  if (typeof unlock === "string") {
    console.log(`voice-transcribe-live: refused: ${unlock}`);
    return 1;
  }
  try {
    const ledger = readLedger(ledgerFile);
    const run = crypto.randomUUID();
    // Every attempt either recording may take (the client tries three times) under the run's cap, and the first of
    // each under what is left of the day's.
    const worst = estimates.reduce((n, e) => n + 3 * e, 0);
    if (worst > RUN_CAP) {
      console.log(`voice-transcribe-live: refused: up to US$${worst.toFixed(4)}, over the US$${RUN_CAP} cap`);
      return 1;
    }
    if (spentOn(ledger, today) + estimates.reduce((n, e) => n + e, 0) > DAY_CAP) {
      console.log(
        `voice-transcribe-live: refused: the calls would pass the US$${DAY_CAP} a day the smoke's ledger allows`,
      );
      return 1;
    }
    const secrets = await readSecretsFromVault();
    const results: Record<string, unknown>[] = [];
    let code = 0;
    for (const [index, { name, wav }] of recordings.entries()) {
      const estimate = estimates[index] as number;
      const attempts: Spend[] = [];
      const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(GATEWAY_URL)) {
          if (spentOn(ledger, today) + estimate > DAY_CAP) throw new NotSent("the day's cap would be passed");
          const reserved = reserveSpend(ledgerFile, ledger, {
            date: today,
            run,
            call: `voice transcribe ${name} attempt ${attempts.length + 1}`,
            estimate,
          });
          if ("refused" in reserved) throw new NotSent(reserved.refused);
          attempts.push(reserved.entry);
        }
        return fetch(input, init);
      }) as typeof fetch;
      const began = Date.now();
      let answer: Awaited<ReturnType<typeof metaRaw>>;
      try {
        answer = await metaRaw(
          "/asr/transcribe",
          {
            request: { model: MODEL, audioEncoding: "WAV", mode: "DIARIZATION" },
            audio: new Blob([wav], { type: "audio/wav" }),
            filename: `${name}.wav`,
            audioSeconds: secondsOf(wav),
          },
          {
            env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
            budget: localBudget("voice-transcribe-live"),
            owner: { kind: "script", name: "voice-transcribe-live" },
            fetch: guarded,
            deadlineMs: 120_000,
          },
        );
      } catch (error) {
        for (const entry of attempts) settleSpend(ledgerFile, ledger, entry, null);
        results.push({ name, failed: (error as Error).name, latencyMs: Date.now() - began, attempts: attempts.length });
        code = 1;
        continue;
      }
      const latencyMs = Date.now() - began;
      const ms = (answer.data as { audioDurationMs?: unknown }).audioDurationMs;
      const cost = typeof ms === "number" ? Math.floor(ms / 1000) * PER_SECOND : null;
      const last = attempts.at(-1);
      for (const entry of attempts) settleSpend(ledgerFile, ledger, entry, entry === last ? cost : null);
      const stored = saveAndReadBack(join(dirname(ledgerFile), `voice-transcribe-live-${name}.json`), answer.data);
      const failures = name === "director-urgent-payment" ? checkTranscript(stored, script.expect) : [];
      if (failures.length) code = 1;
      const turns = ((stored as { turns?: Turn[] }).turns ?? []).map((t) => ({
        speaker: t.speaker ?? null,
        startMs: t.startMs,
        endMs: t.endMs,
        text: t.transcript,
      }));
      results.push({
        name,
        audioSeconds: Math.round(secondsOf(wav) * 10) / 10,
        latencyMs,
        attempts: attempts.length,
        costUsd: cost,
        logId: answer.logId,
        ...(name === "director-urgent-payment"
          ? { check: failures.length ? "failed" : "passed", failures, turns }
          : {}),
        ...(name !== "director-urgent-payment" ? { turns: turns.length } : {}),
      });
    }
    console.log(JSON.stringify({ model: MODEL, results }, null, 1));
    return code;
  } finally {
    unlock();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
