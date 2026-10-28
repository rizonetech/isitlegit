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
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type Browser, type BrowserContext, chromium, type Page, type Route } from "playwright-core";
import { getDomain } from "tldts";
import { HOST } from "../../src/vision/page-screen.ts";
import { chromiumPath } from "../lib/chromium.ts";
import { bounded, type FormFlags, normaliseScreenshot, readFormFlags, shownText } from "./source-pages.ts";
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
    if (!(PAGE_KINDS as readonly string[]).includes(kind))
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
// The page's own server answered with an error status that Chromium turned into a failed navigation (an empty 4xx or
// 5xx body is `net::ERR_HTTP_RESPONSE_CODE_FAILURE` in some Chromium builds): the status, not the browser's error.
export class HttpStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// Signs that the page is not the site but a wall in front of it. Run inside the page.
export function readWalls(): { captcha: boolean; consentWall: boolean } {
  const width = innerWidth;
  const height = innerHeight;
  const area = (el: Element) => {
    const box = el.getBoundingClientRect();
    return (
      Math.max(0, Math.min(box.right, width) - Math.max(box.left, 0)) *
      Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0))
    );
  };
  const shown = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const frames = [...document.querySelectorAll("iframe")];
  // A challenge the viewer must solve, not a protection badge: a visible CAPTCHA frame larger than a corner badge.
  const captcha = frames.some((frame) => {
    if (
      !/recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i.test(frame.src || "")
    )
      return false;
    const box = frame.getBoundingClientRect();
    return shown(frame) && box.width >= 150 && box.height >= 100 && area(frame) > 0;
  });
  const consentWords =
    /we use cookies|accept (all )?cookies|(cookie|privacy) (settings|preferences)|manage cookies|consent to|your consent/i;
  // A consent provider's own frame in front of the page.
  const providerFrame = frames.some(
    (frame) =>
      /consent|cookiebot|onetrust|cookielaw|didomi|trustarc|quantcast|consensu\.org|privacy-mgmt|sourcepoint|usercentrics|cookiefirst|iubenda/i.test(
        frame.src || "",
      ) &&
      shown(frame) &&
      area(frame) >= 0.15 * width * height,
  );
  let covering = false;
  let backdrop = false;
  let dialog = false;
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "absolute") continue;
    if (!shown(el)) continue;
    // biome-ignore lint/performance/useDomNodeTextContent: what the overlay shows is the point
    const text = (el as HTMLElement).innerText || "";
    const big = area(el) >= 0.5 * width * height;
    // A consent wall asks for consent; a page wrapped whole in a positioned frame (Microsoft's sign-in) only links
    // its "Privacy & cookies" policy in a footer.
    if (big && text.length < 3000 && consentWords.test(text)) covering = true;
    // A full-screen backdrop with almost nothing written on it, and a consent dialog of any size above the page.
    if (big && text.trim().length < 40) backdrop = true;
    if (text.length < 3000 && consentWords.test(text)) dialog = true;
  }
  return { captcha, consentWall: covering || providerFrame || (backdrop && dialog) };
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
  // A brand's social profile lives on someone else's site: one that lands on that site's sign-in page is the network's
  // page, not the brand's, so its brand label would be wrong. (A brand's own page that lands elsewhere on its own site
  // is still the brand's, and `capturedKind` records which kind it shows.)
  if (entry.kind === "social" && SIGN_IN_PATH.test(new URL(capture.finalUrl).pathname))
    return `redirected to a sign-in page, not the ${entry.kind} page listed`;
  if (entry.brand && !brandShown(entry.brand, capture)) return `the listed brand (${entry.brand}) is not on the page`;
  return null;
}

const SIGN_IN_PATH =
  /(^|\/)(log-?in|sign-?in|signin|auth|authenticate|accounts?\/login|session\/new|oauth2?)(\/|$|\?|\.)/i;

const ROOT_PATH = /^\/([a-z]{2}([-_][a-z]{2})?\/?)?(index\.html?)?$/i;
const ACCOUNT_PATH = /(^|\/)(my-?account|account|profile|e-?services|self-?service|portal|online-?services)(\/|$|\.)/i;
const CART_PATH = /(^|\/)(cart|basket|checkout|bag|trolley|mycart)(\/|$|\.)/i;
const PRODUCT_PATH = /(^|\/)(p|pd|product|products|item|dp)\/[^/]{3,}/i;
const COMPANY_PATH =
  /(^|\/|-)(about|who-?we-?are|our-?(story|company)|company-?profile|at-a-glance|contact|corporate|investors?|group)(\/|$|\.|-|_)/i;

