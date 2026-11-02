// SAM 3.1 segmentation of the pictures a case was read from (D03 T03 §1; design spec 4.4): one concept
// per streamed request, the special-token answer decoded by @meta-sam/parser, and each kept box
// cropped from the source PNG on a Browser Run canvas and stored as a `crop` artefact for §3's
// comparison. A completed stream with no records is an empty result; every other ending (an
// incomplete stream, a refusal, parser error diagnostics, a transport failure) is a typed
// SegmentError, never "no logos found".

import type { Browser } from "@cloudflare/puppeteer";
import { parseImageStream, type ResponsesEvent, recordsOfKind } from "@meta-sam/parser";
import { putArtefact, type Store, type Stored } from "../intake/store";
import { type MetaContext, ModelError, metaResponsesStream } from "../meta/client";

export const SEGMENT_CONCEPTS = ["logo", "stamp", "signature"] as const;
export type SegmentConcept = (typeof SEGMENT_CONCEPTS)[number];

export type SegmentBox = {
  concept: SegmentConcept;
  left: number;
  top: number;
  right: number;
  bottom: number;
  // Absence is not zero (the parser's own rule): a box Meta did not score is kept, sorted last.
  confidence: number | null;
};

export type SegmentErrorKind = "incomplete" | "refused" | "malformed" | "unavailable";
export class SegmentError extends Error {
  override name = "SegmentError";
  readonly kind: SegmentErrorKind;
  constructor(kind: SegmentErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export const MIN_CONFIDENCE = 0.4;
export const MAX_BOXES_PER_IMAGE = 8;
export const CROP_PADDING_PX = 8;
const CROP_TIMEOUT_MS = 30_000;

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// One concept on one image. The transport is the client's streaming call (ledger, retries and
// `store: false` as every Meta call); this module owns what the stream means.
export async function segment(ctx: MetaContext, imageDataUrl: string, concept: SegmentConcept): Promise<SegmentBox[]> {
  let events: { type: string }[];
  try {
    const answer = await metaResponsesStream(
      {
        model: "sam-3.1",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: concept },
              { type: "input_image", image_url: imageDataUrl, detail: "auto" },
            ],
          },
        ],
        metadata: { include_confidence: "true", mask_encoding: "one_bit" },
      } as unknown as Parameters<typeof metaResponsesStream>[0],
      ctx,
    );
    events = answer.data.events;
  } catch (error) {
    if (error instanceof ModelError && error.kind === "timeout")
      throw new SegmentError("incomplete", "the segmentation stream did not finish in time");
    throw new SegmentError("unavailable", "the segmentation request could not be completed");
  }
  if (events.some((e) => e.type === "response.refusal.done"))
    throw new SegmentError("refused", "Meta refused to segment the image");
  if (events.some((e) => e.type === "response.failed"))
    throw new SegmentError("unavailable", "Meta's segmentation failed");

  const parsed = parseImageStream(
    (async function* () {
      for (const event of events) yield event as ResponsesEvent;
    })(),
  );
  let result: Awaited<typeof parsed.finalResult>;
  try {
    for await (const _snapshot of parsed) {
      // Snapshots are not needed; the final result is.
    }
    result = await parsed.finalResult;
  } catch {
    throw new SegmentError("malformed", "the segmentation stream could not be parsed");
  }
  if (result.outcome.status !== "completed")
    throw new SegmentError("incomplete", "the segmentation stream ended before it completed");
  if (result.diagnostics.some((d) => d.severity === "error"))
    throw new SegmentError("malformed", "the segmentation carried malformed records");
  return recordsOfKind(result.records, "box").map((box) => ({
    concept,
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    confidence: box.confidence ?? null,
  }));
}

// The deterministic order of the selection contract: concept order, then confidence descending
// (an unscored box below every scored one), then the order Meta returned them in.
function ranked(boxes: readonly SegmentBox[]): SegmentBox[] {
  return boxes
    .map((box, index) => ({ box, index }))
    .filter(({ box }) => box.confidence === null || box.confidence >= MIN_CONFIDENCE)
    .sort(
      (a, b) =>
        SEGMENT_CONCEPTS.indexOf(a.box.concept) - SEGMENT_CONCEPTS.indexOf(b.box.concept) ||
        (b.box.confidence ?? -1) - (a.box.confidence ?? -1) ||
        a.index - b.index,
    )
    .map(({ box }) => box);
}

