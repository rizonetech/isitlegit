// The logo detector choice (D03 T03 §4): SAM 3.1 segmentation, or Muse Spark perception
// grounding for the logo concept alone when the measured recall says so. The decision rule is
// deterministic and recorded in docs/frontier-log.md: DETECTOR stays "sam" unless SAM's measured
// logo recall is under 16 of 20 and grounding's is higher; a tie, or both under 16, keeps SAM.
// Stamp and signature always segment with SAM, whichever detector finds logos.
import type { MetaContext } from "../meta/client";
import { ModelError } from "../meta/client";
import { structured } from "../meta/structured";
import { type GroundingAnswer, groundingRequest, groundingSchema } from "./grounding-schema";
import { type SegmentBox, SegmentError, type SegmentImageResult, segment, segmentImage } from "./sam";

export { type GroundingAnswer, groundingRequest } from "./grounding-schema";

export type Detector = "sam" | "grounding";
// Measured 2026-11-02 on test/vision/fixtures/logo-recall (docs/frontier-log.md): SAM found 0 of 20
// logos and grounding found 20 of 20, so grounding holds the logo concept; changed only with a
// new measurement recorded there.
export const DETECTOR: Detector = "grounding";

export const GROUNDING_MODEL = "muse-spark-1.3"; // the shared request names the same model
const GROUNDING_CALL_MS = 60_000;

// Normalised grounding boxes to source pixels (Meta docs, image-understanding: the 0-1000 grid
// converts with the exact image sent, and a value slightly outside is clamped). A box that is
// empty after clamping, or inverted, is malformed and dropped, never cropped.
export function groundingBoxes(answer: GroundingAnswer, size: { width: number; height: number }): SegmentBox[] {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const boxes: SegmentBox[] = [];
  for (const box of answer.boxes) {
    const left = clamp(Math.round((box.x_min * size.width) / 1000), size.width);
    const top = clamp(Math.round((box.y_min * size.height) / 1000), size.height);
    const right = clamp(Math.round((box.x_max * size.width) / 1000), size.width);
    const bottom = clamp(Math.round((box.y_max * size.height) / 1000), size.height);
    // A box that is empty or inverted after clamping is malformed model output, not an empty
    // answer: it fails typed, so the caller states a coverage loss instead of clearing crops.
    if (right <= left || bottom <= top)
      throw new SegmentError("malformed", "a grounding box held no pixel after conversion");
    boxes.push({ concept: "logo", left, top, right, bottom, confidence: null });
  }
  return boxes;
}

// Muse Spark grounding for the logo concept alone. Every failure is a typed SegmentError, so
// the caller states it as a coverage loss and publishes no late crop from it.
export async function groundLogos(
  ctx: MetaContext & { waitUntil: (promise: Promise<unknown>) => void },
  imageDataUrl: string,
  size: { width: number; height: number },
  deadlineAt?: number,
): Promise<SegmentBox[]> {
  try {
    const answer = await structured(groundingSchema, groundingRequest(imageDataUrl), {
      ...ctx,
      deadlineMs: Math.max(1, Math.min(GROUNDING_CALL_MS, deadlineAt ? deadlineAt - Date.now() : GROUNDING_CALL_MS)),
      ...(deadlineAt ? { expired: () => Date.now() > deadlineAt } : {}),
    });
    return groundingBoxes(answer.value, size);
  } catch (error) {
    if (error instanceof SegmentError) throw error;
    throw new SegmentError("unavailable", error instanceof ModelError ? error.message : "logo grounding failed");
  }
}

// The step's segmentation: the chosen detector for logos, SAM for stamp and signature either
// way. A detector that fails loses only its own concept, exactly as a SAM concept failure does.
export async function detectBoxes(
  ctx: MetaContext & { waitUntil: (promise: Promise<unknown>) => void },
  imageDataUrl: string,
  size: { width: number; height: number },
  deadlineAt?: number,
  detector: Detector = DETECTOR,
): Promise<SegmentImageResult> {
  if (detector === "sam") return segmentImage(ctx, imageDataUrl, deadlineAt);
  const boxes: SegmentBox[] = [];
  const failures: SegmentError[] = [];
  for (const concept of ["stamp", "signature"] as const) {
    const left = deadlineAt === undefined ? ctx.deadlineMs : Math.max(1, deadlineAt - Date.now());
    try {
      boxes.push(...(await segment(left === undefined ? ctx : { ...ctx, deadlineMs: left }, imageDataUrl, concept)));
    } catch (error) {
      failures.push(error instanceof SegmentError ? error : new SegmentError("unavailable", "segmentation failed"));
    }
  }
  try {
    boxes.push(...(await groundLogos(ctx, imageDataUrl, size, deadlineAt)));
  } catch (error) {
    failures.push(error instanceof SegmentError ? error : new SegmentError("unavailable", "logo grounding failed"));
  }
  return { boxes, failures };
}

// Box overlap for the recall measurement: intersection over union, 0 when either box is empty.
export function iou(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  if (areaA <= 0 || areaB <= 0) return 0;
  return intersection / (areaA + areaB - intersection);
}

// Recall over labelled samples: a sample is found when any retained box overlaps its label at
// the threshold. A sample with no prediction (a failed or refused call) is missed, never
// removed from the denominator.
export function recallAt(
  samples: readonly {
    label: { left: number; top: number; right: number; bottom: number };
    boxes: readonly SegmentBox[];
  }[],
  threshold = 0.5,
): { found: number; total: number; perSample: boolean[] } {
  const perSample = samples.map((sample) => sample.boxes.some((box) => iou(box, sample.label) >= threshold));
  return { found: perSample.filter(Boolean).length, total: samples.length, perSample };
}
