// The vision step (D03 T02 §3): between walkthrough and verdict, the case's pictures are made and read.
// It renders the email, rasterises each PDF attachment on the shared browser (a failure recorded, its
// siblings kept), reads the desktop render and the pages with Muse Spark, and writes the `vision.`
// evidence. Content and model problems never throw: what could not be read is stated on the case as
// `vision.not_checked` (or `vision.coverage` for a partial picture), so a model outage never fails a
// case and a safe verdict over an unread picture is partial, never a clean bill. A storage failure is
// the opposite: when even the failure statement cannot be written, the step throws, so the case ends
// partial instead of reaching a verdict with its missing coverage concealed.
import type { Browser } from "@cloudflare/puppeteer";
import { brandTable, bundled, registrable } from "../checks/brands";
import { addEvidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import { linksOf } from "../checks/links";
import { originalHeaderOf } from "../intake/original-header";
import { artefactsOf, parsedKey, readArtefact, readVisible, type Store, type Stored } from "../intake/store";
import type { MetaContext } from "../meta/client";
import {
  type BrandResolution,
  brandItem,
  type ComparedDomain,
  normaliseBrand,
  resolveBrand,
  shownDomain,
} from "./brand";
import { detectBoxes } from "./detector";
import { compareLogo, logoMatchItem, logoNotComparedItem } from "./logo-compare";
import { LogoReferenceError, referenceLogo } from "./logo-reference";
import { PDF_DEADLINE_MS, PdfUnreadable, pdfFailureItem, rasterisePdf } from "./pdf-pages";
import { coverageItem, notCheckedItem, type ReadingImage, readingItems, readMail } from "./reading";
import { MAX_READING_IMAGES } from "./reading-schema";
import { type RenderDeps, renderEmail } from "./render";
import { CROP_TIMEOUT_MS, cropBoxes, imageSize, selectBoxes, storeCrops } from "./sam";

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
  // The brand stage's budget, inside the deadline; a test shrinks it to prove a stalled lookup
  // states itself unconfirmed and leaves the committed reading standing.
  brandPhaseMs?: number;
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
// The brand stage's own bound: it ends this long after it starts, and always before the step
// deadline by the commit reserve, so its second commit lands and a stalled lookup states each
// unfinished brand unconfirmed instead of taking the committed reading down with it (G6).
export const BRAND_PHASE_MS = 90_000;
const BRAND_COMMIT_RESERVE_MS = 15_000;
// The logo comparison phase's own bound (D03 T03 §3), inside the same commit reserve.
export const LOGO_PHASE_MS = 60_000;

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
  "vision.brand_domain_mismatch",
  "vision.logo_match",
]);

type ParsedSummary = {
  headers?: { name: string; value: string }[];
  text?: string | null;
  html?: string | null;
  attachments?: { key: string; filename: string | null; mediaType: string }[];
};

// The stored parsed summary, read once for the brand stage; null when the case holds none or it
// cannot be read (an upload), never guessed from the picture.
async function parsedSummaryOf(store: Store, caseId: string): Promise<ParsedSummary | null> {
  try {
    const read = await readArtefact(store, caseId, parsedKey(caseId));
    if (!read || !("body" in read)) return null;
    return JSON.parse(new TextDecoder().decode(read.body)) as ParsedSummary;
  } catch {
    return null;
  }
}

// The case's authoritative sender domain, from its parsed From header; null when the case holds
// no readable one (an upload, a repeated From), never guessed from the picture.
function senderDomainOf(parsed: ParsedSummary | null): string | null {
  if (!parsed || !Array.isArray(parsed.headers)) return null;
  try {
    const address = originalHeaderOf(parsed.headers).fromAddress;
    const host = address?.slice(address.lastIndexOf("@") + 1).toLowerCase();
    return host && registrable(host) ? host : null;
  } catch {
    return null;
  }
}

