// The vision step (D03 T02 §3): between walkthrough and verdict, the case's pictures are made and read.
// It discovers the PDF attachments and rasterises each on the shared browser (a failure recorded, its
// siblings kept), renders the email, reads the desktop render and the pages with Muse Spark, and writes
// the `vision.` evidence. It never throws for a content or model problem: what could not be read is
// stated on the case as `vision.not_checked` (or `vision.coverage` for a partial picture), so a model
// outage never fails a case and a safe verdict over an unread picture is partial, never a clean bill.
import type { Browser } from "@cloudflare/puppeteer";
import { addEvidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import { artefactsOf, readArtefact, readVisible, type Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { PdfUnreadable, rasterisePdf, recordPdfFailure } from "./pdf-pages";
import { coverageItem, notCheckedItem, type ReadingImage, readingItems, readMail } from "./reading";
import { MAX_READING_IMAGES } from "./reading-schema";
import { type RenderDeps, renderEmail } from "./render";

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
  // not checked instead of hanging until the engine kills the attempt.
  deadlineMs?: number;
};

// Just inside the Workflow step's 300 seconds: the render, the rasteriser's 90 and the reading's 60
// run one after another, so this fires only when a stage stalls past its own bound.
export const VISION_DEADLINE_MS = 270_000;

export type VisionResult = { outcome: "read"; items: number } | { outcome: "not_checked"; reason: string };

const CLASS = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const reasonOf = (error: unknown) => (error instanceof Error && CLASS.test(error.name) ? error.name : "error");

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

// `addEvidence` replaces the producer's items, so every write carries the ones already there (a PDF
// failure recorded first must survive the reading's write, and the other way round). One not-checked
// statement is enough however many paths reach it.
async function writeVision(db: D1Database, caseId: string, extra: EvidenceDraft[]): Promise<void> {
  const existing = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("vision."));
  if (existing.some((e) => e.check === "vision.not_checked"))
    extra = extra.filter((e) => e.check !== "vision.not_checked");
  const kept: EvidenceDraft[] = existing.map(({ check, severity, summary, detail, artefacts }) => ({
    check,
    severity,
    summary,
    detail,
    artefacts,
  }));
  await addEvidence(db, caseId, "vision", [...kept, ...extra]);
}

// The Workflow's own failure stated after the fact: the step threw past this helper (a storage failure,
// a step timeout), so the case gets the same not-checked statement the helper would have written.
export async function recordVisionNotRun(db: D1Database, caseId: string, reason: string): Promise<void> {
  await writeVision(db, caseId, [notCheckedItem(reason)]);
}

export async function visionStep(deps: VisionDeps, caseId: string): Promise<VisionResult> {
  const work = runVision(deps, caseId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<VisionResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ outcome: "not_checked", reason: "timeout" }),
      deps.deadlineMs ?? VISION_DEADLINE_MS,
    );
  });
  const result = await Promise.race([work, expired]).finally(() => clearTimeout(timer));
  if (result.outcome === "not_checked" && result.reason === "timeout")
    await writeVision(deps.db, caseId, [notCheckedItem("timeout")]).catch(() => undefined);
  return result;
}

async function runVision(deps: VisionDeps, caseId: string): Promise<VisionResult> {
  const owner = { kind: "case" as const, caseId, step: "vision" };
  let browser: Browser | undefined;
  try {
    browser = await deps.launch();
    const losses: string[] = [];

    // The PDF attachments, each rasterised on the shared browser: a failure is recorded beside the
    // items already there and never stops its siblings.
    const pdfs = (await artefactsOf(deps.store, caseId, "attachment")).filter((a) => a.mediaType === "application/pdf");
    const pages: { key: string; sha256: string; name: string; page: number }[] = [];
    let pdfIncomplete = false;
    for (const pdf of pdfs) {
      const name = pdf.key.split(`${pdf.sha256}-`)[1] ?? "attachment.pdf";
      const read = await readArtefact(deps.store, caseId, pdf.key);
      if (!read || !("body" in read)) {
        await recordPdfFailure(
          deps.db,
          caseId,
          { name, sha: pdf.sha256 },
          new PdfUnreadable("unavailable", "the attachment is missing"),
        );
        pdfIncomplete = true;
        continue;
      }
      try {
        const done = await rasterisePdf(browser, deps.store, caseId, { name, sha: pdf.sha256, bytes: read.body });
        const stored = await artefactsOf(deps.store, caseId, "page");
        const shaOf = new Map(stored.map((s) => [s.key, s.sha256]));
        for (const page of done.pages) {
          const sha256 = shaOf.get(page.key);
          if (sha256) pages.push({ key: page.key, sha256, name, page: page.page });
          else pdfIncomplete = true;
        }
        if (!done.complete) pdfIncomplete = true;
      } catch (error) {
        await recordPdfFailure(
          deps.db,
          caseId,
          { name, sha: pdf.sha256 },
          error instanceof PdfUnreadable ? error : new PdfUnreadable("operational", "the render failed"),
        );
        pdfIncomplete = true;
      }
    }

    const render = await renderEmail(browser, deps.store, caseId, {
      policy: deps.policy,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    if (render.outcome === "failed") {
      await writeVision(deps.db, caseId, [notCheckedItem(`render-${render.reason}`)]);
      return { outcome: "not_checked", reason: `render-${render.reason}` };
    }
    if (!render.complete) losses.push("the rendered email lost content");
    if (pdfIncomplete) losses.push("a PDF attachment is partly unread");

    // The pictures, in the order they are read: the desktop render, then the pages in order.
    const shot = render.shots.find((s) => s.name.startsWith("desktop")) ?? render.shots[0];
    const available: ReadingImage[] = [];
    if (shot) {
      const read = await readArtefact(deps.store, caseId, shot.key);
      if (read && "body" in read)
        available.push({
          id: "image-1",
          promptLabel: "the rendered email as the recipient saw it",
          key: shot.key,
          name: shot.name,
          sha256: shot.sha256,
          dataUrl: `data:image/png;base64,${toBase64(read.body)}`,
        });
    }
    for (const page of pages) {
      const read = await readArtefact(deps.store, caseId, page.key);
      if (read && "body" in read)
        available.push({
          id: `image-${available.length + 1}`,
          promptLabel: `page ${page.page} of a PDF attachment`,
          key: page.key,
          name: `${page.name} page ${page.page}`,
          sha256: page.sha256,
          dataUrl: `data:image/png;base64,${toBase64(read.body)}`,
        });
    }
    const images = available.slice(0, MAX_READING_IMAGES);
    if (available.length > images.length)
      losses.push(`${available.length - images.length} further images were not read`);
    if (!images.length) {
      await writeVision(deps.db, caseId, [notCheckedItem("no-picture")]);
      return { outcome: "not_checked", reason: "no-picture" };
    }

    const visible = (await readVisible(deps.store, caseId)) ?? "";
    const reading = await readMail(
      { meta: { ...deps.meta, owner }, kv: deps.kv, owner, waitUntil: deps.waitUntil },
      images,
      visible,
      losses.length === 0,
    );
    const items = readingItems(reading, images);
    if (losses.length) items.push(coverageItem(losses));
    await writeVision(deps.db, caseId, items);
    return { outcome: "read", items: items.length };
  } catch (error) {
    const reason = reasonOf(error);
    await writeVision(deps.db, caseId, [notCheckedItem(reason)]).catch(() => undefined);
    return { outcome: "not_checked", reason };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
