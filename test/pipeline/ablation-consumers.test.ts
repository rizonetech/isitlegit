import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verdictToolDeps } from "../../src/agent/loop";
import { bundled, getBrand } from "../../src/checks/brands";
import { readEvidence, saveEvidence } from "../../src/checks/evidence";
import { createCase, setStatus } from "../../src/db/cases";
import { putArtefact, putAttachment, putRaw, type Store } from "../../src/intake/store";
import { verdict } from "../../src/pipeline/analysis-workflow";
import { caseAblateFlagFor } from "../../src/pipeline/case-experiments";
import { storeVoice } from "../../src/voice/step";
import { bindExperiment } from "../fixtures/ablation";
import { toneOgg } from "../fixtures/audio/load";
import { BLUE_PNG, RED_PNG } from "../fixtures/vision/emails";

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
async function run(caseId: string, cached = false) {
  const instance = await introspectWorkflowInstance(env.ANALYSIS, caseId);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      if (cached) {
        await m.mockStepResult(
          { name: "admit" },
          { admit: true, orgId: "org-voice-step", channel: "upload", sourceKind: "audio", headersAvailable: false },
        );
        await m.mockStepResult({ name: "parse" }, "cached-summary");
        await m.mockStepResult({ name: "transcribe" }, { transcript: "cached-transcript", chunks: 1 });
        await m.mockStepResult({ name: "voice" }, { state: "silent" });
      }
    });
    await env.ANALYSIS.create({ id: caseId, params: { caseId } });
    await instance.waitForStatus("complete");
  } finally {
    await instance.dispose();
  }
}

