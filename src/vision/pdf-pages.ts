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
import jbig2Wasm from "pdfjs-dist/wasm/jbig2.wasm";
import openjpegWasm from "pdfjs-dist/wasm/openjpeg.wasm";
import { addEvidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import { putArtefact, type Store } from "../intake/store";

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_PAGES = 5;
export const MAX_PAGE_PIXELS = 12_000_000;
export const PDF_DEADLINE_MS = 90_000;
export const PAGE_WIDTH = 1600;
// One rendered page as it crosses back to the Worker: past this, the page is stated as stopped, never carried.
export const MAX_PNG_CHARS = 24_000_000;
// One embedded image as pdfjs may decode it: past this, decoding is refused and the omission is detected below.
export const MAX_IMAGE_PIXELS = 16_777_216;

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
  opts: {
    maxPages: number;
    pageWidth: number;
    maxPixels: number;
    openjpegB64: string;
    jbig2B64: string;
    maxImagePixels: number;
    maxPngChars: number;
  },
): Promise<{
  pages?: { png: string; width: number; height: number }[];
  total?: number;
  unprovenPages?: number[];
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
  // The JPEG2000 and JBIG2/CCITT decoders cross as fetch answers for the wasm names, so no origin is contacted.
  const wasmByName: Record<string, string> = { "openjpeg.wasm": opts.openjpegB64, "jbig2.wasm": opts.jbig2B64 };
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [name, b64] of Object.entries(wasmByName))
      if (url.endsWith(name))
        return Promise.resolve(new Response(dec(b64) as BodyInit, { headers: { "content-type": "application/wasm" } }));
    return realFetch(input, init);
  };
  const workerUrl = URL.createObjectURL(new Blob([dec(workerB64)], { type: "text/javascript" }));
  const libUrl = URL.createObjectURL(new Blob([dec(libB64)], { type: "text/javascript" }));
  try {
    const load = new Function("u", "return import(u)") as (u: string) => Promise<{
      GlobalWorkerOptions: { workerSrc: string };
      OPS: Record<string, number>;
      getDocument: (opts: {
        data: Uint8Array;
        useSystemFonts: boolean;
        wasmUrl: string;
        maxImageSize: number;
        stopAtErrors?: boolean;
      }) => {
        promise: Promise<unknown>;
      };
    }>;
    const lib = await load(libUrl);
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    let doc: {
      numPages: number;
      getPage: (n: number) => Promise<{
        getViewport: (o: { scale: number }) => { width: number; height: number };
        getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
        objs: { get: (id: string) => unknown };
        commonObjs: { get: (id: string) => unknown };
        render: (o: { canvasContext: unknown; viewport: { width: number; height: number } }) => {
          promise: Promise<void>;
        };
        cleanup: () => void;
      }>;
      destroy?: () => Promise<void>;
    };
    try {
      doc = (await lib.getDocument({
        data: dec(b64),
        useSystemFonts: true,
        wasmUrl: "https://pdf-wasm.invalid/",
        maxImageSize: opts.maxImagePixels,
      }).promise) as typeof doc;
    } catch (error) {
      return { error: String((error as Error)?.name || "Error"), kind: "load" };
    }
    // pdfjs silently removes an image past maxImageSize under its default error policy, so a second pass
    // with stopAtErrors builds each page's operator list under the same cap: a refusal aborts that list,
    // and a list shorter than the render pass's marks the page unproven, never complete. The strict pass
    // cannot say which element refused, so the result states the page as unchecked within bounds.
    let inventory: typeof doc | undefined;
    try {
      inventory = (await lib.getDocument({
        data: dec(b64),
        useSystemFonts: true,
        wasmUrl: "https://pdf-wasm.invalid/",
        maxImageSize: opts.maxImagePixels,
        stopAtErrors: true,
      }).promise) as typeof doc;
    } catch {
      inventory = undefined;
    }
    const unprovenPages: number[] = [];
    const total = doc.numPages;
    const out: { png: string; width: number; height: number }[] = [];
    const meta = () => out.map(({ width, height }) => ({ png: "", width, height }));
    (globalThis as unknown as Record<string, unknown>).__pngs = [];
    try {
      for (let n = 1; n <= Math.min(total, opts.maxPages); n++) {
        let strictOps: number | null = null;
        if (inventory) {
          try {
            strictOps = (await (await inventory.getPage(n)).getOperatorList()).fnArray.length;
          } catch {
            strictOps = null;
          }
        }
        const pdfPage = await doc.getPage(n);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: opts.pageWidth / base.width });
        if (Math.round(viewport.width) * Math.round(viewport.height) > opts.maxPixels)
          return { error: "PageTooLarge", kind: "page", total, pages: meta() };
        const canvas = (
          globalThis as unknown as { document: { createElement: (tag: string) => PageCanvas } }
        ).document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        // A failed decode leaves its image object resolved to null: state the omission at this page instead
        // of passing a page with a hole in it on as complete. A valid blank page has no failed object.
        const { fnArray, argsArray } = await pdfPage.getOperatorList();
        if (strictOps !== null && strictOps < fnArray.length) unprovenPages.push(n);
        const imageOps = [lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintImageMaskXObject];
        const isImage = (op: number) => imageOps.some((wanted) => wanted !== undefined && wanted === op);
        for (const [index, op] of fnArray.entries()) {
          if (!isImage(op)) continue;
          const id = argsArray[index]?.[0];
          if (typeof id !== "string") continue;
          let resolved: unknown = null;
          try {
            // Shared images live in the common pool under g_ ids, page-local ones in the page pool.
            resolved = (id.startsWith("g_") ? pdfPage.commonObjs : pdfPage.objs).get(id);
          } catch {
            resolved = null;
          }
          if (resolved === null) return { error: "ImageNotDecoded", kind: "page", total, pages: meta() };
        }
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length > opts.maxPngChars)
          return { error: "PageEncodedTooLarge", kind: "page", total, pages: meta() };
        out.push({ png: dataUrl, width: canvas.width, height: canvas.height });
        ((globalThis as unknown as Record<string, unknown>).__pngs as string[]).push(dataUrl);
        pdfPage.cleanup();
      }
    } catch (error) {
      return { error: String((error as Error)?.name || "Error"), kind: "render", total, pages: meta() };
    } finally {
      await doc.destroy?.().catch(() => undefined);
      await inventory?.destroy?.().catch(() => undefined);
    }
    return { pages: meta(), total, unprovenPages };
  } finally {
    URL.revokeObjectURL(workerUrl);
    URL.revokeObjectURL(libUrl);
  }
}