// Every link host in the message itself, read with the checks' own link reader (D02 T07 §1), so
// a direct link that produced no finding is still a destination this case holds (round 1): the
// evidence's destination fields name where followed links ended, and this names where the
// message's links point, followed or not.
async function messageLinkHostsOf(store: Store, parsed: ParsedSummary | null): Promise<string[]> {
  if (!parsed || (parsed.html == null && parsed.text == null)) return [];
  try {
    const links = await linksOf(store.bucket, {
      source: { kind: "message", path: "inline", otherOriginals: 0 },
      text: parsed.text ?? null,
      html: parsed.html ?? null,
      truncated: [],
      attachments: (parsed.attachments ?? []).map((a) => ({
        key: a.key,
        filename: a.filename ?? "",
        mediaType: a.mediaType,
        contentId: null,
        disposition: null,
        charset: null,
        bytes: 0,
      })),
      attachmentHeads: null,
      htmlAttachments: null,
    });
    return [
      ...new Set((links?.items ?? []).map((link) => link.host.toLowerCase()).filter((host) => registrable(host))),
    ];
  } catch {
    // The brand stage is isolated: a failed read narrows it, never fails the reading.
    return [];
  }
}

// The destination fields a link item carries: the address it was written as, where it was last
// seen, and its hops. Anything else in an item's detail (a reputation provider's delisting page,
// a brand item's own cited source, a summary) is a reference, not a place the mail leads.
const DESTINATION_KEYS = new Set(["href", "link", "final", "url"]);

// Every landing host the case's link evidence actually names, from its destination fields only
// (completion review, G1): provider references and this step's own earlier items never become
// destinations, so a replay compares the same domains as the first attempt.
export function landingHostsFrom(evidence: readonly { check: string; detail: Record<string, unknown> }[]): string[] {
  const hosts = new Set<string>();
  const collect = (key: string, value: unknown) => {
    if (typeof value === "string" && DESTINATION_KEYS.has(key) && /^https?:\/\//.test(value)) {
      try {
        const host = new URL(value).hostname.toLowerCase();
        if (registrable(host)) hosts.add(host);
      } catch {
        // Not an address: data, not a landing.
      }
    } else if (Array.isArray(value)) for (const entry of value) collect(key, entry);
    else if (value && typeof value === "object")
      for (const [childKey, entry] of Object.entries(value)) collect(childKey, entry);
  };
  for (const item of evidence) {
    if (!item.check.startsWith("link.") && !item.check.startsWith("walkthrough.")) continue;
    for (const [key, value] of Object.entries(item.detail)) collect(key, value);
  }
  return [...hosts];
}

