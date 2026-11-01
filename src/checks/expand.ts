// Redirect expansion in Browser Run (D02 T07 §2; design spec 4.3 and the risks table, link detonation). A link is followed
// in an isolated Browser Run page, never from the Worker's own network stack: one page per link, every request the page
// makes checked by the walkthrough lane's URL policy (`allowedUrl`: http(s) only, no port, no credentials, no IP literal,
// no local name, no name that resolves to a non-public address), downloads denied by the browser itself and recorded, and
// 15 seconds for a link. The result is evidence for two pure checks (`link.redirects`, `link.final_domain_changed` in
// ./links.ts); this module is the only place that touches the network, and the `checks` step calls it before they run.
//
// A case's links are followed within bounds (`expansionsOf`): at most MAX_FOLLOWED distinct addresses, document links
// before images, one browser session, CASE_MS in all. Each link keeps its own outcome and the case counts what it did not
// follow and why, so an incomplete investigation is never read as a clean one.
import puppeteer, { type Browser, type CDPSession, type HTTPRequest, type HTTPResponse } from "@cloudflare/puppeteer";
import { allowedUrl, dohResolve, type Resolve, type Verdict } from "../walkthrough/url-policy";

// A link as the follower reads it: its address and where it came from (`Link` in ./links.ts satisfies it; this module
// takes no Worker types, so the Node tests can load it).
export type FollowLink = { href: string; kind: string };

export const LINK_MS = 15_000;
export const CASE_MS = 45_000;
export const MAX_FOLLOWED = 5;
const MAX_HOPS = 20;
const MAX_NOTES = 20;
const NOTE_CHARS = 200;

// What a page may fetch: documents and the things a landing page draws itself with. Everything else (a socket, a beacon,
// a media stream) is refused.
const ALLOWED_TYPES = new Set(["document", "script", "stylesheet", "image", "font"]);

