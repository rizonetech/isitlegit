// Benign real pages rendered locally (D03 T04 §6): the screener must tell lures from the real pages they copy, so real
// homepages, sign-in, checkout, shop, company and social pages are rendered by our own browser from known-good lists.
//
//   node scripts/glimmer/render.ts run [majestic|benign-sa]   # render the lists (both by default), resumable
//   node scripts/glimmer/render.ts coverage                    # what the benign pages in the store cover
//
// Lists: `raw/majestic/top.csv` in the store (the Majestic Million's top 5,000 domains and 600 highest-ranked `.za`,
// CC BY 3.0) and `eval/glimmer/benign-sa-urls.txt` (our own: `<kind>\t<url>\t<brand>[\t<also domains>]`). A list is
// rendered only when its licence is on the commercial-use allowlist. Each render gets a fresh browser context: 1280 by
// 800, downloads, permissions, pop-ups, service workers and WebSockets refused, no stored credentials, 20 seconds in
// all; every request and every redirect hop goes only to public addresses. A capture is stored only when usable: HTTP
// 2xx, still on the listed site, at least 50 characters of visible text, and no challenge, CAPTCHA or consent wall.
// Each URL's outcome goes to `raw/benign/progress.jsonl`, so a stopped run resumes without storing a page twice.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Route } from "playwright-core";
import { getDomain } from "tldts";
import { HOST } from "../../src/vision/page-screen.ts";
import { chromiumPath } from "../lib/chromium.ts";
import { type FormFlags, normaliseScreenshot, readFormFlags } from "./source-pages.ts";
import { MAX_HEIGHT, MAX_WIDTH, openStore, PAGE_KINDS, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const RENDER_LIMIT_MS = 20_000;
export const SETTLE_MS = 3_000;
export const MIN_TEXT = 50;
export const MAX_TRIES = 3;
// Licences that allow rendering a list's pages to train a model for a commercial product (design spec 4.9).
export const LIST_LICENCES = ["CC0", "CC BY 3.0", "CC BY 4.0", "MIT", "Apache 2.0", "own"] as const;

export type Kind = (typeof PAGE_KINDS)[number];
export type ListEntry = { url: string; kind: Kind; brand?: string; also: string[] };
export type UrlList = { name: string; licence: string; southAfrica: boolean; entries: ListEntry[] };

export function assertListLicence(list: Pick<UrlList, "name" | "licence">): void {
  if (!(LIST_LICENCES as readonly string[]).includes(list.licence))
    throw new Error(`${list.name}: licence "${list.licence || "none"}" is not on the commercial-use allowlist`);
}

export function majesticList(csv: string): UrlList {
  const entries: ListEntry[] = [];
  for (const line of csv.split("\n").slice(1)) {
    const domain = line.split(",")[1]?.trim().toLowerCase();
    if (domain && HOST.test(domain)) entries.push({ url: `https://${domain}/`, kind: "home", also: [] });
  }
  return { name: "majestic", licence: "CC BY 3.0", southAfrica: false, entries };
}

// `<kind>\t<url>\t<brand>[\t<also>]`, `#` comments; `also` names other domains the page may finish on (a bank's
// sign-in hosted on its group's domain), comma-separated.
export function saList(text: string): UrlList {
  const entries: ListEntry[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [kind = "", url = "", brand = "", also = ""] = line.split("\t").map((cell) => cell.trim());
    if (!(PAGE_KINDS as readonly string[]).includes(kind) || kind === "home")
      throw new Error(`benign-sa line ${index + 1}: kind "${kind}"`);
    if (!/^https:\/\/[^\s/]+/.test(url)) throw new Error(`benign-sa line ${index + 1}: not an https URL`);
    if (!brand) throw new Error(`benign-sa line ${index + 1}: no brand`);
    const domains = also ? also.split(",").map((d) => d.trim().toLowerCase()) : [];
    entries.push({ url, kind: kind as Kind, brand, also: domains });
  }
  return { name: "benign-sa", licence: "own", southAfrica: true, entries };
}

// Whether an address is on the public internet: loopback, private, shared, link-local, unique-local, multicast and
// reserved ranges are not.
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (dotted) return isPublicAddress(dotted[1] as string);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
      const high = Number.parseInt(hex[1] as string, 16);
      const low = Number.parseInt(hex[2] as string, 16);
      return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (lower === "::" || lower === "::1") return false;
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
    return true;
  }
  return false;
}

