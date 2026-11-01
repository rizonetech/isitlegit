// Email HTML rendering to a screenshot (D03 T02 §1; design spec 4.4 and 4.6a): the message as the recipient saw it,
// at a desktop and a phone width, for the vision steps and the report. The email is hostile content: its page runs no
// script, makes no request of its own (every request is answered by the Worker's fetch after the URL policy, and only
// images are answered from the network), downloads nothing, opens no second page, and is bounded in time, resources and
// size. A page problem is a result, never a throw; the caller owns the browser and this function never closes it.

import type { Browser, CDPSession, Page, Target } from "@cloudflare/puppeteer";
import { parsedKey, putArtefact, readArtefact, readVisible, type Store } from "../intake/store";
import type { Verdict } from "../walkthrough/url-policy";

export const WIDTHS = [1024, 390] as const;
export const MAX_HEIGHT = 6000;
export const LIMITS = {
  resources: 40,
  perResourceBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  resourceMs: 5_000,
  // The whole render, from its first read to its last write.
  pageMs: 25_000,
  redirects: 3,
};
const CLEANUP_MS = 3_000;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_TEXT = 200_000;

export type Shot = {
  width: number;
  name: string;
  key: string;
  sha256: string;
  bytes: number;
  pixelWidth: number;
  pixelHeight: number;
  // The page was taller than MAX_HEIGHT and the picture shows the top of it.
  cut: boolean;
};
// What became of the message's images (D03 T02 §3 reads this: a picture that lost images is a partial reading, never a
// complete one). `loaded` is an image that arrived whole and is well formed; `refused` a request the containment refused
// (a private address, a type that is not an image, a redirect chain past its bound); `failed` one that could not be read
// (a timeout, a bad answer, a missing `cid:` part, bytes that are not the image they claim to be); `skipped` one the
// render's budget left out. Anything but `loaded` is content the screenshot does not show.
export type ImageCounts = { loaded: number; refused: number; failed: number; skipped: number };
// What the message itself lost before it was drawn: a body part the parser cut, parts it left out, or text cut here.
export type SourceCut = { parts: number; omitted: number; text: boolean };
export type RenderResult =
  | {
      outcome: "rendered";
      kind: "html" | "text";
      shots: Shot[];
      images: ImageCounts;
      source: SourceCut;
      // Every image shown and nothing of the message cut.
      complete: boolean;
      ms: { first: number; total: number };
    }
  // `input-missing`: the message's stored parts are not there (distinct from an empty message, which renders);
  // `storage`: reading or writing them failed; `timeout`: the render's deadline passed; `browser`: the page failed.
  | { outcome: "failed"; reason: "input-missing" | "storage" | "timeout" | "browser" };

export type RenderDeps = {
  // The URL policy (the Worker's `allowedUrl` over DNS-over-HTTPS); a test passes one that allows its fixtures.
  policy: (raw: string) => Promise<Verdict>;
  // The Worker's fetch; a test passes a stub.
  fetch?: typeof fetch;
  limits?: Partial<typeof LIMITS>;
  now?: () => number;
};

type Paused = { requestId: string; resourceType?: string; request: { url: string } };

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const base64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
// A PNG's pixel size from its header.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// CRC-32, for the PNG chunk walk.
const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const MAX_SIDE = 30_000;

