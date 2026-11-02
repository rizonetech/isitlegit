// The vision step (D03 T02 §3): between walkthrough and verdict, the case's pictures are made and read.
// It renders the email, rasterises each PDF attachment on the shared browser (a failure recorded, its
// siblings kept), reads the desktop render and the pages with Muse Spark, and writes the `vision.`
// evidence. Content and model problems never throw: what could not be read is stated on the case as
// `vision.not_checked` (or `vision.coverage` for a partial picture), so a model outage never fails a
// case and a safe verdict over an unread picture is partial, never a clean bill. A storage failure is
// the opposite: when even the failure statement cannot be written, the step throws, so the case ends
// partial instead of reaching a verdict with its missing coverage concealed.
import type { Browser } from "@cloudflare/puppeteer";
import { addEvidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import { artefactsOf, readArtefact, readVisible, type Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { PDF_DEADLINE_MS, PdfUnreadable, pdfFailureItem, rasterisePdf } from "./pdf-pages";
import { coverageItem, notCheckedItem, type ReadingImage, readingItems, readMail } from "./reading";
import { MAX_READING_IMAGES } from "./reading-schema";
import { type RenderDeps, renderEmail } from "./render";
import { cropBoxes, imageSize, segmentImage, selectBoxes, storeCrops } from "./sam";

export type VisionDeps = {
  db: D1Database;
  store: Store;
  launch: () => Promise<Browser>;
  // The Meta context without its owner: the step owns the call for this case.
  meta: Omit<MetaContext, "owner">;
  kv: KVNamespace;
  waitUntil: (promise: Promise<unknown>) => void;
  policy: RenderDeps["policy"];
  fetch?: typeof fetch;
  // The step's own bound, inside the Workflow step's timeout: a stalled launch or stage states itself
  // not checked instead of hanging until the engine kills the attempt, and expired work spends and
  // writes nothing further.
  deadlineMs?: number;
  // The PDF phase's budget, inside the deadline; a test shrinks it to prove the phase is shared.
  pdfPhaseMs?: number;
  now?: () => number;
};

// Just inside the Workflow step's 300 seconds: the render, the PDF phase and the reading's 60 run one
// after another, so this fires only when a stage stalls past its own bound.
export const VISION_DEADLINE_MS = 270_000;
// The PDF phase's shared budget: three documents near the rasteriser's own 90-second bound must not
// starve the render's reading, so the phase ends here and states what it left undone.
export const PDF_PHASE_MS = 120_000;
// Segmentation never takes the reading's time: it ends this long before the step deadline, whatever
// is left, so a stalled provider still leaves a readable case.
const READING_RESERVE_MS = 60_000;
// How long the timeout's own failure statement may take before the step fails instead.
const STORE_WAIT_MS = 10_000;

export type VisionResult = { outcome: "read"; items: number } | { outcome: "not_checked"; reason: string };

const CLASS = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const reasonOf = (error: unknown) => (error instanceof Error && CLASS.test(error.name) ? error.name : "error");

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

// The items one attempt owns: a replayed step replaces them, never accumulates them, and a statement
// from a failed attempt does not survive a successful one. A PDF failure is the document's own record
// (keyed by attachment in `recordPdfFailure`), so it is kept beside whatever the current attempt writes.
const ATTEMPT_OWNED = new Set([
  "vision.claimed_brand",
  "vision.requested_action",
  "vision.urgency",
  "vision.coverage",
  "vision.not_checked",
]);

// `addEvidence` replaces the producer's items: the write carries the items it does not own (the PDF
// failures, one per attachment) and replaces the ones it does. The expiry gate is re-read after the
// evidence read and again inside the write, immediately before its batch; the caller's own
// statement, written after the attempt has settled, replaces anything a resuming attempt lands.
async function writeVision(
  db: D1Database,
  caseId: string,
  extra: EvidenceDraft[],
  expired?: () => boolean,
  fenceAt?: number,
): Promise<boolean> {
  const existing = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("vision."));
  if (expired?.()) return false;
  const stated = new Set(extra.filter((e) => e.check === "vision.pdf_unreadable").map((e) => e.detail.attachment));
  const kept: EvidenceDraft[] = existing
    .filter((e) => !ATTEMPT_OWNED.has(e.check))
    .filter((e) => !(e.check === "vision.pdf_unreadable" && stated.has(e.detail.attachment)))
    .map(({ check, severity, summary, detail, artefacts }) => ({ check, severity, summary, detail, artefacts }));
  // The fence travels into the write itself, re-read after its sequence read, immediately before
  // its batch: a store delay no longer lets this attempt land over the timeout's statement.
  await addEvidence(db, caseId, "vision", [...kept, ...extra], undefined, expired, fenceAt);
  if (expired?.()) return false;
  return true;
}

// The Workflow's own failure stated after the fact: the step threw past this helper (a storage failure,
// a step timeout), so the case gets the same not-checked statement the helper would have written. Its
// own failure propagates: the caller ends the case partial rather than proceed without the statement.
export async function recordVisionNotRun(db: D1Database, caseId: string, reason: string): Promise<void> {
  await writeVision(db, caseId, [notCheckedItem(reason)]);
}

export async function visionStep(deps: VisionDeps, caseId: string): Promise<VisionResult> {
  const state = { expired: false };
  const deadlineAt = Date.now() + (deps.deadlineMs ?? VISION_DEADLINE_MS);
  const work = runVision(deps, caseId, () => state.expired, deadlineAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<VisionResult>((resolve) => {
    timer = setTimeout(() => {
      state.expired = true;
      resolve({ outcome: "not_checked", reason: "timeout" });
    }, deps.deadlineMs ?? VISION_DEADLINE_MS);
  });
  const result = await Promise.race([work, expired]).finally(() => clearTimeout(timer));
  if (state.expired) {
    // Let the attempt settle first (bounded): its fenced writes no-op from here, and this statement,
    // written after it, replaces anything it still landed, so the timeout's word is the final one.
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, STORE_WAIT_MS)),
    ]);
    // The statement itself is bounded: a store that cannot take it fails the step, so no verdict is
    // reached over a picture nobody stated as unread.
    let bound: ReturnType<typeof setTimeout> | undefined;
    const gave = new Promise<"late">((resolve) => {
      bound = setTimeout(() => resolve("late"), STORE_WAIT_MS);
    });
    const written = await Promise.race([
      writeVision(deps.db, caseId, [notCheckedItem("timeout")]).then(() => "done" as const),
      gave,
    ]).finally(() => clearTimeout(bound));
    if (written !== "done") {
      const error = new Error("the vision failure could not be recorded");
      error.name = "VisionStoreFailed";
      throw error;
    }
  }
  return result;
}

