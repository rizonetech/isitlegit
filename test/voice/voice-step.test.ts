import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCheckOutcomes, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment, type Store } from "../../src/intake/store";
import { voice } from "../../src/voice/step";
import { toneOgg } from "../fixtures/audio/load";
import { forwards } from "../fixtures/forward/load";

// D01 T03 §4: the Workflow's `voice` step for an uploaded voice note, Meta stubbed at the gateway: the transcription
// answered from a script, the model's read of the transcript from another, every call counted and its ledger row read.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const TEXT =
  "Hi, this is Thandi from Karoo Parts. Please pay the invoice today into account 1234 5678 90, it is for R48 000. It must be done today.";
const CLAIM = {
  request: "pay",
  request_quote: "Please pay the invoice today",
  claimed_identity: "Thandi from Karoo Parts",
  identity_quote: "this is Thandi from Karoo Parts",
  urgency: "high",
  urgency_quote: "It must be done today",
  payment_quote: "into account 1234 5678 90",
};
const transcription = (text = TEXT) =>
  new Response(
    JSON.stringify({
      sessionId: "s-1",
      transcript: text,
      audioDurationMs: 3000,
      turns: text ? [{ turnId: 1, startMs: 100, endMs: 2000, transcript: text, speaker: "A" }] : [],
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-asr" } },
  );
const modelReply = (body: unknown) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-voice", "x-request-id": "req-1" } },
  );
const fail = (status: number) =>
  new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

type Stub = { transcribed: number; asked: string[] };
function stubMeta(options: { text?: string; answers?: (() => Promise<Response> | Response)[] } = {}): Stub {
  const seen: Stub = { transcribed: 0, asked: [] };
  const real = globalThis.fetch;
  const answers = options.answers ?? [() => modelReply(CLAIM)];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/asr/transcribe")) {
      seen.transcribed++;
      return transcription(options.text);
    }
    if (url.endsWith("/responses")) {
      const body = String(init?.body ?? "");
      // Only the voice extraction call carries the transcript block; the verdict agent's calls
      // in the same Workflow are answered but never counted as voice calls.
      if (!body.includes("<<UNTRUSTED:transcript:")) return modelReply(CLAIM);
      seen.asked.push(body);
      const next = answers[Math.min(seen.asked.length, answers.length) - 1];
      return (next as () => Promise<Response> | Response)();
    }
    return real(input, init);
  });
  return seen;
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM model_spend").run();
});
afterEach(() => vi.restoreAllMocks());

