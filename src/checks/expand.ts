// Redirect expansion in Browser Run (D02 T07 §2; design spec 4.3 and the risks table, link detonation). A link is followed
// in an isolated Browser Run page, never from the Worker's own network stack: one page per link, every request any target
// of the browser makes (the page, its frames, a popup, a worker) paused at a browser-wide interception and checked by the
// walkthrough lane's URL policy (`allowedUrl`: http(s) only, no port, no credentials, no IP literal, no local name, no
// name that resolves to a non-public address), a popup closed, downloads denied by the browser itself and recorded, and
// 15 seconds for a link from the moment it starts, the policy's own lookups and the page's clean-up included. The result
// is evidence for two pure checks (`link.redirects`, `link.final_domain_changed` in ./links.ts); this module is the only
// place that touches the network, and the `checks` step calls it before they run.
//
// A case's links are followed within bounds (`expansionsOf`): at most MAX_FOLLOWED distinct addresses, document links
// before images, one browser session, CASE_MS in all. Each link keeps its own outcome and the case counts what it did not
// follow and why, so an incomplete investigation is never read as a clean one.
import puppeteer, { type Browser, type CDPSession, type HTTPResponse, type Target } from "@cloudflare/puppeteer";
import { allowedUrl, dohResolve, type Resolve, type Verdict } from "../walkthrough/url-policy";
import { registrable } from "./brand-schema";

import { CASE_MS, LINK_MS, MAX_FOLLOWED } from "./expand-limits";

