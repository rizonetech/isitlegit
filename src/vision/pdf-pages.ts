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
import cmapBin from "./pdf-cmaps.bin";
import { CMAP_INDEX } from "./pdf-cmaps-index";

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_PAGES = 5;
export const MAX_PAGE_PIXELS = 12_000_000;
export const PDF_DEADLINE_MS = 90_000;
export const PAGE_WIDTH = 1600;
// One rendered page as it crosses back to the Worker: past this, the page is stated as stopped, never carried.
export const MAX_PNG_CHARS = 24_000_000;
// One embedded image as pdfjs may decode it: past this, decoding is refused and the omission is detected below.
export const MAX_IMAGE_PIXELS = 16_777_216;
// Every embedded image in the document together: past this, the document is stated partial before any decode.
export const MAX_TOTAL_IMAGE_PIXELS = 33_554_432;
// Inflated bytes scanned per stream in the budget inventory: dictionaries sit at the front of object streams.
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
// Inflated bytes scanned across every stream of one document.
export const MAX_TOTAL_SCAN_BYTES = 32 * 1024 * 1024;

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
type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
    getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
    ref: { num: number; gen: number };
    objs: { get: (id: string) => unknown };
    commonObjs: { get: (id: string) => unknown };
    render: (o: { canvasContext: unknown; viewport: { width: number; height: number } }) => {
      promise: Promise<void>;
    };
    cleanup: () => void;
  }>;
  destroy?: () => Promise<void>;
};

type PageLib = {
  GlobalWorkerOptions: { workerSrc: string };
  OPS: Record<string, number>;
  getDocument: (opts: {
    data: Uint8Array;
    useSystemFonts: boolean;
    wasmUrl: string;
    cMapUrl: string;
    cMapPacked: boolean;
    maxImageSize: number;
    stopAtErrors?: boolean;
  }) => {
    promise: Promise<unknown>;
  };
};

type PageOpts = {
  maxPages: number;
  pageWidth: number;
  maxPixels: number;
  openjpegB64: string;
  jbig2B64: string;
  maxImagePixels: number;
  maxTotalImagePixels: number;
  maxPngChars: number;
  cmapsB64: string;
  cmapIndex: Record<string, readonly [number, number]>;
};

type PageCtx = {
  lib: PageLib;
  doc: PdfDoc;
  inventory: PdfDoc | undefined;
  opts: PageOpts;
  decodedPixels: number;
  countedImages: Set<string>;
};

// Opens the document (and the strict inventory) once; the pages are then rendered one call at a time so the
// Worker can persist each before the next begins.
async function openInPage(
  b64: string,
  libB64: string,
  workerB64: string,
  opts: PageOpts,
): Promise<{ total?: number; error?: string; kind?: string }> {
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
  const cmapBytes = dec(opts.cmapsB64);
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [name, b64] of Object.entries(wasmByName))
      if (url.endsWith(name))
        return Promise.resolve(new Response(dec(b64) as BodyInit, { headers: { "content-type": "application/wasm" } }));
    if (url.endsWith(".bcmap")) {
      const entry = opts.cmapIndex[url.slice(url.lastIndexOf("/") + 1)];
      if (entry) return Promise.resolve(new Response(cmapBytes.subarray(entry[0], entry[0] + entry[1]) as BodyInit));
    }
    return realFetch(input, init);
  };
  const workerUrl = URL.createObjectURL(new Blob([dec(workerB64)], { type: "text/javascript" }));
  const libUrl = URL.createObjectURL(new Blob([dec(libB64)], { type: "text/javascript" }));
  const load = new Function("u", "return import(u)") as (u: string) => Promise<PageLib>;
  const lib = await load(libUrl);
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  let doc: PdfDoc;
  try {
    doc = (await lib.getDocument({
      data: dec(b64),
      useSystemFonts: true,
      wasmUrl: "https://pdf-wasm.invalid/",
      cMapUrl: "https://pdf-cmaps.invalid/",
      cMapPacked: true,
      maxImageSize: opts.maxImagePixels,
    }).promise) as PdfDoc;
  } catch (error) {
    return { error: String((error as Error)?.name || "Error"), kind: "load" };
  }
  // pdfjs silently removes an image past maxImageSize under its default error policy, so a second pass
  // with stopAtErrors builds each page's operator list under the same cap: a refusal aborts that list,
  // and a list shorter than the render pass's marks the page unproven, never complete. The strict pass
  // cannot say which element refused, so the result states the page as unchecked within bounds.
  let inventory: PdfDoc | undefined;
  try {
    inventory = (await lib.getDocument({
      data: dec(b64),
      useSystemFonts: true,
      wasmUrl: "https://pdf-wasm.invalid/",
      cMapUrl: "https://pdf-cmaps.invalid/",
      cMapPacked: true,
      maxImageSize: opts.maxImagePixels,
      stopAtErrors: true,
    }).promise) as PdfDoc;
  } catch {
    inventory = undefined;
  }
  const ctx: PageCtx = { lib, doc, inventory, opts, decodedPixels: 0, countedImages: new Set() };
  (globalThis as unknown as Record<string, unknown>).__pdfctx = ctx;
  return { total: doc.numPages };
}