export async function rasterisePdf(
  browser: Browser,
  store: Store,
  caseId: string,
  source: { name: string; sha: string; bytes: Uint8Array },
  opts: { deadlineMs?: number; maxPages?: number } = {},
): Promise<PdfPagesResult> {
  if (!source.bytes.length) throw new PdfUnreadable("unavailable", "the attachment is missing");
  if (source.bytes.length > MAX_PDF_BYTES) throw new PdfUnreadable("operational", "the PDF is past the size bound");
  const deadlineMs = opts.deadlineMs ?? PDF_DEADLINE_MS;
  const startedAt = Date.now();
  const timedOut = () => new PdfUnreadable("operational", "the render timed out");
  // Every stage races the one elapsed deadline, storage included: a stalled await never outlives it here,
  // though the underlying write may still land under its deterministic key.
  const within = async <T>(stage: Promise<T>): Promise<T> => {
    const left = deadlineMs - (Date.now() - startedAt);
    if (left <= 0) throw timedOut();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut()), left);
    });
    try {
      return await Promise.race([stage, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const rawPage = browser.newPage();
  const page = await within(rawPage).catch((error) => {
    rawPage.then(
      (late) => late.close().catch(() => undefined),
      () => undefined,
    );
    if (error instanceof PdfUnreadable) throw error;
    throw new PdfUnreadable("operational", `the browser would not open a page: ${(error as Error).name}`);
  });
  try {
    await within(page.setContent("<!doctype html><title>pdf</title>", { waitUntil: "domcontentloaded" })).catch(
      () => undefined,
    );
    const work = page.evaluate(
      renderInPage,
      toBase64(source.bytes),
      toBase64(new TextEncoder().encode(libText)),
      toBase64(new TextEncoder().encode(workerText)),
      {
        maxPages: opts.maxPages ?? MAX_PDF_PAGES,
        pageWidth: PAGE_WIDTH,
        maxPixels: MAX_PAGE_PIXELS,
        openjpegB64: toBase64(new Uint8Array(openjpegWasm)),
        jbig2B64: toBase64(new Uint8Array(jbig2Wasm)),
        maxImagePixels: MAX_IMAGE_PIXELS,
        maxPngChars: MAX_PNG_CHARS,
      },
    ) as Promise<
      PageOut & { total?: number; unprovenPages?: number[]; pages?: { png: string; width: number; height: number }[] }
    >;
    const result = await within(work).catch((error) => {
      if (error instanceof PdfUnreadable) throw error;
      throw new PdfUnreadable("operational", `the browser failed (${(error as Error).name})`);
    });
    if ("error" in result && result.error && !result.pages?.length) {
      if (result.error === "PasswordException") throw new PdfUnreadable("encrypted", "the PDF asks for a password");
      if (result.error === "InvalidPDFException")
        throw new PdfUnreadable("malformed", "the file is not a readable PDF");
      // A page-level stop before the first page is a partial result with no pages, not a failed render.
      if (["PageTooLarge", "ImageNotDecoded", "PageEncodedTooLarge"].includes(result.error)) {
        return {
          pages: [],
          totalPages: result.total ?? 0,
          rendered: 0,
          complete: false,
          reason: `stopped at page 1 (${result.error})`,
        };
      }
      throw new PdfUnreadable("operational", `the render failed (${result.error})`);
    }
    const rendered = result.pages ?? [];
    const pages: RenderedPage[] = [];
    // Each PNG crosses back on its own, within its encoded bound, against the one elapsed deadline.
    let stopped = "error" in result && result.error ? result.error : null;
    for (const [i, out] of rendered.entries()) {
      if (Date.now() - startedAt > deadlineMs) {
        stopped = "the render timed out";
        break;
      }
      const dataUrl = (await within(page.evaluate(`window.__pngs[${i}]`)).catch((error) => {
        if (error instanceof PdfUnreadable) throw error;
        throw new PdfUnreadable("operational", `reading a rendered page back failed (${(error as Error).name})`);
      })) as string;
      if (typeof dataUrl !== "string" || dataUrl.length > MAX_PNG_CHARS) {
        stopped = "a page is past the encoded-size bound";
        break;
      }
      const body = fromBase64(dataUrl.replace(/^data:image\/png;base64,/, ""));
      const stored = await within(
        putArtefact(store, caseId, "page", `page-${source.sha.slice(0, 16)}-p${i + 1}.png`, body, "image/png"),
      ).catch((error) => {
        if (error instanceof PdfUnreadable) throw error;
        throw new PdfUnreadable("operational", `storing a page failed: ${(error as Error).name}`);
      });
      pages.push({ key: stored.key, page: i + 1, width: out.width, height: out.height });
    }
    const totalPages = result.total ?? rendered.length;
    return {
      pages,
      totalPages,
      rendered: pages.length,
      complete: !stopped && !result.unprovenPages?.length && totalPages <= (opts.maxPages ?? MAX_PDF_PAGES),
      reason: stopped
        ? `stopped at page ${pages.length + 1} (${stopped})`
        : result.unprovenPages?.length
          ? "part of a page could not be rendered within the size bounds"
          : totalPages > (opts.maxPages ?? MAX_PDF_PAGES)
            ? "past the five-page bound"
            : null,
    };
  } finally {
    // Cleanup is bounded too: a page that will not close does not hold the next document.
    await Promise.race([page.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
  }
}

// A refused or failed document stated on the case, beside the vision items already there (the producer's write
// replaces its own set, so they are carried back in the same write).
const briefName = (name: string) =>
  Array.from(
    name
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 60)
    .join("");

export async function recordPdfFailure(
  db: D1Database,
  caseId: string,
  source: { name: string; sha: string },
  error: PdfUnreadable,
): Promise<void> {
  const name = briefName(source.name);
  const existing = (await readEvidence(db, caseId)).filter(
    (e) =>
      e.check.startsWith("vision.") && !(e.check === "vision.pdf_unreadable" && e.detail.attachment === source.sha),
  );
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
        ? `A PDF attachment (${name}) is encrypted and could not be read.`
        : error.kind === "malformed"
          ? `A PDF attachment (${name}) could not be read as a PDF.`
          : error.kind === "unavailable"
            ? `A PDF attachment (${name}) was not available to read.`
            : `A PDF attachment (${name}) could not be rendered.`,
    detail: { kind: error.kind, source: name, attachment: source.sha, checked: false },
    artefacts: [],
  };
  await addEvidence(db, caseId, "vision", [...kept, item]);
}