export type Hop = { url: string; status: number; location: string | null };
export type Outcome = "done" | "blocked" | "timeout" | "error";
export type Expansion = {
  link: string;
  outcome: Outcome;
  // Why a link was not followed through or stopped early: the policy's reason, the limit, or the error's name.
  reason: string | null;
  // Each response of the main document's chain, in order: a redirect has a `location`, the last one does not.
  hops: Hop[];
  // The address the page settled on; null when it never got a response.
  final: string | null;
  // Downloads the browser denied and requests the policy refused (each at most NOTE_CHARS characters, MAX_NOTES kept).
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

// Follows one link. Never throws: a failure is the link's outcome.
export async function expandLink(browser: Browser, link: string, deps: ExpandDeps): Promise<Expansion> {
  const now = deps.now ?? Date.now;
  const started = now();
  const limit = deps.limitMs ?? LINK_MS;
  const result: Expansion = {
    link,
    outcome: "done",
    reason: null,
    hops: [],
    final: null,
    downloads: [],
    refused: [],
    ms: 0,
  };
  const first = await deps.policy(link).catch((error: unknown): Verdict => ({ ok: false, reason: errorName(error) }));
  if (!first.ok) {
    result.outcome = "blocked";
    result.reason = first.reason;
    result.refused.push({ url: note(link), reason: first.reason });
    result.ms = now() - started;
    return result;
  }
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  let cdp: CDPSession | undefined;
  let completedDownload = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<"time">((done) => {
    timer = setTimeout(() => done("time"), limit);
  });
  try {
    const work = (async () => {
      cdp = await browser.target().createCDPSession();
      // Downloads are denied by the browser itself, whatever started them, and each attempt is recorded.
      let downloadEnded: () => void = () => undefined;
      const ended = new Promise<void>((done) => {
        downloadEnded = done;
      });
      let sawDownload: () => void = () => undefined;
      const downloaded = new Promise<void>((done) => {
        sawDownload = done;
      });
      cdp.on("Browser.downloadWillBegin", (event: { url: string }) => {
        if (result.downloads.length < MAX_NOTES) result.downloads.push(note(event.url));
        sawDownload();
      });
      // A download that completed was not stopped: the link is an error, whatever else it did.
      cdp.on("Browser.downloadProgress", (event: { state: string }) => {
        if (event.state === "completed") completedDownload = true;
        if (event.state !== "inProgress") downloadEnded();
      });
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
      page = await browser.newPage();
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      page.on("request", (request: HTTPRequest) => void decide(request, deps, result));
      page.on("response", (response: HTTPResponse) => {
        const request = response.request();
        if (request.resourceType() !== "document" || request.frame() !== page?.mainFrame()) return;
        if (result.hops.length >= MAX_HOPS) return;
        const location = response.headers().location ?? null;
        result.hops.push({
          url: note(response.url()),
          status: response.status(),
          location: location && note(location),
        });
      });
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: limit });
      } catch (error) {
        // A navigation that became a download is aborted by the browser, and its event may land just after the abort: the
        // download is the record, and an abort with no download after a short wait is a failure.
        if (!/ERR_ABORTED/.test(String(error))) throw error;
        await Promise.race([downloaded, new Promise((done) => setTimeout(done, 1_000))]);
        if (result.downloads.length === 0) throw error;
        // Its end is the browser's word that nothing was saved (`canceled`), not ours.
        await Promise.race([ended, new Promise((done) => setTimeout(done, 1_000))]);
      }
      result.final = page.url() === "about:blank" ? (result.hops.at(-1)?.url ?? null) : note(page.url());
    })();
    work.catch(() => undefined);
    const winner = await Promise.race([work.then(() => "done" as const), timeUp]);
    if (winner === "time") {
      result.outcome = "timeout";
      result.reason = `no answer within ${Math.round(limit / 1000)} seconds`;
      result.final ??= result.hops.at(-1)?.url ?? null;
    } else if (result.refused.length > 0 && result.hops.length === 0) {
      result.outcome = "blocked";
      result.reason = result.refused[0]?.reason ?? null;
    }
  } catch (error) {
    if (result.refused.length > 0 && result.hops.length === 0) {
      result.outcome = "blocked";
      result.reason = result.refused[0]?.reason ?? null;
    } else {
      result.outcome = "error";
      result.reason = errorName(error);
    }
    result.final ??= result.hops.at(-1)?.url ?? null;
  } finally {
    clearTimeout(timer);
    if (completedDownload) {
      result.outcome = "error";
      result.reason = "a download was not stopped";
    }
    await Promise.allSettled([page?.close(), cdp?.detach()]);
    result.ms = now() - started;
  }
  return result;
}

// A request the page makes: allowed only when its kind and its address pass the policy.
async function decide(request: HTTPRequest, deps: ExpandDeps, result: Expansion) {
  const refuse = (reason: string) => {
    if (result.refused.length < MAX_NOTES) result.refused.push({ url: note(request.url()), reason });
    return request.abort("blockedbyclient").catch(() => undefined);
  };
  try {
    if (!ALLOWED_TYPES.has(request.resourceType()))
      return await refuse(`${request.resourceType()} requests are not followed`);
    const verdict = await deps.policy(request.url());
    if (!verdict.ok) return await refuse(verdict.reason);
    await request.continue().catch(() => undefined);
  } catch (error) {
    await refuse(errorName(error));
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name || "Error" : "Error");

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

// A case's links followed within bounds. `browser` is the caller's (and closed by the caller).
export async function expansionsOf(browser: Browser, links: FollowLink[], deps: ExpandDeps): Promise<Expansions> {
  const now = deps.now ?? Date.now;
  const started = now();
  const all = followable(links);
  const items: Expansion[] = [];
  let timeSkipped = 0;
  for (const [index, href] of all.slice(0, MAX_FOLLOWED).entries()) {
    const left = CASE_MS - (now() - started);
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
// following was unavailable (no binding, or the session could not start), never for a case that simply has no links.
export async function followLinks(
  binding: Parameters<typeof puppeteer.launch>[0] | undefined,
  links: FollowLink[],
  deps: ExpandDeps,
): Promise<Expansions | null> {
  if (followable(links).length === 0) return { items: [], skipped: [] };
  if (!binding) return null;
  let browser: Browser;
  try {
    browser = await puppeteer.launch(binding);
  } catch {
    return null;
  }
  try {
    return await expansionsOf(browser, links, deps);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