export { CASE_MS, LINK_MS, MAX_FOLLOWED };
// A page that navigates again on its own (a meta refresh, a script) is watched until it has been quiet this long, or this
// long in all, within the link's own time.
export const QUIET_MS = 1_000;
export const SETTLE_MS = 4_000;
// The longest address kept whole. A longer one is never cut and called whole: the link is an error ("an address was too
// long to keep"), and its host is still read from the whole address.
const MAX_ADDRESS = 8_192;
const MAX_HOPS = 20;
const MAX_FORMS = 10;
const MAX_PAGE_TEXT = 20_000;
const MAX_FRAMES = 5;
const MAX_LURES = 5;
const MAX_DESTINATIONS = 4;
const MAX_SHADOW_ROOTS = 200;
const MAX_SHOT_BYTES = 2 * 1024 * 1024;
const SHOT_MS = 3_000;
const SCAN_MS = 3_000;
export const LURE_TEXT_BELOW = 400;
// Run in each document of the settled page (D02 T07 §3). Bounded in forms, text and lure candidates; reads the browser's own
// resolved form actions (`form.action` resolves a relative or empty action and a <base>), a submit control's `formAction`
// replacing the form's.
const SCAN = String.raw`(() => {
  const MAX_FORMS = ${MAX_FORMS}, MAX_DEST = ${MAX_DESTINATIONS}, MAX_ROOTS = ${MAX_SHADOW_ROOTS}, MAX_TEXT = ${MAX_PAGE_TEXT}, MAX_LURES = ${MAX_LURES};
  const CARD = /card.?(number|no\b)|cc.?num|cvv|cvc|security.?code|expir|cc.?exp|cc.?csc/i;
  const CARD_AUTO = /^cc-(number|csc|exp)/;
  const label = (el) => [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.closest('label')?.textContent, el.labels && el.labels[0] && el.labels[0].textContent].filter(Boolean).join(' ');
  const isPassword = (i) => i.type === 'password';
  const isCard = (i) => i.type !== 'hidden' && i.type !== 'password' && (CARD_AUTO.test(i.autocomplete || '') || CARD.test(label(i)));
  // Every tree the reader sees: the document and its open shadow roots (closed ones are opened by the page-start patch).
  const roots = [document];
  let shadowCut = false;
  const collect = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) {
        if (roots.length >= MAX_ROOTS) { shadowCut = true; return; }
        roots.push(el.shadowRoot);
        collect(el.shadowRoot);
      }
    }
  };
  collect(document);
  const q = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
  const all = q('input');
  const forms = q('form');
  let formsCut = forms.length > MAX_FORMS;
  const scanned = forms.slice(0, MAX_FORMS).map((f) => {
    const own = all.filter((i) => i.form === f);
    const seen = new Set();
    const destinations = [];
    const add = (url, via) => { if (url && !seen.has(url)) { seen.add(url); destinations.push({ action: url, viaFormaction: via }); } };
    try { add(f.action, false); } catch (e) {}
    for (const c of q('button, input')) {
      if (c.form === f && c.getAttribute('formaction') !== null && (c.type === 'submit' || c.type === 'image')) {
        try { add(c.formAction, true); } catch (e) {}
      }
    }
    if (destinations.length > MAX_DEST) formsCut = true;
    return { passwordFields: own.filter(isPassword).length, cardFields: own.filter(isCard).length, destinations: destinations.slice(0, MAX_DEST) };
  });
  const loosePasswordFields = all.filter((i) => !i.form && isPassword(i)).length;
  const looseCardFields = all.filter((i) => !i.form && isCard(i)).length;
  const text = (document.body ? document.body.innerText : '').slice(0, MAX_TEXT + 1);
  const hiddenParts = [];
  let size = 0;
  for (const root of roots) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n && size <= MAX_TEXT; n = walker.nextNode()) {
    const t = (n.nodeValue || '').trim();
    if (!t) continue;
    const el = n.parentElement;
    let hide = n.nodeType === 8;
    if (!hide && el && !/^(SCRIPT|STYLE|NOSCRIPT|TITLE|HEAD)$/.test(el.tagName)) {
      const cs = getComputedStyle(el);
      hide = !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || parseFloat(cs.fontSize) < 2 || cs.color === 'rgba(0, 0, 0, 0)';
    }
    if (hide) { hiddenParts.push(t); size += t.length + 1; }
  }
  }
  const hidden = hiddenParts.join('\n').slice(0, MAX_TEXT + 1);
  const lures = [];
  let luresCut = false;
  // A candidate the reader can see and press: drawn, with a box, and not disabled.
  const actionable = (el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  if (text.length < ${LURE_TEXT_BELOW} && forms.length === 0)
    for (const el of q('a, button, [role=button]')) {
      const words = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (words && words.length <= 60 && /\b(view|open|download|review|verify|confirm|continue|access|click|sign in|log in|pay|sign)\b/i.test(words) && actionable(el)) {
        if (lures.length < MAX_LURES) lures.push({ text: words, href: el.href || null });
        else luresCut = true;
      }
    }
  return { loosePasswordFields, looseCardFields, forms: scanned, formsTotal: forms.length, formsCut, shadowRoots: roots.length - 1, shadowCut, text, hidden, lures, luresCut };
})()`;
type Raw = {
  loosePasswordFields: number;
  looseCardFields: number;
  forms: { passwordFields: number; cardFields: number; destinations: { action: string; viaFormaction: boolean }[] }[];
  formsTotal: number;
  formsCut: boolean;
  shadowRoots: number;
  shadowCut: boolean;
  text: string;
  hidden: string;
  lures: { text: string; href: string | null }[];
  luresCut: boolean;
};
const MAX_NOTES = 20;
const NOTE_CHARS = 200;
// Browser Run's own start-up and the clean-up after a link, bounded so they cannot outlast the budget they belong to.
const LAUNCH_MS = 10_000;
const TEARDOWN_MS = 2_000;

// What a page may fetch: documents and the things a landing page draws itself with. Everything else (a socket, a beacon,
// a media stream) is refused. The browser names resource types with a capital letter.
const ALLOWED_TYPES = new Set(["Document", "Script", "Stylesheet", "Image", "Font"]);

// A link as the follower reads it: its address and where it came from (`Link` in ./links.ts satisfies it; this module
// takes no Worker types, so the Node tests can load it).
export type FollowLink = { href: string; kind: string };

