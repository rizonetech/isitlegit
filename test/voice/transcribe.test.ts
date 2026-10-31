import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { readArtefact, type Store } from "../../src/intake/store";
import type { MetaContext } from "../../src/meta/client";
import type { Budget } from "../../src/meta/guard";
import { ModelOutputError } from "../../src/meta/structured";
import { wavHeader } from "../../src/voice/decode";
import { TRANSCRIBE_MODEL, transcribe } from "../../src/voice/transcribe";

// D01 T03 §3: each WAV chunk sent to Muse Voice Transcribe through the Meta client, the answers checked and joined.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const metaEnv = {
  META_API_KEY: "LLM_test_key_0123456789",
  CF_AIG_TOKEN: "aig-run-token-0123456789",
  META_GATEWAY_URL: "https://gateway.test/v1/acct/isitlegit/custom-meta/v1",
};

// A chunk of `seconds` of silence as the decoder writes it: 16 kHz mono 16-bit WAV.
const chunk = (seconds: number) => {
  const samples = seconds * 16_000;
  const out = new Uint8Array(44 + samples * 2);
  out.set(wavHeader(samples));
  return out;
};
const answer = (turns: { startMs: number; endMs: number; transcript: string; speaker?: string }[], ms: number) => ({
  sessionId: `s-${ms}`,
  transcript: turns.map((t) => t.transcript).join(" "),
  audioDurationMs: ms,
  turns: turns.map((t, i) => ({ turnId: i + 1, ...t })),
});
function meta(...bodies: unknown[]) {
  const sent: { request: unknown; audio: number; filename: string }[] = [];
  const failed: string[] = [];
  const settled: number[] = [];
  const budget: Budget = {
    async reserve() {
      return `r${sent.length + 1}`;
    },
    async settle(_id, actual) {
      settled.push(actual);
    },
    async uncertain() {},
    async refused() {},
    async cached() {},
    async outputFailed(_id, errorClass) {
      failed.push(errorClass);
    },
  };
  const ctx: MetaContext = {
    env: metaEnv,
    budget,
    owner: { kind: "case", caseId: "01HZTESTCASE0000000000000A", step: "transcribe" },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = await new Request(input, init).formData();
      const audio = form.get("audio") as File;
      sent.push({
        request: JSON.parse(await (form.get("request") as File).text()),
        audio: audio.size,
        filename: audio.name,
      });
      const body = bodies[sent.length - 1];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "cf-aig-log-id": `log-${sent.length}` },
      });
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 0.5,
  };
  return { ctx, sent, failed, settled };
}
async function newCase() {
  const made = await createCase(env.DB, {
    orgId: "org-voice",
    channel: "upload",
    headersAvailable: false,
    uploadedBy: "user-voice",
    sourceKind: "audio",
  });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

describe("transcribe", () => {
  it("sends each chunk as a diarized WAV request, in order, and joins the turns with each chunk's offset", async () => {
    const m = meta(
      answer(
        [
          { startMs: 500, endMs: 4_000, transcript: "It's Pieter Botha, the managing director.", speaker: "A" },
          { startMs: 4_500, endMs: 6_000, transcript: "How can I help?", speaker: "B" },
        ],
        8_000,
      ),
      answer([{ startMs: 1_000, endMs: 3_000, transcript: "Pay the new account today.", speaker: "A" }], 5_000),
    );
    const caseId = await newCase();
    const { transcript, key } = await transcribe(store, caseId, [chunk(8), chunk(5)], m.ctx);
    expect(m.sent).toEqual([
      {
        request: { model: TRANSCRIBE_MODEL, audioEncoding: "WAV", mode: "DIARIZATION" },
        audio: 44 + 8 * 32_000,
        filename: "chunk-1.wav",
      },
      {
        request: { model: TRANSCRIBE_MODEL, audioEncoding: "WAV", mode: "DIARIZATION" },
        audio: 44 + 5 * 32_000,
        filename: "chunk-2.wav",
      },
    ]);
    // The second chunk's turn is offset by the first chunk's 8 seconds, and keeps its own chunk's label.
    expect(transcript.turns).toEqual([
      { chunk: 1, speaker: "A", startMs: 500, endMs: 4_000, text: "It's Pieter Botha, the managing director." },
      { chunk: 1, speaker: "B", startMs: 4_500, endMs: 6_000, text: "How can I help?" },
      { chunk: 2, speaker: "A", startMs: 9_000, endMs: 11_000, text: "Pay the new account today." },
    ]);
    expect(transcript).toMatchObject({
      model: TRANSCRIBE_MODEL,
      chunks: 2,
      durationMs: 13_000,
      complete: true,
      gaps: [],
    });
    expect(transcript.text).toBe(
      "It's Pieter Botha, the managing director. How can I help? Pay the new account today.",
    );
    // Stored as the case's audio artefact, read back whole.
    expect(key).toMatch(new RegExp(`^art/${caseId}/audio/[0-9a-f]{64}-transcript\\.json$`));
    const read = await readArtefact(store, caseId, key);
    if (!read || !("body" in read)) throw new Error("no transcript stored");
    expect(JSON.parse(new TextDecoder().decode(read.body))).toEqual(transcript);
    // Each call settles at the length Meta reported: 8 and 5 seconds at $0.18 an hour.
    expect(m.settled).toHaveLength(2);
    expect(m.settled[0]).toBeCloseTo((8 * 0.18) / 3600, 12);
    expect(m.settled[1]).toBeCloseTo((5 * 0.18) / 3600, 12);
  });

  it("keeps speech cut at a chunk's end as a gap and marks the transcript incomplete; silence stays whole", async () => {
    // The first chunk ends part-way through a turn: Meta gives that turn its boundaries and an empty transcript.
    const m = meta(
      answer(
        [
          { startMs: 1_000, endMs: 4_000, transcript: "Pay the new account today.", speaker: "A" },
          { startMs: 7_000, endMs: 8_000, transcript: "", speaker: "A" },
        ],
        8_000,
      ),
      answer([{ startMs: 0, endMs: 1_500, transcript: "before two o'clock.", speaker: "A" }], 3_000),
    );
    const { transcript } = await transcribe(store, await newCase(), [chunk(8), chunk(3)], m.ctx);
    expect(transcript.complete).toBe(false);
    expect(transcript.gaps).toEqual([{ chunk: 1, startMs: 7_000, endMs: 8_000 }]);
    expect(transcript.turns.map((t) => t.text)).toEqual(["Pay the new account today.", "before two o'clock."]);
    // A silent recording: no turns at all, a whole (empty) transcript.
    const quiet = meta(answer([], 5_000));
    const silent = await transcribe(store, await newCase(), [chunk(5)], quiet.ctx);
    expect(silent.transcript).toMatchObject({ complete: true, gaps: [], turns: [], text: "" });
  });

  it("refuses an answer outside the documented shape, recording it on its paid call, and stores nothing", async () => {
    for (const bad of [
      { transcript: "no turns" },
      answer([{ startMs: -1, endMs: 10, transcript: "x" }], 1_000),
      { ...answer([], 1_000), turns: [{ turnId: 1, startMs: 0, endMs: 10 }] },
      { ...answer([], 1_000), audioDurationMs: "8000" },
    ]) {
      const m = meta(bad);
      const caseId = await newCase();
      const error = await transcribe(store, caseId, [chunk(1)], m.ctx).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, JSON.stringify(bad)).toBeInstanceOf(ModelOutputError);
      expect((error as ModelOutputError).calls).toEqual([{ callId: expect.any(String), logId: "log-1" }]);
      expect(m.failed).toEqual(["output-invalid"]);
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM artefacts WHERE case_id = ? AND kind = 'audio'")
        .bind(caseId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(0);
    }
  });

  it("stops at the first bad chunk, never sending the ones after it", async () => {
    const m = meta({ nope: true }, answer([], 1_000));
    const caseId = await newCase();
    await expect(transcribe(store, caseId, [chunk(1), chunk(1)], m.ctx)).rejects.toBeInstanceOf(ModelOutputError);
    expect(m.sent).toHaveLength(1);
  });
});
