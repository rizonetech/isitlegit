import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCase } from "../../src/db/cases";
import { artefactsOf, putAttachment, putRaw, readArtefact, type Store } from "../../src/intake/store";
import { reserve } from "../../src/meta/budget";
import { DAY_CAP_USD } from "../../src/meta/caps";
import { sastDay } from "../../src/meta/day";
import type { Transcript } from "../../src/voice/transcribe";
import { toneOgg } from "../fixtures/audio/load";
import { oggPackets, oggStream } from "../fixtures/audio/ogg";
import { forwards } from "../fixtures/forward/load";

// D01 T03 §3: the Workflow's `transcribe` step for an uploaded voice note, Meta stubbed at the gateway.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-transcribe";

// The tone fixture's Opus packets (3 seconds), repeated into a longer recording.
const fixture = oggPackets(toneOgg);
const headers = fixture.slice(0, 2).map((p) => p.packet);
const packets = fixture.slice(2).map((p) => p.packet);
const repeated = (times: number) => oggStream(headers, Array.from({ length: times }, () => packets).flat(), 960);

type Reply = { status: number; body: unknown };
const ok = (seconds: number, text = "Pay the new account today."): Reply => ({
  status: 200,
  body: {
    sessionId: "s-1",
    transcript: text,
    audioDurationMs: seconds * 1000,
    turns: [{ turnId: 1, startMs: 100, endMs: 2_000, transcript: text, speaker: "A" }],
  },
});
const voiceReply = () =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                request: "none",
                request_quote: null,
                claimed_identity: null,
                identity_quote: null,
                urgency: "low",
                urgency_quote: null,
                payment_quote: null,
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-voice" } },
  );
// Meta answers each transcription request from the script in turn (the last one repeating).
function stubMeta(script: Reply[]) {
  const calls: number[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    // The voice step's read of the transcript (D01 T03 §4) is answered with a claim that asks for nothing, so these
    // tests stay about transcription.
    if (url.endsWith("/responses")) return voiceReply();
    if (!url.endsWith("/asr/transcribe")) return real(input, init);
    const form = await new Request(input, init).formData();
    calls.push((form.get("audio") as File).size);
    const next = script[Math.min(calls.length, script.length) - 1] as Reply;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", "cf-aig-log-id": `log-${calls.length}` },
    });
  });
  return calls;
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM model_spend").run();
});
afterEach(() => vi.restoreAllMocks());

async function voiceCase(bytes: Uint8Array, mediaType = "audio/ogg") {
  const made = await createCase(env.DB, {
    orgId: ORG,
    channel: "upload",
    headersAvailable: false,
    uploadedBy: "user-transcribe",
    sourceKind: "audio",
    uploadName: "voice-note.ogg",
    uploadMediaType: mediaType,
  });
  if (!made.ok) throw new Error(made.error.message);
  await putAttachment(store, made.value.id, "voice-note.ogg", bytes, mediaType);
  return made.value.id;
}
async function run(caseId: string) {
  const instance = await introspectWorkflowInstance(env.ANALYSIS, caseId);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.ANALYSIS.create({ id: caseId, params: { caseId } });
    await instance.waitForStatus("complete");
  } finally {
    await instance.dispose();
  }
}
const events = async (caseId: string) =>
  (
    await env.DB.prepare("SELECT step, status, error FROM case_events WHERE case_id = ? ORDER BY id")
      .bind(caseId)
      .all<{ step: string; status: string; error: string | null }>()
  ).results;