// Each response of the main document's chain, in order. A redirect has a `location`: the server's own, or, for a page that
// sent the browser on by itself (a meta refresh or a script), the next address, with `via: "page"`.
export type Hop = { url: string; host: string | null; status: number; location: string | null; via: "server" | "page" };
// What the settled page and its frames show (D02 T07 §3): one scan per document (the page first, then up to MAX_FRAMES child
// frames), a screenshot in transit (its bytes are stored by the checks step and dropped, only `shotKey` stays), and what
// could not be read, with the reason, so a followed link never hides an incomplete page.
export type FormScan = {
  // The fields this form holds, and the destinations it declares: its own action (resolved by the browser, `<base>` and
  // a relative or empty action included) and every submit control's `formaction`. Declared, not observed: nothing was sent.
  passwordFields: number;
  cardFields: number;
  destinations: { action: string; host: string | null; offDomain: boolean; viaFormaction: boolean }[];
};
export type Scan = {
  url: string;
  frame: boolean;
  // Fields outside any form (a script-driven page), and the forms (10 at most, 4 destinations each).
  loosePasswordFields: number;
  looseCardFields: number;
  forms: FormScan[];
  formsTotal: number;
  // Something past a bound was not read: forms past 10 or destinations past 4 on a form.
  formsCut: boolean;
  shadowRoots: number;
  shadowCut: boolean;
  text: string;
  textCut: boolean;
  hidden: string;
  hiddenCut: boolean;
  lures: { text: string; href: string | null; host: string | null }[];
  // More lure candidates than the 5 kept.
  luresCut: boolean;
};
export type Landing = {
  shot: Uint8Array | null;
  shotKey: string | null;
  scans: Scan[];
  coverage: {
    shot: "taken" | "too-large" | "timeout" | "error" | "not-stored";
    scan: "ok" | "failed";
    framesTotal: number;
    framesRead: number;
    // Closed shadow trees left after the page-start patch (declarative ones), counted through the DevTools DOM; null when
    // that could not be asked.
    closedShadows: number | null;
  };
};
export type Outcome = "done" | "blocked" | "timeout" | "error";
export type Expansion = {
  link: string;
  outcome: Outcome;
  // Why a link was not followed through or stopped early: the policy's reason, the limit, or the error's name.
  reason: string | null;
  hops: Hop[];
  // The address the page settled on, whole, and its host (read before any cut); null when it never got a response. Only a
  // `done` link's is a confirmed end: an interrupted one is the last address reached.
  final: string | null;
  finalHost: string | null;
  // The page the link settled on, read once it was `done` (null otherwise).
  landing: Landing | null;
  // Downloads the browser denied and requests the policy refused (each address at most NOTE_CHARS characters).
  downloads: string[];
  refused: { url: string; reason: string }[];
  ms: number;
};
export type Skipped = { count: number; why: "past-limit" | "time" };
export type Expansions = { items: Expansion[]; skipped: Skipped[] };

export type ExpandDeps = {
  // The URL policy; the Worker's is `allowedUrl` over DNS-over-HTTPS. A test passes one that allows its own fixture server.
  policy: (raw: string) => Promise<Verdict>;
  limitMs?: number;
  now?: () => number;
  // How long a page is watched for a further navigation of its own; a test shortens it.
  quietMs?: number;
  settleMs?: number;
  // The capture's own bounds (a screenshot's size and time, a scan's time); a test narrows them to reach each failure.
  shotMaxBytes?: number;
  shotMs?: number;
  scanMs?: number;
};

export const livePolicy = (resolve: Resolve = dohResolve()): ExpandDeps["policy"] => {
  // One answer per name for the life of the policy (a case's links share hosts).
  const memo = new Map<string, Promise<string[] | null>>();
  const cached: Resolve = (name) => {
    let answer = memo.get(name);
    if (!answer) {
      answer = resolve(name);
      memo.set(name, answer);
    }
    return answer;
  };
  return (raw) => allowedUrl(raw, cached);
};

const note = (text: string) => text.slice(0, NOTE_CHARS);
// A landing address kept to the bound (a landing address is evidence of where a form is, not of an end).
const clip = (text: string) => text.slice(0, MAX_ADDRESS);
const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
};
const errorName = (error: unknown) => (error instanceof Error ? error.name || "Error" : "Error");
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
// A promise given at most `ms`: the fallback when it is slower, and the late answer left to settle unseen.
const within = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  work.catch(() => undefined);
  return Promise.race([work, sleep(ms).then(() => fallback)]);
};

// The capabilities a page could open a connection with outside the browser's request interception.
const NO_CHANNELS =
  "for (const name of ['WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) { try { delete globalThis[name]; } catch (e) {} }";

type Page = Awaited<ReturnType<Browser["newPage"]>>;

