// The contained walkthrough driver (D04 T02 §3; design spec 4.4a; AGENTS.md safety contract: "the walkthrough is
// contained by the driver, not the model"). Muse Wonder (§4) proposes actions; this driver decides what happens:
//
//   - Every request any target of the browser makes (the walk's page, its frames, a popup, a worker) is paused at a
//     browser-wide interception, checked by the URL policy (./url-policy.ts) and, when allowed, performed by the
//     Worker's own `fetch`, whose answer the browser receives; redirects come back to the browser one hop at a time
//     and are checked again. The Worker owns every connection, so what was checked is what is reached.
//   - At most LIMITS.steps attempts (refused ones count) and LIMITS.ms of wall clock from `open`: a timer closes the
//     whole browser when the time is up, whatever is pending.
//   - Typing is allowed only for the case's canary values (§2); keys only from an allowlist (no modifiers, so no
//     clipboard); a click on a link or form that would leave http(s) (`javascript:`, `file:`, `data:`) is refused
//     before it happens; downloads are denied by the browser and logged; a popup is closed and, when its address passes
//     the policy, followed in the walk's page; workers cannot be constructed and a service worker is stopped.
//   - Every attempt and walk event is a `walkthrough_actions` row (migration 0050); every screenshot is a `page`
//     artefact. Typed text is never stored.
//
// The model's tools are our own function tools (this file's TODO preamble: Meta's API refuses the native computer tool),
// named as in spec 4.4a with the argument shapes of Meta's cookbook (`03_use_cases/12_computer_use`).
import type { Browser, CDPSession, Page, Target } from "@cloudflare/puppeteer";
import { z } from "zod";
import { registrable } from "../checks/brand-schema";
import { hasInstruction } from "../checks/instruction-words";
import { putArtefact, type Store } from "../intake/store";
import {
  atOperation,
  DriverDiagnostic,
  DriverFailure,
  type DriverOperation,
  driverDiagnostic,
  HandledDriverDiagnostics,
} from "./diagnostics";
import { MAX_VIEW_TEXT } from "./limits";
import { allowedUrl, type Resolve } from "./url-policy";

export const LIMITS = { steps: 8, ms: 60_000 } as const;
export const VIEWPORT = { width: 1280, height: 800 } as const;
// In the guard's world: the page's text nodes, through open shadow roots and same-origin frames, judged as rendered.
// Visible means drawn where the reader looks: a point of the text inside the viewport whose topmost element is the
// text's own (the browser's hit test applies clip-path, overflow clipping, masks and covering elements), not
// transparent, not under 2 px and not the colour of its background. Hidden (evidence): not displayed, invisible, no box,
// above or left of the page, clipped or covered, or any of those styles; and comments. Text below or beside the
// viewport is neither: a later view, after a scroll, judges it. Bounded in characters and spans.
const READ_PAGE = `(() => {
  const MAX_TEXT = 200000, MAX_SPANS = 200, MAX_SPAN = 2000;
  const visible = [];
  const hidden = [];
  let omitted = 0, size = 0;
  const clear = (c) => !c || c === "transparent" || /rgba\\([^)]*,\\s*0\\)$/.test(c);
  const up = (n) => n.parentElement || (n.getRootNode() && n.getRootNode().host) || null;
  const background = (el) => {
    for (let n = el; n && n.nodeType === 1; n = up(n)) {
      const c = getComputedStyle(n).backgroundColor;
      if (!clear(c)) return c;
    }
    return "rgb(255, 255, 255)";
  };
  // "visible", "elsewhere" (outside the viewport, judged later) or the reason it is hidden.
  const judge = (node, parent, view) => {
    if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) {
      const cs = getComputedStyle(parent);
      return cs.display === "none" ? "display:none" : cs.visibility !== "visible" ? "visibility:hidden" : "opacity";
    }
    const cs = getComputedStyle(parent);
    if (parseFloat(cs.fontSize) < 2) return "font-size";
    if (clear(cs.color)) return "opacity";
    if (cs.color === background(parent)) return "color-match";
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1);
    if (!rects.length) return "collapsed";
    const win = node.ownerDocument.defaultView;
    if (rects.every((r) => r.right + win.scrollX <= 0 || r.bottom + win.scrollY <= 0)) return "off-screen";
    const root = node.getRootNode();
    let inView = false;
    for (const r of rects) {
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5]]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= view.w || y >= view.h) continue;
        inView = true;
        const hit = (root.elementFromPoint ? root : node.ownerDocument).elementFromPoint(x, y);
        if (hit && (hit === parent || parent.contains(hit))) return "visible";
      }
    }
    return inView ? "clipped" : "elsewhere";
  };
  const keep = (text, reason) => {
    if (hidden.length >= MAX_SPANS) { omitted++; return; }
    hidden.push({ text: text.slice(0, MAX_SPAN), reason });
  };
  const walk = (root, view) => {
    const doc = root.ownerDocument || root;
    const it = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 1) {
        if (n.shadowRoot) walk(n.shadowRoot, view);
        if (/^(IFRAME|FRAME)$/.test(n.tagName)) {
          let d = null;
          try { d = n.contentDocument; } catch (e) {}
          if (d && d.documentElement) walk(d.documentElement, { w: d.defaultView.innerWidth, h: d.defaultView.innerHeight });
        }
        continue;
      }
      const text = n.data.replace(/\\s+/g, " ").trim();
      if (!text) continue;
      if (n.nodeType === 8) { keep(text, "comment"); continue; }
      const parent = n.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(parent.tagName)) continue;
      const verdict = judge(n, parent, view);
      if (verdict === "visible") { if (size < MAX_TEXT) { visible.push(text); size += text.length + 1; } }
      else if (verdict !== "elsewhere") keep(text, verdict);
    }
  };
  walk(document.documentElement, { w: innerWidth, h: innerHeight });
  return { visible: visible.join(" "), hidden, omitted };
})()`;

// The most fields a final read-back reads (`filled`).
const MAX_INPUTS = 2_000;
// The largest response the walk takes, and the longest a single request may take.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_MS = 15_000;

export const KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
] as const;

const X = z
  .int()
  .min(0)
  .max(VIEWPORT.width - 1);
const Y = z
  .int()
  .min(0)
  .max(VIEWPORT.height - 1);
export const Action = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("click"), x: X, y: Y }),
  z.strictObject({ tool: z.literal("double_click"), x: X, y: Y }),
  z.strictObject({ tool: z.literal("move"), x: X, y: Y }),
  z.strictObject({ tool: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.int().min(1).max(10) }),
  z.strictObject({ tool: z.literal("type"), text: z.string().max(200) }),
  z.strictObject({ tool: z.literal("keypress"), key: z.enum(KEYS) }),
  z.strictObject({ tool: z.literal("wait"), ms: z.int().min(100).max(3000) }),
  z.strictObject({ tool: z.literal("screenshot") }),
]);
export type Action = z.infer<typeof Action>;