export type Capture = {
  listed: string;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  screenshot: Uint8Array;
  captcha: boolean;
  consentWall: boolean;
  downloadsWritten: number;
  popupsClosed: number;
  serviceWorkers: number;
} & FormFlags;

export class RenderTimeout extends Error {}

// Signs that the page is not the site but a wall in front of it. Run inside the page.
export function readWalls(): { captcha: boolean; consentWall: boolean } {
  const captcha = [...document.querySelectorAll("iframe")].some((frame) =>
    /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i.test(frame.src || ""),
  );
  const width = innerWidth;
  const height = innerHeight;
  let consentWall = false;
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "absolute") continue;
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const box = el.getBoundingClientRect();
    const covered =
      Math.max(0, Math.min(box.right, width) - Math.max(box.left, 0)) *
      Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0));
    if (covered < 0.5 * width * height) continue;
    // biome-ignore lint/performance/useDomNodeTextContent: what the overlay shows is the point
    const text = (el as HTMLElement).innerText || "";
    // A consent wall asks for consent; a page wrapped whole in a positioned frame (Microsoft's sign-in) only links
    // its "Privacy & cookies" policy in a footer.
    if (
      text.length < 3000 &&
      /we use cookies|accept (all )?cookies|(cookie|privacy) (settings|preferences)|manage cookies|consent to|your consent/i.test(
        text,
      )
    ) {
      consentWall = true;
      break;
    }
  }
  return { captcha, consentWall };
}

// Why a capture cannot be stored as a benign page of the listed site, or null when it can.
export function unusable(capture: Capture, entry: ListEntry): string | null {
  if (capture.status < 200 || capture.status > 299) return `HTTP ${capture.status}`;
  // The registrable domain; an address has none, so it stands for itself.
  const site = (url: string) => {
    const host = new URL(url).hostname;
    return getDomain(host) ?? host;
  };
  const listed = site(entry.url);
  const landed = site(capture.finalUrl);
  if (!landed || (landed !== listed && !entry.also.includes(landed))) return `cross-site redirect to ${landed}`;
  if (
    /just a moment|verify you are human|access denied|attention required|checking your browser|are you a robot/i.test(
      `${capture.title}\n${capture.text.slice(0, 2000)}`,
    )
  )
    return "a challenge page";
  if (capture.captcha) return "a CAPTCHA frame";
  if (capture.consentWall) return "a cookie wall covering the page";
  if (capture.text.trim().length < MIN_TEXT) return `under ${MIN_TEXT} characters of visible text`;
  return null;
}