// Closed shadow trees that remain in the page and its frames (a declarative `shadowrootmode=closed` is made by the parser, not
// by a script), counted through the DevTools DOM, which sees them; null when it could not be asked.
async function closedShadows(cdp: CDPSession): Promise<number | null> {
  type DomNode = { shadowRoots?: DomNode[]; shadowRootType?: string; children?: DomNode[]; contentDocument?: DomNode };
  try {
    const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
    let closed = 0;
    const walk = (node: DomNode) => {
      for (const shadow of node.shadowRoots ?? []) {
        if (shadow.shadowRootType === "closed") closed += 1;
        walk(shadow);
      }
      for (const child of node.children ?? []) walk(child);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    return closed;
  } catch {
    return null;
  }
}

// The settled page and its frames, read once (D02 T07 §3). Every failure is a coverage reason, never a throw.
async function readLanding(page: Page, deps: ExpandDeps): Promise<Landing> {
  const shotMax = deps.shotMaxBytes ?? MAX_SHOT_BYTES;
  const shotMs = deps.shotMs ?? SHOT_MS;
  const scanMs = deps.scanMs ?? SCAN_MS;
  const coverage: Landing["coverage"] = {
    shot: "error",
    scan: "ok",
    framesTotal: 0,
    framesRead: 0,
    closedShadows: null,
  };
  let shot: Uint8Array | null = null;
  try {
    const bytes = await within(page.screenshot({ type: "png" }) as Promise<Uint8Array | null>, shotMs, null);
    if (!bytes) coverage.shot = "timeout";
    else if (bytes.length > shotMax) coverage.shot = "too-large";
    else {
      shot = new Uint8Array(bytes);
      coverage.shot = "taken";
    }
  } catch {
    coverage.shot = "error";
  }
  const main = page.mainFrame();
  const children = page.frames().filter((f) => f !== main);
  // The scan runs in an isolated world of the page's own frame: its DOM objects and prototypes are its own, so a hostile
  // page that replaces `document.forms` or `querySelectorAll` in its world cannot change what is read.
  const cdp = await page.createCDPSession().catch(() => null);
  const inIsolatedWorld = async (frame: (typeof children)[number]): Promise<Raw | null> => {
    const frameId = (frame as unknown as { _id?: string })._id;
    if (!cdp || !frameId) return null;
    const { executionContextId } = (await cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName: "isitlegit-scan",
    })) as { executionContextId: number };
    const answer = (await cdp.send("Runtime.evaluate", {
      expression: SCAN,
      contextId: executionContextId,
      returnByValue: true,
    })) as { exceptionDetails?: unknown; result: { value?: Raw } };
    return answer.exceptionDetails ? null : (answer.result.value ?? null);
  };
  coverage.framesTotal = children.length;
  const scans: Scan[] = [];
  const toScan = async (frame: (typeof children)[number], isFrame: boolean): Promise<void> => {
    // A frame the browser could not load (its request refused, a network error) shows an error document: nothing was read.
    if (isFrame && /^(chrome-error:|about:blank$)/.test(frame.url())) return;
    let raw: Raw | null = null;
    try {
      raw = await within(inIsolatedWorld(frame), scanMs, null);
    } catch {
      raw = null;
    }
    if (!raw) {
      if (!isFrame) coverage.scan = "failed";
      return;
    }
    if (isFrame) coverage.framesRead += 1;
    const url = frame.url();
    const own = hostOf(url);
    const ownDomain = own ? (registrable(own) ?? own) : null;
    scans.push({
      url: clip(url),
      frame: isFrame,
      loosePasswordFields: raw.loosePasswordFields,
      looseCardFields: raw.looseCardFields,
      forms: raw.forms.map((f) => ({
        passwordFields: f.passwordFields,
        cardFields: f.cardFields,
        destinations: f.destinations.map((d) => {
          const host = hostOf(d.action);
          const domain = host ? (registrable(host) ?? host) : null;
          return {
            action: clip(d.action),
            host,
            offDomain: domain !== null && ownDomain !== null && domain !== ownDomain,
            viaFormaction: d.viaFormaction,
          };
        }),
      })),
      formsTotal: raw.formsTotal,
      formsCut: raw.formsCut,
      shadowRoots: raw.shadowRoots,
      shadowCut: raw.shadowCut,
      text: raw.text.slice(0, MAX_PAGE_TEXT),
      textCut: raw.text.length > MAX_PAGE_TEXT,
      hidden: raw.hidden.slice(0, MAX_PAGE_TEXT),
      hiddenCut: raw.hidden.length > MAX_PAGE_TEXT,
      luresCut: raw.luresCut,
      lures: raw.lures.map((l) => ({
        text: l.text,
        href: l.href ? clip(l.href) : null,
        host: l.href ? hostOf(l.href) : null,
      })),
    });
  };
  await toScan(main, false);
  for (const frame of children.slice(0, MAX_FRAMES)) await toScan(frame, true);
  coverage.closedShadows = cdp ? await within(closedShadows(cdp), scanMs, null) : null;
  await cdp?.detach().catch(() => undefined);
  return { shot, shotKey: null, scans, coverage };
}