// Renders one page of the opened document and leaves its PNG on the page for the Worker to persist.
async function renderPageInPage(n: number): Promise<{
  width?: number;
  height?: number;
  unproven?: boolean;
  empty?: boolean;
  ref?: { num: number; gen: number };
  error?: string;
  kind?: string;
}> {
  const ctx = (globalThis as unknown as Record<string, unknown>).__pdfctx as PageCtx;
  const { lib, doc, inventory, opts } = ctx;
  try {
    let strictOps: number | null = null;
    if (inventory) {
      try {
        strictOps = (await (await inventory.getPage(n)).getOperatorList()).fnArray.length;
      } catch {
        strictOps = null;
      }
    }
    const pdfPage = await doc.getPage(n);
    const ref = pdfPage.ref;
    const base = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: opts.pageWidth / base.width });
    if (Math.round(viewport.width) * Math.round(viewport.height) > opts.maxPixels)
      return { error: "PageTooLarge", kind: "page", ref };
    const canvas = (
      globalThis as unknown as { document: { createElement: (tag: string) => PageCanvas } }
    ).document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    // A failed decode leaves its image object resolved to null: state the omission at this page instead
    // of passing a page with a hole in it on as complete. A valid blank page has no failed object.
    const { fnArray, argsArray } = await pdfPage.getOperatorList();
    const unproven = strictOps === null || strictOps < fnArray.length;
    const empty = fnArray.length === 0;
    const imageOps = [lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintImageMaskXObject];
    const isImage = (op: number) => imageOps.some((wanted) => wanted !== undefined && wanted === op);
    for (const [index, op] of fnArray.entries()) {
      if (!isImage(op)) continue;
      const id = argsArray[index]?.[0];
      if (typeof id !== "string") {
        // An inline image or mask carries its data as the argument: count its pixels where it stands.
        const dims = id as { width?: number; height?: number } | null;
        if (dims && typeof dims.width === "number" && typeof dims.height === "number") {
          ctx.decodedPixels += dims.width * dims.height;
          if (ctx.decodedPixels > opts.maxTotalImagePixels) return { error: "ImageBudgetExceeded", kind: "page", ref };
        }
        continue;
      }
      let resolved: unknown = null;
      try {
        // Shared images live in the common pool under g_ ids, page-local ones in the page pool.
        resolved = (id.startsWith("g_") ? pdfPage.commonObjs : pdfPage.objs).get(id);
      } catch {
        resolved = null;
      }
      if (resolved === null) return { error: "ImageNotDecoded", kind: "page", ref };
      const dims = resolved as { width?: number; height?: number };
      // A shared image is decoded once, however many pages paint it: it is counted once.
      if (!ctx.countedImages.has(id) && typeof dims.width === "number" && typeof dims.height === "number") {
        ctx.countedImages.add(id);
        ctx.decodedPixels += dims.width * dims.height;
        if (ctx.decodedPixels > opts.maxTotalImagePixels) return { error: "ImageBudgetExceeded", kind: "page", ref };
      }
    }
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > opts.maxPngChars) return { error: "PageEncodedTooLarge", kind: "page", ref };
    (globalThis as unknown as Record<string, unknown>).__png = dataUrl;
    pdfPage.cleanup();
    return { width: canvas.width, height: canvas.height, unproven, empty, ref };
  } catch (error) {
    return { error: String((error as Error)?.name || "Error"), kind: "render" };
  }
}

const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};