export async function openRenderer(options: { allowOrigins?: string[]; limitMs?: number } = {}) {
  const found = chromiumPath();
  if (!found) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const executablePath: string = found;
  const allowOrigins = new Set(options.allowOrigins ?? []);
  const limitMs = options.limitMs ?? RENDER_LIMIT_MS;
  let session: Promise<Browser> | null = null;
  const contexts = new Set<BrowserContext>();
  const current = () => {
    session ??= chromium.launch({ executablePath, chromiumSandbox: true, args: ["--no-first-run"] }).then((browser) => {
      browser.on("disconnected", () => {
        session = null;
      });
      return browser;
    });
    return session;
  };

  const verdicts = new Map<string, Promise<boolean>>();
  async function allowed(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return true; // no network: the page's own bytes
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (allowOrigins.has(parsed.origin)) return true;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return isPublicAddress(host);
    let verdict = verdicts.get(host);
    if (!verdict) {
      verdict = lookup(host, { all: true, verbatim: true }).then(
        (addresses) => addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address)),
        () => false,
      );
      verdicts.set(host, verdict);
    }
    return verdict;
  }

  // Every request is fetched here, one hop at a time, so each redirect's target is checked before it is followed:
  // Playwright calls a route only for a redirect chain's first URL. The browser follows a passed-on redirect as a new
  // request, which comes back through this route.
  async function guard(route: Route) {
    const request = route.request();
    if (!(await allowed(request.url()))) return route.abort("blockedbyclient");
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (response.status() >= 300 && response.status() < 400 && location) {
        if (!(await allowed(new URL(location, request.url()).href))) return route.abort("blockedbyclient");
      }
      return await route.fulfill({ response });
    } catch {
      return route.abort("failed").catch(() => undefined); // the context closed under it, or the fetch failed
    }
  }

  async function capture(context: BrowserContext, url: string, deadline: number): Promise<Capture> {
    const page = await context.newPage();
    let popupsClosed = 0;
    context.on("page", (other) => {
      if (other !== page) {
        popupsClosed++;
        other.close().catch(() => undefined);
      }
    });
    const downloads: Promise<string | null>[] = [];
    page.on("download", (download) => downloads.push(download.path().catch(() => null)));
    const response = await page.goto(url, { waitUntil: "load", timeout: Math.max(1, deadline - Date.now()) });
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(SETTLE_MS, Math.max(1, deadline - Date.now())) })
      .catch(
        () => undefined, // a page that keeps polling has still settled enough after 3 seconds
      );
    // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const title = await page.title();
    const flags = await page.evaluate(readFormFlags);
    const walls = await page.evaluate(readWalls);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    // Only the kept 1280 by 2000 pixels are captured (§5 found full captures of very tall pages crash the browser).
    const shot = await page.screenshot({
      type: "png",
      fullPage: true,
      clip: { x: 0, y: 0, width: MAX_WIDTH, height: Math.max(1, Math.min(MAX_HEIGHT, height)) },
      timeout: Math.max(1, deadline - Date.now()),
    });
    const written = (await Promise.all(downloads)).filter((path) => path !== null).length;
    return {
      listed: url,
      finalUrl: page.url(),
      status: response?.status() ?? 0,
      title,
      text: text
        .replace(/[ \t\f\v\r]+/g, " ")
        .replace(/ *\n[\n ]*/g, "\n")
        .trim(),
      screenshot: await normaliseScreenshot(new Uint8Array(shot)),
      ...flags,
      ...walls,
      downloadsWritten: written,
      popupsClosed,
      serviceWorkers: context.serviceWorkers().length,
    };
  }

  async function render(url: string): Promise<Capture> {
    const browser = await current();
    const context = await browser.newContext({
      viewport: { width: MAX_WIDTH, height: 800 },
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      ignoreHTTPSErrors: false,
    });
    contexts.add(context);
    const deadline = Date.now() + limitMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      await context.routeWebSocket(/.*/, (socket) => socket.close());
      await context.route("**/*", guard);
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeout(`the render passed ${limitMs / 1000} seconds`)), limitMs);
      });
      return await Promise.race([capture(context, url, deadline), limit]);
    } catch (error) {
      if (error instanceof RenderTimeout || /Timeout \d+ms exceeded/.test((error as Error).message))
        throw new RenderTimeout((error as Error).message.split("\n")[0]);
      throw error;
    } finally {
      clearTimeout(timer);
      contexts.delete(context);
      await context.close().catch(() => undefined); // a context of a crashed browser has nothing left to close
    }
  }

  return {
    render,
    openContexts: () => contexts.size,
    close: async () => {
      const open = session;
      session = null;
      if (open) await (await open).close();
    },
  };
}

// The journal: one JSON line per event, `started` before a render and `stored`, `excluded` or `retry` after it.
export type JournalEvent = {
  url: string;
  event: "started" | "stored" | "excluded" | "retry";
  id?: string;
  reason?: string;
  at: string;
};

// The journal's events, with a last line cut short by a stop dropped and the file rewritten whole (temp-then-rename).
export function readJournal(path: string): JournalEvent[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const events: JournalEvent[] = [];
  let repaired = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      const last = lines.slice(index + 1).every((rest) => !rest.trim());
      if (!last) throw new Error(`${path} line ${index + 1} does not parse: ${(error as Error).message}`);
      repaired = true;
    }
  }
  if (repaired) {
    const temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  }
  return events;
}