async function landingHostsOf(db: D1Database, caseId: string): Promise<string[]> {
  try {
    return landingHostsFrom(await readEvidence(db, caseId));
  } catch {
    // The brand stage is isolated: a failed read narrows it, never fails the reading.
    return [];
  }
}

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
      // The whole segmentation phase (streams, crops and storage) ends at segmentBy; everything
      // after it belongs to the reading.
      const segmentBy = deadlineAt - READING_RESERVE_MS;
      const segmentExpired = () => expired() || Date.now() > segmentBy;
      let unprocessed = images.length;
      for (const image of images) {
        if (expired()) return { outcome: "not_checked", reason: "timeout" };
        if (Date.now() > segmentBy) break;
        const source = sources.get(image.id);
        if (!source) {
          unprocessed--;
          continue;
        }
        try {
          // Each browser operation is capped at its own bound as well as the phase's remainder,
          // so one stalled image cannot spend every later image's allowance.
          const opLeft = () => Math.max(1, Math.min(CROP_TIMEOUT_MS, segmentBy - Date.now()));
          const size = await imageSize(browser, source.bytes, opLeft());
          // The chosen detector (D03 T03 §4): grounding needs the decoded size up front, SAM
          // ignores it; both return the same boxes and typed failures.
          const { boxes, failures } = await detectBoxes(
            { ...deps.meta, owner, expired: segmentExpired, waitUntil: deps.waitUntil },
            image.dataUrl,
            size,
            segmentBy,
          );
          if (failures.length) losses.push(`segmentation was unavailable for ${source.name}`);
          const provenance = { name: source.name, key: image.key, sha256: image.sha256 };
          if (!boxes.length) {
            // A completed zero-match replaces the previous current set with an empty one.
            if (!failures.length && !segmentExpired())
              await storeCrops(deps.store, caseId, provenance, [], segmentExpired, segmentBy);
            unprocessed--;
            continue;
          }
          if (expired()) return { outcome: "not_checked", reason: "timeout" };
          const selected = selectBoxes(boxes, size);
          if (!selected.length) {
            if (!failures.length && !segmentExpired())
              await storeCrops(deps.store, caseId, provenance, [], segmentExpired, segmentBy);
            unprocessed--;
            continue;
          }
          const { crops, failures: cropFailures } = await cropBoxes(browser, source.bytes, selected, opLeft());
          if (cropFailures.length) losses.push(`a segmentation crop on ${source.name} could not be made`);
          if (crops.length && !segmentExpired())
            await storeCrops(deps.store, caseId, provenance, crops, segmentExpired, segmentBy);
          unprocessed--;
        } catch {
          if (expired()) return { outcome: "not_checked", reason: "timeout" };
          losses.push(`segmentation was unavailable for ${source.name}`);
          unprocessed--;
        }
      }
      // Images the phase never reached are stated, like every other unfinished picture.
      if (unprocessed > 0 && Date.now() > segmentBy && !expired())
        losses.push("segmentation did not run in the time left");
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
    // The reading commits before the brand stage starts (G6): a lookup that stalls or fails from
    // here can state its brands unconfirmed, but can never take the reading down with it.
    if (!(await commit([...pdfItems, ...items]))) return { outcome: "not_checked", reason: "timeout" };

    // Each claimed brand against its real domains (D03 T02 §4), isolated per brand after the
    // reading exists: a lookup that fails states that brand unconfirmed and leaves every other
    // item standing, and expired work starts no grounded call.
    const brandItems: EvidenceDraft[] = [];
    const logoItems: EvidenceDraft[] = [];
    // Each claimed picture's domain judgement, retained for the logo comparison's severity
    // (D03 T03 §3): a high brand item is a mismatch, no item is official, an info item is unjudged.
    const logoDomains = new Map<string, "official" | "mismatch" | "unjudged">();
    const claims = reading.readings.filter((entry) => entry.claimed_brand);
    if (claims.length && !expired()) {
      const brandAt = Math.min(
        deadlineAt - BRAND_COMMIT_RESERVE_MS,
        Date.now() + (deps.brandPhaseMs ?? BRAND_PHASE_MS),
      );
      const brandDeadline = { at: brandAt, expired: () => expired() || Date.now() > brandAt };
      // Every setup wait is bounded by the brand deadline too (round 1): a stalled artefact or
      // evidence read states its brands with what is at hand instead of holding the step until
      // the outer timeout replaces the committed reading.
      const withinBrand = async <T>(work: Promise<T>, late: T): Promise<T> => {
        const left = brandAt - Date.now();
        if (left <= 0) return late;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expiredRead = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), left);
        });
        const settled = await Promise.race([work, expiredRead]).finally(() => clearTimeout(timer));
        return settled === "late" ? late : settled;
      };
      let table: Awaited<ReturnType<typeof brandTable>> | null = null;
      try {
        table = await withinBrand(brandTable({ CACHE: deps.kv }), bundled);
        const parsed = await withinBrand(parsedSummaryOf(deps.store, caseId), null);
        const sender = senderDomainOf(parsed);
        const landings = [
          ...new Set([
            ...(await withinBrand(landingHostsOf(deps.db, caseId), [] as string[])),
            ...(await withinBrand(messageLinkHostsOf(deps.store, parsed), [] as string[])),
          ]),
        ];
        const byId = new Map(images.map((image) => [image.id, image]));
        const resolutions = new Map<string, BrandResolution>();
        const grounded = { count: 0 };
        for (const claim of claims) {
          if (expired()) break;
          const image = byId.get(claim.image);
          const brand = claim.claimed_brand;
          if (!image || !brand) continue;
          const comparedByHost = new Map<string, ComparedDomain>();
          if (sender) comparedByHost.set(sender, { host: sender, kind: "sender" });
          for (const host of landings)
            if (!comparedByHost.has(host)) comparedByHost.set(host, { host, kind: "landing" });
          const shown = shownDomain(claim.visible_sender);
          if (shown && !comparedByHost.has(shown)) comparedByHost.set(shown, { host: shown, kind: "shown" });
          const compared = [...comparedByHost.values()];
          try {
            const key = normaliseBrand(brand);
            let resolution = resolutions.get(key);
            if (!resolution) {
              const registrables = new Set(
                compared.map((entry) => registrable(entry.host)).filter((domain) => domain !== null),
              );
              resolution = await resolveBrand(
                {
                  meta: deps.meta,
                  owner,
                  kv: deps.kv,
                  table,
                  deadline: brandDeadline,
                  grounded,
                },
                brand,
                registrables,
              );
              resolutions.set(key, resolution);
            }
            const item = brandItem(table, brand, image, compared, resolution);
            logoDomains.set(image.id, item ? (item.severity === "high" ? "mismatch" : "unjudged") : "official");
            if (item) brandItems.push(item);
          } catch {
            const fallback = brandItem(table, brand, image, compared, {
              kind: "unconfirmed",
              reason: "lookup-failed",
            });
            if (fallback) brandItems.push(fallback);
          }
        }
      } catch {
        // The stage's own setup failed (the table read): the reading stands without it, and the
        // absence is stated per claim rather than concealed.
        for (const claim of claims) {
          const image = images.find((entry) => entry.id === claim.image);
          if (!image || !claim.claimed_brand || !table) continue;
          const fallback = brandItem(table, claim.claimed_brand, image, [], {
            kind: "unconfirmed",
            reason: "lookup-failed",
          });
          if (fallback) brandItems.push(fallback);
        }
      }
    }
    // Logo comparison (D03 T03 §3): each claimed picture's stored logo crops against the claimed
    // brand's reference, in its own bounded phase. A comparison that cannot run states itself
    // not compared; it never takes the committed reading or a sibling's judgement down with it.
    if (claims.length && !expired()) {
      const logoAt = Math.min(deadlineAt - BRAND_COMMIT_RESERVE_MS, Date.now() + LOGO_PHASE_MS);
      const logoDeadline = { at: logoAt, expired: () => expired() || Date.now() > logoAt };
      // Every storage wait in this phase is bounded by the phase deadline: a stalled read states
      // its comparison not compared instead of holding the step to the outer timeout.
      const withinLogo = async <T>(work: Promise<T>, late: T): Promise<T> => {
        const left = logoAt - Date.now();
        if (left <= 0) return late;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expiredRead = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), left);
        });
        const settled = await Promise.race([work, expiredRead]).finally(() => clearTimeout(timer));
        return settled === "late" ? late : settled;
      };
      let listingFailed = false;
      try {
        const cropArtefacts = await withinLogo(
          artefactsOf(deps.store, caseId, "crop").catch(() => {
            listingFailed = true;
            return [] as Stored[];
          }),
          [] as Stored[],
        );
        // A race lost to the phase deadline returns the late value with no failure marked:
        // detect it from the clock so a timed-out listing is stated, never read as no crops.
        if (!cropArtefacts.length && logoDeadline.expired()) listingFailed = true;
        const manifests = new Map<string, string[]>();
        const generations = new Map<string, number>();
        let failedManifests = 0;
        const failedByStem = new Map<string, number>();
        // The storage stem (src/vision/sam.ts): capped, so a long name's manifest keeps its suffix.
        const stemOf = (name: string) =>
          Array.from(name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.(png|jpe?g|webp)$/i, ""))
            .slice(0, 100)
            .join("");
        for (const artefact of cropArtefacts) {
          const generation = /-manifest-(\d+)\.json$/.exec(artefact.key)?.[1];
          if (!generation) continue;
          const read = await withinLogo(
            readArtefact(deps.store, caseId, artefact.key).catch(() => null),
            null,
          );
          if (!read || !("body" in read)) {
            failedManifests += 1;
            const stem = /-(.+)-manifest-\d+\.json$/.exec(artefact.key)?.[1];
            if (stem) failedByStem.set(stem, Math.max(failedByStem.get(stem) ?? 0, Number(generation)));
            continue;
          }
          try {
            const manifest = JSON.parse(new TextDecoder().decode(read.body)) as {
              source?: { key?: string };
              crops?: string[];
            };
            const sourceKey = manifest.source?.key;
            if (!sourceKey || !Array.isArray(manifest.crops)) continue;
            if (Number(generation) >= (generations.get(sourceKey) ?? 0)) {
              generations.set(sourceKey, Number(generation));
              manifests.set(sourceKey, manifest.crops);
            }
          } catch {
            // A manifest that cannot be read names no crops: stated per claim below, never guessed.
            failedManifests += 1;
            const stem = /-(.+)-manifest-\d+\.json$/.exec(artefact.key)?.[1];
            if (stem) failedByStem.set(stem, Math.max(failedByStem.get(stem) ?? 0, Number(generation)));
          }
        }
        const references = new Map<string, Awaited<ReturnType<typeof referenceLogo>> | LogoReferenceError>();
        const byImage = new Map(images.map((image) => [image.id, image]));
        for (const claim of claims) {
          const image = byImage.get(claim.image);
          const brand = claim.claimed_brand;
          if (!image || !brand) continue;
          const crops = (manifests.get(image.key) ?? []).filter((key) => key.includes("-logo-"));
          if (listingFailed && !manifests.has(image.key)) {
            logoItems.push(logoNotComparedItem(brand, image.key, "crop-listing-unavailable"));
            continue;
          }
          if (!manifests.has(image.key) && failedManifests > 0) {
            logoItems.push(logoNotComparedItem(brand, image.key, "manifest-unreadable"));
            continue;
          }
          // An unreadable newer generation supersedes the parsed one: never resurrect its crops.
          if ((failedByStem.get(stemOf(image.name)) ?? 0) > (generations.get(image.key) ?? 0)) {
            logoItems.push(logoNotComparedItem(brand, image.key, "manifest-unreadable"));
            continue;
          }
          if (logoDeadline.expired()) {
            for (const cropKey of crops) logoItems.push(logoNotComparedItem(brand, cropKey, "deadline"));
            continue;
          }
          let reference = references.get(brand);
          if (reference === undefined) {
            reference = await withinLogo(
              referenceLogo(deps.store.bucket, brand).catch((error: unknown) =>
                error instanceof LogoReferenceError
                  ? error
                  : new LogoReferenceError("missing-image", "the reference logo could not be read"),
              ),
              new LogoReferenceError("missing-image", "the reference logo could not be read in time"),
            );
            references.set(brand, reference);
          }
          for (const cropKey of crops) {
            if (logoDeadline.expired()) {
              logoItems.push(logoNotComparedItem(brand, cropKey, "deadline"));
              continue;
            }
            if (reference instanceof LogoReferenceError) {
              logoItems.push(logoNotComparedItem(brand, cropKey, reference.kind));
              continue;
            }
            try {
              const crop = await withinLogo(readArtefact(deps.store, caseId, cropKey), null);
              if (!crop || !("body" in crop)) {
                logoItems.push(logoNotComparedItem(brand, cropKey, "missing-crop"));
                continue;
              }
              const judgement = await compareLogo(
                {
                  meta: { ...deps.meta, owner },
                  kv: deps.kv,
                  owner,
                  waitUntil: deps.waitUntil,
                  deadline: logoDeadline,
                },
                { bytes: crop.body, mediaType: "image/png", label: cropKey },
                { bytes: reference.bytes, mediaType: reference.mediaType, label: reference.slug },
              );
              logoItems.push(logoMatchItem(judgement, brand, cropKey, logoDomains.get(image.id) ?? "unjudged"));
            } catch (error) {
              const reason =
                error instanceof LogoReferenceError || error instanceof Error ? error.name : "comparison-failed";
              logoItems.push(logoNotComparedItem(brand, cropKey, reason));
            }
          }
        }
      } catch {
        // The phase's own setup failed: the reading and brand items stand without it.
        for (const claim of claims) {
          const image = images.find((entry) => entry.id === claim.image);
          if (image && claim.claimed_brand)
            logoItems.push(logoNotComparedItem(claim.claimed_brand, image.key, "comparison-unavailable"));
        }
      }
    }
    if (!(await commit([...pdfItems, ...items, ...brandItems, ...logoItems])))
      return { outcome: "not_checked", reason: "timeout" };
    return { outcome: "read", items: items.length + brandItems.length + logoItems.length };
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
