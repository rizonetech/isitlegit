import { env, introspectWorkflowInstance } from "cloudflare:test";
import puppeteer from "@cloudflare/puppeteer";
import { describe, expect, it, vi } from "vitest";
import { PARTIAL_HEADLINE, ruleVerdict } from "../../src/agent/rule-verdict";
import { readEvidence } from "../../src/checks/evidence";
import { createCase, setStatus } from "../../src/db/cases";
import { artefactsOf, parsedKey, putAttachment, type Store } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { ablateFlagFor, ablateKey } from "../../src/pipeline/ablate";
import { type VisionDeps, visionStep } from "../../src/vision/step";
import { storeMail } from "../fixtures/vision/emails";

// D03 T02 §3: the vision step's own bounds. A launch that never answers and one that refuses both end
// as a stated not_checked on the case, inside the step's deadline, with no browser and no model call.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

async function newCase() {
  const made = await createCase(env.DB, { orgId: "org-vision-step", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

const deps = (caseId: string, launch: VisionDeps["launch"], deadlineMs?: number): VisionDeps => ({
  db: env.DB,
  store,
  launch,
  meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId }) },
  kv: (env as unknown as Env).CACHE,
  waitUntil: () => {},
  policy: async () => ({ ok: false, reason: "refused" }),
  ...(deadlineMs ? { deadlineMs } : {}),
});

describe("visionStep bounds", () => {
  it("states not_checked inside its deadline when the browser never launches, and when launch refuses", async () => {
    const stalled = await newCase();
    const began = Date.now();
    const out = await visionStep(
      deps(stalled, () => new Promise(() => {}), 25),
      stalled,
    );
    expect(out).toEqual({ outcome: "not_checked", reason: "timeout" });
    expect(Date.now() - began).toBeLessThan(30_000);
    const items = (await readEvidence(env.DB, stalled)).filter((e) => e.check === "vision.not_checked");
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toMatchObject({ checked: false, reason: "timeout" });

    const refused = await newCase();
    const out2 = await visionStep(
      deps(refused, async () => {
        throw new Error("browser down");
      }),
      refused,
    );
    expect(out2.outcome).toBe("not_checked");
    expect((await readEvidence(env.DB, refused)).some((e) => e.check === "vision.not_checked")).toBe(true);
  }, 60_000);

  it("propagates a storage failure instead of returning an unstated not_checked", async () => {
    // When even the failure statement cannot be written, the step throws: the case must end partial,
    // never proceed to a verdict with the missing coverage concealed.
    const caseId = await newCase();
    const down = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    await expect(
      visionStep(
        {
          ...deps(caseId, async () => {
            throw new Error("browser down");
          }),
          db: down,
        },
        caseId,
      ),
    ).rejects.toThrow();
  });

  it("spends and writes nothing further when the launch resolves after the deadline", async () => {
    const caseId = await newCase();
    let calls = 0;
    const base = deps(
      caseId,
      async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { close: async () => {} } as never;
      },
      25,
    );
    const out = await visionStep(
      {
        ...base,
        meta: {
          ...base.meta,
          fetch: (async () => {
            calls += 1;
            throw new Error("must not be called");
          }) as typeof fetch,
        },
      },
      caseId,
    );
    expect(out).toEqual({ outcome: "not_checked", reason: "timeout" });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0);
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.map((e) => e.check)).toEqual(["vision.not_checked"]);
    expect(items[0]?.detail).toMatchObject({ reason: "timeout" });
  }, 60_000);
});

