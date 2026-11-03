// The logo recall measurement (D03 T03 §4): SAM 3.1 and Muse Spark perception grounding over
// the 20 labelled synthetic samples in eval/sets/logo-recall, scored by the production scoring
// in src/vision/detector.ts. Per-sample predictions, failures, costs and timings are saved to
// results.json beside the labels, and the totals the frontier log records are recomputed from
// that file by the section's test.
//
//   node scripts/measure-logo-recall.ts --confirm-credit
//
// Spend: the cap is US$1.00 for the whole run (stated in the lane outbox before the first run),
// reserved per call in the shared Meta ledger before it is sent and never raised. A sample whose
// call fails or is refused is scored missed, never removed from the denominator.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { groundingRequest, groundingSchema } from "../src/vision/grounding-schema.ts";

// Scoring mirrors src/vision/detector.ts (the Worker's extensionless modules do not load in
// Node); the section's test recomputes the published totals from results.json with the
// production scoring, so a drift here fails there.
type SegmentBox = {
  concept: "logo";
  left: number;
  top: number;
  right: number;
  bottom: number;
  confidence: number | null;
};
const iou = (
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  return areaA <= 0 || areaB <= 0 ? 0 : intersection / (areaA + areaB - intersection);
};
const retained = (boxes: SegmentBox[]) =>
  boxes
    .filter((box) => box.confidence === null || box.confidence >= 0.4)
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))
    .slice(0, 8);
const recallAt = (samples: readonly { label: Label["logo"]; boxes: readonly SegmentBox[] }[]) => {
  const perSample = samples.map((sample) => retained([...sample.boxes]).some((box) => iou(box, sample.label) >= 0.5));
  return { found: perSample.filter(Boolean).length, total: samples.length, perSample };
};
const groundingBoxes = (
  answer: { boxes: { x_min: number; y_min: number; x_max: number; y_max: number }[] },
  size: { width: number; height: number },
): SegmentBox[] => {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const boxes: SegmentBox[] = [];
  for (const box of answer.boxes) {
    const left = clamp(Math.round((box.x_min * size.width) / 1000), size.width);
    const top = clamp(Math.round((box.y_min * size.height) / 1000), size.height);
    const right = clamp(Math.round((box.x_max * size.width) / 1000), size.width);
    const bottom = clamp(Math.round((box.y_max * size.height) / 1000), size.height);
    // Identical conversion semantics to production (src/vision/detector.ts): malformed
    // geometry fails the whole answer, never silently drops.
    if (right <= left || bottom <= top) throw new Error("a grounding box held no pixel after conversion");
    boxes.push({ concept: "logo", left, top, right, bottom, confidence: null });
  }
  return boxes;
};

import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  SAM_PER_IMAGE,
  settleSpend,
  takeLock,
  tokenCost,
} from "./meta-smoke.ts";

const CAP_USD = 1.0;
const SET = join(import.meta.dirname, "../eval/sets/logo-recall");
const today = new Date().toISOString().slice(0, 10);
const run = `logo-recall-${Date.now()}`;

type Label = {
  file: string;
  brand: string;
  width: number;
  height: number;
  logo: { left: number; top: number; right: number; bottom: number };
};
type Result = {
  file: string;
  detector: "sam" | "grounding";
  boxes: SegmentBox[];
  failed: string | null;
  ms: number;
  costUsd: number | null;
};

if (!process.argv.includes("--confirm-credit")) {
  console.error("measure-logo-recall: a live run spends Meta credit; pass --confirm-credit");
  process.exit(2);
}
const manual = readFileSync(join(import.meta.dirname, "../todo/99-manual/TODO-01-day0-accounts.md"), "utf-8");
if (!/^Meta credit visible: 2026-/m.test(manual)) {
  console.error("measure-logo-recall: no Meta credit visible line recorded (D99 T01 §1); refusing to spend");
  process.exit(2);
}

const labels = (JSON.parse(readFileSync(join(SET, "labels.json"), "utf-8")) as { samples: Label[] }).samples;
const ledgerFile = metaLedger();
const unlock = takeLock(`${ledgerFile}.lock`);
if (typeof unlock === "string") {
  console.error(`measure-logo-recall: ${unlock}`);
  process.exit(2);
}