type ObjectIndex = Map<string, { body: string; at: number }>;

const buildObjectIndex = (text: string): ObjectIndex => {
  // Built on structural text (stream payloads blanked, strings masked), so object-like bytes inside a
  // stream are never headers. The last revision in the file is the active one: an incremental update
  // appends it after the original. The endobj search moves forward only, so the pass stays linear.
  const index: ObjectIndex = new Map();
  let cursor = 0;
  for (const match of text.matchAll(/(?:^|\s)(\d+)\s+(\d+)\s+obj\b/g)) {
    const headerAt = (match.index ?? 0) + (match[0].startsWith(match[1] ?? "") ? 0 : 1);
    const end = text.indexOf("endobj", Math.max(cursor, headerAt));
    if (end < 0) break;
    cursor = end;
    index.set(`${match[1]} ${match[2]}`, { body: text.slice(headerAt, end), at: headerAt });
  }
  return index;
};

const objectText = (objects: ObjectIndex, num: number, gen: number): { body: string; at: number } | null =>
  objects.get(`${num} ${gen}`) ?? null;

// Whether the page's own content stream is empty, read from the objects pdfjs named by reference. Null when
// the objects cannot be read plainly (an object stream, an array of streams): the page stays unproven.
async function pageContentIsEmpty(bytes: Uint8Array, ref: { num: number; gen: number }): Promise<boolean | null> {
  const text = latin1(bytes);
  const objects = buildObjectIndex(maskOutsideStreams(text));
  const page = objectText(objects, ref.num, ref.gen);
  if (!page) return null;
  const contents = /\/Contents\s+(\d+)\s+(\d+)\s+R/.exec(page.body);
  if (!contents) return page.body.includes("/Contents") ? null : true;
  const streamObj = objectText(objects, Number(contents[1]), Number(contents[2]));
  if (!streamObj) return null;
  const marker = streamObj.body.indexOf("stream");
  if (marker < 0) return null;
  let start = streamObj.at + marker + "stream".length;
  if (text[start] === "\r") start++;
  if (text[start] === "\n") start++;
  let end = text.indexOf("endstream", start);
  if (end < 0) return null;
  // The line break before endstream is a delimiter, not stream data.
  while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  if (!streamObj.body.includes("FlateDecode")) return text.slice(start, end).trim().length === 0;
  try {
    const reader = new Blob([bytes.slice(start, end).buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 262_144) return false;
      // Whitespace-only content inflates to whitespace: check the bytes themselves.
      if (value.some((b) => b > 32)) return false;
    }
    return true;
  } catch {
    return null;
  }
}

const unescapeNames = (text: string) =>
  text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

// A same-length copy with string and comment contents blanked: dictionary-shaped text inside a string is
// content, never structure, and the inventory must not read it as an image.
const maskStrings = (text: string) => {
  let out = "";
  let span = 0;
  let i = 0;
  const blank = (from: number, to: number) => {
    out += text.slice(span, from) + " ".repeat(to - from);
    span = to;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "%") {
      const from = i;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      blank(from, i);
    } else if (ch === "(") {
      const from = i;
      let depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "(") depth++;
        if (c === ")") {
          depth--;
          i++;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
      blank(from, i);
    } else {
      i++;
    }
  }
  return out + text.slice(span);
};

const dimensionOf = (dict: string, key: string, objects: ObjectIndex): number | null => {
  // A reference (10 0 R) is tried first: its object number is not a dimension.
  const indirect = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
  if (!indirect) {
    const direct = new RegExp(`/${key}\\s+([+-]?\\d+)`).exec(dict);
    return direct ? Number(direct[1]) : null;
  }
  const found = objectText(objects, Number(indirect[1]), Number(indirect[2]));
  const value = found ? /^\s*(\d+)/.exec(found.body.slice(found.body.indexOf("obj") + 3)) : null;
  return value ? Number(value[1]) : null;
};

const maskOutsideStreams = (text: string) => {
  // Masking is applied segment by segment: a string that never closes inside one stream's data can blank
  // only that stream, never the dictionaries after it.
  let out = "";
  let at = 0;
  for (const match of text.matchAll(/stream(?:\r\n|\r|\n)/g)) {
    if (text.slice((match.index ?? 0) - 3, match.index ?? 0) === "end") continue;
    const dataAt = (match.index ?? 0) + match[0].length;
    if (dataAt < at) continue;
    const end = text.indexOf("endstream", dataAt);
    if (end < 0) break;
    out += maskStrings(text.slice(at, dataAt)) + " ".repeat(end - dataAt) + "endstream";
    at = end + "endstream".length;
  }
  return out + maskStrings(text.slice(at));
};