// Whether bytes are a whole, well-formed image of the kind they claim: the structure each format has, walked to its
// end (PNG: every chunk and its CRC, a header with a real size, data and an IEND; JPEG: a frame header with a real size
// and the end marker; GIF: header, size and trailer; WebP: a RIFF whose length matches; SVG: an element that closes).
// A guard, not a decoder: it refuses the truncated, the mislabelled and the empty, which the browser would draw broken.
export function wholeImage(type: string, b: Uint8Array): boolean {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sized = (w: number, h: number) => w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE;
  if (b.length < 12) return false;
  if (type === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!sig.every((v, i) => b[i] === v)) return false;
    let at = 8;
    let sawHeader = false;
    let sawData = false;
    while (at + 12 <= b.length) {
      const length = view.getUint32(at);
      const name = String.fromCharCode(
        b[at + 4] as number,
        b[at + 5] as number,
        b[at + 6] as number,
        b[at + 7] as number,
      );
      if (at + 12 + length > b.length) return false;
      if (crc32(b.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) return false;
      if (!sawHeader) {
        if (name !== "IHDR" || length !== 13 || !sized(view.getUint32(at + 8), view.getUint32(at + 12))) return false;
        sawHeader = true;
      } else if (name === "IDAT") sawData = true;
      else if (name === "IEND") return sawData && at + 12 + length === b.length;
      at += 12 + length;
    }
    return false;
  }
  if (type === "image/jpeg") {
    if (b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return false;
      const marker = b[at + 1] as number;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return false;
      const length = view.getUint16(at + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc &&
        at + 9 <= b.length
      )
        return sized(view.getUint16(at + 7), view.getUint16(at + 5));
      at += 2 + length;
    }
    return false;
  }
  if (type === "image/gif") {
    const head = String.fromCharCode(...b.subarray(0, 6));
    return (
      (head === "GIF87a" || head === "GIF89a") &&
      sized(view.getUint16(6, true), view.getUint16(8, true)) &&
      b[b.length - 1] === 0x3b
    );
  }
  if (type === "image/webp") {
    const tag = (i: number) =>
      String.fromCharCode(b[i] as number, b[i + 1] as number, b[i + 2] as number, b[i + 3] as number);
    return (
      tag(0) === "RIFF" && tag(8) === "WEBP" && view.getUint32(4, true) + 8 === b.length && /^VP8[ LX]$/.test(tag(12))
    );
  }
  if (type === "image/avif")
    return (
      String.fromCharCode(b[4] as number, b[5] as number, b[6] as number, b[7] as number) === "ftyp" &&
      /avi[fs]/.test(String.fromCharCode(...b.subarray(8, 12)))
    );
  if (type === "image/svg+xml") {
    const text = new TextDecoder()
      .decode(b.subarray(0, Math.min(b.length, MAX_TEXT)))
      .trim()
      .toLowerCase();
    return /<svg[\s>]/.test(text) && text.endsWith("</svg>");
  }
  return false;
}