const caseRow = (caseId: string) =>
  env.DB.prepare("SELECT status, verdict FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ status: string; verdict: string | null }>();
const failedAs = async (caseId: string) =>
  (await events(caseId)).filter((e) => e.status === "failed").map((e) => [e.step, e.error]);
const spend = async (caseId: string) =>
  (
    await env.DB.prepare(
      "SELECT attempt, state FROM model_spend WHERE case_id = ? AND caller = 'transcribe' ORDER BY at, attempt",
    )
      .bind(caseId)
      .all<{ attempt: number; state: string }>()
  ).results;
async function storedTranscript(caseId: string): Promise<Transcript | null> {
  // The transcript among the case's audio artefacts (the voice step's result is another).
  const row = (await artefactsOf(store, caseId, "audio")).find((a) => a.key.endsWith("-transcript.json"));
  if (!row) return null;
  const read = await readArtefact(store, caseId, row.key);
  return read && "body" in read ? (JSON.parse(new TextDecoder().decode(read.body)) as Transcript) : null;
}

describe("the transcribe step", () => {
  it("transcribes an uploaded Ogg voice note, stores the transcript and goes on to the checks", async () => {
    const calls = stubMeta([ok(3)]);
    const caseId = await voiceCase(toneOgg);
    await run(caseId);
    expect(calls).toHaveLength(1);
    const transcript = await storedTranscript(caseId);
    expect(transcript).toMatchObject({ chunks: 1, text: "Pay the new account today." });
    const steps = (await events(caseId)).map((e) => `${e.step}:${e.status}`);
    expect(steps).toContain("transcribe:done");
    expect(steps.indexOf("transcribe:done")).toBeLessThan(steps.indexOf("checks:started"));
    expect((await caseRow(caseId))?.status).toBe("done");
    expect(await spend(caseId)).toEqual([{ attempt: 1, state: "settled" }]);
  });

  it("ends the case partial naming transcribe, after one attempt, for a malformed answer, recorded on its call", async () => {
    const calls = stubMeta([{ status: 200, body: { transcript: "no turns" } }]);
    const caseId = await voiceCase(toneOgg);
    await run(caseId);
    expect(calls).toHaveLength(1);
    expect(await failedAs(caseId)).toEqual([["transcribe", "ModelOutputError"]]);
    expect(await caseRow(caseId)).toMatchObject({ status: "partial", verdict: null });
    expect(await storedTranscript(caseId)).toBeNull();
  });

  it("ends partial after one attempt for a 200 whose body cannot be read (round 1)", async () => {
    for (const body of ['{"transcript":', "", "null"]) {
      const calls: string[] = [];
      const real = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        // The voice step's read of the transcript (D01 T03 §4) is answered with a claim that asks for nothing, so these
        // tests stay about transcription.
        if (url.endsWith("/responses")) return voiceReply();
        if (!url.endsWith("/asr/transcribe")) return real(input, init);
        calls.push(url);
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      });
      const caseId = await voiceCase(toneOgg);
      await run(caseId);
      expect(calls, JSON.stringify(body)).toHaveLength(1);
      expect(await failedAs(caseId), JSON.stringify(body)).toEqual([["transcribe", "ModelOutputError"]]);
      vi.restoreAllMocks();
    }
  });

  it("ends damaged and overlong recordings partial naming their class, sending nothing", async () => {
    for (const [bytes, errorClass] of [
      [toneOgg.slice(0, toneOgg.length - 200), "CorruptAudio"],
      [repeated(620), "AudioTooLong"],
    ] as const) {
      const calls = stubMeta([ok(3)]);
      const caseId = await voiceCase(bytes);
      await run(caseId);
      expect(calls, errorClass).toEqual([]);
      expect(await failedAs(caseId), errorClass).toEqual([["transcribe", errorClass]]);
      vi.restoreAllMocks();
    }
  });

  it("retries a step whose second chunk failed, finishing with every chunk's turns in order", async () => {
    // 603 seconds: two chunks. The second chunk's calls fail (500 on each of the client's three attempts), then the
    // step's second attempt transcribes both.
    const calls = stubMeta([
      ok(600, "first"),
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      ok(600, "first"),
      ok(3, "second"),
    ]);
    const caseId = await voiceCase(repeated(201));
    await run(caseId);
    expect(calls).toHaveLength(6);
    const transcript = await storedTranscript(caseId);
    expect(transcript?.turns.map((t) => [t.chunk, t.text])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    // The second chunk's turn starts after the first chunk's 600 seconds.
    expect(transcript?.turns[1]?.startMs).toBe(600_000 + 100);
    expect((await caseRow(caseId))?.status).toBe("done");
    // Every attempt reserved once: the first chunk twice (once per step attempt), the failing chunk three times.
    expect((await spend(caseId)).length).toBe(6);
  }, 60_000);

  it("ends partial naming transcribe with no verdict when every attempt fails, at two attempts", async () => {
    const calls = stubMeta([{ status: 500, body: {} }]);
    const caseId = await voiceCase(toneOgg);
    await run(caseId);
    // Two step attempts, each the client's three.
    expect(calls).toHaveLength(6);
    expect((await failedAs(caseId)).map(([step]) => step)).toEqual(["transcribe"]);
    expect(await caseRow(caseId)).toMatchObject({ status: "partial", verdict: null });
  });

  it("recovers when the transcript cannot be stored after a paid call, paying once per attempt", async () => {
    const calls = stubMeta([ok(3)]);
    // The transcript's object write fails on the step's first attempt only.
    const put = env.ARTEFACTS.put.bind(env.ARTEFACTS);
    let failed = 0;
    vi.spyOn(env.ARTEFACTS, "put").mockImplementation(async (key, ...rest) => {
      if (String(key).includes("/audio/") && failed++ === 0) throw new Error("R2 put failed");
      return put(key, ...rest);
    });
    const caseId = await voiceCase(toneOgg);
    await run(caseId);
    expect(calls).toHaveLength(2);
    expect(await spend(caseId)).toEqual([
      { attempt: 1, state: "settled" },
      { attempt: 1, state: "settled" },
    ]);
    expect((await storedTranscript(caseId))?.text).toBe("Pay the new account today.");
    expect((await caseRow(caseId))?.status).toBe("done");
  });

  it("ends partial naming transcribe, no verdict, when the transcript can never be stored", async () => {
    const calls = stubMeta([ok(3)]);
    const put = env.ARTEFACTS.put.bind(env.ARTEFACTS);
    vi.spyOn(env.ARTEFACTS, "put").mockImplementation(async (key, ...rest) => {
      if (String(key).includes("/audio/")) throw new Error("R2 put failed");
      return put(key, ...rest);
    });
    const caseId = await voiceCase(toneOgg);
    await run(caseId);
    // Two attempts, each paid once and recorded.
    expect(calls).toHaveLength(2);
    expect((await spend(caseId)).length).toBe(2);
    expect((await failedAs(caseId)).map(([step]) => step)).toEqual(["transcribe"]);
    expect(await caseRow(caseId)).toMatchObject({ status: "partial", verdict: null });
    expect(await storedTranscript(caseId)).toBeNull();
  });

  it("is refused at the budget before anything is sent, ending partial with the cap", async () => {
    await reserve(env.DB, {
      at: new Date().toISOString(),
      day: sastDay(),
      source: "worker",
      caller: "earlier",
      model: "muse-spark-1.3",
      caseId: null,
      attempt: 1,
      estimateUsd: DAY_CAP_USD,
    });
    const calls = stubMeta([ok(3)]);
    const caseId = await voiceCase(toneOgg);
    await run(caseId);
    expect(calls).toEqual([]);
    expect(await failedAs(caseId)).toEqual([["transcribe", "budget:day:muse-voice-transcribe-1.0"]]);
  });

  it("records no transcribe step for a mail case", async () => {
    const calls = stubMeta([ok(3)]);
    const made = await createCase(env.DB, {
      orgId: ORG,
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "user-transcribe",
      sourceKind: "mail",
    });
    if (!made.ok) throw new Error(made.error.message);
    await putRaw(store, made.value.id, forwards["inline-forward"]);
    await run(made.value.id);
    expect(calls).toEqual([]);
    expect((await events(made.value.id)).some((e) => e.step === "transcribe")).toBe(false);
  });
});