try {
  const ledger = readLedger(ledgerFile);
  const secrets = await readSecretsFromVault();
  const headers = {
    authorization: `Bearer ${secrets.meta}`,
    "cf-aig-authorization": `Bearer ${secrets.run}`,
    "cf-aig-collect-log": "true",
    "cf-aig-collect-log-payload": "false",
    "content-type": "application/json",
  };
  let spent = 0;
  const reserve = (detector: string, file: string, estimate: number) => {
    if (spent + estimate > CAP_USD) throw new Error(`the US$${CAP_USD} cap would be passed; stopping`);
    const reserved = reserveSpend(ledgerFile, ledger, {
      date: today,
      run,
      call: `${detector} logo-recall ${file}`,
      estimate,
    });
    if ("refused" in reserved) throw new Error(reserved.refused);
    spent += estimate;
    return reserved.entry;
  };

  const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(join(SET, file)).toString("base64")}`;

  const samBoxes = async (label: Label): Promise<SegmentBox[]> => {
    const started = Date.now();
    void started;
    const response = await fetch(`${GATEWAY_URL}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "sam-3.1",
        store: false,
        stream: true,
        metadata: { include_confidence: "true", mask_encoding: "one_bit" },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "logo" },
              { type: "input_image", image_url: dataUrl(label.file), detail: "auto" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`SAM answered HTTP ${response.status}`);
    const events: unknown[] = [];
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      events.push(JSON.parse(data));
    }
    // The parser's own shape, as src/vision/sam.ts consumes it: iterate the stream, then read
    // the final result's records; a box record already carries pixel coordinates.
    const parsed = parseImageStream(
      (async function* () {
        for (const event of events) yield event as never;
      })(),
    );
    for await (const _snapshot of parsed) {
      // Snapshots are not needed; the final result is.
    }
    const result = await parsed.finalResult;
    if (result.outcome.status !== "completed") throw new Error("the segmentation stream did not complete");
    const records = recordsOfKind(result.records, "box") as readonly {
      left: number;
      top: number;
      right: number;
      bottom: number;
      confidence?: number;
    }[];
    return records.map((record) => ({
      concept: "logo" as const,
      left: record.left,
      top: record.top,
      right: record.right,
      bottom: record.bottom,
      confidence: record.confidence ?? null,
    }));
  };

  const grounding = async (label: Label): Promise<{ boxes: SegmentBox[]; costUsd: number }> => {
    // The shipped request and schema (src/vision/grounding-schema.ts), so the measured call is
    // the production call; the answer is validated before anything is scored.
    const request = groundingRequest(dataUrl(label.file));
    const { name: _name, ...params } = request;
    const response = await fetch(`${GATEWAY_URL}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...params,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "logo_grounding",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["boxes"],
              properties: {
                boxes: {
                  type: "array",
                  maxItems: 8,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["x_min", "y_min", "x_max", "y_max"],
                    properties: {
                      x_min: { type: "integer", minimum: -50, maximum: 1050 },
                      y_min: { type: "integer", minimum: -50, maximum: 1050 },
                      x_max: { type: "integer", minimum: -50, maximum: 1050 },
                      y_max: { type: "integer", minimum: -50, maximum: 1050 },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`grounding answered HTTP ${response.status}`);
    const data = (await response.json()) as {
      status?: string;
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
      usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
    };
    if (data.status !== "completed") throw new Error("grounding did not complete");
    const textPart = (data.output ?? [])
      .flatMap((item) => (item.type === "message" ? (item.content ?? []) : []))
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("");
    const answer = groundingSchema.parse(JSON.parse(textPart));
    const usage = data.usage;
    const costUsd = usage
      ? tokenCost(
          "muse-spark-1.3",
          usage.input_tokens,
          usage.output_tokens,
          usage.input_tokens_details?.cached_tokens ?? 0,
        )
      : tokenCost("muse-spark-1.3", 1200, 800);
    return { boxes: groundingBoxes(answer, { width: label.width, height: label.height }), costUsd };
  };

  const results: Result[] = [];
  const checkpoint = () => {
    const partial = {
      run,
      capUsd: CAP_USD,
      complete: results.length === labels.length * 2,
      sam: byDetectorEarly("sam"),
      grounding: byDetectorEarly("grounding"),
      results,
    };
    writeFileSync(join(SET, "results.json.tmp"), `${JSON.stringify(partial, null, 1)}\n`);
    renameSync(join(SET, "results.json.tmp"), join(SET, "results.json"));
  };
  const byDetectorEarly = (detector: "sam" | "grounding") =>
    recallAt(
      labels.map((label) => ({
        label: label.logo,
        boxes: results.find((r) => r.file === label.file && r.detector === detector)?.boxes ?? [],
      })),
    );
  for (const label of labels) {
    for (const detector of ["sam", "grounding"] as const) {
      const estimate = detector === "sam" ? SAM_PER_IMAGE : tokenCost("muse-spark-1.3", 1200, 800);
      const entry = reserve(detector, label.file, estimate);
      const started = Date.now();
      try {
        const grounded = detector === "grounding" ? await grounding(label) : null;
        const boxes = detector === "sam" ? await samBoxes(label) : (grounded?.boxes ?? []);
        const cost = detector === "sam" ? SAM_PER_IMAGE : (grounded?.costUsd ?? estimate);
        settleSpend(ledgerFile, ledger, entry, cost);
        results.push({ file: label.file, detector, boxes, failed: null, ms: Date.now() - started, costUsd: cost });
        checkpoint();
        console.log(
          `${detector} ${label.file}: ${boxes.length} box(es), best IoU ${Math.max(0, ...boxes.map((b) => iou(b, label.logo))).toFixed(2)}`,
        );
      } catch (error) {
        settleSpend(ledgerFile, ledger, entry, null);
        results.push({
          file: label.file,
          detector,
          boxes: [],
          failed: error instanceof Error ? error.name : "failed",
          ms: Date.now() - started,
          costUsd: null,
        });
        checkpoint();
        console.log(
          `${detector} ${label.file}: failed (${error instanceof Error ? error.message : "failed"}), scored missed`,
        );
      }
    }
  }
  const byDetector = (detector: "sam" | "grounding") =>
    recallAt(
      labels.map((label) => ({
        label: label.logo,
        boxes: results.find((r) => r.file === label.file && r.detector === detector)?.boxes ?? [],
      })),
    );
  const sam = byDetector("sam");
  const grounded = byDetector("grounding");
  const out = { run, capUsd: CAP_USD, sam, grounding: grounded, results };
  writeFileSync(join(SET, "results.json.tmp"), `${JSON.stringify(out, null, 1)}\n`);
  renameSync(join(SET, "results.json.tmp"), join(SET, "results.json"));
  console.log(
    `SAM recall ${sam.found}/${sam.total}; grounding recall ${grounded.found}/${grounded.total}; ledger run ${run}`,
  );
} finally {
  unlock();
}