async function runVision(
  deps: VisionDeps,
  caseId: string,
  expired: () => boolean,
  deadlineAt: number,
): Promise<VisionResult> {
  const owner = { kind: "case" as const, caseId, step: "vision" };
  const now = deps.now ?? Date.now;
  // Every write of this attempt passes one fence: once the deadline has fired, nothing is committed,
  // so a stage resuming late can neither spend nor overwrite the timeout's statement.
  const commit = async (items: EvidenceDraft[]): Promise<boolean> => {
    if (expired()) return false;
    return writeVision(deps.db, caseId, items, expired, deadlineAt);
  };
  const pdfItems: EvidenceDraft[] = [];
  const fail = async (item: EvidenceDraft, reason: string): Promise<VisionResult> => {
    await commit([...pdfItems, item]);
    return { outcome: "not_checked", reason };
  };
  let browser: Browser | undefined;
  try {
    browser = await deps.launch();
    if (expired()) return { outcome: "not_checked", reason: "timeout" };
    const losses: string[] = [];

    // The email first, so its reading survives a PDF phase that exhausts its budget.
    const render = await renderEmail(browser, deps.store, caseId, {
      policy: deps.policy,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    if (expired()) return { outcome: "not_checked", reason: "timeout" };

    // The PDF attachments, each rasterised on the shared browser inside the phase's shared budget: a
    // failure (its body unreadable included) is gathered and never stops its siblings; a document the
    // budget leaves over is stated as not rendered. The remaining time is recomputed after every
    // await, so a stalled body read consumes the phase instead of earning a fresh raster allowance.
    const pages: { key: string; sha256: string; name: string; page: number }[] = [];
    let pdfIncomplete = false;
    const phaseEnds = now() + (deps.pdfPhaseMs ?? PDF_PHASE_MS);
    // The phase bounds its own waits, body and metadata reads included: a wait outliving the phase is
    // the phase spent, and no further document is started.
    const inPhase = async <T>(work: Promise<T>): Promise<T> => {
      const left = phaseEnds - now();
      if (left <= 0) throw new PdfUnreadable("operational", "the step's PDF budget was spent");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PdfUnreadable("operational", "the step's PDF budget was spent")), left);
      });
      try {
        return await Promise.race([work, late]);
      } finally {
        clearTimeout(timer);
      }
    };
    let phaseSpent = false;
    // Discovery is a phase wait too: listing the attachments inside the same budget, so a stalled
    // store states the documents unread (the email is still read) instead of holding the step.
    let pdfs: Awaited<ReturnType<typeof artefactsOf>> = [];
    try {
      pdfs = (await inPhase(artefactsOf(deps.store, caseId, "attachment"))).filter(
        (a) => a.mediaType === "application/pdf",
      );
    } catch (error) {
      if (!(error instanceof PdfUnreadable)) throw error;
      pdfIncomplete = true;
      phaseSpent = true;
    }
    for (const pdf of pdfs) {
      if (expired()) return { outcome: "not_checked", reason: "timeout" };
      const name = pdf.key.split(`${pdf.sha256}-`)[1] ?? "attachment.pdf";
      if (phaseSpent) {
        pdfItems.push(
          pdfFailureItem(
            { name, sha: pdf.sha256 },
            new PdfUnreadable("operational", "the step's PDF budget was spent"),
          ),
        );
        pdfIncomplete = true;
        continue;
      }
      try {
        const read = await inPhase(readArtefact(deps.store, caseId, pdf.key));
        if (!read || !("body" in read)) throw new PdfUnreadable("unavailable", "the attachment is missing");
        const left = phaseEnds - now();
        if (left <= 0) throw new PdfUnreadable("operational", "the step's PDF budget was spent");
        const done = await rasterisePdf(
          browser,
          deps.store,
          caseId,
          { name, sha: pdf.sha256, bytes: read.body },
          { deadlineMs: Math.min(left, PDF_DEADLINE_MS) },
        );
        const stored = await inPhase(artefactsOf(deps.store, caseId, "page"));
        const shaOf = new Map(stored.map((s) => [s.key, s.sha256]));
        for (const page of done.pages) {
          const sha256 = shaOf.get(page.key);
          if (sha256) pages.push({ key: page.key, sha256, name, page: page.page });
          else pdfIncomplete = true;
        }
        if (!done.complete) pdfIncomplete = true;
      } catch (error) {
        const failure = error instanceof PdfUnreadable ? error : new PdfUnreadable("operational", "the render failed");
        if (failure.kind === "operational" && phaseEnds - now() <= 0) phaseSpent = true;
        pdfItems.push(pdfFailureItem({ name, sha: pdf.sha256 }, failure));
        pdfIncomplete = true;
      }
    }
    if (expired()) return { outcome: "not_checked", reason: "timeout" };

    if (render.outcome === "failed" && !pages.length)
      return fail(notCheckedItem(`render-${render.reason}`), `render-${render.reason}`);
    if (render.outcome === "failed") losses.push("the email itself could not be rendered");
    else if (!render.complete) losses.push("the rendered email lost content");
    if (pdfIncomplete) losses.push("a PDF attachment is partly unread");

    // The pictures to read, in order (the desktop render, then the pages): selected before any body is
    // buffered, and a selected body that cannot be read back is a stated loss, never a silent omission.
    const shot =
      render.outcome === "rendered"
        ? (render.shots.find((s) => s.name.startsWith("desktop")) ?? render.shots[0])
        : undefined;
    const candidates: { key: string; sha256: string; name: string; promptLabel: string }[] = [];
    if (shot)
      candidates.push({
        key: shot.key,
        sha256: shot.sha256,
        name: shot.name,
        promptLabel: "the rendered email as the recipient saw it",
      });
    for (const page of pages)
      candidates.push({
        key: page.key,
        sha256: page.sha256,
        name: `${page.name} page ${page.page}`,
        promptLabel: `page ${page.page} of a PDF attachment`,
      });
    const selected = candidates.slice(0, MAX_READING_IMAGES);
    if (candidates.length > selected.length)
      losses.push(`${candidates.length - selected.length} further images were not read`);
    const images: ReadingImage[] = [];
    const sources = new Map<string, { name: string; bytes: Uint8Array }>();
    for (const candidate of selected) {
      // A rejected read loses this image, not its siblings.
      const read = await readArtefact(deps.store, caseId, candidate.key).catch(() => null);
      if (!read || !("body" in read)) {
        losses.push(`an image (${candidate.name}) could not be read back`);
        continue;
      }
      const image: ReadingImage = {
        id: `image-${images.length + 1}`,
        promptLabel: candidate.promptLabel,
        key: candidate.key,
        name: candidate.name,
        sha256: candidate.sha256,
        dataUrl: `data:image/png;base64,${toBase64(read.body)}`,
      };
      images.push(image);
      sources.set(image.id, { name: candidate.name, bytes: read.body });
    }
    if (!images.length) return fail(notCheckedItem("no-picture"), "no-picture");

    // SAM segmentation of the same pictures (D03 T03 §1), on this step's browser inside its
    // deadline: each kept box becomes a stored crop naming its source image, for §3's comparison.
    // A segmentation or crop failure is a stated coverage loss, never a case failure, and expired
    // work stores nothing further.
    if (browser) {
      const segmentBy = deadlineAt - READING_RESERVE_MS;
      const segmentExpired = () => expired() || Date.now() > segmentBy;
      if (Date.now() > segmentBy) losses.push("segmentation did not run in the time left");
      for (const image of images) {
        if (expired()) return { outcome: "not_checked", reason: "timeout" };
        if (Date.now() > segmentBy) break;
        const source = sources.get(image.id);
        if (!source) continue;
        try {
          const { boxes, failures } = await segmentImage(
            { ...deps.meta, owner, expired: segmentExpired },
            image.dataUrl,
            segmentBy,
          );
          if (failures.length) losses.push(`segmentation was unavailable for ${source.name}`);
          if (!boxes.length) continue;
          if (expired()) return { outcome: "not_checked", reason: "timeout" };
          const size = await imageSize(browser, source.bytes);
          const selected = selectBoxes(boxes, size);
          if (!selected.length) continue;
          const { crops, failures: cropFailures } = await cropBoxes(browser, source.bytes, selected);
          if (cropFailures.length) losses.push(`a segmentation crop on ${source.name} could not be made`);
          if (!crops.length) continue;
          if (expired()) return { outcome: "not_checked", reason: "timeout" };
          await storeCrops(
            deps.store,
            caseId,
            { name: source.name, key: image.key, sha256: image.sha256 },
            crops,
            expired,
          );
        } catch {
          if (expired()) return { outcome: "not_checked", reason: "timeout" };
          losses.push(`segmentation was unavailable for ${source.name}`);
        }
      }
    }

    const visible = (await readVisible(deps.store, caseId)) ?? "";
    if (expired()) return { outcome: "not_checked", reason: "timeout" };
    const reading = await readMail(
      { meta: { ...deps.meta, owner }, kv: deps.kv, owner, waitUntil: deps.waitUntil },
      images,
      visible,
      losses.length === 0,
      { at: deadlineAt, expired },
    );
    const items = readingItems(reading, images);
    if (losses.length) items.push(coverageItem(losses));
    if (!(await commit([...pdfItems, ...items]))) return { outcome: "not_checked", reason: "timeout" };
    return { outcome: "read", items: items.length };
  } catch (error) {
    // Expired work writes nothing: the timeout's own statement already stands.
    if (expired()) return { outcome: "not_checked", reason: "timeout" };
    const reason = reasonOf(error);
    // A failure of this write is the step's failure, propagated: the case must not proceed unstated.
    await commit([...pdfItems, notCheckedItem(reason)]);
    return { outcome: "not_checked", reason };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