// The kind a capture shows: its listed kind when the page bears it out, otherwise `home` (a real page of the site, but
// not the sign-in, cart, product or about page the list names), so a kind's count is of pages of that kind.
export function capturedKind(
  entry: Pick<ListEntry, "kind">,
  capture: Pick<Capture, "finalUrl" | "title" | "text" | "has_login_form" | "has_payment_form">,
): Kind {
  const path = new URL(capture.finalUrl).pathname;
  const shown = `${capture.title}\n${capture.text.slice(0, 4000)}`;
  switch (entry.kind) {
    case "login":
      return capture.has_login_form ? "login" : "home";
    case "account":
      return capture.has_login_form || ACCOUNT_PATH.test(path) ? "account" : "home";
    case "checkout":
      return capture.has_payment_form || CART_PATH.test(path) ? "checkout" : "home";
    case "shop":
      return !ROOT_PATH.test(path) &&
        (CART_PATH.test(path) || PRODUCT_PATH.test(path) || /add to (cart|basket|bag|trolley)|buy now/i.test(shown))
        ? "shop"
        : "home";
    case "company":
      return !ROOT_PATH.test(path) &&
        (COMPANY_PATH.test(path) ||
          /about us|who we are|contact us|our story|company profile|at a glance/i.test(capture.title))
        ? "company"
        : "home";
    default:
      return entry.kind;
  }
}

// Words a brand's name shares with many others, which on their own do not show the brand.
const GENERIC_WORDS = new Set(
  "the and city bank group online south africa african limited ltd pty company municipality metropolitan metro store shop mobile insurance services".split(
    " ",
  ),
);

// Whether a listed brand is on the page: any word of its name (three letters or more, or the whole short name) in the
// title, the text or the host.
export function brandShown(brand: string, capture: Pick<Capture, "title" | "text" | "finalUrl">): boolean {
  const haystack = `${capture.title}\n${capture.text}\n${new URL(capture.finalUrl).hostname}`.toLowerCase();
  const words = brand
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  const tokens = words.length ? words : [brand.toLowerCase()];
  return tokens.some((word) => haystack.includes(word));
}

// The address a connection may use: every one the name resolves to must be public, checked when the socket connects,
// so a name that resolves publicly for a check and privately for the connection never reaches a private address.
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolve: Resolve = (host) => lookup(host, { all: true, verbatim: true });

export function publicLookup(resolve: Resolve = systemResolve) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    resolve(hostname).then(
      (addresses) => {
        const refused = addresses.find((a) => !isPublicAddress(a.address));
        if (!addresses.length || refused)
          return callback(
            Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "EPRIVATE" }),
          );
        if (options.all) return callback(null, addresses);
        const first = addresses[0] as { address: string; family: number };
        return callback(null, first.address, first.family);
      },
      (error: Error) => callback(error),
    );
  };
}

export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
type Hop = { status: number; headers: Record<string, string>; body: Buffer };

// One request, one hop, no redirect followed, over a socket whose address `lookup` checked; uncompressed, so the bytes
// reach the browser as they are; at most 20 MB.
function fetchHop(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  lookupFn: ReturnType<typeof publicLookup> | undefined,
  timeoutMs: number,
): Promise<Hop> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const outgoing = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !/^(host|connection|accept-encoding|content-length|:)/i.test(name)),
  );
  return new Promise((resolveHop, reject) => {
    const req = send(
      url,
      {
        method,
        headers: { ...outgoing, "accept-encoding": "identity" },
        ...(lookupFn ? { lookup: lookupFn as never } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        // A server may compress although asked not to: the body reaches the browser decoded, since the encoding header
        // is not passed on, and the 20 MB bound counts the decoded bytes.
        const encoding = String(res.headers["content-encoding"] ?? "")
          .toLowerCase()
          .trim();
        const decoder =
          encoding === "gzip" || encoding === "x-gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : null;
        const stream: Readable = decoder ? res.pipe(decoder) : res;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`the response is over ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`));
            decoder?.destroy();
            return;
          }
          chunks.push(chunk);
        });
        decoder?.on("error", reject);
        stream.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined || /^(content-encoding|transfer-encoding|content-length|connection)$/i.test(name))
              continue;
            flat[name] = Array.isArray(value) ? value.join("\n") : String(value);
          }
          resolveHop({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("the request timed out")));
    req.on("error", reject);
    if (body?.length) req.write(body);
    req.end();
  });
}

