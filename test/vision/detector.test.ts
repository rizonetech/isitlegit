import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { d1Budget } from "../../src/meta/budget";
import { DETECTOR, groundingBoxes, groundingRequest, groundLogos, iou, recallAt } from "../../src/vision/detector";

// D03 T03 §4: the detector choice and its scoring, with stubbed transports. No Meta credit spent.
const db = (env as unknown as Env).DB;
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const reply = (body: unknown) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

describe("detector scoring", () => {
  it("computes IoU and recall, scoring a failed sample as missed", () => {
    const label = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(iou(label, label)).toBe(1);
    expect(iou(label, { left: 200, top: 0, right: 300, bottom: 100 })).toBe(0);
    // Half overlap in x: intersection 50*100, union 150*100.
    expect(iou(label, { left: 50, top: 0, right: 150, bottom: 100 })).toBeCloseTo(1 / 3);
    const box = { concept: "logo" as const, ...label, confidence: null };
    const recall = recallAt([
      { label, boxes: [box] },
      { label, boxes: [] },
    ]);
    expect(recall).toMatchObject({ found: 1, total: 2 });
    expect(recall.perSample).toEqual([true, false]);
  });

  it("converts normalised boxes on a non-square image and drops malformed geometry", () => {
    const boxes = groundingBoxes(
      {
        boxes: [
          { x_min: 100, y_min: 500, x_max: 300, y_max: 750 },
          { x_min: -20, y_min: 0, x_max: 1001, y_max: 1000 },
        ],
      },
      { width: 1024, height: 768 },
    );
    // The out-of-range box is clamped to the image.
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ left: 102, top: 384, right: 307, bottom: 576, confidence: null });
    expect(boxes[1]).toMatchObject({ left: 0, top: 0, right: 1024, bottom: 768 });
  });
});

describe("detectBoxes selections", () => {
  const samSse = (events: unknown[]) =>
    new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
    });
  const samEmpty = () =>
    samSse([
      { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: "" },
      {
        type: "response.completed",
        response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);
  it("runs SAM for every concept under the sam selection and grounding only for logos under grounding", async () => {
    const { detectBoxes } = await import("../../src/vision/detector");
    const routed = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string; text?: { format?: { name?: string } } };
      if (body.model === "sam-3.1") return samEmpty();
      if (body.text?.format?.name === "logo_grounding")
        return reply({ boxes: [{ x_min: 0, y_min: 0, x_max: 500, y_max: 500 }] });
      return reply({ boxes: [] });
    }) as typeof fetch;
    const context = {
      env: META,
      budget: d1Budget(db, { caller: "vision", caseId: "detector-select" }),
      owner: { kind: "case" as const, caseId: "detector-select", step: "vision" },
      fetch: routed,
      waitUntil: () => {},
    };
    const samResult = await detectBoxes(
      context,
      "data:image/png;base64,EEE",
      { width: 100, height: 100 },
      undefined,
      "sam",
    );
    expect(samResult.failures).toEqual([]);
    expect(samResult.boxes).toEqual([]);
    const groundingResult = await detectBoxes(
      context,
      "data:image/png;base64,EEE",
      { width: 100, height: 100 },
      undefined,
      "grounding",
    );
    expect(groundingResult.boxes).toEqual([
      { concept: "logo", left: 0, top: 0, right: 50, bottom: 50, confidence: null },
    ]);
  });

  it("states malformed grounding geometry and a refused budget as typed failures", async () => {
    const malformed = (async () =>
      reply({ boxes: [{ x_min: 900, y_min: 900, x_max: 100, y_max: 100 }] })) as typeof fetch;
    await expect(
      groundLogos(
        {
          env: META,
          budget: d1Budget(db, { caller: "vision", caseId: "detector-malformed" }),
          owner: { kind: "case", caseId: "detector-malformed", step: "vision" },
          fetch: malformed,
          waitUntil: () => {},
        },
        "data:image/png;base64,FFF",
        { width: 100, height: 100 },
      ),
    ).rejects.toMatchObject({ name: "SegmentError", kind: "malformed" });
    const refusingBudget = {
      reserve: async () => {
        throw new Error("budget refused");
      },
    };
    await expect(
      groundLogos(
        {
          env: META,
          budget: refusingBudget as never,
          owner: { kind: "case", caseId: "detector-budget", step: "vision" },
          fetch: (async () => reply({ boxes: [] })) as typeof fetch,
          waitUntil: () => {},
        },
        "data:image/png;base64,GGG",
        { width: 100, height: 100 },
      ),
    ).rejects.toMatchObject({ name: "SegmentError" });
  });
});

