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

// Whether bytes are a whole image of the kind they claim: the signature and the ending each format has. A cheap guard,
// not a decoder: it refuses the truncated and the mislabelled, which the browser would draw as a broken picture.
export function wholeImage(type: string, b: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const end = (...v: number[]) => v.every((x, k) => b[b.length - v.length + k] === x);
  if (b.length < 8) return false;
  if (type === "image/png") return at(0, 0x89, 0x50, 0x4e, 0x47) && end(0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
  if (type === "image/jpeg") return at(0, 0xff, 0xd8) && end(0xff, 0xd9);
  if (type === "image/gif") return at(0, 0x47, 0x49, 0x46, 0x38) && end(0x3b);
  if (type === "image/webp") return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  if (type === "image/avif") return at(4, 0x66, 0x74, 0x79, 0x70);
  if (type === "image/svg+xml") {
    const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
    return head.startsWith("<svg") || head.startsWith("<?xml");
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
  attachments?: { key: string; mediaType: string; contentId: string | null }[];
  truncated?: { mediaType: string }[];
  omitted?: number;
};
class Stopped extends Error {}

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
    const cids = new Map<string, { key: string; mediaType: string }>();
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
          cids.set(a.contentId.replace(/^<|>$/g, "").toLowerCase(), { key: a.key, mediaType: a.mediaType });
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
    // One byte budget for every image source (remote, `cid:` and `data:`), spent as the bytes are accepted.
    const spend = (bytes: number): boolean => {
      if (bytes > limits.perResourceBytes) return false;
      total += bytes;
      return true;
    };
    // Chrome does not pause `data:` images, so they are settled here, before the page is built: each is checked and
    // counted like any other image, and one that is corrupt or past the budget is replaced by a blank pixel.
    const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const dataSeen = new Map<string, string>();
    html = (html as string).replace(/data:[^"'()\s<>]+/gi, (uri) => {
      const known = dataSeen.get(uri);
      if (known !== undefined) return known;
      let outcome: keyof ImageCounts = "refused";
      const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(uri);
      if (m) {
        try {
          const raw = decodeURIComponent(m[3] ?? "");
          const bytes = m[2] ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : new TextEncoder().encode(raw);
          if (!wholeImage((m[1] ?? "").toLowerCase(), bytes)) outcome = "failed";
          else if (resources >= limits.resources || total + bytes.byteLength > limits.totalBytes) outcome = "skipped";
          else if (!spend(bytes.byteLength)) outcome = "refused";
          else {
            resources += 1;
            outcome = "loaded";
          }
        } catch {
          outcome = "failed";
        }
      }
      images[outcome] += 1;
      const kept = outcome === "loaded" ? uri : PIXEL;
      dataSeen.set(uri, kept);
      return kept;
    });
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
        const room = Math.min(limits.perResourceBytes, limits.totalBytes - total);
        if (room <= 0) {
          await res.body?.cancel().catch(() => undefined);
          return { count: "skipped" };
        }
        const body = await boundedBody(res, room);
        if (!body) return { count: room < limits.perResourceBytes ? "skipped" : "refused" };
        if (!wholeImage(type, body)) return { count: "failed" };
        if (!spend(body.byteLength)) return { count: "refused" };
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
          const art = hit ? await readArtefact(store, caseId, hit.key).catch(() => null) : null;
          if (!hit || !art || !("body" in art)) return { count: "failed" };
          if (!wholeImage(hit.mediaType, art.body)) return { count: "failed" };
          if (total + art.body.byteLength > limits.totalBytes) return { count: "skipped" };
          if (!spend(art.body.byteLength)) return { count: "refused" };
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
    for (const width of WIDTHS) {
      live();
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
      await page.setContent(html as string, { waitUntil: "networkidle0", timeout: limits.pageMs });
      live();
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
    await Promise.allSettled([cdp?.send("Fetch.disable"), page?.close()]);
    await cdp?.detach().catch(() => undefined);
  }
}