describe("visionStep no-sam ablation (D03 T03 §6)", () => {
  const reply = (body: unknown) =>
    new Response(
      JSON.stringify({
        id: "r",
        object: "response",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
    );

  const samSse = (events: unknown[]) =>
    new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
    });

  const mask = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
  const maskText = `<0f>0<|box;x1=10;y1=10;x2=60;y2=40;w=320;h=334;c=0.9|><|mask;x=0;y=0;data=27,60,~${mask}|>\n`;
  const samBoxed = () =>
    samSse([
      { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: maskText },
      { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: maskText },
      {
        type: "response.completed",
        response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);

  const safeReading = () => ({
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

  const claimedReading = (brand: string) => ({
    readings: [
      {
        image: "image-1",
        claimed_brand: brand,
        requested_action: "pay",
        urgency_cues: ["Pay today"],
        visible_sender: "billing@proteabank.example",
        payment_request: true,
        confidence: 0.92,
      },
    ],
  });

  async function mailCase(orgId: string, marker: string) {
    const made = await createCase(env.DB, { orgId, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    await storeMail(store, caseId, { text: `Monthly statement for [${marker}].` });
    return caseId;
  }

  it("skips SAM and logo comparison under no-sam, preserves reading and cache eligibility, and keeps safe ruleVerdict whole unless a real loss occurs", async () => {
    const seen: string[] = [];
    let readingCalls = 0;
    const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { model?: string; text?: { format?: { name?: string } } })
          : {};
      if (body.model === "sam-3.1") {
        seen.push("sam-3.1");
        throw new Error("SAM must not be called under no-sam");
      }
      const name = body.text?.format?.name ?? "other";
      seen.push(name);
      if (name === "logo_grounding" || name === "logo_comparison") {
        throw new Error(`${name} must not be called under no-sam`);
      }
      if (name === "mail_reading") {
        readingCalls += 1;
        return reply(safeReading());
      }
      return reply({});
    }) as typeof fetch;

    const first = await mailCase("org-no-sam-1", "whole-cache-proof");
    const out1 = await visionStep(
      {
        ...deps(first, () => puppeteer.launch(env.BROWSER)),
        meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId: first }), fetch: fetchStub },
        ablateFlag: async () => "no-sam",
      },
      first,
    );
    expect(out1.outcome).toBe("read");
    expect(seen).toEqual(["mail_reading"]);
    expect(readingCalls).toBe(1);
    expect(await artefactsOf(store, first, "crop")).toHaveLength(0);

    const evidence1 = await readEvidence(env.DB, first);
    const cov1 = evidence1.find((e) => e.check === "vision.coverage");
    expect(cov1?.detail).toEqual({ ablated: "no-sam", complete: true, losses: [] });
    expect("checked" in (cov1?.detail ?? {})).toBe(false);
    // Safe ruleVerdict is whole (confidence 0.6, normal safe headline), not capped as partial.
    const view1 = ruleVerdict(evidence1, { headersAvailable: true });
    expect(view1.verdict).toBe("safe");
    expect(view1.confidence).toBe(0.6);
    expect(view1.headline).not.toBe(PARTIAL_HEADLINE);

    // Whole pictures under no-sam remain cache-eligible: a twin case hits the reading cache with 0 reading calls.
    const twin = await mailCase("org-no-sam-1", "whole-cache-proof");
    const outTwin = await visionStep(
      {
        ...deps(twin, () => puppeteer.launch(env.BROWSER)),
        meta: {
          env: META,
          budget: d1Budget(env.DB, { caller: "vision", caseId: twin }),
          fetch: (async () => {
            throw new Error("reading cache must answer for whole no-sam picture");
          }) as typeof fetch,
        },
        ablateFlag: async () => "no-sam",
      },
      twin,
    );
    expect(outTwin.outcome).toBe("read");
    expect(readingCalls).toBe(1);

    // When a real picture loss occurs alongside no-sam (e.g. an unreadable PDF attachment),
    // vision.coverage retains checked: false, complete: false, losses and ablated: "no-sam",
    // so ruleVerdict marks a safe verdict as partial.
    const damaged = await mailCase("org-no-sam-1", "damaged-loss-proof");
    await putAttachment(store, damaged, "corrupt.pdf", new TextEncoder().encode("not-a-pdf"), "application/pdf");
    const outDamaged = await visionStep(
      {
        ...deps(damaged, () => puppeteer.launch(env.BROWSER)),
        meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId: damaged }), fetch: fetchStub },
        ablateFlag: async () => "no-sam",
      },
      damaged,
    );
    expect(outDamaged.outcome).toBe("read");
    const damagedEv = await readEvidence(env.DB, damaged);
    const damagedCov = damagedEv.find((e) => e.check === "vision.coverage");
    expect(damagedCov?.detail).toMatchObject({
      checked: false,
      complete: false,
      ablated: "no-sam",
      losses: ["a PDF attachment is partly unread"],
    });
    const viewDamaged = ruleVerdict(damagedEv, { headersAvailable: true });
    expect(viewDamaged.verdict).toBe("safe");
    expect(viewDamaged.confidence).toBe(0.5);
    expect(viewDamaged.headline).toBe(PARTIAL_HEADLINE);
  }, 180_000);

  it("replays a previously segmented case under no-sam with zero detector or comparison calls, zero new crop writes, and removes prior vision.logo_match items while keeping reading and brand items", async () => {
    const referenceBytes = new TextEncoder().encode("protea-bank-reference-for-no-sam-replay");
    const digest = await crypto.subtle.digest("SHA-256", referenceBytes.buffer as ArrayBuffer);
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const referenceKey = "ref/logos/20260303T000000Z/protea-bank.png";
    await env.ARTEFACTS.put(referenceKey, referenceBytes);
    await env.ARTEFACTS.put(
      "ref/logos/index.json",
      JSON.stringify({
        version: 1,
        generation: "20260303T000000Z",
        generated_at: "2026-03-03T00:00:00Z",
        logos: [
          {
            slug: "protea-bank",
            brand: "Protea Bank",
            key: referenceKey,
            page_url: "https://proteabank.example/",
            source_url: "https://proteabank.example/logo.png",
            source_kind: "fictional",
            use: "detection-reference",
            fetched_at: "2026-03-03T00:00:00Z",
            media_type: "image/png",
            width: 512,
            height: 512,
            sha256: sha,
            fictional: true,
          },
        ],
        missing: [],
      }),
    );

    const calls: string[] = [];
    const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { model?: string; text?: { format?: { name?: string } } })
          : {};
      if (body.model === "sam-3.1") {
        calls.push("sam-3.1");
        return samBoxed();
      }
      const name = body.text?.format?.name ?? "grounded_brand";
      calls.push(name);
      if (name === "logo_grounding") {
        return reply({ boxes: [{ x_min: 30, y_min: 30, x_max: 190, y_max: 120 }] });
      }
      if (name === "logo_comparison") {
        return reply({ same_brand: true, brand_seen: "Protea Bank", differences: [], confidence: 0.91 });
      }
      if (name === "mail_reading") {
        return reply(claimedReading("Protea Bank"));
      }
      return reply({});
    }) as typeof fetch;

    const caseId = await mailCase("org-no-sam-replay", "replay-segmented");
    // Unflagged first run: segments, stores crops and manifest, and writes vision.logo_match.
    const unflagged = await visionStep(
      {
        ...deps(caseId, () => puppeteer.launch(env.BROWSER)),
        meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId }), fetch: fetchStub },
        ablateFlag: async () => null,
      },
      caseId,
    );
    expect(unflagged.outcome).toBe("read");
    const cropsBefore = await artefactsOf(store, caseId, "crop");
    expect(cropsBefore.length).toBeGreaterThan(0);
    const evBefore = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(evBefore.some((e) => e.check === "vision.logo_match")).toBe(true);
    expect(evBefore.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect(evBefore.some((e) => e.check === "vision.brand_domain_mismatch")).toBe(true);

    // Replay the same case under no-sam: zero SAM, grounding or logo-comparison calls, zero new crop
    // or manifest writes, and prior vision.logo_match items are removed while reading and brand items remain.
    calls.length = 0;
    const replayed = await visionStep(
      {
        ...deps(caseId, () => puppeteer.launch(env.BROWSER)),
        meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId }), fetch: fetchStub },
        ablateFlag: async () => "no-sam",
      },
      caseId,
    );
    expect(replayed.outcome).toBe("read");
    expect(calls).not.toContain("sam-3.1");
    expect(calls).not.toContain("logo_grounding");
    expect(calls).not.toContain("logo_comparison");
    const cropsAfter = await artefactsOf(store, caseId, "crop");
    expect(cropsAfter.map((c) => c.key)).toEqual(cropsBefore.map((c) => c.key));

    const evAfter = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(evAfter.some((e) => e.check === "vision.logo_match")).toBe(false);
    expect(evAfter.some((e) => e.check === "vision.claimed_brand")).toBe(true);
    expect(evAfter.some((e) => e.check === "vision.requested_action")).toBe(true);
    expect(evAfter.some((e) => e.check === "vision.urgency")).toBe(true);
    expect(evAfter.some((e) => e.check === "vision.brand_domain_mismatch")).toBe(true);
    expect(evAfter.find((e) => e.check === "vision.coverage")?.detail).toEqual({
      ablated: "no-sam",
      complete: true,
      losses: [],
    });

    // Other flags and a throwing reader still segment as normal.
    for (const reader of [
      async () => "no-screening" as const,
      async () => {
        throw new Error("kv down");
      },
    ]) {
      calls.length = 0;
      const otherCase = await mailCase("org-no-sam-replay", `other-${Math.random()}`);
      await visionStep(
        {
          ...deps(otherCase, () => puppeteer.launch(env.BROWSER)),
          meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId: otherCase }), fetch: fetchStub },
          ablateFlag: reader,
        },
        otherCase,
      );
      expect(calls).toContain("sam-3.1");
      expect((await artefactsOf(store, otherCase, "crop")).length).toBeGreaterThan(0);
    }
  }, 240_000);

  it("wires ablate:<orgId> through AnalysisWorkflow with org isolation and restores segmentation when cleared", async () => {
    const kv = (env as unknown as Env).CACHE;
    const orgFlagged = "org-workflow-no-sam-a";
    const orgUnflagged = "org-workflow-no-sam-b";
    const realFetch = globalThis.fetch;
    const seenByCase: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("gateway.ai.cloudflare.com")) {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { model?: string; text?: { format?: { name?: string } } })
            : {};
        if (body.model === "sam-3.1") {
          seenByCase.push("sam-3.1");
          return samBoxed();
        }
        const name = body.text?.format?.name ?? "other";
        seenByCase.push(name);
        if (name === "logo_grounding") {
          return reply({ boxes: [{ x_min: 30, y_min: 30, x_max: 190, y_max: 120 }] });
        }
        if (name === "mail_reading") {
          return reply(safeReading());
        }
        return reply({});
      }
      return realFetch(input as never, init as never);
    });

    const runWorkflowVision = async (orgId: string, caseId: string) => {
      expect((await setStatus(env.DB, orgId, caseId, "running")).ok).toBe(true);
      const instance = await introspectWorkflowInstance(env.ANALYSIS, caseId);
      try {
        await instance.modify(async (m) => {
          await m.disableRetryDelays();
          await m.disableSleeps();
          await m.mockStepResult(
            { name: "admit" },
            { admit: true, orgId, channel: "email", sourceKind: "mail", headersAvailable: true },
          );
          await m.mockStepResult({ name: "parse" }, parsedKey(caseId));
          await m.mockStepResult({ name: "checks" }, { evidence: 0 });
        });
        await env.ANALYSIS.create({ id: caseId, params: { caseId } });
        await instance.waitForStatus("complete");
      } finally {
        await instance.dispose();
      }
    };

    await kv.put(ablateKey(orgFlagged), "no-sam");
    try {
      expect(await ablateFlagFor(kv, orgFlagged)).toBe("no-sam");
      expect(await ablateFlagFor(kv, orgUnflagged)).toBeNull();

      // 1. Flagged organisation's Workflow run skips SAM and records ablated: "no-sam".
      seenByCase.length = 0;
      const caseFlagged = await mailCase(orgFlagged, "wf-flagged");
      await runWorkflowVision(orgFlagged, caseFlagged);
      expect(seenByCase).not.toContain("sam-3.1");
      expect(seenByCase).not.toContain("logo_grounding");
      expect(await artefactsOf(store, caseFlagged, "crop")).toHaveLength(0);
      const evFlagged = await readEvidence(env.DB, caseFlagged);
      expect(evFlagged.find((e) => e.check === "vision.coverage")?.detail).toEqual({
        ablated: "no-sam",
        complete: true,
        losses: [],
      });

      // 2. Unflagged second organisation's Workflow run is isolated and segments normally.
      seenByCase.length = 0;
      const caseUnflagged = await mailCase(orgUnflagged, "wf-unflagged");
      await runWorkflowVision(orgUnflagged, caseUnflagged);
      expect(seenByCase).toContain("sam-3.1");
      expect((await artefactsOf(store, caseUnflagged, "crop")).length).toBeGreaterThan(0);
      const evUnflagged = await readEvidence(env.DB, caseUnflagged);
      expect(evUnflagged.find((e) => e.check === "vision.coverage")).toBeUndefined();

      // 3. Clearing ablate:<orgFlagged> restores segmentation on the next Workflow run.
      await kv.delete(ablateKey(orgFlagged));
      seenByCase.length = 0;
      const caseRestored = await mailCase(orgFlagged, "wf-restored");
      await runWorkflowVision(orgFlagged, caseRestored);
      expect(seenByCase).toContain("sam-3.1");
      expect((await artefactsOf(store, caseRestored, "crop")).length).toBeGreaterThan(0);
    } finally {
      await kv.delete(ablateKey(orgFlagged));
      spy.mockRestore();
    }
  }, 240_000);
});
