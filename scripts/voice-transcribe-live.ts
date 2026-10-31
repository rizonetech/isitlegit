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
//   node scripts/voice-transcribe-live.ts
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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

type Expect = { request: string[]; identity: string[]; urgency: string[]; speakers: number };
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
    for (const word of words) if (!text.includes(word.toLowerCase())) failures.push(`${what}: "${word}" not heard`);
  const turns = Array.isArray(data.turns) ? (data.turns as Turn[]) : [];
  const speakers = new Set(turns.map((t) => t.speaker).filter(Boolean));
  if (speakers.size < expect.speakers) failures.push(`${speakers.size} speaker(s) labelled, ${expect.speakers} spoke`);
  for (let i = 1; i < turns.length; i++)
    if ((turns[i] as Turn).startMs < (turns[i - 1] as Turn).startMs)
      failures.push(`turn ${i + 1} starts before turn ${i}`);
  return failures;
}

async function main(): Promise<number> {
  const script = JSON.parse(readFileSync(`${FIXTURE}.json`, "utf8")) as { expect: Expect };
  const wav = wavOfOgg(new Uint8Array(readFileSync(`${FIXTURE}.ogg`)));
  const seconds = (wav.length - 44) / (RATE * 2);
  const estimate = Math.ceil(seconds) * PER_SECOND;
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
    const attempts: Spend[] = [];
    const overCap = (attempt: number) =>
      attempt * estimate > RUN_CAP
        ? `${attempt} attempt(s) could cost US$${(attempt * estimate).toFixed(6)}, over the US$${RUN_CAP} cap`
        : spentOn(ledger, today) + estimate > DAY_CAP
          ? `another attempt would pass the US$${DAY_CAP} a day the smoke's ledger allows`
          : null;
    const before = overCap(1);
    if (before) {
      console.log(`voice-transcribe-live: refused: ${before}`);
      return 1;
    }
    const secrets = await readSecretsFromVault();
    const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(GATEWAY_URL)) {
        const over = overCap(attempts.length + 1);
        const reserved = over
          ? { refused: over }
          : reserveSpend(ledgerFile, ledger, {
              date: today,
              run,
              call: `voice transcribe attempt ${attempts.length + 1}`,
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
          filename: "director-urgent-payment.wav",
          audioSeconds: seconds,
        },
        {
          env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
          budget: localBudget("voice-transcribe-live"),
          owner: { kind: "script", name: "voice-transcribe-live" },
          fetch: guarded,
        },
      );
    } catch (error) {
      for (const entry of attempts) settleSpend(ledgerFile, ledger, entry, null);
      console.log(`voice-transcribe-live: failed: ${(error as Error).name}`);
      return 1;
    }
    const latencyMs = Date.now() - began;
    const ms = (answer.data as { audioDurationMs?: unknown }).audioDurationMs;
    const cost = typeof ms === "number" ? Math.floor(ms / 1000) * PER_SECOND : null;
    const last = attempts.at(-1);
    for (const entry of attempts) settleSpend(ledgerFile, ledger, entry, entry === last ? cost : null);
    const failures = checkTranscript(answer.data, script.expect);
    const turns = ((answer.data as { turns?: Turn[] }).turns ?? []).map((t) => ({
      speaker: t.speaker ?? null,
      startMs: t.startMs,
      endMs: t.endMs,
      text: t.transcript,
    }));
    console.log(
      JSON.stringify(
        {
          model: MODEL,
          audioSeconds: Math.round(seconds * 10) / 10,
          latencyMs,
          attempts: attempts.length,
          costUsd: cost,
          logId: answer.logId,
          check: failures.length ? "failed" : "passed",
          failures,
          turns,
        },
        null,
        1,
      ),
    );
    return failures.length ? 1 : 0;
  } finally {
    unlock();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