async function voiceCase() {
  const made = await createCase(env.DB, {
    orgId: "org-voice-step",
    channel: "upload",
    headersAvailable: false,
    uploadedBy: "user-voice",
    sourceKind: "audio",
    uploadName: "voice-note.ogg",
    uploadMediaType: "audio/ogg",
  });
  if (!made.ok) throw new Error(made.error.message);
  await putAttachment(store, made.value.id, "voice-note.ogg", toneOgg, "audio/ogg");
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
const steps = async (caseId: string) =>
  (
    await env.DB.prepare("SELECT step, status FROM case_events WHERE case_id = ? ORDER BY id")
      .bind(caseId)
      .all<{ step: string; status: string }>()
  ).results;
const caseRow = (caseId: string) =>
  env.DB.prepare("SELECT status FROM cases WHERE id = ?").bind(caseId).first<{ status: string }>();
const voiceItems = async (caseId: string) =>
  (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("voice."));
const ledger = async (caseId: string) =>
  (
    await env.DB.prepare(
      "SELECT attempt, state FROM model_spend WHERE case_id = ? AND caller = 'voice-extract' ORDER BY at",
    )
      .bind(caseId)
      .all<{ attempt: number; state: string }>()
  ).results;
const outcomeOf = async (caseId: string, name: string) =>
  (await readCheckOutcomes(env.DB, caseId))?.find((o) => o.check === name);

describe("the voice step", () => {
  it("reads the transcript for what the speaker asks and stores it as evidence through the Workflow", async () => {
    const seen = stubMeta();
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked).toHaveLength(1);
    // The transcript went to the model inside the untrusted block, and the claim came back as evidence.
    expect(seen.asked[0]).toContain("<<UNTRUSTED:transcript:");
    expect(seen.asked[0]).toContain("Please pay the invoice today");
    expect((await steps(caseId)).filter((s) => s.step === "voice").map((s) => s.status)).toEqual(["started", "done"]);
    // One voice.transcript item per recording among them (D01 T03 §16).
    expect((await voiceItems(caseId)).map((i) => [i.check, i.severity])).toEqual([
      ["voice.request", "high"],
      ["voice.claimed_identity", "info"],
      ["voice.urgency", "medium"],
      ["voice.transcript", "info"],
      ["voice.limits", "info"],
    ]);
    expect(await outcomeOf(caseId, "voice.request")).toMatchObject({ outcome: "ran", summary: "asks for a payment" });
    expect(await ledger(caseId)).toEqual([{ attempt: 1, state: "settled" }]);
    expect((await caseRow(caseId))?.status).toBe("done");
  }, 60_000);

  it("reads the stored result on a replay, calling the model once", async () => {
    const seen = stubMeta();
    const caseId = await voiceCase();
    await run(caseId);
    const again = await voice(env as unknown as Parameters<typeof voice>[0], store, caseId);
    expect(again).toMatchObject({ state: "read", complete: true });
    expect(seen.asked).toHaveLength(1);
    expect(await ledger(caseId)).toHaveLength(1);
  }, 60_000);

  it("completes with a slow answer", async () => {
    const seen = stubMeta({
      answers: [() => new Promise((resolve) => setTimeout(() => resolve(modelReply(CLAIM)), 400))],
    });
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked).toHaveLength(1);
    expect((await voiceItems(caseId))[0]?.severity).toBe("high");
  }, 60_000);

  it("states a refused answer as not checked, final, and the case still completes", async () => {
    const seen = stubMeta({ answers: [() => fail(400)] });
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked).toHaveLength(1);
    const items = await voiceItems(caseId);
    expect(items.find((i) => i.check === "voice.request")).toMatchObject({
      severity: "info",
      detail: { checked: false, reason: expect.stringContaining("model-invalid-request") },
    });
    expect(items.some((i) => i.check === "voice.limits")).toBe(true);
    expect(await outcomeOf(caseId, "voice.request")).toMatchObject({ outcome: "partial" });
    expect((await caseRow(caseId))?.status).toBe("done");
  }, 60_000);

  it("states exhausted retries as not checked, bounded, and the case still completes", async () => {
    const seen = stubMeta({ answers: [() => fail(503)] });
    const caseId = await voiceCase();
    await run(caseId);
    // The client's three attempts in each of the step's two, every one on the ledger; then a named not-checked.
    expect(seen.asked.length).toBeGreaterThanOrEqual(2);
    expect(seen.asked.length).toBeLessThanOrEqual(6);
    expect((await ledger(caseId)).length).toBe(seen.asked.length);
    expect((await voiceItems(caseId)).find((i) => i.check === "voice.request")).toMatchObject({
      severity: "info",
      detail: { checked: false, reason: expect.stringContaining("the reading did not finish") },
    });
    expect(await outcomeOf(caseId, "voice.request")).toMatchObject({ outcome: "partial" });
    expect((await caseRow(caseId))?.status).toBe("done");
  }, 120_000);

  it("pays again for a result that could not be stored, once more and no more, each call on the ledger", async () => {
    const seen = stubMeta();
    const put = env.ARTEFACTS.put.bind(env.ARTEFACTS);
    let failed = 0;
    vi.spyOn(env.ARTEFACTS, "put").mockImplementation(async (key, ...rest) => {
      if (String(key).includes("voice-claim") && failed++ === 0) throw new Error("R2 put failed");
      return put(key, ...rest);
    });
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked).toHaveLength(2);
    expect((await ledger(caseId)).length).toBe(2);
    expect((await voiceItems(caseId))[0]).toMatchObject({ check: "voice.request", severity: "high" });
  }, 60_000);

  it("pays again for a write whose acknowledgement was lost, once more and no more", async () => {
    const seen = stubMeta();
    const put = env.ARTEFACTS.put.bind(env.ARTEFACTS);
    let lost = 0;
    vi.spyOn(env.ARTEFACTS, "put").mockImplementation(async (key, ...rest) => {
      const done = await put(key, ...rest);
      if (String(key).includes("voice-claim") && lost++ === 0) throw new Error("the acknowledgement was lost");
      return done;
    });
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked.length).toBeLessThanOrEqual(2);
    expect((await ledger(caseId)).length).toBe(seen.asked.length);
    expect((await voiceItems(caseId))[0]).toMatchObject({ check: "voice.request", severity: "high" });
  }, 60_000);

  it("states a transcript longer than the part the model reads as cut, partial, never read whole", async () => {
    const long = `${TEXT} ${"filler words ".repeat(12_000)}`;
    const seen = stubMeta({ text: long });
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]).toContain("[truncated]");
    expect((await voiceItems(caseId)).find((i) => i.detail.reason === "cut")).toMatchObject({
      severity: "info",
      detail: { checked: false },
    });
    expect(await outcomeOf(caseId, "voice.request")).toMatchObject({ outcome: "partial" });
  }, 60_000);

  it("makes no call for a silent recording, and states it", async () => {
    const seen = stubMeta({ text: "" });
    const caseId = await voiceCase();
    await run(caseId);
    expect(seen.asked).toEqual([]);
    expect((await voiceItems(caseId)).find((i) => i.check === "voice.request")?.summary).toMatch(/no speech was heard/);
    expect((await voiceItems(caseId)).some((i) => i.check === "voice.limits")).toBe(true);
  }, 60_000);

  it("is not run for a mail case, which has no voice evidence", async () => {
    const seen = stubMeta();
    const made = await createCase(env.DB, { orgId: "org-voice-step", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const { putRaw } = await import("../../src/intake/store");
    await putRaw(store, made.value.id, forwards["attached-rfc822"] as Uint8Array);
    await run(made.value.id).catch(() => undefined);
    expect((await steps(made.value.id)).some((s) => s.step === "voice")).toBe(false);
    expect(seen.asked).toEqual([]);
    expect(await voiceItems(made.value.id)).toEqual([]);
  }, 60_000);
});