export function selectBoxes(boxes: readonly SegmentBox[]): SegmentBox[] {
  return ranked(boxes).slice(0, MAX_BOXES_PER_IMAGE);
}

// Every concept on one image, one request each, selected as one list (at most 8 per image).
export async function segmentImage(ctx: MetaContext, imageDataUrl: string): Promise<SegmentBox[]> {
  const all: SegmentBox[] = [];
  for (const concept of SEGMENT_CONCEPTS) all.push(...(await segment(ctx, imageDataUrl, concept)));
  return selectBoxes(all);
}

export type Crop = { box: SegmentBox; bytes: Uint8Array; width: number; height: number };

// The crop work as it runs in the page: decode once, then each box padded, clipped to the picture,
// drawn and read back as PNG. A box holding no pixel of the picture is named by index, not drawn.
// The page's globals are typed structurally here, as in pdf-pages.ts: this file is compiled for the
// Worker, where they do not exist.
type PageImage = { width: number; height: number; close: () => void };
type PageCanvas = {
  width: number;
  height: number;
  getContext: (kind: string) => { drawImage: (image: PageImage, ...args: number[]) => void } | null;
  toBlob: (done: (blob: Blob | null) => void, type: string) => void;
};
async function cropInPage(b64: string, boxes: readonly SegmentBox[], padding: number) {
  const page = globalThis as unknown as {
    createImageBitmap: (blob: Blob) => Promise<PageImage>;
    document: { createElement: (tag: string) => PageCanvas };
  };
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }));
  try {
    const image = await page.createImageBitmap(await (await fetch(url)).blob());
    try {
      const out: ({ width: number; height: number; b64: string } | null)[] = [];
      for (const box of boxes) {
        const left = Math.max(0, box.left - padding);
        const top = Math.max(0, box.top - padding);
        const right = Math.min(image.width, box.right + padding);
        const bottom = Math.min(image.height, box.bottom + padding);
        if (right <= left || bottom <= top) {
          out.push(null);
          continue;
        }
        const canvas = page.document.createElement("canvas");
        canvas.width = right - left;
        canvas.height = bottom - top;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no-2d-context");
        context.drawImage(image, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("no-blob");
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let text = "";
        for (let i = 0; i < buffer.length; i += 0x8000) text += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
        out.push({ width: canvas.width, height: canvas.height, b64: btoa(text) });
      }
      return out;
    } finally {
      image.close();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Crops every box from the source PNG on a page of the caller's browser (never closed here). The
// whole operation is bounded: a stall loses this image's crops as a typed failure, and the caller
// moves to the next image. Boxes outside the picture are malformed for this image, not drawn.
export async function cropBoxes(
  browser: Browser,
  png: Uint8Array,
  boxes: readonly SegmentBox[],
  timeoutMs: number = CROP_TIMEOUT_MS,
): Promise<{ crops: Crop[]; failures: SegmentError[] }> {
  if (!boxes.length) return { crops: [], failures: [] };
  const page = await browser.newPage();
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SegmentError("unavailable", "the crop timed out")), timeoutMs);
    });
    const drawn = await Promise.race([page.evaluate(cropInPage, toBase64(png), boxes, CROP_PADDING_PX), late]).finally(
      () => clearTimeout(timer),
    );
    const crops: Crop[] = [];
    const failures: SegmentError[] = [];
    drawn.forEach((entry, i) => {
      const box = boxes[i] as SegmentBox;
      if (!entry) failures.push(new SegmentError("malformed", "a box held no pixel of the picture"));
      else crops.push({ box, bytes: fromBase64(entry.b64), width: entry.width, height: entry.height });
    });
    return { crops, failures };
  } catch (error) {
    if (error instanceof SegmentError) throw error;
    throw new SegmentError("unavailable", "the crop could not be made");
  } finally {
    await page.close().catch(() => undefined);
  }
}

// Each crop stored through the case's artefact API, named for its source image and concept. The
// artefact key is content-addressed, so a retry stores the same references and no duplicate rows.
export async function storeCrops(
  store: Store,
  caseId: string,
  sourceName: string,
  crops: readonly Crop[],
): Promise<Stored[]> {
  const stem = sourceName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.(png|jpe?g|webp)$/i, "");
  const stored: Stored[] = [];
  for (const [i, crop] of crops.entries())
    stored.push(
      await putArtefact(store, caseId, "crop", `${stem}-${crop.box.concept}-${i + 1}.png`, crop.bytes, "image/png"),
    );
  return stored;
}