// A body read to the end but never past `max`: the read stops at the bound, so a hostile endpoint cannot make the Worker
// buffer more than it allows.
async function boundedBody(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.byteLength > max ? null : whole;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// The plain-text page for a case with no HTML: the visible text in a monospace block, escaped.
export const textPage = (text: string) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#fff;color:#111"><pre style="margin:0;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word">${escapeHtml(text.slice(0, MAX_TEXT))}</pre></body>`;

type Summary = {
  html?: string | null;
  attachments?: { key: string; mediaType: string; contentId: string | null; bytes?: number }[];
  truncated?: { mediaType: string }[];
  omitted?: number;
};
class Stopped extends Error {}

// The page's own policy, on top of the interception: images from the network and `cid:` only, no `data:` image, no
// script, frame, font, connection or form target.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: cid:; style-src 'unsafe-inline'">`;

type DomNode = {
  localName?: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
};
// The distinct `data:` image sources in the parsed page, shadow trees and frames included.
async function dataImages(session: CDPSession): Promise<number> {
  const found = new Set<string>();
  const result = (await session.send("DOM.getDocument", { depth: -1, pierce: true }).catch(() => null)) as {
    root?: DomNode;
  } | null;
  const walk = (node: DomNode | undefined) => {
    if (!node) return;
    if (node.localName === "img" && node.attributes) {
      const at = node.attributes.indexOf("src");
      const src = at >= 0 ? node.attributes[at + 1] : undefined;
      if (src && /^\s*data:/i.test(src)) found.add(src);
    }
    for (const c of node.children ?? []) walk(c);
    for (const c of node.shadowRoots ?? []) walk(c);
    walk(node.contentDocument);
  };
  walk(result?.root);
  return found.size;
}

export async function renderEmail(
  browser: Browser,
  store: Store,
  caseId: string,
  deps: RenderDeps,
): Promise<RenderResult> {
  const limits = { ...LIMITS, ...deps.limits };
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const started = now();
  // The deadline covers the whole operation, reads and writes included. When it passes (or the work ends) `stopped` is
  // set, every pending fetch is aborted, and no later step creates anything.
  let stopped = false;
  const abort = new AbortController();
  const live = () => {
    if (stopped) throw new Stopped();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      stopped = true;
      abort.abort();
      resolve("timeout");
    }, limits.pageMs);
  });

  let cdp: CDPSession | undefined;
  let page: Page | undefined;
  let onTarget: ((target: Target) => void) | undefined;
  const work = (async (): Promise<RenderResult> => {
    // What the message holds: its HTML, or its visible text. A part that is not there is `input-missing`, never an empty
    // message; a message that holds nothing renders as a page saying so.
    let html: string | null = null;
    let kind: "html" | "text" = "html";
    const source: SourceCut = { parts: 0, omitted: 0, text: false };
    const cids = new Map<string, { key: string; mediaType: string; bytes: number }>();
    try {
      const parsed = await readArtefact(store, caseId, parsedKey(caseId));
      live();
      if (!parsed || !("body" in parsed)) return { outcome: "failed", reason: "input-missing" };
      const summary = JSON.parse(new TextDecoder().decode(parsed.body)) as Summary;
      source.parts = (summary.truncated ?? []).filter((t) => /^text\/(html|plain)/.test(t.mediaType)).length;
      source.omitted = summary.omitted ?? 0;
      if (typeof summary.html === "string" && summary.html.trim()) {
        if (summary.html.length > MAX_HTML) source.text = true;
        html = summary.html.slice(0, MAX_HTML);
      }
      for (const a of summary.attachments ?? [])
        if (a.contentId && /^image\//.test(a.mediaType))
          cids.set(a.contentId.replace(/^<|>$/g, "").toLowerCase(), {
            key: a.key,
            mediaType: a.mediaType,
            bytes: typeof a.bytes === "number" ? a.bytes : 0,
          });
      if (html === null) {
        const text = await readVisible(store, caseId);
        live();
        if (text === null) return { outcome: "failed", reason: "input-missing" };
        if (text.length > MAX_TEXT) source.text = true;
        html = textPage(text.trim() ? text : "(this message holds no text)");
        kind = "text";
      }
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return { outcome: "failed", reason: "storage" };
    }

    const images: ImageCounts = { loaded: 0, refused: 0, failed: 0, skipped: 0 };
    let resources = 0;
    let total = 0;
    // One byte budget for every image source (remote and `cid:`), reserved before a body is read so concurrent reads
    // cannot together hold more than the budget, and settled to the bytes actually kept.
    const reserve = (): number => {
      const room = Math.min(limits.perResourceBytes, limits.totalBytes - total);
      if (room > 0) total += room;
      return Math.max(room, 0);
    };
    const settle = (reserved: number, kept: number) => {
      total -= reserved - kept;
    };
    const opened = await browser.target().createCDPSession();
    if (stopped) {
      await opened.detach().catch(() => undefined);
      throw new Stopped();
    }
    cdp = opened;
    const session = opened;
    // Anything that is not the one page is closed at once.
    let own = false;
    onTarget = (target) => {
      if (target.type() === "other" || target.type() === "browser") return;
      if (target.type() === "page" && !own) {
        own = true;
        return;
      }
      if (target.type() === "page" && page && target === page.target()) return;
      target.page().then(
        (p) => p?.close(),
        () => undefined,
      );
    };
    browser.on("targetcreated", onTarget);
    session.on("Fetch.requestPaused", (event: Paused) => {
      void answer(session, event);
    });
    // Each image address is settled once (both captures share its answer), and counted once.
    type Settled = { type: string; body: Uint8Array } | { count: Exclude<keyof ImageCounts, "loaded"> };
    const settled = new Map<string, Promise<Settled>>();
    const fetched = async (first: string): Promise<Settled> => {
      let target = first;
      for (let hop = 0; hop <= limits.redirects; hop++) {
        const verdict = await deps.policy(target).catch(() => null);
        if (!verdict?.ok) return { count: "refused" };
        const res = await doFetch(verdict.url.href, {
          redirect: "manual",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(limits.resourceMs)]),
          headers: { accept: "image/*" },
        });
        const where = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && where) {
          await res.body?.cancel().catch(() => undefined);
          try {
            target = new URL(where, verdict.url).href;
          } catch {
            return { count: "failed" };
          }
          if (!/^https?:/i.test(target)) return { count: "refused" };
          continue;
        }
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return { count: "failed" };
        }
        const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        if (!/^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(type)) {
          await res.body?.cancel().catch(() => undefined);
          return { count: "refused" };
        }
        const room = reserve();
        if (room <= 0) {
          await res.body?.cancel().catch(() => undefined);
          return { count: "skipped" };
        }
        let body: Uint8Array | null = null;
        try {
          body = await boundedBody(res, room);
        } finally {
          settle(room, body?.byteLength ?? 0);
        }
        if (!body) return { count: room < limits.perResourceBytes ? "skipped" : "refused" };
        if (!wholeImage(type, body)) {
          settle(body.byteLength, 0);
          return { count: "failed" };
        }
        return { type, body };
      }
      return { count: "refused" };
    };
    const resolveImage = (url: string): Promise<Settled> => {
      const known = settled.get(url);
      if (known) return known;
      const made = (async (): Promise<Settled> => {
        if (url.toLowerCase().startsWith("cid:")) {
          const hit = cids.get(url.slice(4).replace(/^<|>$/g, "").toLowerCase());
          if (!hit) return { count: "failed" };
          if (resources >= limits.resources) return { count: "skipped" };
          // The stored size is known before the part is read: a part past the per-image bound is never buffered.
          if (hit.bytes > limits.perResourceBytes) return { count: "refused" };
          resources += 1;
          if (total + hit.bytes > limits.totalBytes) return { count: "skipped" };
          total += hit.bytes;
          const art = await readArtefact(store, caseId, hit.key).catch(() => null);
          if (!art || !("body" in art) || !wholeImage(hit.mediaType, art.body)) {
            total -= hit.bytes;
            return { count: "failed" };
          }
          return { type: hit.mediaType, body: art.body };
        }
        if (!/^https?:/i.test(url)) return { count: "refused" };
        if (resources >= limits.resources) return { count: "skipped" };
        resources += 1;
        try {
          return await fetched(url);
        } catch {
          return { count: "failed" };
        }
      })();
      settled.set(url, made);
      void made.then((r) => {
        if ("count" in r) images[r.count] += 1;
        else images.loaded += 1;
      });
      return made;
    };
    const answer = async (s: CDPSession, event: Paused) => {
      const block = () =>
        s
          .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
          .catch(() => undefined);
      const url = event.request.url;
      // The page itself is set from the message, not fetched: its blank document is the only document that loads.
      if (url === "about:blank") {
        await s.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
        return;
      }
      // Anything that is not an image (a script, a style sheet, a frame, a font, a form post) is refused.
      if (event.resourceType !== "Image") {
        images.refused += 1;
        await block();
        return;
      }
      const answer = await resolveImage(url);
      if (stopped) return;
      if ("count" in answer) {
        await block();
        return;
      }
      await s
        .send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: answer.type }],
          body: base64(answer.body),
        })
        .catch(() => undefined);
    };
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    live();
    await session.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
    const made = await browser.newPage();
    // A page made after the deadline passed is closed at once; the clean-up below closes the rest.
    if (stopped) {
      await made.close().catch(() => undefined);
      throw new Stopped();
    }
    page = made;
    await page.setJavaScriptEnabled(false);
    const pageSession = await page.createCDPSession().catch(() => null);
    await pageSession?.send("Emulation.setScriptExecutionDisabled", { value: true }).catch(() => undefined);
    const shots: Shot[] = [];
    let first = 0;
    let scanned = false;
    for (const width of WIDTHS) {
      live();
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
      await page.setContent(`${CSP}${html as string}`, { waitUntil: "networkidle0", timeout: limits.pageMs });
      live();
      // The page's `data:` images cannot be paused by the interception, so the policy refuses them outright (as most mail
      // clients do) and they are counted here from the parsed page, entity-decoded: each is content the picture lacks.
      if (!scanned && pageSession) {
        scanned = true;
        images.refused += await dataImages(pageSession);
      }
      // The page's height from the browser's layout, not from a script (scripts are off).
      const metrics = (await pageSession?.send("Page.getLayoutMetrics").catch(() => null)) as {
        cssContentSize?: { height: number };
        contentSize?: { height: number };
      } | null;
      const full = Math.ceil(metrics?.cssContentSize?.height ?? metrics?.contentSize?.height ?? 800);
      const cut = full > MAX_HEIGHT;
      const png = (await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(full, MAX_HEIGHT)) },
        captureBeyondViewport: true,
      })) as Uint8Array;
      live();
      const size = pngSize(png);
      const name = width === 1024 ? "desktop-1024.png" : "phone-390.png";
      const stored = await putArtefact(store, caseId, "render", name, png, "image/png");
      shots.push({
        width,
        name,
        key: stored.key,
        sha256: stored.sha256,
        bytes: stored.bytes,
        pixelWidth: size?.width ?? width,
        pixelHeight: size?.height ?? 0,
        cut,
      });
      if (!first) first = now() - started;
    }
    const sourceCut = source.parts > 0 || source.omitted > 0 || source.text;
    const complete = images.refused + images.failed + images.skipped === 0 && !sourceCut;
    return { outcome: "rendered", kind, shots, images, source, complete, ms: { first, total: now() - started } };
  })();
  work.catch(() => undefined);
  try {
    const result = await Promise.race([work, timedOut]);
    if (result === "timeout") return { outcome: "failed", reason: "timeout" };
    return result;
  } catch (error) {
    if (error instanceof Stopped) return { outcome: "failed", reason: "timeout" };
    return { outcome: "failed", reason: (error as Error).name === "StoreError" ? "storage" : "browser" };
  } finally {
    // Every exit releases what this render took: the deadline, pending fetches, the target listener, the interception,
    // the page and the session. The browser is the caller's; it is never closed here.
    stopped = true;
    abort.abort();
    if (timer) clearTimeout(timer);
    if (onTarget) browser.off("targetcreated", onTarget);
    // The clean-up has its own bound, so a stalled browser connection cannot hold the caller past the deadline.
    const cleanup = Promise.allSettled([cdp?.send("Fetch.disable"), page?.close()]).then(() =>
      cdp?.detach().catch(() => undefined),
    );
    await Promise.race([cleanup, new Promise<void>((done) => setTimeout(done, CLEANUP_MS))]);
  }
}
