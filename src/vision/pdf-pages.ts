// PDF page rasterisation (D03 T02 §2). `pdfjs-dist` runs inside the Browser Run page: the Worker holds its two
// bundles as text (the Text rule in `wrangler.jsonc`) and injects them, the worker from the same text as a blob
// URL, so the page contacts no origin and the URL policy is untouched. The first five pages become `page`
// artefacts at 1600 px wide for SAM (§3 of D03 T03) and the report's evidence cards.
//
// Bounds, enforced here: at most 8 MiB of PDF, 5 pages, 12 million canvas pixels a page and 90 seconds a
// document. An encrypted or malformed document is its own refusal; a missing attachment, a storage failure, a
// browser failure or a timeout is operational, never a malformed document, and one bad attachment never stops
// its siblings (the caller renders each on its own). The page and its blob URLs are released on every exit.

import type { Browser } from "@cloudflare/puppeteer";
import libText from "pdfjs-dist/build/pdf.min.mjs";
import workerText from "pdfjs-dist/build/pdf.worker.min.mjs";
import { addEvidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import { putArtefact, type Store } from "../intake/store";

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_PAGES = 5;
export const MAX_PAGE_PIXELS = 12_000_000;
export const PDF_DEADLINE_MS = 90_000;
export const PAGE_WIDTH = 1600;

export type PdfErrorKind = "encrypted" | "malformed" | "unavailable" | "operational";
export class PdfUnreadable extends Error {
  override name = "PdfUnreadable";
  readonly kind: PdfErrorKind;
  constructor(kind: PdfErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type RenderedPage = { key: string; page: number; width: number; height: number };
export type PdfPagesResult = {
  pages: RenderedPage[];
  totalPages: number;
  rendered: number;
  complete: boolean;
  reason: string | null;
};

type PageOut = { png: string; width: number; height: number }[] | { error: string; kind: string; total?: number };

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// The page's own work, as text evaluated with the bytes: load, then render each page to a PNG data string. Its
// errors cross back as names, which the caller maps to typed kinds; nothing else about them is trusted.
type PageCanvas = {
  width: number;
  height: number;
  getContext: (kind: string) => unknown;
  toDataURL: (type: string) => string;
};

// Runs in the page (serialised by the driver): load the library from its blob, then render each page to a PNG
// data string. Its errors cross back as names, which the caller maps to typed kinds.
async function renderInPage(
  b64: string,
  libB64: string,
  workerB64: string,
  maxPages: number,
  pageWidth: number,
  maxPixels: number,
): Promise<{
  pages?: { png: string; width: number; height: number }[];
  total?: number;
  error?: string;
  kind?: string;
}> {
  const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  // Browser Run's Chromium lacks newer builtins pdfjs 6 calls: `Promise.try` while setting up its worker, and
  // the `Uint8Array` hex and base64 methods while reading the document.
  const promise = Promise as unknown as Record<string, unknown>;
  promise.try ??= (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
    Promise.resolve().then(() => fn(...args));
  const bytes = Uint8Array.prototype as unknown as Record<string, unknown>;
  bytes.toHex ??= function (this: Uint8Array) {
    return [...this].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  bytes.toBase64 ??= function (this: Uint8Array) {
    let out = "";
    for (let i = 0; i < this.length; i += 0x8000) out += String.fromCharCode(...this.subarray(i, i + 0x8000));
    return btoa(out);
  };
  for (const ctor of [Map, WeakMap] as const) {
    const proto = ctor.prototype as unknown as Record<string, unknown>;
    proto.getOrInsert ??= function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    };
    proto.getOrInsertComputed ??= function (this: Map<unknown, unknown>, key: unknown, fn: (k: unknown) => unknown) {
      if (!this.has(key)) this.set(key, fn(key));
      return this.get(key);
    };
  }
  const statics = Uint8Array as unknown as Record<string, unknown>;
  statics.fromHex ??= (hex: string) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => parseInt(pair, 16));
  statics.fromBase64 ??= (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const workerUrl = URL.createObjectURL(new Blob([dec(workerB64)], { type: "text/javascript" }));
  const libUrl = URL.createObjectURL(new Blob([dec(libB64)], { type: "text/javascript" }));
  try {
    const load = new Function("u", "return import(u)") as (u: string) => Promise<{
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (opts: { data: Uint8Array; useSystemFonts: boolean }) => { promise: Promise<unknown> };
    }>;
    const lib = await load(libUrl);
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    let doc: {
      numPages: number;
      getPage: (n: number) => Promise<{
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: { canvasContext: unknown; viewport: { width: number; height: number } }) => {
          promise: Promise<void>;
        };
        cleanup: () => void;
      }>;
      destroy?: () => Promise<void>;
    };
    try {
      doc = (await lib.getDocument({ data: dec(b64), useSystemFonts: true }).promise) as typeof doc;
    } catch (error) {
      return { error: String((error as Error)?.name || "Error"), kind: "load" };
    }
    const total = doc.numPages;
    const out: { png: string; width: number; height: number }[] = [];
    try {
      for (let n = 1; n <= Math.min(total, maxPages); n++) {
        const pdfPage = await doc.getPage(n);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: pageWidth / base.width });
        if (Math.round(viewport.width) * Math.round(viewport.height) > maxPixels)
          return { error: "PageTooLarge", kind: "page", total };
        const canvas = (
          globalThis as unknown as { document: { createElement: (tag: string) => PageCanvas } }
        ).document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        out.push({ png: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height });
        pdfPage.cleanup();
      }
    } catch (error) {
      return { error: String((error as Error)?.name || "Error"), kind: "render", total };
    } finally {
      await doc.destroy?.().catch(() => undefined);
    }
    return { pages: out, total };
  } finally {
    URL.revokeObjectURL(workerUrl);
    URL.revokeObjectURL(libUrl);
  }
}

export async function rasterisePdf(
  browser: Browser,
  store: Store,
  caseId: string,
  source: { name: string; bytes: Uint8Array },
  opts: { deadlineMs?: number; maxPages?: number } = {},
): Promise<PdfPagesResult> {
  if (!source.bytes.length) throw new PdfUnreadable("unavailable", "the attachment is missing");
  if (source.bytes.length > MAX_PDF_BYTES) throw new PdfUnreadable("operational", "the PDF is past the size bound");
  const page = await browser.newPage().catch((error) => {
    throw new PdfUnreadable("operational", `the browser would not open a page: ${(error as Error).name}`);
  });
  try {
    await page
      .setContent("<!doctype html><title>pdf</title>", { waitUntil: "domcontentloaded" })
      .catch(() => undefined);
    const work = page.evaluate(
      renderInPage,
      toBase64(source.bytes),
      toBase64(new TextEncoder().encode(libText)),
      toBase64(new TextEncoder().encode(workerText)),
      opts.maxPages ?? MAX_PDF_PAGES,
      PAGE_WIDTH,
      MAX_PAGE_PIXELS,
    ) as Promise<PageOut & { total?: number; pages?: { png: string; width: number; height: number }[] }>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PdfUnreadable("operational", "the render timed out")),
        opts.deadlineMs ?? PDF_DEADLINE_MS,
      );
    });
    const result = await Promise.race([work, late]).finally(() => clearTimeout(timer));
    if ("error" in result && result.error) {
      if (result.error === "PasswordException") throw new PdfUnreadable("encrypted", "the PDF asks for a password");
      if (result.kind === "page") throw new PdfUnreadable("operational", "a page is past the pixel bound");
      throw new PdfUnreadable("malformed", `the PDF could not be read (${result.error})`);
    }
    const rendered = result.pages ?? [];
    const pages: RenderedPage[] = [];
    for (const [i, out] of rendered.entries()) {
      const body = fromBase64(out.png.replace(/^data:image\/png;base64,/, ""));
      const stored = await putArtefact(
        store,
        caseId,
        "page",
        `page-${source.name}-p${i + 1}.png`,
        body,
        "image/png",
      ).catch((error) => {
        throw new PdfUnreadable("operational", `storing a page failed: ${(error as Error).name}`);
      });
      pages.push({ key: stored.key, page: i + 1, width: out.width, height: out.height });
    }
    const totalPages = result.total ?? rendered.length;
    return {
      pages,
      totalPages,
      rendered: pages.length,
      complete: totalPages <= (opts.maxPages ?? MAX_PDF_PAGES),
      reason: totalPages > (opts.maxPages ?? MAX_PDF_PAGES) ? "past the five-page bound" : null,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

// A refused or failed document stated on the case, beside the vision items already there (the producer's write
// replaces its own set, so they are carried back in the same write).
export async function recordPdfFailure(
  db: D1Database,
  caseId: string,
  sourceName: string,
  error: PdfUnreadable,
): Promise<void> {
  const existing = (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("vision."));
  const kept: EvidenceDraft[] = existing.map(({ check, severity, summary, detail, artefacts }) => ({
    check,
    severity,
    summary,
    detail,
    artefacts,
  }));
  const item: EvidenceDraft = {
    check: "vision.pdf_unreadable",
    severity: "info",
    summary:
      error.kind === "encrypted"
        ? `A PDF attachment (${sourceName}) is encrypted and could not be read.`
        : error.kind === "malformed"
          ? `A PDF attachment (${sourceName}) could not be read as a PDF.`
          : error.kind === "unavailable"
            ? `A PDF attachment (${sourceName}) was not available to read.`
            : `A PDF attachment (${sourceName}) could not be rendered.`,
    detail: { kind: error.kind, source: sourceName, checked: false },
    artefacts: [],
  };
  await addEvidence(db, caseId, "vision", [...kept, item]);
}
