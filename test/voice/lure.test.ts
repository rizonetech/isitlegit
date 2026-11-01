import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import {
  artefactsOf,
  parsedKey,
  putAttachment,
  putParsed,
  putRaw,
  readArtefact,
  type Store,
} from "../../src/intake/store";
import { transcribeAttachments } from "../../src/pipeline/analysis-workflow";
import { readVoice } from "../../src/voice/step";
import lureText from "../fixtures/voicemail-html-lure.eml?raw";
import newsletterText from "../fixtures/voicemail-newsletter.eml?raw";
import wavText from "../fixtures/voicemail-wav.eml?raw";

// D01 T03 §5: a mail case's audio attachments go through the voice steps, and an HTML attachment posing as a voice
// message is flagged. Both model endpoints are stubbed at fetch; decoding, orchestration and persistence are real.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-lure";
const bytes = (s: string) => new TextEncoder().encode(s);

function stubMeta(text: string | string[] = "You have a new voice message from the office.") {
  const texts = Array.isArray(text) ? text : [text];
  const calls: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/responses"))
      return new Response(
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
    if (!url.endsWith("/asr/transcribe")) return real(input, init);
    calls.push(url);
    const said = texts[Math.min(calls.length, texts.length) - 1] as string;
    return new Response(
      JSON.stringify({
        sessionId: "s-1",
        transcript: said,
        audioDurationMs: 500,
        turns: [{ turnId: 1, startMs: 0, endMs: 500, transcript: said, speaker: "A" }],
      }),
      { headers: { "content-type": "application/json", "cf-aig-log-id": "log-asr" } },
    );
  });
  return calls;
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM model_spend").run();
});
afterEach(() => vi.restoreAllMocks());

async function mailCase(raw: Uint8Array) {
  const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: false });
  if (!made.ok) throw new Error(made.error.message);
  await putRaw(store, made.value.id, raw);
  return made.value.id;
}
async function run(caseId: string) {
  const instance = await introspectWorkflowInstance(env.ANALYSIS, caseId);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
    });
    await env.ANALYSIS.create({ id: caseId, params: { caseId } });
    await instance.waitForStatus("complete");
  } finally {
    await instance.dispose();
  }
}
const events = async (caseId: string) =>
  (
    await env.DB.prepare("SELECT step, status FROM case_events WHERE case_id = ? ORDER BY id")
      .bind(caseId)
      .all<{ step: string; status: string }>()
  ).results;
const stepsDone = async (caseId: string) =>
  (await events(caseId)).filter((e) => e.status === "done").map((e) => e.step);