export function appendJournal(path: string, event: Omit<JournalEvent, "at">): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type BatchResult = { stored: number; excluded: number; retry: number; skipped: number; recovered: number };

export async function runBatch(options: {
  list: UrlList;
  store: ReturnType<typeof openStore>;
  journal: string;
  render: (url: string) => Promise<Capture>;
  concurrency?: number;
  // Between storing a page and recording it; a test stops the run here.
  afterStore?: (url: string) => void;
  log?: (line: string) => void;
}): Promise<BatchResult> {
  const { list, store, journal } = options;
  assertListLicence(list);
  mkdirSync(resolve(journal, ".."), { recursive: true });
  const state = new Map<string, { outcome?: "stored" | "excluded"; open: boolean; retries: number }>();
  for (const event of readJournal(journal)) {
    const entry = state.get(event.url) ?? { open: false, retries: 0 };
    if (event.event === "started") entry.open = true;
    else {
      entry.open = false;
      if (event.event === "retry") entry.retries++;
      else entry.outcome = event.event;
    }
    state.set(event.url, entry);
  }
  const byUrl = new Map(store.manifest().flatMap((page) => (page.url ? [[page.url, page.id] as const] : [])));
  const result: BatchResult = { stored: 0, excluded: 0, retry: 0, skipped: 0, recovered: 0 };
  const source = list.name === "majestic" ? "benign-majestic" : `benign-${list.name.replace(/^benign-/, "")}`;
  let next = 0;
  let done = 0;
  async function one(entry: ListEntry) {
    const known = state.get(entry.url);
    if (known?.outcome || (known?.retries ?? 0) >= MAX_TRIES) {
      result.skipped++;
      return;
    }
    // Started with no outcome: the run stopped mid-page. A page already stored for it is recorded, not made again.
    const stored = known?.open ? byUrl.get(entry.url) : undefined;
    if (stored) {
      appendJournal(journal, { url: entry.url, event: "stored", id: stored });
      result.recovered++;
      return;
    }
    appendJournal(journal, { url: entry.url, event: "started" });
    let capture: Capture;
    try {
      capture = await options.render(entry.url);
    } catch (error) {
      const reason = (error as Error).message.split("\n")[0] ?? "render failed";
      if (error instanceof RenderTimeout) return retry(entry, known?.retries ?? 0, reason);
      appendJournal(journal, { url: entry.url, event: "excluded", reason });
      result.excluded++;
      return;
    }
    if (capture.status >= 500) return retry(entry, known?.retries ?? 0, `HTTP ${capture.status}`);
    const reason = unusable(capture, entry);
    if (reason) {
      appendJournal(journal, { url: entry.url, event: "excluded", reason });
      result.excluded++;
      return;
    }
    const host = new URL(capture.finalUrl).hostname.toLowerCase();
    const id = await store.putPage(source, {
      screenshot: capture.screenshot,
      text: capture.text,
      origin: "benign",
      licence: `${list.name}: ${list.licence}`,
      host: HOST.test(host) ? host : null,
      template: null,
      south_africa: list.southAfrica || host.endsWith(".za"),
      labels: {
        lure: false,
        lure_type: "none",
        has_login_form: capture.has_login_form,
        has_payment_form: capture.has_payment_form,
        ...(entry.brand ? { brand: entry.brand } : {}),
      },
      label_source: {
        lure: "ground-truth",
        lure_type: "ground-truth",
        has_login_form: "dom",
        has_payment_form: "dom",
        ...(entry.brand ? { brand: "ground-truth" as const } : {}),
      },
      redacted: false,
      url: entry.url,
      kind: entry.kind,
    });
    options.afterStore?.(entry.url);
    appendJournal(journal, { url: entry.url, event: "stored", id });
    result.stored++;
  }
  function retry(entry: ListEntry, tries: number, reason: string) {
    // A timeout or a server error is tried again on a rerun, three times in all, then excluded.
    if (tries + 1 >= MAX_TRIES) {
      appendJournal(journal, { url: entry.url, event: "excluded", reason: `${reason} (${MAX_TRIES} tries)` });
      result.excluded++;
    } else {
      appendJournal(journal, { url: entry.url, event: "retry", reason });
      result.retry++;
    }
  }
  async function worker() {
    while (next < list.entries.length) {
      const entry = list.entries[next++] as ListEntry;
      await one(entry);
      if (++done % 100 === 0)
        options.log?.(`${list.name}: ${done} of ${list.entries.length} ${JSON.stringify(result)}`);
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
  return result;
}

export const COVERAGE_MINIMUMS = { total: 3000, southAfrica: 300, signIn: 120, shop: 40, company: 40, social: 20 };

// What the store's benign renders cover, counted from pages of origin `benign` only, each read back whole first.
export function benignCoverage(store: Pick<ReturnType<typeof openStore>, "manifest" | "readPage">) {
  const problems: string[] = [];
  const byKind: Record<string, number> = {};
  let total = 0;
  let southAfrica = 0;
  for (const page of store.manifest().filter((p) => p.origin === "benign")) {
    const fault = pageFault(store, page);
    if (fault) {
      problems.push(`${page.id}: ${fault}`);
      continue;
    }
    total++;
    if (page.south_africa) southAfrica++;
    if (page.kind) byKind[page.kind] = (byKind[page.kind] ?? 0) + 1;
  }
  const signIn = (byKind.login ?? 0) + (byKind.checkout ?? 0) + (byKind.account ?? 0);
  const counts = {
    total,
    southAfrica,
    signIn,
    shop: byKind.shop ?? 0,
    company: byKind.company ?? 0,
    social: byKind.social ?? 0,
  };
  const short = Object.entries(COVERAGE_MINIMUMS)
    .filter(([key, minimum]) => counts[key as keyof typeof counts] < minimum)
    .map(([key, minimum]) => `${key} ${counts[key as keyof typeof counts]} of ${minimum}`);
  return { ...counts, byKind, problems, short, met: short.length === 0 && problems.length === 0 };
}

function pageFault(store: Pick<ReturnType<typeof openStore>, "readPage">, page: StoredPage): string | null {
  const { screenshot, text } = store.readPage(page.id);
  const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
  if (hash(screenshot) !== page.sha256.screenshot || hash(text) !== page.sha256.text) return "files do not match";
  if (page.labels.lure !== false || page.label_source.lure !== "ground-truth") return "not a ground-truth benign page";
  if (
    page.kind &&
    page.kind !== "home" &&
    (!page.labels.brand || !page.south_africa || page.label_source.brand !== "ground-truth")
  )
    return "a South African list page without its brand or region";
  return null;
}

if (import.meta.filename === process.argv[1]) {
  const [command, only] = process.argv.slice(2);
  const dir = storeDir();
  const store = openStore(dir);
  if (command === "coverage") {
    const coverage = benignCoverage(store);
    console.log(JSON.stringify({ ...coverage, problems: coverage.problems.slice(0, 20) }, null, 2));
    process.exit(coverage.met ? 0 : 1);
  }
  if (command !== "run" || (only && only !== "majestic" && only !== "benign-sa")) {
    console.error("usage: node scripts/glimmer/render.ts run [majestic|benign-sa] | coverage");
    process.exit(2);
  }
  const lists: UrlList[] = [];
  if (!only || only === "benign-sa")
    lists.push(saList(readFileSync(join(ROOT, "eval/glimmer/benign-sa-urls.txt"), "utf-8")));
  if (!only || only === "majestic") lists.push(majesticList(readFileSync(join(dir, "raw/majestic/top.csv"), "utf-8")));
  const renderer = await openRenderer();
  try {
    for (const list of lists) {
      const result = await runBatch({
        list,
        store,
        journal: join(dir, "raw/benign/progress.jsonl"),
        render: renderer.render,
        log: (line) => console.log(line),
      });
      console.log(`${list.name}: ${JSON.stringify(result)}`);
    }
  } finally {
    await renderer.close();
  }
}