export async function openRenderer(options: { allowOrigins?: string[]; limitMs?: number; resolve?: Resolve } = {}) {
  const found = chromiumPath();
  if (!found) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const executablePath: string = found;
  const allowOrigins = new Set(options.allowOrigins ?? []);
  const limitMs = options.limitMs ?? RENDER_LIMIT_MS;
  const checkedLookup = publicLookup(options.resolve);
  let session: Promise<Browser> | null = null;
  let launched = 0;
  const contexts = new Set<BrowserContext>();
  const current = () => {
    session ??= chromium.launch({ executablePath, chromiumSandbox: true, args: ["--no-first-run"] }).then((browser) => {
      launched++;
      browser.on("disconnected", () => {
        session = null;
      });
      return browser;
    });
    return session;
  };

  // A request may leave only for http or https (data and blob carry the page's own bytes); an address in the URL itself
  // must be public. A name is checked where it is connected to (`publicLookup`).
  function allowedUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return true;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (allowOrigins.has(parsed.origin)) return true;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return isIP(host) ? isPublicAddress(host) : true;
  }

  // Every request is fetched here, one hop at a time, over a connection whose address was checked as it connected; a
  // redirect is passed to the browser, which follows it as a new request through this same route (Playwright calls a
  // route only for a redirect chain's first URL, so the route never follows one itself).
  const mainStatus = new WeakMap<Page, number>();
  async function guard(route: Route, deadline: number) {
    const request = route.request();
    if (!allowedUrl(request.url())) return route.abort("blockedbyclient");
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    try {
      const hop = await fetchHop(
        url,
        request.method(),
        await request.allHeaders(),
        request.postDataBuffer(),
        allowOrigins.has(url.origin) ? undefined : checkedLookup,
        Math.max(1, deadline - Date.now()),
      );
      const location = hop.headers.location;
      if (hop.status >= 300 && hop.status < 400 && location && !allowedUrl(new URL(location, url).href))
        return route.abort("blockedbyclient");
      const frame = request.frame();
      if (request.isNavigationRequest() && !frame.parentFrame()) mainStatus.set(frame.page(), hop.status);
      return await route.fulfill({ status: hop.status, headers: hop.headers, body: hop.body });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return route.abort(code === "EPRIVATE" ? "blockedbyclient" : "failed").catch(() => undefined);
    }
  }

  async function capture(context: BrowserContext, url: string, deadline: number): Promise<Capture> {
    const page = await context.newPage();
    let popupsClosed = 0;
    context.on("page", (other) => {
      if (other !== page) {
        void other.close().then(
          () => {
            popupsClosed++;
          },
          () => undefined,
        );
      }
    });
    const downloads: Promise<string | null>[] = [];
    page.on("download", (download) => downloads.push(download.path().catch(() => null)));
    const left = () => Math.max(1, deadline - Date.now());
    const response = await page.goto(url, { waitUntil: "load", timeout: left() }).catch((error: Error) => {
      const status = mainStatus.get(page);
      if (status !== undefined && status >= 400) throw new HttpStatus(status);
      throw error;
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(SETTLE_MS, left()) }).catch(
      () => undefined, // a page that keeps polling has still settled enough after 3 seconds
    );
    // The page and every frame in it, cross-origin and nested ones included: a sign-in form inside an identity
    // provider's frame is still the page's sign-in form, and its text is still what the viewer reads.
    const frames = page.frames();
    const readFrame = async <T>(frame: (typeof frames)[number], fn: () => T, fallback: T): Promise<T> => {
      try {
        return await frame.evaluate(fn);
      } catch {
        return fallback; // a frame that went away or never loaded reads as empty
      }
    };
    let text = await page.evaluate(shownText);
    let has_login_form = false;
    let has_payment_form = false;
    for (const frame of frames) {
      const flags = await readFrame(frame, readFormFlags, { has_login_form: false, has_payment_form: false });
      has_login_form ||= flags.has_login_form;
      has_payment_form ||= flags.has_payment_form;
      if (frame !== page.mainFrame()) {
        const shown = await frame.frameElement().then(
          (el) => el.isVisible(),
          () => false,
        );
        if (shown) text += `\n${await readFrame(frame, shownText, "")}`;
      }
    }
    const title = await page.title();
    const walls = await page.evaluate(readWalls);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    // Only the kept 1280 by 2000 pixels are captured (§5 found full captures of very tall pages crash the browser).
    const shot = await page.screenshot({
      type: "png",
      fullPage: true,
      clip: { x: 0, y: 0, width: MAX_WIDTH, height: Math.max(1, Math.min(MAX_HEIGHT, height)) },
      timeout: left(),
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
      has_login_form,
      has_payment_form,
      ...walls,
      downloadsWritten: written,
      popupsClosed,
      serviceWorkers: context.serviceWorkers().length,
    };
  }

  // The whole render, the browser's start and the context's setup included, runs under one deadline; the context's
  // close gets 5 seconds more, and a browser that does not close it is dropped, so no worker waits on it again.
  async function render(url: string): Promise<Capture> {
    const deadline = Date.now() + limitMs;
    let timer: NodeJS.Timeout | undefined;
    let context: BrowserContext | undefined;
    let browser: Browser | undefined;
    let abandoned = false;
    const mine = current();
    const work = (async () => {
      browser = await mine;
      const made = await browser.newContext({
        viewport: { width: MAX_WIDTH, height: 800 },
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
        ignoreHTTPSErrors: false,
      });
      // Made after the deadline gave up on this render: closed here, since nothing else will.
      if (abandoned) {
        void bounded(made.close());
        throw new RenderTimeout("the render passed its deadline while its context was made");
      }
      context = made;
      contexts.add(context);
      await context.routeWebSocket(/.*/, (socket) => socket.close());
      await context.route("**/*", (route) => guard(route, deadline));
      return capture(context, url, deadline);
    })();
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RenderTimeout(`the render passed ${limitMs / 1000} seconds`)), limitMs);
    });
    try {
      return await Promise.race([work, limit]);
    } catch (error) {
      if (error instanceof RenderTimeout || /Timeout \d+ms exceeded/.test((error as Error).message))
        throw new RenderTimeout((error as Error).message.split("\n")[0]);
      throw error;
    } finally {
      abandoned = true;
      clearTimeout(timer);
      work.catch(() => undefined); // a render abandoned at its deadline still settles somewhere: nothing waits on it
      if (context) {
        contexts.delete(context);
        if (!(await bounded(context.close()))) {
          // The browser did not close the context: it is dropped, and the next render starts a new one.
          if (session === mine) session = null;
          if (browser) void bounded(browser.close());
        }
      }
    }
  }

  return {
    render,
    openContexts: () => contexts.size,
    launches: () => launched,
    close: async () => {
      const open = session;
      session = null;
      if (open) await bounded(open.then((b) => b.close()));
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

// Network failures that pass: tried again on a rerun, like a timeout or a 5xx, three times in all.
const TRANSIENT =
  /net::ERR_(CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT|ABORTED)|TIMED_OUT|NETWORK_CHANGED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE)/;

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
      if (
        error instanceof RenderTimeout ||
        (error instanceof HttpStatus && (error.status >= 500 || error.status === 429)) ||
        TRANSIENT.test(reason)
      )
        return retry(entry, known?.retries ?? 0, reason);
      appendJournal(journal, { url: entry.url, event: "excluded", reason });
      result.excluded++;
      return;
    }
    if (capture.status >= 500 || capture.status === 429)
      return retry(entry, known?.retries ?? 0, `HTTP ${capture.status}`);
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
      kind: capturedKind(entry, capture),
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
  if (page.labels.lure_type !== "none" || page.label_source.lure_type !== "ground-truth")
    return "no ground-truth lure type of none";
  for (const flag of ["has_login_form", "has_payment_form"] as const)
    if (typeof page.labels[flag] !== "boolean" || page.label_source[flag] !== "dom") return `no DOM-read ${flag}`;
  if (!page.kind) return "no listed kind";
  if (!page.url || !/^https?:\/\//.test(page.url)) return "no listed URL";
  if (page.kind !== "home" && (!page.labels.brand || !page.south_africa || page.label_source.brand !== "ground-truth"))
    return "a South African list page without its brand or region";
  return null;
}