// The dictionary that owns a stream: the one whose closing brackets sit immediately before the keyword,
// found by walking backwards so a nested dictionary at its tail is never mistaken for it.
const streamDict = (text: string, keywordAt: number): string => {
  let end = keywordAt;
  while (end > 0 && /\s/.test(text[end - 1] ?? "")) end--;
  if (text.slice(end - 2, end) !== ">>") return "";
  let depth = 0;
  for (let i = end; i >= 2; i--) {
    const pair = text.slice(i - 2, i);
    if (pair === ">>") depth++;
    else if (pair === "<<") {
      depth--;
      if (depth === 0) return text.slice(i - 2, end);
    }
  }
  return "";
};

// A stream's exact bytes, by its dictionary's /Length where that is readable; null when it must be guessed.
const streamSlice = (
  text: string,
  bytes: Uint8Array,
  keywordAt: number,
  dataAt: number,
  objects: ObjectIndex,
): { slice: Uint8Array; exact: boolean } => {
  const dict = streamDict(text, keywordAt);
  if (dict) {
    const length = dimensionOf(unescapeNames(dict), "Length", objects);
    if (length !== null && length >= 0 && dataAt + length <= bytes.length)
      return { slice: bytes.slice(dataAt, dataAt + length), exact: true };
  }
  const end = text.indexOf("endstream", dataAt);
  return { slice: bytes.slice(dataAt, end < 0 ? bytes.length : end), exact: false };
};

// The end of the dictionary opened at `open`, honouring nested dictionaries (strings are already masked).
const dictEnd = (text: string, open: number): number => {
  let depth = 0;
  let i = open;
  while (i < text.length - 1) {
    const pair = text.slice(i, i + 2);
    if (pair === "<<") {
      depth++;
      i += 2;
      continue;
    }
    if (pair === ">>") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
};

// The dictionary with nested dictionaries removed: a key inside DecodeParms is not the image's own key.
const topLevel = (dict: string) => {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < dict.length) {
    const pair = dict.slice(i, i + 2);
    if (pair === "<<") {
      depth++;
      if (depth === 1) out += pair;
      i += 2;
      continue;
    }
    if (pair === ">>") {
      if (depth === 1) out += pair;
      depth--;
      i += 2;
      continue;
    }
    if (depth <= 1) out += dict[i];
    i++;
  }
  return out;
};

const inlineImageSpans = (text: string) => {
  const spans: { dict: string; dataAt: number; dataEnd: number; terminated: boolean }[] = [];
  let at = 0;
  for (;;) {
    const found = /\bBI\b/.exec(text.slice(at));
    if (!found) break;
    const dictAt = at + found.index;
    const id = /\bID\b/.exec(text.slice(dictAt, dictAt + 65_536));
    if (!id) {
      spans.push({ dict: text.slice(dictAt), dataAt: text.length, dataEnd: text.length, terminated: false });
      break;
    }
    let dataAt = dictAt + id.index + 2;
    if (/\s/.test(text[dataAt] ?? "")) dataAt++;
    const ei = /\sEI(?=\s|$)/.exec(text.slice(dataAt));
    const dataEnd = ei ? dataAt + ei.index : text.length;
    spans.push({ dict: text.slice(dictAt, dictAt + id.index), dataAt, dataEnd, terminated: ei !== null });
    at = ei ? dataAt + ei.index + 3 : text.length;
  }
  return spans;
};

