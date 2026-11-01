// A voice note's transcript, from Muse Voice Transcribe (D01 T03 §3; spec 4.2a), each 10-minute chunk of the decoder's
// WAV (`decodeToWavChunks`, ./decode) sent in turn through the one Meta client (D03 T01: budget, Standard IDs, cost).
//
// The endpoint (https://dev.meta.ai/docs/speech-to-text, "Transcribe a file"; the reference is
// sources/meta-api/docs/docs/api-reference/voice/transcribe.md and schemas.md): `POST /v1/asr/transcribe`, multipart,
// a `request` part of JSON settings (`model`, `audioEncoding: "WAV"`, `mode: "DIARIZATION"`) and an `audio` part, a
// RIFF/WAVE file of mono 16-bit PCM at 16 or 24 kHz, at most 10 minutes and 32 MB. The JSON answer (`TranscribeResponse`)
// is `{ sessionId, transcript, audioDurationMs, turns: [{ turnId, startMs, endMs, transcript, speaker? }] }`: turns in
// ascending `turnId` order, their times from the start of the clip, `speaker` a label such as `A` in `DIARIZATION`
// only, and a turn the clip ended part-way through given its boundaries and an empty transcript. Priced at $0.18 an
// hour of audio processed, rounded down to whole seconds.
//
// A label names a speaker within one transcription only ("a label does not identify the same person across separate
// sessions"), so every turn keeps its chunk's number beside its label and labels are never merged across chunks; each
// chunk's times are offset by the length of the chunks before it, measured from their own WAV, not from what Meta says.
// An answer outside that shape is a ModelOutputError, recorded against its paid call, never a transcript made up from it.
// A turn cut off by a chunk's end comes back with an empty transcript: it is kept as a gap and the transcript marked
// incomplete, never dropped as if nothing had been said.
import { z } from "zod";
import { putArtefact, type Store } from "../intake/store";
import { type MetaContext, metaRaw, wavSeconds } from "../meta/client";
import { ModelOutputError } from "../meta/structured";

export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
export const TRANSCRIPT_NAME = "transcript.json";

const Turn = z.object({
  turnId: z.number().int(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  transcript: z.string(),
  speaker: z.string().min(1).max(16).optional(),
});
const Answer = z.object({
  sessionId: z.string(),
  transcript: z.string(),
  audioDurationMs: z.number().int().nonnegative(),
  turns: z.array(Turn),
});

// One turn of the whole recording: its chunk (from 1), the speaker label within that chunk (null when the model gave
// none), and its times from the start of the recording.
export type TranscriptTurn = { chunk: number; speaker: string | null; startMs: number; endMs: number; text: string };
// Where speech was cut and not transcribed: a turn the model reported with an empty transcript (a chunk that ended
// part-way through it, schemas.md's Turn), with its times in the recording. Silence gives no turn at all, so an empty
// list is a whole transcript.
export type TranscriptGap = { chunk: number; startMs: number; endMs: number };
export type Transcript = {
  model: typeof TRANSCRIBE_MODEL;
  chunks: number;
  durationMs: number;
  text: string;
  turns: TranscriptTurn[];
  // Speech the transcript does not hold (D01 T03 §3's completion review): `complete` false when there is any, so a
  // reader never takes a cut recording for the whole of what was said.
  complete: boolean;
  gaps: TranscriptGap[];
};

// Every chunk transcribed in order and joined, stored as the case's `audio` artefact `transcript.json`.
export async function transcribe(
  store: Store,
  caseId: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ctx: MetaContext,
): Promise<{ transcript: Transcript; key: string }> {
  const turns: TranscriptTurn[] = [];
  const gaps: TranscriptGap[] = [];
  const texts: string[] = [];
  let offsetMs = 0;
  let chunk = 0;
  for await (const wav of chunks) {
    chunk++;
    const audio = new Blob([wav], { type: "audio/wav" });
    const seconds = await wavSeconds(audio);
    // The decoder writes nothing else; a chunk that is not a well-formed WAV is a fault here, never sent.
    if (seconds === null) throw new Error(`chunk ${chunk} is not a PCM WAV`);
    const answer = await metaRaw(
      "/asr/transcribe",
      {
        request: { model: TRANSCRIBE_MODEL, audioEncoding: "WAV", mode: "DIARIZATION" },
        audio,
        filename: `chunk-${chunk}.wav`,
        audioSeconds: seconds,
      },
      ctx,
    );
    const read = Answer.safeParse(answer.data);
    if (!read.success) {
      // Paid for and unusable: recorded on its call so the ledger says why, then the step fails.
      await ctx.budget.outputFailed(answer.callId, "output-invalid").catch(() => {
        console.error(JSON.stringify({ event: "meta", outcome: "output-failure-unrecorded", kind: "invalid" }));
      });
      throw new ModelOutputError("invalid", `chunk ${chunk}'s transcription was not in the documented shape`, [
        { callId: answer.callId, logId: answer.logId },
      ]);
    }
    for (const turn of read.data.turns) {
      const startMs = offsetMs + turn.startMs;
      const endMs = offsetMs + turn.endMs;
      if (!turn.transcript.trim()) gaps.push({ chunk, startMs, endMs });
      else turns.push({ chunk, speaker: turn.speaker ?? null, startMs, endMs, text: turn.transcript });
    }
    if (read.data.transcript) texts.push(read.data.transcript);
    offsetMs += Math.round(seconds * 1000);
  }
  const transcript: Transcript = {
    model: TRANSCRIBE_MODEL,
    chunks: chunk,
    durationMs: offsetMs,
    text: texts.join(" "),
    turns,
    complete: gaps.length === 0,
    gaps,
  };
  const stored = await putArtefact(
    store,
    caseId,
    "audio",
    TRANSCRIPT_NAME,
    new TextEncoder().encode(JSON.stringify(transcript)),
    "application/json",
  );
  return { transcript, key: stored.key };
}