// The browser asks for a page's icon by itself (CI's Chromium fetches /favicon.ico, a request of type Other, on every page):
// it is never made, and it is not a refusal worth reporting, since the page asked for nothing.
export function isBrowserIconRequest(resourceType: string | undefined, url: string): boolean {
  if (resourceType !== "Other") return false;
  try {
    return /\/favicon\.ico$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// A closed shadow root hides its content from the page's own scripts and from the scan; made through attachShadow it is
// opened here before any page script runs (the constructor is the page's only way to make one).
const OPEN_SHADOWS =
  "(() => { const attach = Element.prototype.attachShadow; Element.prototype.attachShadow = function (init) { return attach.call(this, Object.assign({}, init, { mode: 'open' })); }; })();";

type Paused = { requestId: string; frameId?: string; resourceType?: string; request: { url: string } };

// Follows one link. Never throws: a failure is the link's outcome.
export async function expandLink(browser: Browser, link: string, deps: ExpandDeps): Promise<Expansion> {
  const now = deps.now ?? Date.now;
  const started = now();
  const limit = deps.limitMs ?? LINK_MS;
  // The clean-up is inside the link's time, not on top of it: it is given a share of the limit, and the work the rest.
  const reserve = Math.min(TEARDOWN_MS, Math.floor(limit / 2));
  const workLimit = limit - reserve;
  const quiet = deps.quietMs ?? QUIET_MS;
  const settle = deps.settleMs ?? SETTLE_MS;
  const result: Expansion = {
    link,
    outcome: "done",
    reason: null,
    hops: [],
    final: null,
    finalHost: null,
    landing: null,
    downloads: [],
    refused: [],
    ms: 0,
  };
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  let cdp: CDPSession | undefined;
  let completedDownload = false;
  let ended = false;
  let ownPage = false;
  const inflight = new Set<string>();
  let cut = false;
  let unfinished = false;
  let overflowed = false;
  let failedNavigation: string | null = null;
  let blockedNavigation: string | null = null;
  // A main-frame document request begun and not yet answered or failed: a navigation still in flight.
  let pending = 0;
  const whole = (text: string) => {
    if (text.length > MAX_ADDRESS) cut = true;
    return text.slice(0, MAX_ADDRESS);
  };
  const refuse = (url: string, reason: string) => {
    if (result.refused.length < MAX_NOTES) result.refused.push({ url: note(url), reason });
  };
  const onTarget = (target: Target) => {
    // The browser's own targets (DevTools, prerendering, a worker some other page made, the browser itself) are not the
    // link's page or a popup it opened: left alone. The link's own workers cannot be made (see NO_CHANNELS), and a request
    // with no frame is refused by the interception whoever made it.
    if (target.type() === "other" || target.type() === "browser") return;
    // Anything but the link's own page (a popup, a new tab, a worker) is closed at once; its first request is refused by
    // the interception below even before it is.
    // The first page target made while the link's own page is being opened is that page.
    if (target.type() === "page" && !ownPage) {
      ownPage = true;
      return;
    }
    if (target.type() === "page" && target === page?.target()) return;
    refuse(target.url(), `a ${target.type()} was opened and closed`);
    target.page().then(
      (p) => p?.close(),
      () => undefined,
    );
  };
  const work = (async () => {
    // The first address is checked inside the link's time: a slow lookup is part of the budget.
    const first = await deps.policy(link).catch((error: unknown): Verdict => ({ ok: false, reason: errorName(error) }));
    if (!first.ok) {
      result.outcome = "blocked";
      result.reason = first.reason;
      refuse(link, first.reason);
      return;
    }
    cdp = await browser.target().createCDPSession();
    const session = cdp;
    if (ended) {
      await session.detach().catch(() => undefined);
      return;
    }
    // Every target's requests, browser-wide: a popup or a worker is paused at its first request like the page is.
    session.on("Fetch.requestPaused", (event: Paused) => {
      void (async () => {
        // A request is held here, unanswered, until its policy check is done: the ones still held when the link ends are
        // failed by the clean-up before interception is switched off (switching it off would let the browser resume them).
        inflight.add(event.requestId);
        const answer = async (send: () => Promise<unknown>) => {
          if (!inflight.delete(event.requestId)) return;
          await send();
        };
        const fail = (reason: string, quiet = false) => {
          if (!quiet) refuse(event.request.url, reason);
          // Classify at the refusing interception, using the same CDP frame identity as
          // Puppeteer's frame capture above. Child documents cannot consume main-frame state.
          const mainFrameId = (page?.mainFrame() as unknown as { _id?: string } | undefined)?._id;
          if (event.resourceType === "Document" && event.frameId && event.frameId === mainFrameId)
            blockedNavigation ??= reason;
          return answer(() =>
            session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }),
          );
        };
        try {
          if (ended) return await fail("the link had ended");
          // A request with no frame is a worker's.
          if (!event.frameId) return await fail("a worker's request");
          // The browser asks for a page's icon by itself (a request of type Other): never made, and not a refusal worth
          // reporting, since the page asked for nothing.
          if (isBrowserIconRequest(event.resourceType, event.request.url))
            return await fail("the browser's own icon request", true);
          if (!ALLOWED_TYPES.has(event.resourceType ?? ""))
            return await fail(`${event.resourceType} requests are not followed`);
          const verdict = await deps.policy(event.request.url);
          if (!verdict.ok) return await fail(verdict.reason);
          // The link may have ended while the policy was being asked: nothing is let through after that.
          if (ended) return await fail("the link had ended");
          await answer(() => session.send("Fetch.continueRequest", { requestId: event.requestId }));
        } catch {
          // The request was already gone, or the session closed under it.
        }
      })();
    });
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    // Downloads are denied by the browser itself, whatever started them, and each attempt is recorded.
    let sawDownload: () => void = () => undefined;
    const downloaded = new Promise<void>((done) => {
      sawDownload = done;
    });
    let downloadEnded: () => void = () => undefined;
    const downloadFinished = new Promise<void>((done) => {
      downloadEnded = done;
    });
    session.on("Browser.downloadWillBegin", (event: { url: string }) => {
      if (result.downloads.length < MAX_NOTES) result.downloads.push(note(event.url));
      sawDownload();
    });
    // A download that completed was not stopped: the link is an error, whatever else it did.
    session.on("Browser.downloadProgress", (event: { state: string }) => {
      if (event.state === "completed") completedDownload = true;
      if (event.state !== "inProgress") downloadEnded();
    });
    await session.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
    browser.on("targetcreated", onTarget);
    const opened = await browser.newPage();
    if (ended) {
      // Opened after the link's time was up: closed unused, never navigated.
      await opened.close().catch(() => undefined);
      return;
    }
    page = opened;
    await page.setBypassServiceWorker(true);
    await page.setViewport({ width: 1280, height: 800 });
    // A WebSocket handshake, an event stream and a worker's own connections are not requests the interception sees, so the
    // page is given none of them: the constructors are gone from every frame before any page script runs (as the contained
    // walkthrough driver does for workers). Proven by test/node/expand-browser.test.ts, whose server logs any handshake.
    await page.evaluateOnNewDocument(NO_CHANNELS);
    await page.evaluateOnNewDocument(OPEN_SHADOWS);

    let lastNavigation = now();
    page.on("framenavigated", (frame) => {
      if (frame === page?.mainFrame()) lastNavigation = now();
    });
    page.on("request", (request) => {
      if (request.resourceType() === "document" && request.frame() === page?.mainFrame()) pending += 1;
    });
    page.on("requestfailed", (request) => {
      if (request.resourceType() !== "document" || request.frame() !== page?.mainFrame()) return;
      pending = Math.max(0, pending - 1);
      // A navigation that failed (a refused destination, a reset) leaves the page on the address before it: that address is
      // not where the link ends. A download's aborted navigation is accounted for by the download itself.
      const why = request.failure()?.errorText ?? "failed";
      failedNavigation ??= why;
    });
    page.on("response", (response: HTTPResponse) => {
      const request = response.request();
      if (request.resourceType() !== "document" || request.frame() !== page?.mainFrame()) return;
      pending = Math.max(0, pending - 1);
      if (result.hops.length >= MAX_HOPS) {
        overflowed = true;
        return;
      }
      // A page that answered without a `Location` and was followed by another document sent the browser on itself.
      const before = result.hops.at(-1);
      if (before && before.location === null) {
        before.location = whole(response.url());
        before.via = "page";
      }
      const location = response.headers().location ?? null;
      result.hops.push({
        url: whole(response.url()),
        host: hostOf(response.url()),
        status: response.status(),
        location: location && whole(location),
        via: "server",
      });
    });
    try {
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: workLimit });
    } catch (error) {
      // A navigation that became a download is aborted by the browser, and its event may land just after the abort: the
      // download is the record, and an abort with no download after a short wait is a failure.
      if (!/ERR_ABORTED/.test(String(error))) throw error;
      await Promise.race([downloaded, sleep(1_000)]);
      if (result.downloads.length === 0) throw error;
      // Its end is the browser's word that nothing was saved (`canceled`), not ours.
      await Promise.race([downloadFinished, sleep(1_000)]);
    }
    // A page that moves on by itself is watched until it is quiet (or the settle time is up).
    const watching = now();
    while ((pending > 0 || now() - lastNavigation < quiet) && now() - watching < settle && !ended) await sleep(50);
    // Still moving on when the watch ended: not a confirmed end.
    // A page whose document is still arriving (headers in, body stalled) is not finished either.
    const state = await within(
      (page.evaluate("document.readyState") as Promise<string>).catch(() => "loading"),
      500,
      "loading",
    );
    if (pending > 0 || now() - lastNavigation < quiet || state === "loading") unfinished = true;
    const url = page.url();
    if (url !== "about:blank") {
      result.final = whole(url);
      result.finalHost = hostOf(url);
    }
    // A page that ended cleanly on a document is read: a screenshot and what it asks for (D02 T07 §3).
    if (
      url !== "about:blank" &&
      !unfinished &&
      !failedNavigation &&
      !overflowed &&
      !cut &&
      result.downloads.length === 0 &&
      !ended
    )
      result.landing = await readLanding(page, deps);
  })();
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<"time">((done) => {
    timer = setTimeout(() => done("time"), workLimit);
  });
  try {
    const winner = await Promise.race([work.then(() => "done" as const), timeUp]);
    if (winner === "time") {
      result.outcome = "timeout";
      result.reason = `no answer within ${Math.round(limit / 1000)} seconds`;
      // Nothing the late work does after this point may reach the network or keep a page open.
      ended = true;
    }
  } catch (error) {
    if (blockedNavigation !== null || (result.refused.length > 0 && result.hops.length === 0)) {
      result.outcome = "blocked";
      result.reason = blockedNavigation ?? result.refused[0]?.reason ?? null;
    } else {
      result.outcome = "error";
      result.reason = errorName(error);
    }
  } finally {
    clearTimeout(timer);
    ended = true;
    browser.off("targetcreated", onTarget);
    if (result.outcome === "done" && result.refused.length > 0 && result.hops.length === 0) {
      result.outcome = "blocked";
      result.reason = result.refused[0]?.reason ?? null;
    }
    // The last address reached, when the page never settled.
    if (result.final === null) {
      const last = result.hops.at(-1);
      if (last) {
        result.final = last.url;
        result.finalHost = last.host;
      }
    }
    if (result.outcome === "done" && overflowed) {
      result.outcome = "error";
      result.reason = `the chain was longer than ${MAX_HOPS} hops`;
    }
    // A policy refusal is already known even if the browser has not delivered requestfailed yet.
    if (result.outcome === "done" && blockedNavigation !== null) {
      result.outcome = "blocked";
      result.reason = blockedNavigation;
    }
    if (result.outcome === "done" && unfinished) {
      result.outcome = "timeout";
      result.reason = "the page was still moving on when the time was up";
    }
    // A download's aborted navigation is accounted for by the download itself (its event may land after the failure).
    const seen = failedNavigation as string | null;
    const failed = seen !== null && /ERR_ABORTED/.test(seen) && result.downloads.length > 0 ? null : seen;
    if (result.outcome === "done" && failed) {
      // The page's next navigation was refused or failed: the end is not confirmed. A refused destination is a refusal.
      result.outcome = blockedNavigation !== null ? "blocked" : "error";
      result.reason = blockedNavigation ?? `a navigation failed (${failed.replace(/^net::/, "")})`;
    }
    if (result.outcome === "done" && cut) {
      result.outcome = "error";
      result.reason = "an address was too long to keep whole";
    }
    if (completedDownload) {
      result.outcome = "error";
      result.reason = "a download was not stopped";
    }
    await within(
      (async () => {
        // Interception stays on until the page is closed: what is still held is failed first (switching interception off
        // resumes held requests), anything that arrives meanwhile is failed because the link has ended, and only then is it
        // switched off, so a link that has ended can neither let a request through nor fail a later link's.
        await Promise.allSettled(
          [...inflight].map((id) => {
            inflight.delete(id);
            return cdp?.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" });
          }),
        );
        await Promise.allSettled([page?.close()]);
        await Promise.allSettled([cdp?.send("Fetch.disable")]);
        await cdp?.detach().catch(() => undefined);
      })(),
      reserve,
      undefined,
    );
    result.ms = now() - started;
  }
  return result;
}