const imageInventory = (clean: string, keyed = false, objects: ObjectIndex = new Map()) => {
  let pixels = 0;
  let invalid = false;
  // Superseded revisions of one image object are not decoding work: in the plain file, only the last
  // dictionary of each object counts.
  const byObject = new Map<string, number>();
  let keyedTotal = 0;
  // Every occurrence of every object header, in file order: a revision's dictionary keys to its own object.
  const headers: { at: number; key: string }[] = [];
  if (keyed)
    for (const match of clean.matchAll(/(?:^|\s)(\d+)\s+(\d+)\s+obj\b/g))
      headers.push({
        at: (match.index ?? 0) + (match[0].startsWith(match[1] ?? "") ? 0 : 1),
        key: `${match[1]} ${match[2]}`,
      });
  let headerCursor = 0;
  let currentObject: string | null = null;
  const objectAt = (pos: number): string | null => {
    while (headerCursor < headers.length && (headers[headerCursor]?.at ?? 0) <= pos)
      currentObject = headers[headerCursor++]?.key ?? currentObject;
    return currentObject;
  };
  const addPixels = (pos: number, count: number) => {
    const key = keyed ? objectAt(pos) : null;
    if (key) {
      keyedTotal += count - (byObject.get(key) ?? 0);
      byObject.set(key, count);
    } else pixels += count;
  };
  let dictionaries = 0;
  // Each dictionary is read once, in one forward pass: hostile text inside a string cannot multiply the work.
  let unverified = false;
  let at = 0;
  for (;;) {
    const open = clean.indexOf("<<", at);
    if (open < 0) break;
    const close = dictEnd(clean, open);
    if (close < 0) break;
    at = close;
    if (++dictionaries > 8192) {
      unverified = true;
      break;
    }
    const dict = clean.slice(open, close);
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const own = topLevel(dict);
    const width = dimensionOf(own, "Width", objects);
    const height = dimensionOf(own, "Height", objects);
    if (width === null || height === null) {
      unverified = true;
      continue;
    }
    if (width <= 0 || height <= 0) {
      invalid = true;
      continue;
    }
    addPixels(open, width * height);
  }
  // Inline images: each BI dictionary is read whole, so /W and /H count in either order, with other keys between.
  for (const match of clean.matchAll(/\bBI\b([\s\S]{0,400}?)\bID\b/g)) {
    const dict = match[1] ?? "";
    const width = /\/W\s+([+-]?\d+)/.exec(dict) ?? /\/Width\s+([+-]?\d+)/.exec(dict);
    const height = /\/H\s+([+-]?\d+)/.exec(dict) ?? /\/Height\s+([+-]?\d+)/.exec(dict);
    if (!width || !height) {
      unverified = true;
      continue;
    }
    if (Number(width[1]) <= 0 || Number(height[1]) <= 0) {
      invalid = true;
      continue;
    }
    pixels += Number(width[1]) * Number(height[1]);
    if (pixels > MAX_TOTAL_IMAGE_PIXELS) return { pixels, invalid, unverified };
  }
  return { pixels: pixels + keyedTotal, invalid, unverified };
};

// The decoded-image budget, inventoried from the document's own dictionaries (plain and inside Flate
// streams, object streams included) before pdfjs decodes anything. This bounds hostile input; completeness
// itself is proven by the render passes, never by this inventory.
// Inline image data (between ID and EI) is binary: blank it before any string masking, so a parenthesis
// in pixel bytes cannot hide the dictionaries that follow it.
const blankInlineImageData = (text: string) => {
  let out = "";
  let at = 0;
  for (const span of inlineImageSpans(text)) {
    if (span.dataAt < at) continue;
    out += text.slice(at, span.dataAt) + " ".repeat(span.dataEnd - span.dataAt);
    at = span.dataEnd;
  }
  return out + text.slice(at);
};