// What a lookup answers for a frame it cannot look into.
const FRAME = "frame:";
// In the page: where activating `el` would go. A link's address (an SVG link's too), a submit control's effective
// action (its own `formaction` attribute, else its form's action: the `formAction` getter falls back to the document's
// address, which is not where the form goes), a label's submit control, and with `enter` a field's form. A frame
// element is FRAME. Ancestors are walked across shadow roots.
const TARGET_OF = `function targetOf(el, enter) {
  if (!el) return null;
  if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName)) return "${FRAME}";
  const submits = (c) => !!c && !!c.form && /^(submit|image)$/i.test(c.type || "");
  const action = (c) => (c.hasAttribute("formaction") ? c.formAction : c.form.action);
  for (let n = el; n; n = n.parentNode || n.host || null) {
    if (n.nodeType !== 1) continue;
    const href = /^(a|area)$/i.test(n.localName) && (n.getAttribute("href") ?? n.getAttributeNS("http://www.w3.org/1999/xlink", "href"));
    if (href !== false && href !== null) {
      try { return new URL(href, n.baseURI).href; } catch (e) { return "invalid:"; }
    }
    if (submits(n)) return action(n);
    if (n.localName === "label" && submits(n.control)) return action(n.control);
  }
  // Enter in a field submits its form through the form's default button (the first submit control), so that button's
  // own action counts.
  if (enter && el.form) {
    const submitter = Array.from(el.form.elements).find(submits);
    return submitter ? action(submitter) : el.form.action;
  }
  return null;
}`;

export type Outcome = "done" | "refused" | "limit" | "error";
// `screenshotKey` is absent when no screenshot was stored (withheld: it may have shown the canary password).
export type Result = {
  outcome: Outcome;
  reason?: string;
  diagnostic?: DriverDiagnostic;
  screenshot: Uint8Array | null;
  screenshotKey?: string | undefined;
};
export type Canary = { username: string; password: string };
// What a walk saw and sent, in one sequence (D04 T02 §5), for its evidence: every screenshot's page, every request that
// carried a canary value (field names and where it went, never the values), every hidden span with its page. Canary
// values are removed from every address before anything leaves the driver.
export type WalkPage = {
  seq: number;
  url: string;
  // Null when the screenshot was withheld: it may have shown the canary password.
  screenshotKey: string | null;
  // The record's sequence number when its capture began: a page began after a request was answered only if this is
  // at least that request's `deliveredAt`.
  began: number;
  asksPassword: boolean | null;
  failure: boolean | null;
  // Text that specifically refuses the credentials (not a generic error or challenge); absent on older records.
  refusal?: boolean | null;
  withheld?: true;
};
// `asksPassword` and `failure` are null when the read was cut short by a bound and found nothing: a "no" from a read
// that stopped early is not a "no".
type PageSnapshot = {
  url: string;
  asksPassword: boolean | null;
  failure: boolean | null;
  refusal: boolean | null;
  echo: boolean;
};
export type Submission = {
  seq: number;
  fromPage: number | null;
  url: string;
  domain: string | null;
  method: string;
  fields: string[];
  state: "blocked" | "failed" | "delivered";
  status?: number;
  // The record's sequence number when the answer arrived (delivered only).
  deliveredAt?: number;
};
export type HiddenSpan = { text: string; reason: string; instruction: boolean; page: number | null; key: string };
// `omitted` counts what the record's bounds left out, so a cut is said, never silent.
export type WalkRecord = {
  pages: WalkPage[];
  submissions: Submission[];
  hidden: HiddenSpan[];
  omitted: { pages: number; submissions: number; hidden: number };
};
const MAX_RECORD = 200;
const FACTS_MS = 2_000;
// What a page read inspects at most: fields read for the password, characters of text. A page past either is not
// certified clear (its screenshot is withheld).
const MAX_FIELDS = 200;
const MAX_PAGE_TEXT = 1_000_000;
const MAX_SPAN_TEXT = 300;
// A page that answers a sign-in with one of these said no, or asked again.
const FAILURE_WORDS = /\b(incorrect|invalid|wrong|try again|failed|error|captcha|verify you are human)\b/i;
// Words that specifically refuse the submitted credentials, as distinct from a generic error or an anti-bot
// challenge: a 403 corroborated only by these is a credential refusal (D04 T02 §8).
const REFUSAL_WORDS = /\b(incorrect|invalid|wrong|not confirmed|does not match|not recognised|not recognized)\b/i;

// What the page shows now (D04 T02 §4): its screenshot when asked for, and its visible text; the hidden text found on it
// is stored as an artefact before the view returns (`hiddenKey`), never handed on.
export type View = {
  outcome: "done" | "limit" | "error";
  reason?: string;
  diagnostic?: DriverDiagnostic;
  screenshot: Uint8Array | null;
  screenshotKey?: string | undefined;
  text: string;
  hiddenKey?: string;
};

export type OpenOptions = {
  caseId: string;
  walkId: string;
  canary: Canary;
  startUrl: string;
  store: Store;
  // The Worker's `fetch`: every request the browser makes is performed through it.
  fetch?: typeof fetch;
  resolve: Resolve;
  limits?: { steps: number; ms: number };
};

class TimeUp extends Error {
  override name = "TimeUp";
}

type Paused = {
  requestId: string;
  frameId?: string;
  resourceType?: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
};

type HandledOperation = "frames.read" | "containment.popup-close";

export class Driver {
  // First failure of each handled operation, at most two; carried by existing later rows, never a new write.
  private readonly handled = new Map<HandledOperation, DriverDiagnostic>();
  private attempts = 0;
  private seq = 0;
  private views = 0;
  private walkRecord: WalkRecord = {
    pages: [],
    submissions: [],
    hidden: [],
    omitted: { pages: 0, submissions: 0, hidden: 0 },
  };
  private recordSeq = 0;
  private readonly started = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeUp: Promise<never>;
  private signalTimeUp: () => void = () => undefined;
  private page: Page | undefined;
  private pageCdp: CDPSession | undefined;
  private walkFrames = new Set<string>();
  private browserCdp: CDPSession | undefined;
  // Pages a page of the walk opened (a popup or new tab, `noopener` or not), still open.
  private popups = new Set<string>();
  // A popup's address that passed the policy, followed in the walk's page by the next step of `execute`.
  private follow: string | undefined;
  // Requests refused while the current action ran, logged on it.
  private blocked: string[] = [];
  private ending: Promise<void> | undefined;
  // Aborted when the walk ends: no request the walk had begun reaches the network after it.
  private readonly stopped = new AbortController();
  ended: { outcome: Outcome; reason: string; diagnostic?: DriverDiagnostic } | undefined;

  private constructor(
    private readonly browser: Browser,
    private readonly o: Required<Pick<OpenOptions, "fetch" | "limits">> & OpenOptions,
  ) {
    this.timeUp = new Promise<never>((_, reject) => {
      this.signalTimeUp = () => reject(new TimeUp("time"));
    });
    this.timeUp.catch(() => undefined);
  }