describe("immutable ablation consumers", () => {
  it("isolates concurrent rule-only and full cases in one organisation and retains full model accounting", async () => {
    const rule = await voiceCase();
    const full = await voiceCase();
    await bindExperiment(rule, "no-agent-reasoning");
    await bindExperiment(full, "full");
    for (const id of [rule, full])
      await saveEvidence(env.DB, id, [
        {
          check: "attachment.executable",
          severity: "critical",
          summary: "A program is attached.",
          detail: {},
          artefacts: [],
        },
      ]);
    stubMeta();
    await env.CACHE.put("ablate:org-voice-step", "no-agent-reasoning");
    const [rules, retained] = await Promise.all([verdict(env, env.DB, store, rule), verdict(env, env.DB, store, full)]);
    expect(rules.view).toMatchObject({ verdict: "malicious", ablated: "no-agent-reasoning" });
    expect(rules.view.reasons[0]?.evidenceIds).toEqual(["E1"]);
    expect(retained.view.verdict).toBe("malicious");
    expect(retained.view.ablated ?? null).toBeNull();
    const spent = async (id: string) =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM model_spend WHERE case_id=? AND caller='verdict-agent'")
          .bind(id)
          .first<{ n: number }>()
      )?.n;
    expect(await spent(rule)).toBe(0);
    expect(await spent(full)).toBeGreaterThan(0);
  });

  it("prevents agent tool dependencies from restoring a removed walk or SAM after KV changes", async () => {
    for (const arm of ["no-walkthrough", "no-sam"]) {
      const id = await voiceCase();
      await bindExperiment(id, arm);
      await saveEvidence(env.DB, id, [
        {
          check: "link.credential_form",
          severity: "high",
          summary: "Sign-in form.",
          detail: { page: "https://synthetic.example/login" },
          artefacts: [],
        },
      ]);
      await env.CACHE.put("ablate:org-voice-step", "full");
      let calls = 0;
      const deps = verdictToolDeps(env, env.DB, store, id, "org-voice-step", bundled, null, {
        launch: async () => {
          calls++;
          throw new Error("must not launch");
        },
        metaFetch: async () => {
          calls++;
          throw new Error("must not call model");
        },
      });
      if (arm === "no-walkthrough") {
        const items = await deps.walk("https://synthetic.example/login");
        expect(items.some((e) => e.check === "walkthrough.ablated")).toBe(true);
      } else {
        const fence = { deadlineAt: Date.now() + 1000, expired: () => false };
        const brand = getBrand(bundled, "FNB");
        if (!brand) throw new Error("Synthetic reference missing");
        expect(await deps.segmentLogos?.({ artefactKey: "unused", concept: "logo" }, fence)).toEqual([
          expect.objectContaining({ detail: expect.objectContaining({ ablated: "no-sam" }) }),
        ]);
        expect(await deps.compareLogo?.({ cropKey: "unused", brand }, fence)).toEqual([
          expect.objectContaining({ detail: expect.objectContaining({ ablated: "no-sam" }) }),
        ]);
      }
      expect(calls).toBe(0);
    }
  });

  it.each(["audio", "mail"])(
    "omits ASR, extraction and cached contributions for %s while full retains both calls",
    async (kind) => {
      const make = async () => {
        if (kind === "audio") return voiceCase();
        const made = await createCase(env.DB, {
          orgId: "org-voice-step",
          channel: "upload",
          sourceKind: "mail",
          headersAvailable: true,
          uploadedBy: "user-voice",
        });
        if (!made.ok) throw new Error(made.error.message);
        let binary = "";
        for (const byte of toneOgg) binary += String.fromCharCode(byte);
        await putRaw(
          store,
          made.value.id,
          new TextEncoder().encode(
            [
              "From: speaker@demo.isitlegit.co.za",
              "To: member@demo.isitlegit.co.za",
              "Subject: Recorded message",
              'Content-Type: multipart/mixed; boundary="recording"',
              "MIME-Version: 1.0",
              "",
              "--recording",
              "Content-Type: text/plain",
              "",
              "Please listen.",
              "--recording",
              "Content-Type: audio/ogg",
              'Content-Disposition: attachment; filename="voice-note.ogg"',
              "Content-Transfer-Encoding: base64",
              "",
              btoa(binary),
              "--recording--",
              "",
            ].join("\r\n"),
          ),
        );
        return made.value.id;
      };
      const flagged = await make();
      await bindExperiment(flagged, "no-transcribe");
      await storeVoice(store, flagged, {
        state: "read",
        dropped: 0,
        complete: true,
        claim: {
          request: "pay",
          requestQuote: "Please pay",
          claimedIdentity: "Synthetic caller",
          identityQuote: "Synthetic caller",
          urgency: "high",
          urgencyQuote: "today",
          paymentQuote: null,
        },
      });
      await putArtefact(
        store,
        flagged,
        "audio",
        "transcript.json",
        new TextEncoder().encode(
          JSON.stringify({
            text: TEXT,
            complete: true,
            gaps: [],
            turns: [{ chunk: 0, startMs: 0, endMs: 2000, text: TEXT, speaker: null }],
          }),
        ),
        "application/json",
      );
      const seen = stubMeta();
      await env.CACHE.put("ablate:org-voice-step", "full");
      await run(flagged);
      expect(seen.transcribed).toBe(0);
      expect(seen.asked).toHaveLength(0);
      const items = await readEvidence(env.DB, flagged);
      expect(items.some((e) => ["voice.claimed_identity", "voice.urgency", "voice.transcript"].includes(e.check))).toBe(
        false,
      );
      expect(items.filter((e) => e.check === "voice.request")).toEqual([
        expect.objectContaining({
          severity: "info",
          detail: expect.objectContaining({ checked: false, reason: "no-transcribe" }),
        }),
      ]);
      expect(JSON.stringify(items)).toContain("no-transcribe");
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM model_spend WHERE case_id=? AND caller IN ('transcribe','voice-extract')",
        )
          .bind(flagged)
          .first(),
      ).toEqual({ n: 0 });
      expect(await env.DB.prepare("SELECT status FROM cases WHERE id=?").bind(flagged).first()).toEqual({
        status: "done",
      });
      const full = await make();
      await bindExperiment(full, "full");
      await env.CACHE.put("ablate:org-voice-step", "no-transcribe");
      await run(full);
      expect(seen.transcribed).toBeGreaterThan(0);
      expect(seen.asked).toHaveLength(1);
      expect((await readEvidence(env.DB, full)).some((e) => e.check === "voice.request")).toBe(true);
    },
  );

  it.each(["no-sam", "full"])(
    "keeps %s on the non-payment document fallback while retaining document and picture reading",
    async (arm) => {
      const counts = { sam: 0, reading: 0, document: 0 };
      const real = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith("/responses")) return real(input, init);
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.model === "sam-3.1") {
          counts.sam++;
          return modelReply({});
        }
        const name = body.text?.format?.name;
        if (name === "payment_document") {
          counts.document++;
          return modelReply({
            type: "other",
            issuer: null,
            currency: null,
            amount_cents: null,
            paid_at: null,
            issued_at: null,
            reference: null,
            beneficiary: { name: null, account_number: null, branch_code: null },
            layout_differences: [],
          });
        }
        if (name === "mail_reading") {
          counts.reading++;
          return modelReply({
            readings: [
              {
                image: "image-1",
                claimed_brand: null,
                requested_action: "none",
                urgency_cues: [],
                visible_sender: null,
                payment_request: false,
                confidence: 0.95,
              },
            ],
          });
        }
        return modelReply(CLAIM);
      });
      const made = await createCase(env.DB, {
        orgId: "org-fallback-ablation",
        channel: "upload",
        sourceKind: "image",
        headersAvailable: false,
        uploadedBy: "user-image",
        uploadName: "notice.png",
        uploadMediaType: "image/png",
      });
      if (!made.ok) throw new Error(made.error.message);
      const id = made.value.id;
      await putAttachment(store, id, "notice.png", arm === "full" ? BLUE_PNG : RED_PNG, "image/png");
      await bindExperiment(id, arm);
      await run(id);
      const items = await readEvidence(env.DB, id);
      expect(counts.reading, JSON.stringify(items)).toBe(1);
      expect(counts.document).toBe(1);
      if (arm === "no-sam") expect(counts.sam).toBe(0);
      else expect(counts.sam).toBeGreaterThan(0);
      expect(items.find((e) => e.check === "document.type")?.detail.type).toBe("other");
      expect(items.find((e) => e.check === "vision.coverage")?.detail.ablated ?? null).toBe(
        arm === "no-sam" ? "no-sam" : null,
      );
    },
  );

  it("rejects mismatched deployment on each entry before cached model steps can resume", async () => {
    const id = await voiceCase();
    await bindExperiment(id, "full", "f".repeat(40));
    const seen = stubMeta();
    await expect(caseAblateFlagFor(env, id)).rejects.toThrow("deployment");
    await setStatus(env.DB, "org-voice-step", id, "running");
    await run(id, true);
    expect(seen.transcribed).toBe(0);
    expect(seen.asked).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status FROM cases WHERE id=?").bind(id).first()).toEqual({ status: "partial" });
  });

  it("propagates attribution storage failure and ignores disabled admission for already admitted arms", async () => {
    const id = await voiceCase();
    await bindExperiment(id, "no-transcribe");
    const disabled = { ...env, EVAL_ORG_ID: "" };
    expect(await caseAblateFlagFor(disabled, id)).toBe("no-transcribe");
    const down = {
      prepare: () => {
        throw new Error("synthetic attribution outage");
      },
    } as unknown as D1Database;
    await expect(caseAblateFlagFor({ ...env, DB: down }, id)).rejects.toThrow("synthetic attribution outage");
    await expect(verdict({ ...env, DB: down }, down, store, id)).rejects.toThrow("synthetic attribution outage");
    const malformed = {
      prepare: () => ({ bind: () => ({ first: async () => ({ arm: "full", deployment: env.COMMIT_SHA }) }) }),
    } as unknown as D1Database;
    await expect(caseAblateFlagFor({ ...env, DB: malformed }, id)).rejects.toThrow();
  });
});
