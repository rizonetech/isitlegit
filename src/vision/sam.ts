// SAM 3.1 segmentation of the pictures a case was read from (D03 T03 §1; design spec 4.4): one concept
// per streamed request, the special-token answer decoded by @meta-sam/parser, and each kept box
// cropped from the source PNG on a Browser Run canvas and stored as a `crop` artefact for §3's
// comparison. A completed stream with no records is an empty result; every other ending (an
// incomplete stream, a refusal, parser error diagnostics, a transport failure) is a typed
// SegmentError, never "no logos found".

import type { Browser } from "@cloudflare/puppeteer";
import { parseImageStream, type ResponsesEvent, recordsOfKind } from "@meta-sam/parser";
import { z } from "zod";
import { artefactsOf, putArtefact, type Store, type Stored } from "../intake/store";
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
export const CROP_TIMEOUT_MS = 30_000;

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
  // The model's boxes cross the zod boundary like every model output before anything uses them.
  return recordsOfKind(result.records, "box").map((box) => {
    const parsedBox = segmentBoxSchema.safeParse({
      concept,
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      confidence: box.confidence ?? null,
    });
    if (!parsedBox.success) throw new SegmentError("malformed", "a segmentation box failed validation");
    return parsedBox.data;
  });
}

// Strict geometry at the model boundary: finite integer pixels, a non-empty half-open rectangle,
// and a confidence that is either absent or a proportion.
const segmentBoxSchema = z
  .strictObject({
    concept: z.enum(SEGMENT_CONCEPTS),
    left: z.int().nonnegative(),
    top: z.int().nonnegative(),
    right: z.int().positive(),
    bottom: z.int().positive(),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .refine((box) => box.right > box.left && box.bottom > box.top, "a box must hold a pixel");

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

export function selectBoxes(boxes: readonly SegmentBox[], source?: { width: number; height: number }): SegmentBox[] {
  // Against the decoded picture, a box holding no pixel of it is not a candidate at all: it is
  // dropped before ranking, so it cannot spend the per-image allowance on a crop of padding.
  const inside = source
    ? boxes.filter((box) => box.left < source.width && box.top < source.height && box.right > 0 && box.bottom > 0)
    : boxes;
  return ranked(inside).slice(0, MAX_BOXES_PER_IMAGE);
}

export type SegmentImageResult = { boxes: SegmentBox[]; failures: SegmentError[] };

// Every concept on one image, one request each. A concept that fails loses only itself: the
// successful concepts' boxes are returned beside the typed failures, never thrown away with them.
// With an absolute deadline, each concept's call is given what is left of it, so an active stream
// is aborted at the deadline instead of starting a fresh full-length timer per concept.
export async function segmentImage(
  ctx: MetaContext,
  imageDataUrl: string,
  deadlineAt?: number,
): Promise<SegmentImageResult> {
  const boxes: SegmentBox[] = [];
  const failures: SegmentError[] = [];
  for (const concept of SEGMENT_CONCEPTS) {
    const left = deadlineAt === undefined ? ctx.deadlineMs : Math.max(1, deadlineAt - Date.now());
    try {
      boxes.push(...(await segment(left === undefined ? ctx : { ...ctx, deadlineMs: left }, imageDataUrl, concept)));
    } catch (error) {
      failures.push(error instanceof SegmentError ? error : new SegmentError("unavailable", "segmentation failed"));
    }
  }
  return { boxes, failures };
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

// One page of the caller's browser (never closed here), bounded at every stage: page creation,
// the work, and the close. A stall anywhere is a typed loss for this image only; a page that
// arrives after its bound is closed whenever it lands.
async function withPage<T>(
  browser: Browser,
  timeoutMs: number,
  work: (page: Awaited<ReturnType<Browser["newPage"]>>) => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SegmentError("unavailable", "the crop timed out")), timeoutMs);
  });
  let landed: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  let settled = false;
  const startedAt = Date.now();
  try {
    const page = await Promise.race([
      browser.newPage().then((p) => {
        landed = p;
        if (settled) void p.close().catch(() => undefined);
        return p;
      }),
      late,
    ]);
    return await Promise.race([work(page), late]);
  } catch (error) {
    if (error instanceof SegmentError) throw error;
    throw new SegmentError("unavailable", "the crop could not be made");
  } finally {
    settled = true;
    clearTimeout(timer);
    // Cleanup shares the same absolute bound: it gets what is left of the operation's time, never
    // a fresh duration of its own.
    if (landed)
      await Promise.race([
        landed.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, startedAt + timeoutMs - Date.now()))),
      ]);
  }
}

