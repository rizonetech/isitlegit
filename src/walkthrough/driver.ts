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
import { scanHtml } from "../checks/hidden-text";
import { putArtefact, type Store } from "../intake/store";
import { MAX_VIEW_TEXT } from "./limits";
import { allowedUrl, type Resolve } from "./url-policy";

export const LIMITS = { steps: 8, ms: 60_000 } as const;
export const VIEWPORT = { width: 1280, height: 800 } as const;
// The most of a page's HTML a view reads (its visible text is cut at MAX_VIEW_TEXT, ./limits.ts).
const MAX_VIEW_HTML = 2 * 1024 * 1024;
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
export type Result = { outcome: Outcome; reason?: string; screenshot: Uint8Array | null; screenshotKey?: string };
export type Canary = { username: string; password: string };
// What the page shows now (D04 T02 §4): its screenshot when asked for, and its visible text; the hidden text found on it
// is stored as an artefact before the view returns (`hiddenKey`), never handed on.
export type View = {
  outcome: "done" | "limit" | "error";
  reason?: string;
  screenshot: Uint8Array | null;
  screenshotKey?: string;
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

export class Driver {
  private attempts = 0;
  private seq = 0;
  private views = 0;
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
  ended: { outcome: Outcome; reason: string } | undefined;

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
    const driver = new Driver(browser, { ...options, fetch: options.fetch ?? fetch, limits: options.limits ?? LIMITS });
    driver.timer = setTimeout(() => {
      driver.signalTimeUp();
      void driver.end("limit", "time");
    }, driver.o.limits.ms);
    try {
      await driver.bounded(driver.setUp());
      const verdict = await driver.bounded(allowedUrl(options.startUrl, options.resolve));
      if (!verdict.ok) {
        await driver.record("request", { url: options.startUrl }, "refused", verdict.reason);
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
    const cdp = await this.browser.target().createCDPSession();
    this.browserCdp = cdp;
    // A popup is known by its opener at creation, even a `noopener` one (`target=_blank`), which Puppeteer reports with
    // no opener. Its main frame's id is its target id.
    cdp.on("Target.targetCreated", (event: { targetInfo: { targetId: string; type: string; openerId?: string } }) => {
      const target = event.targetInfo;
      if (target.type === "page" && target.openerId) this.popups.add(target.targetId);
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    cdp.on("Fetch.requestPaused", (event: Paused) => {
      this.answer(cdp, event).catch((error) => void this.fail(error));
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    // Downloads are denied by the browser itself, whatever started them (an attachment header, an `<a download>`
    // link, a page-made Blob), and each attempt is recorded.
    cdp.on("Browser.downloadWillBegin", (event: { url: string }) => {
      this.refuse(`${event.url.slice(0, 200)}`, "download refused");
    });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
    this.browser.on("targetcreated", (target) => {
      this.contain(target).catch((error) => void this.fail(error));
    });
    const page = await this.browser.newPage();
    this.page = page;
    await page.setViewport(VIEWPORT);
    await page.setBypassServiceWorker(true);
    // No page or frame of the walk can start a worker: the constructors are gone before any page script runs. A worker
    // that starts anyway is stopped by `contain`.
    await page.evaluateOnNewDocument(
      "for (const name of ['Worker', 'SharedWorker']) { try { delete globalThis[name]; } catch (e) {} }",
    );
    this.pageCdp = await page.createCDPSession();
    // The click guard's hit test (`DOM.getNodeForLocation`) needs the DOM domain.
    await this.pageCdp.send("DOM.enable");
    await this.refreshFrames();
  }

  private async refreshFrames() {
    if (!this.pageCdp) return;
    type Tree = { frame: { id: string }; childFrames?: Tree[] };
    const { frameTree } = (await this.pageCdp.send("Page.getFrameTree")) as { frameTree: Tree };
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
    const fail = (reason: string) => {
      this.refuse(event.request.url.slice(0, 200), reason);
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
      await this.refreshFrames().catch(() => undefined);
      if (!this.walkFrames.has(event.frameId)) {
        // A popup's or new tab's first navigation: the popup never loads and is closed; its address is followed in the
        // walk's own page when the policy allows it.
        if (event.resourceType === "Document") {
          const verdict = await allowedUrl(event.request.url, this.o.resolve);
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
    const verdict = await allowedUrl(event.request.url, this.o.resolve);
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
      return fail(`the request failed (${error instanceof Error ? error.name : "Error"})`);
    }
    // A download is never delivered: the browser gets an empty answer, and the walk records the refusal.
    if (/^\s*attachment/i.test(answer.headers.get("content-disposition") ?? "")) {
      this.refuse(verdict.url.href.slice(0, 200), "download refused");
      await answer.body?.cancel();
      return cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204, responseHeaders: [] });
    }
    const body = await readCapped(answer, MAX_RESPONSE_BYTES);
    if (body === null) return fail(`the answer is over ${MAX_RESPONSE_BYTES} bytes`);
    const responseHeaders: { name: string; value: string }[] = [];
    answer.headers.forEach((value, name) => {
      if (name !== "set-cookie" && name !== "content-encoding" && name !== "content-length")
        responseHeaders.push({ name, value });
    });
    for (const cookie of answer.headers.getSetCookie()) responseHeaders.push({ name: "set-cookie", value: cookie });
    await cdp.send("Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: answer.status,
      responseHeaders,
      body: Buffer.from(body).toString("base64"),
    });
  }

  private async closePopup(targetId: string) {
    if (!this.popups.delete(targetId)) return;
    await this.browserCdp?.send("Target.closeTarget", { targetId }).catch(() => undefined);
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
    const session = await target.createCDPSession().catch(() => null);
    await session?.send("Runtime.terminateExecution").catch(() => undefined);
    await session?.detach().catch(() => undefined);
    await this.record("popup", { target: type }, "refused", `${type} stopped`);
  }

  // A refused request or download: kept for the current action's answer and recorded at once as its own row, so a
  // refusal during loading or between actions is never lost.
  private refuse(what: string, reason: string) {
    this.blocked.push(`${what}: ${reason}`);
    // A refusal that cannot be recorded ends the walk like any other failed write: no later action answers `done`.
    void this.record("request", { url: what }, "refused", reason).catch((error) => this.fail(error));
  }

  private async navigate(url: string) {
    const page = this.need();
    await page.goto(url, { timeout: REQUEST_MS, waitUntil: "load" }).catch((error: Error) => {
      if (!/net::ERR_BLOCKED_BY_CLIENT|ERR_FAILED/.test(error.message)) throw error;
    });
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
        const shot = await this.bounded(this.shoot());
        await this.bounded(this.record("action", kept, "refused", reason, shot.key, Date.now() - began));
        return { outcome: "refused", reason, screenshot: shot.bytes, screenshotKey: shot.key };
      }
      const refusal = await this.bounded(this.refusal(action));
      if (refusal) {
        const shot = await this.bounded(this.shoot());
        await this.bounded(this.record("action", kept, "refused", refusal, shot.key, Date.now() - began));
        return { outcome: "refused", reason: refusal, screenshot: shot.bytes, screenshotKey: shot.key };
      }
      await this.bounded(this.run(action));
      await this.bounded(this.followPopup());
      await this.bounded(this.refreshFrames());
      const shot = await this.bounded(this.shoot());
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
      return { outcome: "error", reason: this.endReason() ?? "error", screenshot: null };
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
        return new Promise<void>((done) => setTimeout(done, action.ms));
      case "screenshot":
        return;
    }
  }

  private async shoot(): Promise<{ bytes: Uint8Array; key: string }> {
    const bytes = new Uint8Array(await this.need().screenshot({ type: "png" }));
    const stored = await putArtefact(
      this.o.store,
      this.o.caseId,
      "page",
      `walkthrough-${this.o.walkId}-${this.seq + 1}.png`,
      bytes,
      "image/png",
    );
    return { bytes, key: stored.key };
  }

  private async record(
    kind: "action" | "request" | "popup" | "end",
    action: unknown,
    outcome: Outcome,
    reason?: string,
    screenshotKey?: string,
    ms = 0,
  ) {
    this.seq++;
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
        this.redact(JSON.stringify(action)).slice(0, 2000),
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

  private async fail(error: unknown) {
    // A walk already ending (the clock, a limit) keeps its reason; the caller still waits for it to finish closing.
    if (this.ended && this.ended.outcome !== "error") return this.ending;
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
    await this.end("error", name);
  }

  // Ends the walk once: the clock stops, every target closes, the session is released, and an `end` row is kept
  // when the database allows.
  end(outcome: Outcome, reason: string): Promise<void> {
    if (this.ending) return this.ending;
    this.ended = { outcome, reason };
    this.stopped.abort();
    clearTimeout(this.timer);
    this.ending = (async () => {
      await Promise.race([this.browser.close(), new Promise((done) => setTimeout(done, 5_000))]).catch(() => undefined);
      await this.record("end", { elapsed_ms: Date.now() - this.started }, outcome, reason).catch(() => undefined);
    })();
    return this.ending;
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
        screenshot: null,
        text: "",
      };
    try {
      const shot = options.screenshot === false ? null : await this.bounded(this.shoot());
      const read = await this.bounded(this.readPage());
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
      return { outcome: "error", reason: this.endReason() ?? "error", screenshot: null, text: "" };
    }
  }

  // Where the walk stands (D04 T02 §4): the page's address and which of its fields hold a canary value, read in the
  // guard's world (page script cannot answer for it). Values themselves never leave this method.
  async filled(): Promise<{ url: string; filled: ("username" | "password")[] }> {
    const cdp = this.pageCdp;
    if (!cdp || this.ended) return { url: "", filled: [] };
    const context = await this.guardWorld(await this.mainFrameId());
    if (context === null) return { url: "", filled: [] };
    const { result } = (await this.bounded(
      cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const values = Array.from(document.querySelectorAll("input"), (i) => i.value);
          return { url: location.href, user: values.includes(${JSON.stringify(this.o.canary.username)}),
            pass: values.includes(${JSON.stringify(this.o.canary.password)}) };
        })()`,
        contextId: context,
        returnByValue: true,
      }),
    )) as { result: { value?: { url: string; user: boolean; pass: boolean } } };
    const v = result.value;
    if (!v) return { url: "", filled: [] };
    return {
      url: v.url,
      filled: [...(v.user ? (["username"] as const) : []), ...(v.pass ? (["password"] as const) : [])],
    };
  }

  private async readPage(): Promise<{ text: string; hiddenKey?: string }> {
    const cdp = this.pageCdp;
    if (!cdp) throw new Error("the walk has no page");
    const { root } = (await cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
    const { outerHTML } = (await cdp.send("DOM.getOuterHTML", { nodeId: root.nodeId })) as { outerHTML: string };
    const scan = await scanHtml(() => outerHTML.slice(0, MAX_VIEW_HTML));
    this.views++;
    let hiddenKey: string | undefined;
    if (scan.hidden.length || scan.omittedSpans) {
      const stored = await putArtefact(
        this.o.store,
        this.o.caseId,
        "page",
        `walkthrough-${this.o.walkId}-${this.views}-hidden.json`,
        new TextEncoder().encode(
          this.redact(
            JSON.stringify({
              hidden: scan.hidden,
              omittedSpans: scan.omittedSpans,
              unresolvedRules: scan.unresolvedRules,
              cut: outerHTML.length > MAX_VIEW_HTML,
            }),
          ),
        ),
        "application/json",
      );
      hiddenKey = stored.key;
    }
    const text = scan.visible.replace(/\s+/g, " ").trim().slice(0, MAX_VIEW_TEXT);
    return { text, ...(hiddenKey ? { hiddenKey } : {}) };
  }

  close(): Promise<void> {
    return this.end("done", "closed");
  }
}

// What the audit row keeps of an action: never typed text. A canary is named by its field; anything else by length.
function summary(input: unknown, canary: Canary): unknown {
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