function mailWith(attachments: { name: string; type: string; body: Uint8Array }[]) {
  const boundary = "inline-boundary";
  const b64 = (b: Uint8Array) => {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/(.{76})/g, "$1\r\n");
  };
  const parts = attachments
    .map(
      (a) =>
        `--${boundary}\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.body)}\r\n`,
    )
    .join("");
  return bytes(
    `From: Voicebox <notify@fictional-voicebox.example>\r\nTo: check@isitlegit.co.za\r\nSubject: Voice message\r\nMessage-ID: <inline-${Math.random()}@fictional-voicebox.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee the attachment.\r\n${parts}--${boundary}--\r\n`,
  );
}
// The fixture WAV's bytes, out of the fixture mail (a tiny generated silence).
function wavBytes(): Uint8Array {
  const match = /Content-Type: audio\/wav[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(wavText);
  if (!match) throw new Error("the fixture carries no WAV");
  const bin = atob((match[1] as string).replace(/\s/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("voicemail attachments in email", () => {
  it("transcribes a mail case's WAV attachment and reads its claim as evidence", async () => {
    const calls = stubMeta();
    const id = await mailCase(bytes(wavText));
    await run(id);
    const steps = await stepsDone(id);
    expect(steps).toContain("transcribe");
    expect(steps).toContain("voice");
    expect(calls.length).toBeGreaterThan(0);
    // The stored transcript reads back with the stub's words.
    const transcript = (await artefactsOf(store, id, "audio")).find((a) => a.key.endsWith("-transcript.json"));
    expect(transcript).toBeDefined();
    const read = transcript ? await readArtefact(store, id, transcript.key) : null;
    const stored = read && "body" in read ? JSON.parse(new TextDecoder().decode(read.body)) : null;
    expect(stored?.text).toContain("new voice message");
    // The stored claim reads back as read, the checks outcome is stored, and the case completed.
    expect((await readVoice(store, id))?.state).toBe("read");
    const row = await env.DB.prepare("SELECT status FROM cases WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("done");
    // The §4 voice evidence is in the case's evidence, and no step failed for transcribe or voice.
    const evidence = await readEvidence(env.DB, id);
    expect(evidence.some((e) => e.check.startsWith("voice."))).toBe(true);
    expect(
      (await events(id)).some((e) => (e.step === "transcribe" || e.step === "voice") && e.status === "failed"),
    ).toBe(false);
  });

  it("flags an HTML attachment posing as a voice message, and not a newsletter", async () => {
    stubMeta();
    const lure = await mailCase(bytes(lureText));
    await run(lure);
    const lureEvidence = await readEvidence(env.DB, lure);
    expect(lureEvidence).toContainEqual(expect.objectContaining({ check: "voice.lure", severity: "medium" }));
    const news = await mailCase(bytes(newsletterText));
    await run(news);
    const newsEvidence = await readEvidence(env.DB, news);
    expect(newsEvidence.some((e) => e.check === "voice.lure")).toBe(false);
  });

  it("states a corrupt recording as not read and completes the case", async () => {
    stubMeta();
    const junk = new TextEncoder().encode("RIFFxxxxWAVEfmt not really audio at all");
    const id = await mailCase(mailWith([{ name: "message.wav", type: "audio/wav", body: junk }]));
    await run(id);
    const evidence = await readEvidence(env.DB, id);
    expect(evidence.some((e) => e.check.startsWith("voice.") && e.detail.checked === false)).toBe(true);
    expect((await events(id)).some((e) => e.step === "checks" && e.status === "done")).toBe(true);
  });

  it("transcribes several recordings in order, each kept under its own name", async () => {
    const calls = stubMeta(["First recording speaks.", "Second recording speaks."]);
    const wav = wavBytes();
    const id = await mailCase(
      mailWith([
        { name: "one.wav", type: "audio/wav", body: wav },
        { name: "two.wav", type: "audio/wav", body: wav },
      ]),
    );
    await run(id);
    expect(calls.length).toBe(2);
    // The joined transcript keeps the recordings in order, each under its own name.
    const joined = (await artefactsOf(store, id, "audio")).find(
      (a) => a.key.endsWith("-transcript.json") && !/-transcript-\d\.json$/.test(a.key),
    );
    const readJoined = joined ? await readArtefact(store, id, joined.key) : null;
    const storedJoined =
      readJoined && "body" in readJoined ? JSON.parse(new TextDecoder().decode(readJoined.body)) : null;
    expect(storedJoined?.text).toBe(
      "[Recording 1 of the message's audio attachments: one.wav]\nFirst recording speaks.\n[Recording 2 of the message's audio attachments: two.wav]\nSecond recording speaks.",
    );
    expect(storedJoined?.recordings).toEqual([
      { filename: "one.wav", outcome: "transcribed" },
      { filename: "two.wav", outcome: "transcribed" },
    ]);
    const names = (await artefactsOf(store, id, "audio")).map((a) => a.key);
    expect(names.some((k) => k.endsWith("-transcript-1.json"))).toBe(true);
    expect(names.some((k) => k.endsWith("-transcript-2.json"))).toBe(true);
  });
});

describe("voicemail lure variants and recording outcomes", () => {
  it("flags an entity-written lure with a play button, and not a podcast button", async () => {
    stubMeta();
    const lure = await mailCase(
      mailWith([
        {
          name: "play.html",
          type: "text/html",
          body: bytes(
            "<html><body><p>You have a voice&nbsp;message waiting.</p><button>Play message</button></body></html>",
          ),
        },
      ]),
    );
    await run(lure);
    expect((await readEvidence(env.DB, lure)).some((e) => e.check === "voice.lure")).toBe(true);
    const podcast = await mailCase(
      mailWith([
        {
          name: "news.html",
          type: "text/html",
          body: bytes("<html><body><p>Listen to our podcast.</p><button>Play</button></body></html>"),
        },
      ]),
    );
    await run(podcast);
    expect((await readEvidence(env.DB, podcast)).some((e) => e.check === "voice.lure")).toBe(false);
  });

  it("transcribes a WAV whatever its declared type says, and names a corrupt recording in the evidence", async () => {
    stubMeta();
    const wav = wavBytes();
    const declared = await mailCase(mailWith([{ name: "message.wav", type: "application/octet-stream", body: wav }]));
    await run(declared);
    expect((await readVoice(store, declared))?.state).toBe("read");

    const junk = new TextEncoder().encode("RIFFxxxxWAVEfmt not really audio at all");
    const mixed = await mailCase(
      mailWith([
        { name: "good.wav", type: "audio/wav", body: wav },
        { name: "broken.wav", type: "audio/wav", body: junk },
      ]),
    );
    await run(mixed);
    const evidence = await readEvidence(env.DB, mixed);
    expect(evidence.some((e) => e.check.startsWith("voice.") && e.summary.includes("broken.wav"))).toBe(true);
  });

  it("keeps an incomplete recording incomplete across a resume (round 1)", async () => {
    const real = globalThis.fetch;
    let asrCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/asr/transcribe")) return real(input, init);
      asrCalls++;
      return new Response(
        JSON.stringify({
          sessionId: "s-1",
          transcript: "Words before the gap.",
          audioDurationMs: 500,
          turns: [
            { turnId: 1, startMs: 0, endMs: 250, transcript: "Words before the gap.", speaker: "A" },
            { turnId: 2, startMs: 250, endMs: 500, transcript: "", speaker: "A" },
          ],
        }),
        { headers: { "content-type": "application/json", "cf-aig-log-id": "log-gap" } },
      );
    });
    const envArg = env as unknown as Parameters<typeof transcribeAttachments>[0];
    const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const kept = await putAttachment(store, made.value.id, "gap.wav", wavBytes(), "audio/wav");
    await putParsed(store, made.value.id, {
      attachments: [
        {
          key: kept.key,
          filename: "gap.wav",
          mediaType: "audio/wav",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: kept.bytes,
        },
      ],
    });
    await transcribeAttachments(envArg, store, made.value.id, parsedKey(made.value.id));
    await transcribeAttachments(envArg, store, made.value.id, parsedKey(made.value.id));
    expect(asrCalls).toBe(1);
    const joined = (await artefactsOf(store, made.value.id, "audio")).find(
      (a) => a.key.endsWith("-transcript.json") && !/-transcript-\d\.json$/.test(a.key),
    );
    const read = joined ? await readArtefact(store, made.value.id, joined.key) : null;
    const parsed = read && "body" in read ? JSON.parse(new TextDecoder().decode(read.body)) : null;
    expect(parsed?.complete).toBe(false);
  });

  it("transcribes a forwarded original's audio attachment", async () => {
    const calls = stubMeta();
    const inner = wavText;
    const outer = bytes(
      `From: Member <member@fictional-recipient.example>\r\nTo: check@isitlegit.co.za\r\nSubject: Fwd: voicemail\r\nMessage-ID: <outer-${Math.random()}@fictional-recipient.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer-b"\r\n\r\n--outer-b\r\nContent-Type: text/plain\r\n\r\nIs this real?\r\n--outer-b\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="original.eml"\r\n\r\n${inner}\r\n--outer-b--\r\n`,
    );
    const id = await mailCase(outer);
    await run(id);
    expect(calls.length).toBeGreaterThan(0);
    expect((await readVoice(store, id))?.state).toBe("read");
  });

  it("names a missing recording, and resumes a finished one without paying again", async () => {
    const calls = stubMeta();
    const envArg = env as unknown as Parameters<typeof transcribeAttachments>[0];
    const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const stored = await putAttachment(store, id, "gone.wav", wavBytes(), "audio/wav");
    await putParsed(store, id, {
      attachments: [
        {
          key: stored.key,
          filename: "gone.wav",
          mediaType: "audio/wav",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: stored.bytes,
        },
      ],
    });
    await store.bucket.delete(stored.key);
    await transcribeAttachments(envArg, store, id, parsedKey(id));
    const afterMissing = (await artefactsOf(store, id, "audio")).find((a) => a.key.endsWith("-transcript.json"));
    const readMissing = afterMissing ? await readArtefact(store, id, afterMissing.key) : null;
    const parsedMissing =
      readMissing && "body" in readMissing ? JSON.parse(new TextDecoder().decode(readMissing.body)) : null;
    expect(parsedMissing?.recordings).toEqual([{ filename: "gone.wav", outcome: "missing" }]);
    expect(calls).toHaveLength(0);

    const made2 = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: false });
    if (!made2.ok) throw new Error(made2.error.message);
    const id2 = made2.value.id;
    const kept = await putAttachment(store, id2, "kept.wav", wavBytes(), "audio/wav");
    await putParsed(store, id2, {
      attachments: [
        {
          key: kept.key,
          filename: "kept.wav",
          mediaType: "audio/wav",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: kept.bytes,
        },
      ],
    });
    await transcribeAttachments(envArg, store, id2, parsedKey(id2));
    expect(calls).toHaveLength(1);
    await transcribeAttachments(envArg, store, id2, parsedKey(id2));
    expect(calls).toHaveLength(1);
  });
});

describe("a long recording filename", () => {
  it("keeps the voice evidence instead of losing the read (round 3)", async () => {
    stubMeta();
    const name = `${"a".repeat(205)}.wav`;
    const id = await mailCase(mailWith([{ name, type: "audio/wav", body: wavBytes() }]));
    await run(id);
    expect((await readVoice(store, id))?.state).toBe("read");
    expect((await readEvidence(env.DB, id)).some((e) => e.check.startsWith("voice."))).toBe(true);
  });
});