export async function scanImageBudget(
  bytes: Uint8Array,
): Promise<{ pixels: number; invalid: boolean; unverified: boolean }> {
  const prepared = unescapeNames(maskOutsideStreams(latin1(bytes)));
  const objects = buildObjectIndex(prepared);
  let { pixels, invalid, unverified } = imageInventory(prepared, true, objects);
  if (pixels > MAX_TOTAL_IMAGE_PIXELS) return { pixels, invalid, unverified };
  const text = latin1(bytes);
  let inflatedTotal = 0;
  for (const match of text.matchAll(/stream(?:\r\n|\r|\n)/g)) {
    if (text.slice((match.index ?? 0) - 3, match.index ?? 0) === "end") continue;
    const start = (match.index ?? 0) + match[0].length;
    // An image's own stream is pixel data, never dictionaries: it is not inflated for the inventory.
    const dictText = unescapeNames(streamDict(text, match.index ?? 0));
    if (/\/Subtype\s*\/Image\b/.test(dictText)) continue;
    // The filter may itself be an indirect object holding a name or an array of names.
    const indirectFilter = /\/Filter\s+(\d+)\s+(\d+)\s+R/.exec(dictText);
    const filterSource = indirectFilter
      ? (objectText(objects, Number(indirectFilter[1]), Number(indirectFilter[2]))?.body ?? "")
      : dictText;
    const filters = indirectFilter
      ? [...filterSource.matchAll(/\/([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1] ?? "")
      : [...dictText.matchAll(/\/Filter\s*(?:\[([^\]]*)\]|\/([A-Za-z0-9]+))/g)].flatMap(
          (m) => (m[1] ?? m[2] ?? "").match(/[A-Za-z0-9]+/g) ?? [],
        );
    const chain = filters.map((f) => f.replace(/Decode$/, ""));
    const supported =
      chain.length === 0 ||
      (chain.length === 1 && (chain[0] === "Flate" || chain[0] === "ASCIIHex")) ||
      (chain.length === 2 && chain[0] === "ASCIIHex" && chain[1] === "Flate");
    if (!supported) {
      unverified = true;
      continue;
    }
    let { slice, exact } = streamSlice(text, bytes, match.index ?? 0, start, objects);
    if (!exact && text.indexOf("endstream", start) < 0) continue;
    if (chain[0] === "ASCIIHex") {
      const hex = latin1(slice).replace(/[^0-9A-Fa-f]/g, "");
      const decoded = new Uint8Array(Math.ceil(hex.length / 2));
      for (let i = 0; i < decoded.length; i++) decoded[i] = parseInt(hex.slice(i * 2, i * 2 + 2).padEnd(2, "0"), 16);
      slice = decoded;
      if (chain.length === 1) {
        const preparedSlice = unescapeNames(maskStrings(blankInlineImageData(latin1(slice))));
        const found = imageInventory(preparedSlice, false, buildObjectIndex(preparedSlice));
        pixels += found.pixels;
        invalid ||= found.invalid;
        unverified ||= found.unverified;
        if (pixels > MAX_TOTAL_IMAGE_PIXELS) return { pixels, invalid, unverified };
        continue;
      }
    }
    if (!chain.includes("Flate")) {
      // An uncompressed stream is inventoried as it stands (inline images live in content streams).
      inflatedTotal += slice.length;
      if (inflatedTotal > MAX_TOTAL_SCAN_BYTES) {
        unverified = true;
        break;
      }
      const preparedSlice = unescapeNames(maskStrings(blankInlineImageData(latin1(slice))));
      const found = imageInventory(preparedSlice, false, buildObjectIndex(preparedSlice));
      pixels += found.pixels;
      invalid ||= found.invalid;
      unverified ||= found.unverified;
      if (pixels > MAX_TOTAL_IMAGE_PIXELS) return { pixels, invalid, unverified };
      continue;
    }
    try {
      const reader = new Blob([slice.buffer as ArrayBuffer])
        .stream()
        .pipeThrough(new DecompressionStream("deflate"))
        .getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_SCAN_BYTES) {
          unverified = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
      inflatedTotal += total;
      if (inflatedTotal > MAX_TOTAL_SCAN_BYTES) {
        unverified = true;
        break;
      }
      const inflated = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        inflated.set(chunk, at);
        at += chunk.length;
      }
      const preparedInflated = unescapeNames(maskStrings(blankInlineImageData(latin1(inflated))));
      const found = imageInventory(preparedInflated, false, buildObjectIndex(preparedInflated));
      pixels += found.pixels;
      invalid ||= found.invalid;
      unverified ||= found.unverified;
      if (pixels > MAX_TOTAL_IMAGE_PIXELS) return { pixels, invalid, unverified };
    } catch {
      // Not a Flate stream: the plain inventory already covered what is readable.
    }
  }
  return { pixels, invalid, unverified };
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
  const budget = await within(scanImageBudget(source.bytes));
  if (budget.unverified)
    return {
      pages: [],
      totalPages: 0,
      rendered: 0,
      complete: false,
      reason: "an embedded image's size could not be verified",
    };
  if (budget.pixels > MAX_TOTAL_IMAGE_PIXELS)
    return {
      pages: [],
      totalPages: 0,
      rendered: 0,
      complete: false,
      reason: "the document's images are past the decoded-size budget",
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
    const opened = (await within(
      page.evaluate(
        openInPage,
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
          maxTotalImagePixels: MAX_TOTAL_IMAGE_PIXELS,
          maxPngChars: MAX_PNG_CHARS,
          cmapsB64: toBase64(new Uint8Array(cmapBin)),
          cmapIndex: CMAP_INDEX,
        },
      ),
    ).catch((error) => {
      if (error instanceof PdfUnreadable) throw error;
      throw new PdfUnreadable("operational", `the browser failed (${(error as Error).name})`);
    })) as { total?: number; error?: string; kind?: string };
    if (opened.error) {
      if (opened.error === "PasswordException") throw new PdfUnreadable("encrypted", "the PDF asks for a password");
      if (opened.error === "InvalidPDFException")
        throw new PdfUnreadable("malformed", "the file is not a readable PDF");
      throw new PdfUnreadable("operational", `the render failed (${opened.error})`);
    }
    const totalPages = opened.total ?? 0;
    const limit = Math.min(totalPages, opts.maxPages ?? MAX_PDF_PAGES);
    const pages: RenderedPage[] = [];
    const unproven = new Set<number>();
    const emptyPages: { n: number; ref: { num: number; gen: number } | undefined }[] = [];
    // Each page is persisted before the next renders, so a stall after page one loses nothing already done.
    let stopped: string | null = null;
    for (let n = 1; n <= limit; n++) {
      let rendered: Awaited<ReturnType<typeof renderPageInPage>>;
      try {
        rendered = (await within(page.evaluate(renderPageInPage, n))) as typeof rendered;
      } catch (error) {
        if (pages.length === 0) {
          if (error instanceof PdfUnreadable) throw error;
          throw new PdfUnreadable("operational", `the browser failed (${(error as Error).name})`);
        }
        stopped =
          error instanceof PdfUnreadable ? "the render timed out" : `the browser failed (${(error as Error).name})`;
        break;
      }
      if (rendered.error) {
        if (
          ["PageTooLarge", "ImageNotDecoded", "PageEncodedTooLarge", "ImageBudgetExceeded"].includes(rendered.error)
        ) {
          stopped = rendered.error;
          break;
        }
        if (pages.length === 0) throw new PdfUnreadable("operational", `the render failed (${rendered.error})`);
        stopped = `the render failed (${rendered.error})`;
        break;
      }
      if (rendered.unproven) unproven.add(n);
      if (rendered.empty) emptyPages.push({ n, ref: rendered.ref });
      let dataUrl: string;
      try {
        dataUrl = (await within(page.evaluate("window.__png"))) as string;
      } catch {
        return {
          pages,
          totalPages,
          rendered: pages.length,
          complete: false,
          reason: `reading page ${n} back failed (operational)`,
        };
      }
      if (typeof dataUrl !== "string" || dataUrl.length > MAX_PNG_CHARS) {
        stopped = "a page is past the encoded-size bound";
        break;
      }
      const body = fromBase64(dataUrl.replace(/^data:image\/png;base64,/, ""));
      let stored: Awaited<ReturnType<typeof putArtefact>>;
      try {
        stored = await within(
          putArtefact(store, caseId, "page", `page-${source.sha.slice(0, 16)}-p${n}.png`, body, "image/png"),
        );
      } catch {
        // Pages already stored stay returned; the document is stated partial, never silently whole.
        return {
          pages,
          totalPages,
          rendered: pages.length,
          complete: false,
          reason: `storing page ${n} failed (operational)`,
        };
      }
      pages.push({ key: stored.key, page: n, width: rendered.width ?? 0, height: rendered.height ?? 0 });
    }
    // An empty operator list is a refused page only when the page actually has content: a page whose own
    // content stream is empty is a valid blank page and proves itself.
    for (const { n, ref } of emptyPages) {
      const empty = ref ? await pageContentIsEmpty(source.bytes, ref) : null;
      if (empty !== true) unproven.add(n);
    }
    return {
      pages,
      totalPages,
      rendered: pages.length,
      complete: !stopped && unproven.size === 0 && !budget.invalid && totalPages <= (opts.maxPages ?? MAX_PDF_PAGES),
      reason: stopped
        ? `stopped at page ${pages.length + 1} (${stopped})`
        : unproven.size > 0
          ? "part of a page could not be rendered within the size bounds"
          : budget.invalid
            ? "an embedded image is malformed"
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