// The distinct http(s) addresses of a case's links worth following, in order: document links, then images.
export function followable(links: FollowLink[]): string[] {
  const rank = (kind: string) => (kind === "image" ? 1 : 0);
  const seen = new Set<string>();
  const out: { href: string; rank: number }[] = [];
  for (const link of links) {
    if (!/^https?:\/\//i.test(link.href) || seen.has(link.href)) continue;
    seen.add(link.href);
    out.push({ href: link.href, rank: rank(link.kind) });
  }
  return out.sort((a, b) => a.rank - b.rank).map((l) => l.href);
}

// A case's links followed within bounds. `browser` is the caller's (and closed by the caller). `begun` is when the case's
// clock started (before the browser did), so launch time counts.
export async function expansionsOf(
  browser: Browser,
  links: FollowLink[],
  deps: ExpandDeps,
  begun?: number,
): Promise<Expansions> {
  const now = deps.now ?? Date.now;
  const started = begun ?? now();
  const all = followable(links);
  const items: Expansion[] = [];
  let timeSkipped = 0;
  for (const [index, href] of all.slice(0, MAX_FOLLOWED).entries()) {
    // The close of the session is inside the case's time too.
    const left = CASE_MS - TEARDOWN_MS - (now() - started);
    if (left <= 0) {
      timeSkipped = Math.min(all.length, MAX_FOLLOWED) - index;
      break;
    }
    items.push(await expandLink(browser, href, { ...deps, limitMs: Math.min(deps.limitMs ?? LINK_MS, left) }));
  }
  const skipped: Skipped[] = [];
  if (timeSkipped) skipped.push({ count: timeSkipped, why: "time" });
  if (all.length > MAX_FOLLOWED) skipped.push({ count: all.length - MAX_FOLLOWED, why: "past-limit" });
  return { items, skipped };
}

// The checks step's entry: the case's links followed in one Browser Run session, closed whatever happens. Null when
// following was unavailable (no binding, or the session could not start in time), never for a case that simply has no
// links. The case's clock starts here, so the session's start-up and its close are inside CASE_MS.
export async function followLinks(
  binding: Parameters<typeof puppeteer.launch>[0] | undefined,
  links: FollowLink[],
  deps: ExpandDeps,
): Promise<Expansions | null> {
  if (followable(links).length === 0) return { items: [], skipped: [] };
  if (!binding) return null;
  const now = deps.now ?? Date.now;
  const begun = now();
  const launching = puppeteer.launch(binding).catch(() => null);
  const browser = await within(launching, LAUNCH_MS, null);
  if (!browser) {
    // A session that opens after its time is closed unseen.
    void launching.then((late) => late?.close().catch(() => undefined));
    return null;
  }
  try {
    return await expansionsOf(browser, links, deps, begun);
  } finally {
    await within(
      browser.close().catch(() => undefined),
      TEARDOWN_MS,
      undefined,
    );
  }
}