if (import.meta.filename === process.argv[1]) {
  const [given, only] = process.argv.slice(2);
  // `--coverage` is the spelling §6's checkpoint names; `coverage` the subcommand's.
  const command = given === "--coverage" ? "coverage" : given;
  const dir = storeDir();
  const store = openStore(dir);
  if (command === "coverage") {
    const coverage = benignCoverage(store);
    console.log(JSON.stringify({ ...coverage, problems: coverage.problems.slice(0, 20) }, null, 2));
    process.exit(coverage.met ? 0 : 1);
  }
  if (command !== "run" || (only && only !== "majestic" && only !== "benign-sa")) {
    console.error("usage: node scripts/glimmer/render.ts run [majestic|benign-sa] | coverage | --coverage");
    process.exit(2);
  }
  const lists: UrlList[] = [];
  if (!only || only === "benign-sa")
    lists.push(saList(readFileSync(join(ROOT, "eval/glimmer/benign-sa-urls.txt"), "utf-8")));
  if (!only || only === "majestic") lists.push(majesticList(readFileSync(join(dir, "raw/majestic/top.csv"), "utf-8")));
  const renderer = await openRenderer();
  try {
    for (const list of lists) {
      // A page that timed out or met a passing failure is tried again in the same run, up to three tries in all, so
      // one command leaves every URL stored or excluded.
      for (let pass = 1; pass <= MAX_TRIES; pass++) {
        const result = await runBatch({
          list,
          store,
          journal: join(dir, "raw/benign/progress.jsonl"),
          render: renderer.render,
          log: (line) => console.log(line),
        });
        console.log(`${list.name}: ${JSON.stringify(result)}`);
        if (result.retry === 0) break;
      }
    }
  } finally {
    await renderer.close();
  }
}