describe("groundLogos", () => {
  it("sends one image with a fixed grounding prompt and returns pixel boxes", async () => {
    let seen: { model?: string } = {};
    const fetchStub = (async (_input: unknown, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body)) as { model?: string };
      return reply({ boxes: [{ x_min: 0, y_min: 0, x_max: 500, y_max: 500 }] });
    }) as typeof fetch;
    expect(groundingRequest("data:image/png;base64,AAA").model).toBe("muse-spark-1.3");
    const boxes = await groundLogos(
      {
        env: META,
        budget: d1Budget(db, { caller: "vision", caseId: "detector-ground" }),
        owner: { kind: "case", caseId: "detector-ground", step: "vision" },
        fetch: fetchStub,
        waitUntil: () => {},
      },
      "data:image/png;base64,AAA",
      { width: 200, height: 100 },
    );
    expect(seen.model).toBe("muse-spark-1.3");
    expect(boxes).toEqual([{ concept: "logo", left: 0, top: 0, right: 100, bottom: 50, confidence: null }]);
  });

  it("scores a box at exactly IoU 0.5 as found, and one just under as missed", () => {
    const label = { left: 0, top: 0, right: 100, bottom: 100 };
    // Intersection 100*100 over union 200*100 is exactly 0.5.
    const half = { concept: "logo" as const, left: 0, top: 0, right: 200, bottom: 100, confidence: null };
    expect(recallAt([{ label, boxes: [half] }]).perSample).toEqual([true]);
    const under = { ...half, right: 201 };
    expect(recallAt([{ label, boxes: [under] }]).perSample).toEqual([false]);
  });

  it("turns a transport timeout and a refused answer into typed SegmentErrors", async () => {
    const context = (fetchImpl: typeof fetch, caseId: string) => ({
      env: META,
      budget: d1Budget(db, { caller: "vision", caseId }),
      owner: { kind: "case" as const, caseId, step: "vision" },
      fetch: fetchImpl,
      waitUntil: () => {},
    });
    const timingOut = (async () => {
      throw new Error("the request timed out");
    }) as typeof fetch;
    await expect(
      groundLogos(context(timingOut, "detector-timeout"), "data:image/png;base64,CCC", { width: 100, height: 100 }),
    ).rejects.toMatchObject({ name: "SegmentError" });
    const refusing = (async () =>
      new Response(
        JSON.stringify({
          id: "r",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
      )) as typeof fetch;
    await expect(
      groundLogos(context(refusing, "detector-refusal"), "data:image/png;base64,DDD", { width: 100, height: 100 }),
    ).rejects.toMatchObject({ name: "SegmentError" });
  });

  it("turns a refusal into a typed SegmentError, never boxes", async () => {
    const fetchStub = (async () => reply({ boxes: [] })) as typeof fetch;
    const boxes = await groundLogos(
      {
        env: META,
        budget: d1Budget(db, { caller: "vision", caseId: "detector-empty" }),
        owner: { kind: "case", caseId: "detector-empty", step: "vision" },
        fetch: fetchStub,
        waitUntil: () => {},
      },
      "data:image/png;base64,BBB",
      { width: 200, height: 100 },
    );
    expect(boxes).toEqual([]);
    expect(DETECTOR).toBe("grounding");
  });
});

import labelsJson from "./fixtures/logo-recall/labels.json";
import resultsJson from "./fixtures/logo-recall/results.json";
import { selectBoxes } from "../../src/vision/sam";

describe("the recorded recall measurement", () => {
  it("recomputes the published totals from the saved per-sample results", () => {
    const labels = labelsJson.samples;
    const results = resultsJson.results as {
      file: string;
      detector: string;
      boxes: { left: number; top: number; right: number; bottom: number; confidence: number | null }[];
    }[];
    for (const detector of ["sam", "grounding"] as const) {
      const samples = labels.map((label) => ({
        label: label.logo,
        boxes: selectBoxes(
          (results.find((r) => r.file === label.file && r.detector === detector)?.boxes ?? []).map((box) => ({
            concept: "logo" as const,
            ...box,
          })),
          { width: label.width, height: label.height },
        ),
      }));
      const recall = recallAt(samples);
      const recorded = detector === "sam" ? resultsJson.sam : resultsJson.grounding;
      expect(recall.found).toBe(recorded.found);
      expect(recall.total).toBe(20);
    }
    expect(resultsJson.sam.found).toBe(0);
    expect(resultsJson.grounding.found).toBe(20);
  });
});