// The decoded size of a PNG, for validating boxes against the picture they were found in.
export async function imageSize(
  browser: Browser,
  png: Uint8Array,
  timeoutMs: number = CROP_TIMEOUT_MS,
): Promise<{ width: number; height: number }> {
  return withPage(browser, timeoutMs, async (page) => {
    const size = await page.evaluate(async (b64: string) => {
      const g = globalThis as unknown as {
        createImageBitmap: (blob: Blob) => Promise<{ width: number; height: number; close: () => void }>;
      };
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const image = await g.createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }));
      try {
        return { width: image.width, height: image.height };
      } finally {
        image.close();
      }
    }, toBase64(png));
    return size;
  });
}

// Crops every box from the source PNG. Boxes outside the picture are malformed for this image,
// not drawn; a decode or canvas failure loses this image's crops as one typed failure.
export async function cropBoxes(
  browser: Browser,
  png: Uint8Array,
  boxes: readonly SegmentBox[],
  timeoutMs: number = CROP_TIMEOUT_MS,
): Promise<{ crops: Crop[]; failures: SegmentError[] }> {
  if (!boxes.length) return { crops: [], failures: [] };
  const drawn = await withPage(browser, timeoutMs, (page) =>
    page.evaluate(cropInPage, toBase64(png), boxes, CROP_PADDING_PX),
  );
  const crops: Crop[] = [];
  const failures: SegmentError[] = [];
  drawn.forEach((entry, i) => {
    const box = boxes[i] as SegmentBox;
    if (!entry) failures.push(new SegmentError("malformed", "a box held no pixel of the picture"));
    else crops.push({ box, bytes: fromBase64(entry.b64), width: entry.width, height: entry.height });
  });
  return { crops, failures };
}

// Each crop stored through the case's artefact API, named for its source image and concept, then a
// manifest naming the exact current set: the manifest is written last, carries the next generation
// for its source, and lists the crops with their source artefact's key and hash. A retry with
// changed boxes writes a new generation; a partial retry writes none, so the last complete
// generation stays the consumer's current set. Stale crops remain listed but unreferenced. Writes
// stop at the caller's fence and each is bounded.
const STORE_TIMEOUT_MS = 30_000;
export async function storeCrops(
  store: Store,
  caseId: string,
  source: { name: string; key: string; sha256: string },
  crops: readonly Crop[],
  fence?: () => boolean,
  fenceAt?: number,
  timeoutMs: number = STORE_TIMEOUT_MS,
): Promise<Stored[]> {
  // The stem is capped so the longest name built from it (a manifest's `-manifest-<generation>.json`)
  // stays inside the store's 120-character name limit: an attacker-named attachment must not have
  // its manifest suffix truncated away, which would hide the crop set from its readers.
  const stem = Array.from(source.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.(png|jpe?g|webp)$/i, ""))
    .slice(0, 100)
    .join("");
  // Every wait and every write is fenced at the earlier of this operation's own timeout and the
  // caller's deadline: a wait that times out locally leaves nothing able to publish afterwards,
  // because the store's own fence is that same earlier instant.
  const startedAt = Date.now();
  const effectiveFenceAt = fenceAt === undefined ? startedAt + timeoutMs : Math.min(fenceAt, startedAt + timeoutMs);
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SegmentError("unavailable", "storing a crop timed out")),
        Math.max(1, Math.min(timeoutMs, effectiveFenceAt - Date.now())),
      );
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stored: Stored[] = [];
  for (const [i, crop] of crops.entries()) {
    if (fence?.()) return stored;
    stored.push(
      await bounded(
        putArtefact(
          store,
          caseId,
          "crop",
          `${stem}-${crop.box.concept}-${i + 1}.png`,
          crop.bytes,
          "image/png",
          effectiveFenceAt,
        ),
      ),
    );
  }
  // The fence is re-read after the awaited listing, immediately before the manifest write: an
  // attempt that expired while the store was answering publishes no new current set. An empty
  // completed set still publishes its manifest, so a zero-match retry clears the previous one.
  // The listing shares the same bound, and the manifest write carries the caller's deadline into
  // the store itself, where it is enforced in the row's own SQL.
  if (fence?.()) return stored;
  const existing = await bounded(artefactsOf(store, caseId, "crop"));
  if (fence?.()) return stored;
  const generations = existing
    .map((a) => new RegExp(`^art/${caseId}/crop/[0-9a-f]+-${stem}-manifest-(\\d+)\\.json$`).exec(a.key)?.[1])
    .filter((g): g is string => g !== undefined)
    .map(Number);
  const manifest = {
    source: { name: source.name, key: source.key, sha256: source.sha256 },
    crops: stored.map((s) => s.key),
  };
  stored.push(
    await bounded(
      putArtefact(
        store,
        caseId,
        "crop",
        `${stem}-manifest-${(generations.length ? Math.max(...generations) : 0) + 1}.json`,
        new TextEncoder().encode(JSON.stringify(manifest)),
        "application/json",
        effectiveFenceAt,
      ),
    ),
  );
  return stored;
}