  // Opens the walk: the clock starts here, before anything else can stall.
  static async open(browser: Browser, options: OpenOptions): Promise<Driver> {
    // Worker-native fetch requires its global receiver, not the options object used by interception.
    const driver = new Driver(browser, {
      ...options,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      limits: options.limits ?? LIMITS,
    });
    driver.timer = setTimeout(() => {
      driver.signalTimeUp();
      void driver.end("limit", "time");
    }, driver.o.limits.ms);
    try {
      await driver.bounded(driver.setUp());
      const verdict = await driver.bounded(
        atOperation("policy.start", () => allowedUrl(options.startUrl, options.resolve)),
      );
      if (!verdict.ok) {
        await atOperation("record.refusal", () =>
          driver.record("request", { url: options.startUrl }, "refused", verdict.reason),
        );
        await driver.end("refused", `start URL refused: ${verdict.reason}`);
        return driver;
      }
      await driver.bounded(driver.navigate(verdict.url.href));
    } catch (error) {
      await driver.fail(error);
    }
    return driver;
  }

  private async setUp() {
    // Every target's requests, browser-wide: a popup or a worker is paused at its first request like the page is.
    const cdp = await atOperation("setup.browser-session", () => this.browser.target().createCDPSession());
    this.browserCdp = cdp;
    // A popup is known by its opener at creation, even a `noopener` one (`target=_blank`), which Puppeteer reports with
    // no opener. Its main frame's id is its target id.
    cdp.on("Target.targetCreated", (event: { targetInfo: { targetId: string; type: string; openerId?: string } }) => {
      const target = event.targetInfo;
      if (target.type === "page" && target.openerId) this.popups.add(target.targetId);
    });
    await atOperation("setup.discover-targets", () => cdp.send("Target.setDiscoverTargets", { discover: true }));
    cdp.on("Fetch.requestPaused", (event: Paused) => {
      this.answer(cdp, event).catch((error) => void this.fail(error, "interception.request"));
    });
    await atOperation("setup.interception", () =>
      cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }),
    );
    // Downloads are denied by the browser itself, whatever started them (an attachment header, an `<a download>`
    // link, a page-made Blob), and each attempt is recorded.
    cdp.on("Browser.downloadWillBegin", (event: { url: string }) => {
      this.refuse(`${event.url.slice(0, 200)}`, "download refused");
    });
    await atOperation("setup.download-denial", () =>
      cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }),
    );
    this.browser.on("targetcreated", (target) => {
      this.contain(target).catch((error) => void this.fail(error, "containment.target"));
    });
    const page = await atOperation("setup.new-page", () => this.browser.newPage());
    this.page = page;
    await atOperation("setup.viewport", () => page.setViewport(VIEWPORT));
    await atOperation("setup.service-worker-bypass", () => page.setBypassServiceWorker(true));
    // No page or frame of the walk can start a worker: the constructors are gone before any page script runs. A worker
    // that starts anyway is stopped by `contain`.
    await atOperation("setup.worker-guard", () =>
      page.evaluateOnNewDocument(
        "for (const name of ['Worker', 'SharedWorker']) { try { delete globalThis[name]; } catch (e) {} }",
      ),
    );
    const pageCdp = await atOperation("setup.page-session", () => page.createCDPSession());
    this.pageCdp = pageCdp;
    // The click guard's hit test (`DOM.getNodeForLocation`) needs the DOM domain.
    await atOperation("setup.dom", () => pageCdp.send("DOM.enable"));
    await this.refreshFrames();
  }

  private async refreshFrames() {
    const pageCdp = this.pageCdp;
    if (!pageCdp) return;
    type Tree = { frame: { id: string }; childFrames?: Tree[] };
    const { frameTree } = (await atOperation("frames.read", () => pageCdp.send("Page.getFrameTree"))) as {
      frameTree: Tree;
    };
    const ids = new Set<string>();
    const walk = (t: Tree) => {
      ids.add(t.frame.id);
      for (const c of t.childFrames ?? []) walk(c);
    };
    walk(frameTree);
    this.walkFrames = ids;
  }

  // A paused request: checked, then answered by the Worker's fetch, or refused.
  private async answer(cdp: CDPSession, event: Paused) {
    // A request carrying a canary value is a submission: recorded at once (blocked until it is delivered).
    const submission = this.submission(event);
    const fail = (reason: string, diagnostic?: DriverDiagnostic) => {
      this.refuse(event.request.url.slice(0, 200), reason, diagnostic);
      // A refused navigation is answered with an empty 204, on which a browser stays on the page it was showing (no
      // error page); any other refused request fails.
      if (event.resourceType === "Document")
        return cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204, responseHeaders: [] });
      return cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
    };
    if (this.ended) return fail("the walk has ended");
    // Only the walk's own page and its frames may reach the network; a popup or a stray target is refused here and
    // closed by `contain`.
    // A request with no frame is a worker's: refused, so a worker can reach nothing.
    if (!event.frameId) return fail("a worker's request");
    if (!this.walkFrames.has(event.frameId)) {
      await this.refreshFrames().catch((error) => this.rememberHandled("frames.read", error));
      if (!this.walkFrames.has(event.frameId)) {
        // A popup's or new tab's first navigation: the popup never loads and is closed; its address is followed in the
        // walk's own page when the policy allows it.
        if (event.resourceType === "Document") {
          const verdict = await atOperation("policy.request", () => allowedUrl(event.request.url, this.o.resolve));
          if (this.ended) return fail("the walk has ended");
          if (verdict.ok) {
            await this.record(
              "popup",
              { url: verdict.url.href.slice(0, 200) },
              "done",
              "popup followed in the walk's page",
            );
            this.follow = verdict.url.href;
          } else {
            await this.record("popup", { url: event.request.url.slice(0, 200) }, "refused", verdict.reason);
          }
          await fail(verdict.ok ? "popup followed in the walk's page" : `popup: ${verdict.reason}`);
          return this.closePopup(event.frameId);
        }
        return fail("not the walk's page");
      }
    }
    const verdict = await atOperation("policy.request", () => allowedUrl(event.request.url, this.o.resolve));
    // A name resolved after the walk ended reaches nothing: the end is checked again before any connection.
    if (this.ended) return fail("the walk has ended");
    if (!verdict.ok) return fail(verdict.reason);
    const headers = new Headers();
    for (const [name, value] of Object.entries(event.request.headers))
      if (!/^(host|content-length|connection)$/i.test(name)) headers.set(name, value);
    let answer: Response;
    try {
      answer = await this.o.fetch(verdict.url.href, {
        method: event.request.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(REQUEST_MS)]),
        ...(event.request.postData !== undefined && !/^(GET|HEAD)$/.test(event.request.method)
          ? { body: event.request.postData }
          : {}),
      });
    } catch (error) {
      // One request that cannot be made is refused; the walk goes on.
      if (submission) submission.state = "failed";
      const diagnostic = driverDiagnostic("interception.fetch", error);
      return fail(`the request failed (${diagnostic.category})`, diagnostic);
    }
    if (submission) {
      submission.state = "delivered";
      submission.status = answer.status;
    }
    // A download is never delivered: the browser gets an empty answer, and the walk records the refusal.
    if (/^\s*attachment/i.test(answer.headers.get("content-disposition") ?? "")) {
      this.refuse(verdict.url.href.slice(0, 200), "download refused");
      await answer.body?.cancel();
      return cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204, responseHeaders: [] });
    }
    const body = await atOperation("interception.body", () => readCapped(answer, MAX_RESPONSE_BYTES));
    if (body === null) return fail(`the answer is over ${MAX_RESPONSE_BYTES} bytes`);
    const responseHeaders: { name: string; value: string }[] = [];
    answer.headers.forEach((value, name) => {
      if (name !== "set-cookie" && name !== "content-encoding" && name !== "content-length")
        responseHeaders.push({ name, value });
    });
    for (const cookie of answer.headers.getSetCookie()) responseHeaders.push({ name: "set-cookie", value: cookie });
    await atOperation("interception.fulfill", () =>
      cdp.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: answer.status,
        responseHeaders,
        body: Buffer.from(body).toString("base64"),
      }),
    );
    // Answered only now: its whole body was read and handed to the browser. A page captured before this saw, at most,
    // a screen waiting for the answer (the headers alone are not the answer).
    if (submission) submission.deliveredAt = ++this.recordSeq;
  }

  private async closePopup(targetId: string) {
    if (!this.popups.delete(targetId)) return;
    await this.browserCdp
      ?.send("Target.closeTarget", { targetId })
      .catch((error) => this.rememberHandled("containment.popup-close", error));
  }

  // A popup that never navigated (an `about:blank` one a page writes into) is closed before the next action runs; one
  // that navigated was closed when its first request was decided.
  private async closePopups() {
    for (const id of [...this.popups]) await this.closePopup(id);
  }

  // The walk's page goes where an allowed popup would have, inside `execute`, never beside its screenshot.
  private async followPopup() {
    const url = this.follow;
    if (!url) return;
    this.follow = undefined;
    await this.navigate(url);
  }

  // A new worker target. Pages are not handled here: a popup is closed by its first request or by `closePopups`.
  private async contain(target: Target) {
    const type = target.type();
    if (type === "browser" || type === "other" || type === "page" || this.ended) return;
    // A worker of any kind is stopped where it runs, and recorded.
    let diagnostic: DriverDiagnostic | undefined;
    const failed = (operation: DriverOperation, error: unknown) => {
      diagnostic ??= driverDiagnostic(operation, error);
    };
    const session = await target.createCDPSession().catch((error) => {
      failed("containment.session", error);
      return null;
    });
    await session?.send("Runtime.terminateExecution").catch((error) => failed("containment.terminate", error));
    await session?.detach().catch((error) => failed("containment.detach", error));
    await this.record("popup", { target: type, ...(diagnostic ? { diagnostic } : {}) }, "refused", `${type} stopped`);
  }

  // A refused request or download: kept for the current action's answer and recorded at once as its own row, so a
  // refusal during loading or between actions is never lost.
  private refuse(what: string, reason: string, diagnostic?: DriverDiagnostic) {
    this.blocked.push(`${what}: ${reason}`);
    // A refusal that cannot be recorded ends the walk like any other failed write: no later action answers `done`.
    void this.record(
      "request",
      { url: what, ...(diagnostic ? { diagnostic: DriverDiagnostic.parse(diagnostic) } : {}) },
      "refused",
      reason,
    ).catch((error) => this.fail(error, "record.refusal"));
  }

  private async navigate(url: string) {
    const page = this.need();
    await atOperation("navigation.goto", () =>
      page.goto(url, { timeout: REQUEST_MS, waitUntil: "load" }).catch((error: Error) => {
        if (!/net::ERR_BLOCKED_BY_CLIENT|ERR_FAILED/.test(error.message)) throw error;
      }),
    );
    await this.refreshFrames();
  }

  private need(): Page {
    if (!this.page) throw new Error("the walk has no page");
    return this.page;
  }

  // A promise cut short when the wall clock runs out.
  private bounded<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.timeUp]);
  }

  // Runs one proposed action, whatever the model sent. Every outcome has its row, and every write is inside the
  // failure handling and the wall clock: a late write never turns into `done`.
  async execute(input: unknown): Promise<Result> {
    if (this.ended)
      return {
        outcome: this.ended.outcome === "error" ? "error" : "limit",
        reason: this.ended.reason,
        ...this.failureMetadata(),
        screenshot: null,
      };
    this.attempts++;
    const began = Date.now();
    const kept = summary(input, this.o.canary);
    this.blocked = [];
    try {
      // Nothing touches the page before the step limit and the action's shape are checked.
      if (this.attempts > this.o.limits.steps) {
        await this.bounded(this.record("action", kept, "limit", "steps"));
        await this.end("limit", "steps");
        return { outcome: "limit", reason: "steps", screenshot: null };
      }
      await this.bounded(this.closePopups());
      const parsed = Action.safeParse(input);
      if (!parsed.success) {
        const reason = `invalid: ${parsed.error.issues[0]?.message ?? "not an action"}`.slice(0, 300);
        await this.bounded(this.record("action", kept, "refused", reason));
        return { outcome: "refused", reason, screenshot: null };
      }
      const action = parsed.data;
      // A popup the page opened after the last action returned: the walk follows it now, and this action, chosen on
      // the page before it, does not run. The answer is the followed page.
      if (this.follow) {
        await this.bounded(this.followPopup());
        const reason = "a popup was followed first; the action did not run";
        const shot = await this.bounded(atOperation("view.screenshot", () => this.shoot()));
        await this.bounded(this.record("action", kept, "refused", reason, shot.key, Date.now() - began));
        return { outcome: "refused", reason, screenshot: shot.bytes, screenshotKey: shot.key };
      }
      const refusal = await this.bounded(this.refusal(action));
      if (refusal) {
        const shot = await this.bounded(atOperation("view.screenshot", () => this.shoot()));
        await this.bounded(this.record("action", kept, "refused", refusal, shot.key, Date.now() - began));
        return { outcome: "refused", reason: refusal, screenshot: shot.bytes, screenshotKey: shot.key };
      }
      await this.bounded(this.run(action));
      await this.bounded(this.followPopup());
      await this.bounded(this.refreshFrames());
      const shot = await this.bounded(atOperation("view.screenshot", () => this.shoot()));
      const reason = this.blocked.length ? `blocked: ${this.blocked.join("; ")}`.slice(0, 500) : undefined;
      await this.bounded(this.record("action", kept, "done", reason, shot.key, Date.now() - began));
      return { outcome: "done", ...(reason ? { reason } : {}), screenshot: shot.bytes, screenshotKey: shot.key };
    } catch (error) {
      if (error instanceof TimeUp || this.endReason() === "time") {
        await this.ending;
        // The attempt the clock cut short keeps its row, with no screenshot.
        await this.record("action", kept, "limit", "time", undefined, Date.now() - began).catch(() => undefined);
        return { outcome: "limit", reason: "time", screenshot: null };
      }
      await this.fail(error);
      await this.record("action", kept, "error", this.endReason(), undefined, Date.now() - began).catch(
        () => undefined,
      );
      return {
        outcome: "error",
        reason: this.endReason() ?? "error",
        ...this.failureMetadata(),
        screenshot: null,
      };
    }
  }

  // Why an otherwise valid action may not run: typing other than the canary, or an activation that would leave
  // http(s) (a `javascript:`, `file:` or `data:` link or form runs no request the interception could stop).
  private async refusal(action: Action): Promise<string | null> {
    if (action.tool === "type" && action.text !== this.o.canary.username && action.text !== this.o.canary.password)
      return "typing other than the case's canary values";
    if (action.tool === "click" || action.tool === "double_click") {
      const target = await this.clickTarget(action.x, action.y);
      if (target === FRAME) return "a click into a frame the driver cannot inspect";
      if (target && !/^https?:/i.test(target)) return `a click on a ${target.split(":")[0]}: link or form`;
    }
    if (action.tool === "keypress" && (action.key === "Enter" || action.key === "Space")) {
      const target = await this.focusTarget(action.key === "Enter");
      if (target === FRAME) return `${action.key} in a frame the driver cannot inspect`;
      if (target && !/^https?:/i.test(target)) return `${action.key} on a ${target.split(":")[0]}: link or form`;
    }
    return null;
  }

  // The guard's lookups run in an isolated world of the frame that holds the node: its own globals and DOM wrappers,
  // which page script cannot reach, so a page that replaces `getAttribute`, a prototype getter or `URL` changes
  // nothing the guard reads. Null when the frame is not this session's to inspect (another process).
  private async guardWorld(frameId: string): Promise<number | null> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const made = (await cdp
      .send("Page.createIsolatedWorld", { frameId, worldName: "walkthrough-guard" })
      .catch(() => null)) as { executionContextId: number } | null;
    return made?.executionContextId ?? null;
  }

  // A node, resolved in the guard's world of its frame, and asked `body` (run with the node as `this`).
  private async askNode(backendNodeId: number, frameId: string, body: string, byValue: boolean, held: string[]) {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const context = await this.guardWorld(frameId);
    if (context === null) return null;
    const { object } = (await cdp.send("DOM.resolveNode", { backendNodeId, executionContextId: context })) as {
      object: { objectId?: string };
    };
    if (!object.objectId) return null;
    held.push(object.objectId);
    const { result } = (await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function () { ${body} }`,
      returnByValue: byValue,
    })) as { result: { objectId?: string; value?: unknown } };
    if (result.objectId) held.push(result.objectId);
    return result;
  }

  private async release(held: string[]) {
    for (const id of held) await this.pageCdp?.send("Runtime.releaseObject", { objectId: id }).catch(() => undefined);
  }

  private async mainFrameId(): Promise<string> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    return frameTree.frame.id;
  }

  // Where Enter (or Space) would go from what has focus. Focus is followed through Chrome's protocol: into frames by
  // their frame ids, and into every shadow root, closed ones too (page script cannot see a closed root, and a page can
  // focus a link inside one it made). Every read is in the guard's world.
  private async focusTarget(enter: boolean): Promise<string | null> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const held: string[] = [];
    type Described = { node: { frameId?: string; nodeName: string; shadowRoots?: { backendNodeId: number }[] } };
    const describe = async (objectId: string) =>
      ((await cdp.send("DOM.describeNode", { objectId, depth: 0, pierce: true })) as Described).node;
    const backendOf = async (objectId: string) =>
      ((await cdp.send("DOM.describeNode", { objectId })) as { node: { backendNodeId: number } }).node.backendNodeId;
    try {
      let frameId = await this.mainFrameId();
      const context = await this.guardWorld(frameId);
      if (context === null) return FRAME;
      const first = (await cdp.send("Runtime.evaluate", {
        expression: "document.activeElement",
        contextId: context,
      })) as { result: { objectId?: string } };
      let element = first.result.objectId;
      if (element) held.push(element);
      for (let depth = 0; depth < 16 && element; depth++) {
        const node = await describe(element);
        if (/^(IFRAME|FRAME)$/i.test(node.nodeName)) {
          // The frame's own document, in the guard's world of that frame.
          if (!node.frameId) return FRAME;
          frameId = node.frameId;
          const inner = await this.guardWorld(frameId);
          if (inner === null) return FRAME;
          const focused = (await cdp
            .send("Runtime.evaluate", { expression: "document.activeElement", contextId: inner })
            .catch(() => null)) as { result: { objectId?: string } } | null;
          if (!focused?.result.objectId) return FRAME;
          element = focused.result.objectId;
          held.push(element);
          continue;
        }
        const root = node.shadowRoots?.[0];
        if (!root) break;
        const inner = await this.askNode(root.backendNodeId, frameId, "return this.activeElement;", false, held);
        if (!inner?.objectId) break;
        element = inner.objectId;
      }
      if (!element) return null;
      const result = await this.askNode(
        await backendOf(element),
        frameId,
        `${TARGET_OF} return /^(BODY|HTML)$/.test(this.tagName) ? null : targetOf(this, ${enter});`,
        true,
        held,
      );
      if (!result) return FRAME;
      return (result.value as string | null | undefined) ?? null;
    } finally {
      await this.release(held);
    }
  }

  // Where a click at the point would go. Chrome's own hit test finds the node, through same-process frames and every
  // shadow root, open or closed; it is read in the guard's world of its frame. A frame Chrome cannot look into
  // (another process) answers FRAME.
  private async clickTarget(x: number, y: number): Promise<string | null> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const hit = (await cdp
      .send("DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: true, ignorePointerEventsNone: false })
      .catch(() => null)) as { backendNodeId: number; frameId: string } | null;
    if (!hit) return null;
    const held: string[] = [];
    try {
      const result = await this.askNode(
        hit.backendNodeId,
        hit.frameId,
        `${TARGET_OF} return targetOf(this.nodeType === 1 ? this : this.parentElement, false);`,
        true,
        held,
      );
      if (!result) return FRAME;
      return (result.value as string | null | undefined) ?? null;
    } finally {
      await this.release(held);
    }
  }

  private async run(action: Action) {
    const page = this.need();
    switch (action.tool) {
      case "click":
        return page.mouse.click(action.x, action.y);
      case "double_click":
        return page.mouse.click(action.x, action.y, { count: 2 });
      case "move":
        return page.mouse.move(action.x, action.y);
      case "scroll":
        return page.mouse.wheel({ deltaY: (action.direction === "down" ? 1 : -1) * action.amount * 100 });
      case "type":
        return page.keyboard.type(action.text);
      case "keypress":
        return page.keyboard.press(action.key);
      case "wait":
        // The wait's own timer stops when the clock cuts the walk, so a cut action leaves nothing running behind it.
        return new Promise<void>((done) => {
          const timer = setTimeout(done, action.ms);
          this.timeUp.catch(() => clearTimeout(timer));
        });
      case "screenshot":
        return;
    }
  }

  // One screenshot, and the page it shows (D04 T02 §5). The page is read on both sides of the capture: its facts stand
  // only when both reads agree on its address and no submission happened while it was taken; otherwise they are
  // unknown. A screenshot that may show the canary password (a page that printed it, or a field that shows it in clear)
  // is never stored: the model still sees it (it holds the value already), the store does not.
  private async shoot(): Promise<{ bytes: Uint8Array; key: string | undefined }> {
    // A capture is kept for the page only when the page read on both sides agrees on its address and no submission
    // happened while it was taken. A page that moved is shot once more; if it is still moving, the image is not stored
    // under any page (the model has it; the evidence does not cite it).
    let taken: {
      bytes: Uint8Array;
      began: number;
      seq: number;
      before: PageSnapshot | null;
      after: PageSnapshot | null;
      consistent: boolean;
    } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.snapshot();
      const began = this.recordSeq;
      const bytes = new Uint8Array(await this.need().screenshot({ type: "png" }));
      const seq = ++this.recordSeq;
      const after = await this.snapshot();
      const crossed = this.walkRecord.submissions.some((sub) => sub.seq > began && sub.seq < seq);
      const consistent = !!before && !!after && before.url === after.url && !crossed;
      taken = { bytes, began, seq, before, after, consistent };
      if (consistent) break;
    }
    const { bytes, began, seq, before, after, consistent } = taken as NonNullable<typeof taken>;
    const withheld = before?.echo === true || after?.echo === true || !consistent;
    const key = withheld
      ? undefined
      : (
          await putArtefact(
            this.o.store,
            this.o.caseId,
            "page",
            `walkthrough-${this.o.walkId}-${this.seq + 1}.png`,
            bytes,
            "image/png",
          )
        ).key;
    if (this.walkRecord.pages.length < MAX_RECORD)
      this.walkRecord.pages.push({
        seq,
        url: this.redact(after?.url ?? this.need().url()).slice(0, 2000),
        screenshotKey: key ?? null,
        began,
        asksPassword: consistent ? (after?.asksPassword ?? null) : null,
        failure: consistent ? (after?.failure ?? null) : null,
        refusal: consistent ? (after?.refusal ?? null) : null,
        ...(withheld ? { withheld: true } : {}),
      });
    else this.walkRecord.omitted.pages++;
    return { bytes, key };
  }

  // The page as the evidence needs it, or null when it cannot be read in time (a navigation, a stall). Read from
  // Chrome's own tree (`DOM.getDocument` with `pierce`: same-process frames and every shadow root, closed ones too):
  // whether any password field is there, whether any text says a failure word, and whether the canary password shows
  // anywhere (in a text, or as the value of a field that is not a password field).
  private snapshot(): Promise<PageSnapshot | null> {
    return Promise.race([
      this.readSnapshot().catch(() => null),
      new Promise<null>((done) => setTimeout(() => done(null), FACTS_MS)),
    ]);
  }

  private async readSnapshot(): Promise<PageSnapshot> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    type Node = {
      backendNodeId: number;
      nodeType: number;
      nodeName: string;
      nodeValue?: string;
      attributes?: string[];
      frameId?: string;
      shadowRootType?: string;
      children?: Node[];
      shadowRoots?: Node[];
      contentDocument?: Node;
    };
    const main = await this.mainFrameId();
    const context = await this.guardWorld(main);
    if (context === null) throw new Error("the page cannot be read");
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: "location.href",
      contextId: context,
      returnByValue: true,
    })) as { result: { value?: unknown } };
    if (typeof result.value !== "string") throw new Error("the page cannot be read");
    const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: Node };
    const failure = FAILURE_WORDS;
    const password = this.o.canary.password;
    let asksPassword = false;
    let saysFailure = false;
    let saysRefusal = false;
    let echo = false;
    // The read was cut short by a bound (too many fields, too much text): nothing is certified clear.
    let uncertified = false;
    let read = 0;
    // Every text of the page in document order, joined: a password shown one character to a node (a span each) is a
    // text of the page though no single node holds it.
    const texts: string[] = [];
    const fields: { backendNodeId: number; frameId: string }[] = [];
    const walk = (node: Node, frameId: string, parent: string) => {
      if (node.nodeType === 3 && node.nodeValue && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent)) {
        read += node.nodeValue.length;
        texts.push(node.nodeValue);
      }
      if (node.nodeName === "INPUT" || node.nodeName === "TEXTAREA") {
        const attrs = node.attributes ?? [];
        const type = attrs[attrs.indexOf("type") + 1]?.toLowerCase();
        if (node.nodeName === "INPUT" && attrs.includes("type") && type === "password") asksPassword = true;
        else if (fields.length < MAX_FIELDS) fields.push({ backendNodeId: node.backendNodeId, frameId });
        else uncertified = true;
      }
      if (read > MAX_PAGE_TEXT) {
        uncertified = true;
        return;
      }
      for (const child of node.children ?? []) walk(child, frameId, node.nodeName);
      // A control's own built-in shadow tree holds its current value as text (a password field's too, masked only on
      // screen): not the page's text. Non-password fields are read for the password separately, below.
      for (const shadow of node.shadowRoots ?? [])
        if (shadow.shadowRootType !== "user-agent") walk(shadow, frameId, node.nodeName);
      if (node.contentDocument) walk(node.contentDocument, node.frameId ?? frameId, node.nodeName);
    };
    walk(root, main, "");
    // The password in the page's text however it is split (by nodes, spacing or case), as typed or encoded. Text drawn
    // other ways (a canvas, an image, generated content) is not read: a recorded residual risk, the canary being a
    // synthetic value that identifies the case and is no one's credential.
    const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();
    // A failure phrase split by markup (`Try <strong>again</strong>`) is still the phrase: tested on the texts joined
    // with a space and with none.
    if (failure.test(texts.join(" ")) || failure.test(texts.join(""))) saysFailure = true;
    if (REFUSAL_WORDS.test(texts.join(" ")) || REFUSAL_WORDS.test(texts.join(""))) saysRefusal = true;
    const page = squash(texts.join(""));
    if (page.includes(squash(password)) || page.includes(squash(encodeURIComponent(password)))) echo = true;
    // A field that is not a password field yet holds the password shows it in clear (a page can change a field's type).
    const held: string[] = [];
    try {
      for (const field of fields) {
        const answer = await this.askNode(
          field.backendNodeId,
          field.frameId,
          // Anywhere in the value, as typed or encoded: a handler can copy "Password: " + value into a visible field.
          `if (this.type === "password") return false; const v = String(this.value); return v.includes(${JSON.stringify(password)}) || v.includes(${JSON.stringify(encodeURIComponent(password))});`,
          true,
          held,
        );
        if (answer?.value === true) echo = true;
      }
    } finally {
      await this.release(held);
    }
    return {
      url: result.value,
      asksPassword: asksPassword || !uncertified ? asksPassword : null,
      failure: saysFailure || !uncertified ? saysFailure : null,
      refusal: saysRefusal || !uncertified ? saysRefusal : null,
      echo: echo || uncertified,
    };
  }

  // A paused request that carries a canary value, as typed or encoded, in its address or body: recorded with the
  // names of the fields that held it, never the values. Null for any other request.
  private submission(event: Paused): Submission | null {
    const { username, password } = this.o.canary;
    const forms = (v: string) => [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];
    const holds = (text: string) => [username, password].some((v) => forms(v).some((f) => text.includes(f)));
    const body = event.request.postData ?? "";
    if (!holds(event.request.url) && !holds(body)) return null;
    const fields = new Set<string>();
    const isCanary = (value: unknown) => typeof value === "string" && (value === username || value === password);
    try {
      for (const [k, v] of new URL(event.request.url).searchParams) if (isCanary(v)) fields.add(k);
    } catch {}
    try {
      const json = JSON.parse(body) as unknown;
      const walk = (value: unknown, depth: number) => {
        if (!value || typeof value !== "object" || depth > 3) return;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (isCanary(v)) fields.add(k);
          else walk(v, depth + 1);
        }
      };
      walk(json, 0);
    } catch {
      for (const [k, v] of new URLSearchParams(body)) if (isCanary(v)) fields.add(k);
      for (const m of body.matchAll(/name="([^"\r\n]{1,80})"\r?\n(?:[^\r\n]*\r?\n)*?\r?\n([^\r\n]*)/g))
        if (m[1] && isCanary(m[2])) fields.add(m[1]);
    }
    let domain: string | null = null;
    try {
      domain = registrable(new URL(event.request.url).hostname);
    } catch {}
    const entry: Submission = {
      seq: ++this.recordSeq,
      fromPage: this.walkRecord.pages.at(-1)?.seq ?? null,
      url: this.redact(event.request.url).slice(0, 2000),
      domain,
      method: event.request.method.slice(0, 10),
      fields: [...fields].map((f) => this.redact(f).slice(0, 80)).slice(0, 20),
      state: "blocked",
    };
    if (this.walkRecord.submissions.length < MAX_RECORD) this.walkRecord.submissions.push(entry);
    else this.walkRecord.omitted.submissions++;
    return entry;
  }

  // What the walk saw and sent so far (D04 T02 §5), a copy.
  trace(): WalkRecord {
    return structuredClone(this.walkRecord);
  }

  private rememberHandled(operation: HandledOperation, error: unknown) {
    if (this.ended || this.handled.has(operation)) return;
    const diagnostic = error instanceof DriverFailure ? error.diagnostic : driverDiagnostic(operation, error);
    this.handled.set(operation, DriverDiagnostic.parse({ ...diagnostic, operation }));
  }

  private async record(
    kind: "action" | "request" | "popup" | "end",
    action: Record<string, unknown>,
    outcome: Outcome,
    reason?: string,
    screenshotKey?: string,
    ms = 0,
  ) {
    this.seq++;
    // Cumulative handled failures occurred before this row. Each keeps its lexical operation, not this row's kind.
    const kept = this.handled.size
      ? { ...action, handledDiagnostics: HandledDriverDiagnostics.parse([...this.handled.values()]) }
      : action;
    await this.o.store.db
      .prepare(
        `INSERT INTO walkthrough_actions (case_id, walk_id, seq, kind, action_json, outcome, reason, screenshot_key, ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.o.caseId,
        this.o.walkId,
        this.seq,
        kind,
        this.redact(JSON.stringify(kept)).slice(0, 2000),
        outcome,
        reason === undefined ? null : this.redact(reason).slice(0, 500),
        screenshotKey ?? null,
        Math.max(0, Math.round(ms)),
        new Date().toISOString(),
      )
      .run();
  }

  // No row keeps a canary value, whatever carried it (a page can put a typed value into a refused URL): each is
  // replaced by its field's name, as typed and in its URL-encoded forms.
  private redact(text: string): string {
    let out = text;
    for (const [field, value] of [
      ["username", this.o.canary.username],
      ["password", this.o.canary.password],
    ] as const) {
      for (const form of new Set([
        value,
        encodeURIComponent(value),
        new URLSearchParams({ v: value }).toString().slice(2),
      ]))
        out = out.split(form).join(`[canary ${field}]`);
    }
    return out;
  }

  private async fail(error: unknown, operation: DriverOperation = "action") {
    // First terminal outcome and diagnostic win, including callbacks completing during close/persistence.
    if (this.ended) return this.ending;
    const diagnostic = error instanceof DriverFailure ? error.diagnostic : driverDiagnostic(operation, error);
    const reason = {
      error: "Error",
      type: "TypeError",
      timeout: "TimeoutError",
      abort: "AbortError",
      protocol: "ProtocolError",
      "target-closed": "TargetCloseError",
      unknown: "Error",
    }[diagnostic.category];
    await this.end("error", reason, diagnostic);
  }

  // Ends the walk once: the clock stops, every target closes, the session is released, and an `end` row is kept
  // when the database allows.
  end(outcome: Outcome, reason: string, diagnostic?: DriverDiagnostic): Promise<void> {
    if (this.ending) return this.ending;
    const safe = diagnostic === undefined ? undefined : DriverDiagnostic.parse(diagnostic);
    this.ended = { outcome, reason, ...(safe ? { diagnostic: safe } : {}) };
    this.stopped.abort();
    clearTimeout(this.timer);
    this.ending = (async () => {
      await Promise.race([this.browser.close(), new Promise((done) => setTimeout(done, 5_000))]).catch(() => undefined);
      await this.record(
        "end",
        { elapsed_ms: Date.now() - this.started, ...(safe ? { diagnostic: safe } : {}) },
        outcome,
        reason,
      ).catch(() => undefined);
    })();
    return this.ending;
  }

  private failureMetadata(): { diagnostic?: DriverDiagnostic } {
    return this.ended?.diagnostic ? { diagnostic: this.ended.diagnostic } : {};
  }

  private endReason(): string | undefined {
    return this.ended?.reason;
  }

  // The time left on the wall clock (D04 T02 §4: the model's calls count against it).
  get remainingMs(): number {
    return Math.max(0, this.o.limits.ms - (Date.now() - this.started));
  }

  // What the page shows, for the model (D04 T02 §4): no attempt is counted and no input is sent. The HTML is read
  // through CDP (page script cannot spoof it) and scanned for hidden text first (spec 4.6a): the hidden spans are a `page`
  // artefact before anything returns, and only the visible text is handed on. Inside the wall clock and the failure
  // handling, like `execute`.
  async view(options: { screenshot?: boolean } = {}): Promise<View> {
    if (this.ended)
      return {
        outcome: this.ended.outcome === "error" ? "error" : "limit",
        reason: this.ended.reason,
        ...this.failureMetadata(),
        screenshot: null,
        text: "",
      };
    try {
      const shot =
        options.screenshot === false ? null : await this.bounded(atOperation("view.screenshot", () => this.shoot()));
      const read = await this.bounded(atOperation("view.read", () => this.readPage()));
      return {
        outcome: "done",
        screenshot: shot?.bytes ?? null,
        ...(shot ? { screenshotKey: shot.key } : {}),
        text: read.text,
        ...(read.hiddenKey ? { hiddenKey: read.hiddenKey } : {}),
      };
    } catch (error) {
      if (error instanceof TimeUp || this.endReason() === "time") {
        await this.ending;
        return { outcome: "limit", reason: "time", screenshot: null, text: "" };
      }
      await this.fail(error);
      return {
        outcome: "error",
        reason: this.endReason() ?? "error",
        ...this.failureMetadata(),
        screenshot: null,
        text: "",
      };
    }
  }

  // Where the walk stands (D04 T02 §4): the page's address and which of its fields hold a canary value. Every input
  // the driver could type into is found through CDP (`pierce`: same-process frames and every shadow root, closed ones
  // too) and read in the guard's world of its own frame (page script cannot answer for it). Values never leave this
  // method. A page that cannot be read throws: an empty answer would read as a page with nothing filled.
  // The whole read, cleanup included, is inside the wall clock: a stalled read ends at the walk's deadline.
  filled(): Promise<{ url: string; filled: ("username" | "password")[] }> {
    return this.bounded(this.readFilled());
  }

  private async readFilled(): Promise<{ url: string; filled: ("username" | "password")[] }> {
    const cdp = this.pageCdp;
    if (!cdp || this.ended) throw new Error("the walk has no page to read");
    type Node = {
      backendNodeId: number;
      nodeName: string;
      frameId?: string;
      children?: Node[];
      shadowRoots?: Node[];
      contentDocument?: Node;
    };
    const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: Node };
    const main = await this.mainFrameId();
    const inputs: { backendNodeId: number; frameId: string }[] = [];
    // Every input is read; a page with more than MAX_INPUTS fails the read rather than answering for some of them.
    const walk = (node: Node, frameId: string) => {
      if (node.nodeName === "INPUT") {
        if (inputs.length >= MAX_INPUTS) throw new Error("the page has too many fields to read");
        inputs.push({ backendNodeId: node.backendNodeId, frameId });
      }
      for (const child of node.children ?? []) walk(child, frameId);
      for (const shadow of node.shadowRoots ?? []) walk(shadow, frameId);
      if (node.contentDocument) walk(node.contentDocument, node.frameId ?? frameId);
    };
    walk(root, main);
    const found = new Set<"username" | "password">();
    const held: string[] = [];
    try {
      for (const input of inputs) {
        const answer = await this.askNode(
          input.backendNodeId,
          input.frameId,
          `return this.value === ${JSON.stringify(this.o.canary.username)} ? "username" : this.value === ${JSON.stringify(this.o.canary.password)} ? "password" : null;`,
          true,
          held,
        );
        // A field that cannot be read fails the read: it is not a field without a canary.
        if (!answer) throw new Error("a field cannot be read");
        if (answer.value === "username" || answer.value === "password") found.add(answer.value);
      }
    } finally {
      await this.release(held);
    }
    const context = await this.guardWorld(main);
    if (context === null) throw new Error("the page cannot be read");
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: "location.href",
      contextId: context,
      returnByValue: true,
    })) as { result: { value?: unknown } };
    if (typeof result.value !== "string") throw new Error("the page cannot be read");
    return { url: result.value, filled: (["username", "password"] as const).filter((f) => found.has(f)) };
  }

  // The page's text as the browser renders it (spec 4.6a: hidden text is evidence before anything reaches a model):
  // each text node is judged in the guard's world from its computed style, box and colour, so a rule from an external
  // style sheet, a class or a script counts as it does on screen. Hidden runs (and comments) are stored as a `page`
  // artefact before the view returns; only the visible text is handed on.
  private async readPage(): Promise<{ text: string; hiddenKey?: string }> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const context = await this.guardWorld(await this.mainFrameId());
    if (context === null) throw new Error("the page cannot be read");
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: READ_PAGE,
      contextId: context,
      returnByValue: true,
    })) as { result: { value?: { visible: string; hidden: { text: string; reason: string }[]; omitted: number } } };
    const read = result.value;
    if (!read || typeof read.visible !== "string") throw new Error("the page cannot be read");
    this.views++;
    let hiddenKey: string | undefined;
    if (read.hidden.length || read.omitted) {
      const hidden = read.hidden.map((span) => ({ ...span, instruction: hasInstruction(span.text) }));
      const page = this.walkRecord.pages.at(-1)?.seq ?? null;
      const stored = await putArtefact(
        this.o.store,
        this.o.caseId,
        "page",
        `walkthrough-${this.o.walkId}-${this.views}-hidden.json`,
        new TextEncoder().encode(this.redact(JSON.stringify({ hidden, omittedSpans: read.omitted }))),
        "application/json",
      );
      hiddenKey = stored.key;
      this.walkRecord.omitted.hidden += read.omitted;
      // Each span in the record itself, bounded and redacted, so the evidence needs no artefact read (D04 T02 §5).
      for (const span of hidden) {
        if (this.walkRecord.hidden.length >= MAX_RECORD) {
          this.walkRecord.omitted.hidden++;
          continue;
        }
        this.walkRecord.hidden.push({
          text: this.redact(span.text).slice(0, MAX_SPAN_TEXT),
          reason: span.reason,
          instruction: span.instruction,
          page,
          key: stored.key,
        });
      }
    }
    const text = read.visible.replace(/\s+/g, " ").trim().slice(0, MAX_VIEW_TEXT);
    return { text, ...(hiddenKey ? { hiddenKey } : {}) };
  }

  close(): Promise<void> {
    return this.end("done", "closed");
  }
}

// What the audit row keeps of an action: never typed text. A canary is named by its field; anything else by length.
function summary(input: unknown, canary: Canary): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return { invalid: typeof input };
  const record = input as Record<string, unknown>;
  if (record.tool === "type") {
    const text = typeof record.text === "string" ? record.text : "";
    if (text === canary.username) return { tool: "type", field: "username" };
    if (text === canary.password) return { tool: "type", field: "password" };
    return { tool: "type", length: text.length };
  }
  const kept: Record<string, unknown> = {};
  for (const key of ["tool", "x", "y", "direction", "amount", "key", "ms"])
    if (key in record) kept[key] = typeof record[key] === "string" ? String(record[key]).slice(0, 40) : record[key];
  return kept;
}

// A response body read as it arrives, or null past `max` bytes.
async function readCapped(answer: Response, max: number): Promise<Uint8Array | null> {
  if (Number(answer.headers.get("content-length") ?? "0") > max) {
    await answer.body?.cancel();
    return null;
  }
  const reader = answer.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
