// Benign real pages rendered locally (D03 T04 §6): the screener must tell lures from the real pages they copy, so real
// homepages, sign-in, checkout, shop, company and social pages are rendered by our own browser from known-good lists.
//
//   node scripts/glimmer/render.ts run [majestic|benign-sa]   # render the lists (both by default), resumable
//   node scripts/glimmer/render.ts coverage                    # what the benign pages in the store cover
//
// Lists: `raw/majestic/top.csv` in the store (the Majestic Million's top 20,000 domains and the 576 highest-ranked `.za`
// not among them, CC BY 3.0) and `eval/glimmer/benign-sa-urls.txt` (our own: `<kind>\t<url>\t<brand>[\t<also domains>]`). A list is
// rendered only when its licence is on the commercial-use allowlist. Each render gets a fresh browser context: 1280 by
// 2000 (the crop the screenshot keeps, so readers and picture share one layout; §6 set 1280 by 800, corrected by §26),
// downloads, permissions, pop-ups, service workers and WebSockets refused, no stored credentials, 20 seconds in
// all; every request and every redirect hop goes only to public addresses. A capture is stored only when usable: HTTP
// 2xx, still on the listed site, at least 50 characters of visible text, and no challenge, CAPTCHA or consent wall.
// Each URL's outcome goes to `raw/benign/progress.jsonl`, so a stopped run resumes without storing a page twice.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { type AddressInfo, isIP, connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { getDomain } from "tldts";
import { HOST } from "../../src/vision/page-screen.ts";
import { chromiumPath } from "../lib/chromium.ts";
import {
  bounded,
  CHALLENGE,
  type FormFlags,
  NO_SITE,
  NOT_FOUND,
  normaliseScreenshot,
  readFormFlags,
  readWalls,
  shownText,
  wallShown,
} from "./source-pages.ts";

export { CHALLENGE, NO_SITE, NOT_FOUND, readWalls, wallShown };

import { MAX_HEIGHT, MAX_WIDTH, openStore, PAGE_KINDS, type PageInput, type StoredPage, storeDir } from "./store.ts";

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
  // The text of what is drawn over the page (shown fixed elements, and absolute ones covering half the view), in the
  // page and every shown frame, and whether a near-empty cover over a page carrying a bot-wall vendor's script hides it.
  overlays: string;
  challengeCover: boolean;
  // A large picture with few words of its own was on the page: what OCR read off the screenshot ("" when none was).
  imageCover: boolean;
  imageText: string;
  downloadsWritten: number;
  popupsClosed: number;
  serviceWorkers: number;
} & FormFlags;

export class RenderTimeout extends Error {}
// A capture that did not hold still, or kept a frame unread, through two tries: excluded with its reason.
export class Unsettled extends Error {}
// The browser failed to start or to open its first page: the renderer's fault, never the listed page's, so the batch
// tries the page again on a later run instead of excluding it (§26, plan review gap 10).
export class BrowserFault extends Error {}
// The page's own server answered with an error status that Chromium turned into a failed navigation (an empty 4xx or
// 5xx body is `net::ERR_HTTP_RESPONSE_CODE_FAILURE` in some Chromium builds): the status, not the browser's error.
export class HttpStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// A frame's owner element as its document lays it out, run on that element (`this`) in the document's isolated world:
// whether it is shown (a size, and not hidden by itself or an ancestor), and where its content box sits.
const OWNER_BOX = `function () {
  const box = this.getBoundingClientRect();
  // A transform scales the frame: its drawn box against its layout size gives the scale its content is drawn at.
  const scaleX = this.offsetWidth > 0 ? box.width / this.offsetWidth : 1;
  const scaleY = this.offsetHeight > 0 ? box.height / this.offsetHeight : 1;
  const left = box.left + this.clientLeft * scaleX;
  const top = box.top + this.clientTop * scaleY;
  // The ancestors that clip their overflow cut what of the frame can show (checkVisibility does not see clipping),
  // across a shadow root to its host too.
  let clip = { left, top, right: left + this.clientWidth * scaleX, bottom: top + this.clientHeight * scaleY };
  const up = (el) => el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
  for (let at = up(this); at; at = up(at)) {
    const style = getComputedStyle(at);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const outer = at.getBoundingClientRect();
    if (style.overflowX !== "visible") clip = { ...clip, left: Math.max(clip.left, outer.left), right: Math.min(clip.right, outer.right) };
    if (style.overflowY !== "visible") clip = { ...clip, top: Math.max(clip.top, outer.top), bottom: Math.min(clip.bottom, outer.bottom) };
  }
  return {
    shown:
      box.width > 0 &&
      box.height > 0 &&
      this.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      // Not painted over: the frame element is on top at one of its centre and inset corners within the view.
      [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].some(([fx, fy]) => {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        return this.getRootNode().elementFromPoint(x, y) === this;
      }),
    left,
    top,
    scaleX,
    scaleY,
    clip,
  };
}`;

// One reading of a page: its text, form flags and walls from the page and every frame a viewer sees, and how many shown
// frames could not be read.
export type Reading = {
  url: string;
  title: string;
  text: string;
  has_login_form: boolean;
  has_payment_form: boolean;
  walls: ReturnType<typeof readWalls>;
  unreadable: number;
  height: number;
};

const steady = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// Two readings agree when nothing a label rests on moved between them: the address, the title, the form flags, the
// walls, whether the text shows one, the text and overlays themselves with digits set aside (a clock may move), and
// what admission reads off the text with its digits ("Error 0" becoming "Error 404" is a different page).
export function readingsAgree(a: Reading, b: Reading): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.has_login_form === b.has_login_form &&
    a.has_payment_form === b.has_payment_form &&
    a.walls.captcha === b.walls.captcha &&
    a.walls.consentWall === b.walls.consentWall &&
    a.walls.challengeCover === b.walls.challengeCover &&
    wallShown({ ...a, overlays: a.walls.overlays }) === wallShown({ ...b, overlays: b.walls.overlays }) &&
    steady(a.text) === steady(b.text) &&
    steady(a.walls.overlays) === steady(b.walls.overlays) &&
    NOT_FOUND.test(`${a.title}\n${a.text.slice(0, 3000)}`) === NOT_FOUND.test(`${b.title}\n${b.text.slice(0, 3000)}`) &&
    a.text.trim().length < MIN_TEXT === b.text.trim().length < MIN_TEXT
  );
}

// A screenshot's words, read by §7's OCR engine from a temporary file that is removed after.
async function ocrScreenshot(png: Uint8Array): Promise<string> {
  const { systemOcr } = await import("./import-samples.ts");
  const folder = mkdtempSync(join(tmpdir(), "glimmer-ocr-"));
  try {
    const file = join(folder, "shot.png");
    writeFileSync(file, png);
    const [text] = await systemOcr([file]);
    return text ?? "";
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The readings a stored benign page keeps beside its text, so `recheckStored` applies the refusals admission applied.
export function evidenceOf(capture: Capture): NonNullable<PageInput["evidence"]> {
  return {
    title: capture.title.slice(0, 2000),
    overlays: capture.overlays.slice(0, 8000),
    captcha: capture.captcha,
    consentWall: capture.consentWall,
    challengeCover: capture.challengeCover,
    wall: wallShown(capture),
  };
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
  if (wallShown(capture)) return "a challenge page";
  if (capture.challengeCover) return "a bot challenge drawn over the page";
  // Past a site's navigation, too: an error page's message often follows a long header.
  if (NOT_FOUND.test(`${capture.title}\n${capture.text.slice(0, 3000)}`)) return "an error page answered with 200";
  if (capture.captcha) return "a CAPTCHA frame";
  if (NO_SITE.test(capture.text.slice(0, 2000))) return "a directory listing, an empty placeholder or a suspended host";
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
const COMPANY_PATH =
  /(^|\/|-)(about|who-?we-?are|our-?(story|company)|company-?profile|at-a-glance|contact|corporate|investors?|group)(\/|$|\.|-|_)/i;

const ACCOUNT_WORDS = /my account|sign ?in|log ?in|log on|profile|e-?services|self.?service|register/i;
const CART_WORDS = /\b(cart|basket|trolley|bag|checkout|subtotal|order summary)\b/i;
const SHOP_WORDS = /add to (cart|basket|bag|trolley)|buy now|in stock|out of stock|\bR ?\d[\d ,]*(\.\d{2})?\b/i;
const COMPANY_WORDS =
  /about us|about the|who we are|contact us|our story|our history|our mission|company profile|at a glance|head office|our (company|group|people|values)/i;

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
    // A path names what a page should be; its content must say so too (a stale URL answered with a site's 200
    // fallback page is not its cart).
    case "account":
      return capture.has_login_form || (ACCOUNT_PATH.test(path) && ACCOUNT_WORDS.test(shown)) ? "account" : "home";
    case "checkout":
      return capture.has_payment_form || (CART_PATH.test(path) && CART_WORDS.test(shown)) ? "checkout" : "home";
    case "shop":
      return !ROOT_PATH.test(path) && (SHOP_WORDS.test(shown) || (CART_PATH.test(path) && CART_WORDS.test(shown)))
        ? "shop"
        : "home";
    case "company":
      return !ROOT_PATH.test(path) &&
        COMPANY_WORDS.test(shown) &&
        (COMPANY_PATH.test(path) || COMPANY_WORDS.test(capture.title))
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

// A request the egress proxy refused because its address is not public: excluded, never retried.
export class RefusedAddress extends Error {}
const REFUSED = "x-glimmer-refused";
const HOP_BY_HOP =
  /^(connection|keep-alive|proxy-connection|proxy-authenticate|proxy-authorization|te|trailer|upgrade)$/i;

// The one way out of a render's browser: an HTTP proxy on loopback that Chromium sends every request through, each
// redirect hop included (a Playwright route sees only a chain's first request, so a second hop to a private address
// went straight past it). A plain request is forwarded and a CONNECT tunnelled only over a socket whose address
// `publicLookup` checked as it connected; anything else answers 403 with `x-glimmer-refused` and is recorded. Closing
// it ends every connection it holds, so no request outlives its render.
function openEgress(allowOrigins: Set<string>, checked: ReturnType<typeof publicLookup>) {
  const sockets = new Set<Socket>();
  const refused: string[] = [];
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const isRefused = (error: unknown) => (error as NodeJS.ErrnoException).code === "EPRIVATE";
  const literalRefused = (host: string) => isIP(host) !== 0 && !isPublicAddress(host);

  const server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const allowed = allowOrigins.has(target.origin);
    const refuse = () => {
      refused.push(target.host);
      res.writeHead(403, { [REFUSED]: "non-public address", "content-type": "text/plain" }).end("refused");
    };
    if (target.protocol !== "http:" || (!allowed && literalRefused(host))) return refuse();
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.test(name)));
    const upstream = httpRequest(
      {
        hostname: host,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        ...(allowed ? {} : { lookup: checked as never }),
      },
      (answer) => {
        const raw: string[] = [];
        for (let i = 0; i < answer.rawHeaders.length; i += 2) {
          const name = answer.rawHeaders[i] as string;
          if (!HOP_BY_HOP.test(name)) raw.push(name, answer.rawHeaders[i + 1] as string);
        }
        res.writeHead(answer.statusCode ?? 502, raw);
        answer.pipe(res);
      },
    );
    upstream.on("socket", track);
    upstream.on("error", (error) => {
      if (res.headersSent) return res.destroy();
      if (isRefused(error)) return refuse();
      // A connection the server reset or refused is a 502 the batch tries again, not the browser's bare failure.
      res.writeHead(502, { "x-glimmer-upstream": (error as NodeJS.ErrnoException).code ?? "failed" }).end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", track);
  server.on("connect", (req, client: Socket, head: Buffer) => {
    const authority = req.url ?? "";
    const split = /^\[?([^\]]+?)\]?:(\d+)$/.exec(authority);
    const host = split?.[1] ?? "";
    const port = Number(split?.[2] ?? 0);
    const allowed = allowOrigins.has(`https://${authority}`);
    const answer = (line: string) => client.end(`HTTP/1.1 ${line}\r\n\r\n`);
    if (!split || (!allowed && literalRefused(host))) {
      refused.push(authority);
      return answer(`403 Forbidden\r\n${REFUSED}: non-public address`);
    }
    let open = false;
    const upstream = track(netConnect({ host, port, ...(allowed ? {} : { lookup: checked as never }) }));
    upstream.once("connect", () => {
      open = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (error) => {
      if (open) return client.destroy();
      if (isRefused(error)) {
        refused.push(authority);
        return answer(`403 Forbidden\r\n${REFUSED}: non-public address`);
      }
      answer("502 Bad Gateway");
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  // WebSockets are refused in the browser (`routeWebSocket`); one that reached the proxy is refused here too.
  server.on("upgrade", (_req, socket: Socket) => socket.destroy());

  return {
    refused,
    listen: () =>
      new Promise<string>((done, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      }),
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

// The browser's start has its own bound: one cold start on a loaded machine is not a page's render time.
export const BROWSER_START_MS = 60_000;

// One recorded response in a replay archive (§38): the status, headers and body a request was answered with, and
// the later responses the same URL was answered with on the recorded visit, in order (a polled or re-requested URL).
export type ReplayResponse = { status?: number; headers?: Record<string, string>; bodyBase64: string };
export type ReplayEntry = ReplayResponse & { later?: ReplayResponse[] };
// A replay archive (§38): every request URL the recorded page made, mapped to its recorded response.
export type ReplayArchive = Record<string, ReplayEntry>;
// Answers one replayed visit: each request gets the next recorded response for its exact method, URL and POST body,
// the last one repeating once the recording runs out; an unrecorded request, method or POST body gets null.
export function replayResponder(
  archive: ReplayArchive,
): (url: string, method?: string, postData?: string) => ReplayResponse | null {
  const served = new Map<string, number>();
  return (url, method = "GET", postData = "") => {
    const verb = method.toUpperCase();
    const key = verb === "GET" ? url : `${verb} ${url}${postData ? ` ${postData}` : ""}`;
    const first = archive[key];
    if (!first) return null;
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    const sequence: ReplayResponse[] = [first, ...(first.later ?? [])];
    return sequence[Math.min(n, sequence.length - 1)] ?? null;
  };
}
export function loadReplayArchive(file: string): ReplayArchive {
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`replay archive ${file} is not an object of recorded responses`);
  for (const [url, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = entry as { bodyBase64?: unknown };
    if (typeof e?.bodyBase64 !== "string") throw new Error(`replay archive entry for ${url} has no bodyBase64`);
  }
  return parsed as ReplayArchive;
}

export async function openRenderer(
  options: {
    allowOrigins?: string[];
    limitMs?: number;
    resolve?: Resolve;
    // §38: serve every request from this recorded archive instead of the egress layer, refusing anything not recorded.
    replay?: ReplayArchive;
    // How a browser is started (tests slow it or break it); Chromium's own launch otherwise.
    launch?: (launchOptions: Parameters<typeof chromium.launch>[0]) => Promise<Browser>;
    // A fault to raise when a frame is read (tests make a shown frame unreadable); none otherwise.
    readFault?: (frame: { url: string; main: boolean }) => Error | null;
    // What a screenshot's pixels say (OCR, §7's engine); tests give their own.
    ocr?: (png: Uint8Array) => Promise<string>;
  } = {},
) {
  const found = chromiumPath();
  if (!found) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const executablePath: string = found;
  const allowOrigins = new Set(options.allowOrigins ?? []);
  const limitMs = options.limitMs ?? RENDER_LIMIT_MS;
  const checkedLookup = publicLookup(options.resolve);
  let session: Promise<Browser> | null = null;
  let launched = 0;
  let warmed = 0;
  const contexts = new Set<BrowserContext>();
  const current = () => {
    if (!session) {
      const launch = options.launch ?? ((launchOptions) => chromium.launch(launchOptions));
      const starting = launch({
        executablePath,
        chromiumSandbox: true,
        // WebRTC sends UDP of its own, outside any proxy: only proxied traffic may leave, so it has none.
        args: [
          "--no-first-run",
          // Every frame in the page's own renderer, so the readers' CDP session reaches each one (Playwright's default,
          // kept explicit: a frame left in another process would be counted unread).
          "--disable-site-isolation-trials",
          "--disable-features=IsolateOrigins,site-per-process",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
        timeout: BROWSER_START_MS,
      })
        .then(async (browser) => {
          launched++;
          browser.on("disconnected", () => {
            if (session === starting) session = null;
          });
          // A fresh Chromium's first context and page cost its start-up, not a page's: on a busy CI runner they took
          // nearly all of a render's 8 seconds (2026-10-29). One is made and closed here, under the start-up bound.
          let timer: NodeJS.Timeout | undefined;
          const warm = (async () => {
            const context = await browser.newContext();
            await (await context.newPage()).close();
            await context.close();
          })();
          try {
            await Promise.race([
              warm,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("the browser did not open a page while starting")),
                  BROWSER_START_MS,
                );
              }),
            ]);
          } catch (error) {
            warm.catch(() => undefined);
            void bounded(browser.close());
            throw error;
          } finally {
            clearTimeout(timer);
          }
          warmed++;
          return browser;
        })
        .catch((error: Error) => {
          throw error instanceof BrowserFault ? error : new BrowserFault(`the browser did not start: ${error.message}`);
        });
      // A start that failed is forgotten, so the next page starts the browser again.
      starting.catch(() => {
        if (session === starting) session = null;
      });
      session = starting;
    }
    return session;
  };

  async function capture(
    context: BrowserContext,
    url: string,
    deadline: number,
    egress: ReturnType<typeof openEgress>,
  ): Promise<Capture> {
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
    // The last main-frame document's own answer: a page that navigates on while it settles is judged by the document
    // captured, not by the first one.
    let status: number | undefined;
    let refusedMain = false;
    page.on("response", (answer) => {
      if (answer.request().isNavigationRequest() && answer.frame() === page.mainFrame()) {
        status = answer.status();
        refusedMain = answer.headers()[REFUSED] !== undefined;
      }
    });
    const downloads: Promise<string | null>[] = [];
    page.on("download", (download) => downloads.push(download.path().catch(() => null)));
    const left = () => Math.max(1, deadline - Date.now());
    await page.goto(url, { waitUntil: "load", timeout: left() }).catch((error: Error) => {
      if (refusedMain || (egress.refused.length && /TUNNEL_CONNECTION_FAILED/.test(error.message)))
        throw new RefusedAddress(`refused a non-public address: ${egress.refused.join(", ")}`);
      if (status !== undefined && status >= 400) throw new HttpStatus(status);
      throw error;
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(SETTLE_MS, left()) }).catch(
      () => undefined, // a page that keeps polling has still settled enough after 3 seconds
    );
    if (refusedMain) throw new RefusedAddress(`refused a non-public address: ${egress.refused.join(", ")}`);
    // The page and every frame in it the viewer can see, cross-origin and nested ones included: a sign-in form inside
    // an identity provider's frame is still the page's sign-in form. A frame counts only when every frame element
    // above it is shown (display, visibility, opacity 0 and a zero size all hide it).
    // A frame whose reading failed while it is still attached could not be read: it is counted, never taken for an
    // empty or hidden frame (a sign-in form in it would otherwise read as none). A frame that went away is gone.
    // Every reader runs in an isolated world (§26, plan review gap 1): the page's DOM, but none of its script, so no
    // method or getter the page replaced, on an element, a prototype or a global, changes what is read. Chromium's
    // `Page.createIsolatedWorld` gives one per frame through the page's own CDP session (Playwright's Chromium keeps
    // every frame, cross-origin ones too, in that session).
    const readAll = async (): Promise<Reading> => {
      let unreadable = 0;
      const cdp = await context.newCDPSession(page);
      try {
        type FrameNode = { id: string; parent: string | null; url: string };
        type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] };
        const frames = async (): Promise<FrameNode[]> => {
          const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: Tree };
          const out: FrameNode[] = [];
          const walk = (node: Tree, parent: string | null) => {
            out.push({ id: node.frame.id, parent, url: node.frame.url });
            for (const child of node.childFrames ?? []) walk(child, node.frame.id);
          };
          walk(frameTree, null);
          return out;
        };
        const nodes = await frames();
        // Whether a frame whose reading failed is still on the page: a frame that went away is gone, not unread. When
        // the frame tree itself cannot be read, that is not known, so the frame counts as unread.
        const stillThere = async (id: string) => {
          const now = await frames().catch(() => null);
          return now === null || now.some((node) => node.id === id);
        };
        const worlds = new Map<string, number>();
        const world = async (id: string) => {
          let made = worlds.get(id);
          if (made === undefined) {
            ({ executionContextId: made } = await cdp.send("Page.createIsolatedWorld", {
              frameId: id,
              worldName: "glimmer-reader",
            }));
            worlds.set(id, made);
          }
          return made;
        };
        const evaluate = async <T>(node: FrameNode, fn: (arg?: never) => T, arg?: unknown): Promise<T> => {
          const fault = options.readFault?.({ url: node.url, main: node.parent === null });
          if (fault) throw fault;
          const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
            expression: `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`,
            contextId: await world(node.id),
            returnByValue: true,
          });
          if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
          return result.value as T;
        };
        const readFrame = async <T>(
          node: FrameNode,
          fn: (arg?: never) => T,
          fallback: T,
          arg?: unknown,
        ): Promise<T> => {
          try {
            return await evaluate(node, fn, arg);
          } catch {
            if (await stillThere(node.id)) unreadable++;
            return fallback;
          }
        };
        // Where each frame shows in the screenshot: its owner element's content box, placed through every frame around
        // it and clipped by each one's own visible area, down to the 1280 by 2000 pixels kept. A frame with no area left
        // is not seen; null when an owner could not be read. Parents come before their children in `nodes`.
        type Region = { left: number; top: number; right: number; bottom: number };
        // Where a frame's content starts in the screenshot, the scale it is drawn at there, and the area of it that shows.
        type Placed = { offsetX: number; offsetY: number; scaleX: number; scaleY: number; region: Region };
        const placed = new Map<string, Placed | false | null>();
        const place = async (node: FrameNode): Promise<Placed | false | null> => {
          if (!node.parent)
            return {
              offsetX: 0,
              offsetY: 0,
              scaleX: 1,
              scaleY: 1,
              region: { left: 0, top: 0, right: MAX_WIDTH, bottom: MAX_HEIGHT },
            };
          const parent = placed.get(node.parent);
          if (!parent) return parent ?? null;
          try {
            const { backendNodeId } = await cdp.send("DOM.getFrameOwner", { frameId: node.id });
            const { object } = await cdp.send("DOM.resolveNode", {
              backendNodeId,
              executionContextId: await world(node.parent),
            });
            const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
              objectId: object.objectId as string,
              functionDeclaration: OWNER_BOX,
              returnByValue: true,
            });
            if (exceptionDetails) throw new Error(exceptionDetails.text);
            const box = result.value as {
              shown: boolean;
              left: number;
              top: number;
              scaleX: number;
              scaleY: number;
              clip: { left: number; top: number; right: number; bottom: number };
            };
            if (!box.shown) return false;
            // The parent's coordinates, placed in the screenshot by the parent's own offset and scale.
            const x = (value: number) => parent.offsetX + value * parent.scaleX;
            const y = (value: number) => parent.offsetY + value * parent.scaleY;
            // The frame's clipped box, in the screenshot's coordinates, within its parent's visible area.
            const region = {
              left: Math.max(parent.region.left, x(box.clip.left)),
              top: Math.max(parent.region.top, y(box.clip.top)),
              right: Math.min(parent.region.right, x(box.clip.right)),
              bottom: Math.min(parent.region.bottom, y(box.clip.bottom)),
            };
            if (region.right <= region.left || region.bottom <= region.top) return false;
            return {
              offsetX: x(box.left),
              offsetY: y(box.top),
              scaleX: parent.scaleX * box.scaleX,
              scaleY: parent.scaleY * box.scaleY,
              region,
            };
          } catch {
            return (await stillThere(node.id)) ? null : false;
          }
        };
        for (const node of nodes) placed.set(node.id, await place(node));
        // A closed shadow root hides its contents from every reader (a wall or a form drawn in one cannot be read):
        // the DOM tree, which sees through it, finds each one, and one whose host is shown on the captured page counts
        // as part of the page left unread. A hidden closed widget is not on the screenshot, so it does not.
        try {
          type DomNode = {
            backendNodeId?: number;
            frameId?: string;
            shadowRootType?: string;
            children?: DomNode[];
            shadowRoots?: DomNode[];
            contentDocument?: DomNode;
          };
          const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
          const hosts: { backendNodeId: number; frame: string }[] = [];
          const walk = (node: DomNode, frame: string) => {
            if (node.backendNodeId && node.shadowRoots?.some((shadow) => shadow.shadowRootType === "closed"))
              hosts.push({ backendNodeId: node.backendNodeId, frame });
            for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child, frame);
            if (node.contentDocument) walk(node.contentDocument, node.frameId ?? frame);
          };
          walk(root, (nodes[0] as FrameNode).id);
          for (const host of hosts) {
            if (!placed.get(host.frame)) continue; // in a frame that is not seen
            try {
              const { object } = await cdp.send("DOM.resolveNode", {
                backendNodeId: host.backendNodeId,
                executionContextId: await world(host.frame),
              });
              const { result } = await cdp.send("Runtime.callFunctionOn", {
                objectId: object.objectId as string,
                functionDeclaration: OWNER_BOX,
                returnByValue: true,
              });
              if ((result.value as { shown: boolean }).shown) unreadable++;
            } catch {
              unreadable++; // a host that could not be judged leaves its root unread
            }
          }
        } catch {
          unreadable++; // the tree that would show a closed root could not be read
        }
        // A frame Playwright sees that the page's frame tree leaves out (one in another renderer process) is not read
        // here: it counts as unread, never as no frame (§26, completion review).
        unreadable += Math.max(0, page.frames().length - nodes.length);
        const main = nodes[0] as FrameNode;
        // The main frame's own reading failing is the render's failure, as it always was.
        let text = await evaluate(main, shownText);
        let has_login_form = false;
        let has_payment_form = false;
        const walls = await evaluate(main, readWalls);
        for (const node of nodes) {
          const where = placed.get(node.id);
          if (where === null) unreadable++;
          if (!where) continue;
          // Only the fields the screenshot shows: a frame's area in its own coordinates.
          // The visible area in the frame's own coordinates: back through its offset and its scale.
          const region = {
            left: (where.region.left - where.offsetX) / where.scaleX,
            top: (where.region.top - where.offsetY) / where.scaleY,
            right: (where.region.right - where.offsetX) / where.scaleX,
            bottom: (where.region.bottom - where.offsetY) / where.scaleY,
          };
          const flags = await readFrame(
            node,
            readFormFlags,
            { has_login_form: false, has_payment_form: false },
            { region, descend: false },
          );
          has_login_form ||= flags.has_login_form;
          has_payment_form ||= flags.has_payment_form;
          if (node === main) continue;
          text += `\n${await readFrame(node, shownText, "")}`;
          // The walls of every frame a viewer sees: a CAPTCHA or a wall can sit in a nested frame.
          const inner = await readFrame(node, readWalls, {
            captcha: false,
            consentWall: false,
            overlays: "",
            challengeCover: false,
            imageCover: false,
          });
          walls.captcha ||= inner.captcha;
          walls.consentWall ||= inner.consentWall;
          walls.challengeCover ||= inner.challengeCover;
          walls.imageCover ||= inner.imageCover;
          if (inner.overlays) walls.overlays = `${walls.overlays}\n${inner.overlays}`.slice(0, 200_000);
        }
        // A page may remove its own root element; then nothing is drawn below the top.
        const height = await evaluate(main, () => document.documentElement?.scrollHeight ?? 0);
        return {
          url: page.url(),
          title: await evaluate(main, () => document.title),
          text,
          has_login_form,
          has_payment_form,
          walls,
          unreadable,
          height,
        };
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    };
    const screenshot = async (height: number) => {
      // The viewport is the 1280 by 2000 pixels kept, so the picture is the very layout the readers read (a full-page
      // capture resizes the view and moves anything placed by it).
      return page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: MAX_WIDTH, height: Math.max(1, Math.min(MAX_HEIGHT, height)) },
        timeout: left(),
      });
    };
    // The capture as one moment: read, take the picture, read again. A page that moved between the readings (a
    // navigation, a wall appearing) or left a frame unread is tried once more, then refused as such.
    let reading = await readAll();
    let shot = await screenshot(reading.height);
    let check = await readAll();
    if (!readingsAgree(reading, check) || reading.unreadable || check.unreadable) {
      reading = check;
      shot = await screenshot(reading.height);
      check = await readAll();
      if (reading.unreadable || check.unreadable)
        throw new Unsettled("part of the page (a frame or a closed shadow root) could not be read");
      if (!readingsAgree(reading, check)) throw new Unsettled("the page kept changing while it was captured");
    }
    const { title, text, has_login_form, has_payment_form, walls } = reading;
    // A large picture with few words of its own: its words, a wall's "Press & Hold" among them, are read off the
    // screenshot. A picture that cannot be read leaves the page unjudged, so it is not stored.
    let imageText = "";
    if (walls.imageCover) {
      try {
        imageText = await (options.ocr ?? ocrScreenshot)(new Uint8Array(shot));
      } catch (error) {
        throw new Unsettled(`a picture covering the page could not be read (${(error as Error).message.slice(0, 80)})`);
      }
    }
    const written = (await Promise.all(downloads)).filter((path) => path !== null).length;
    return {
      listed: url,
      finalUrl: reading.url,
      status: status ?? 0,
      title,
      text: text
        .replace(/[ \t\f\v\r]+/g, " ")
        .replace(/ *\n[\n ]*/g, "\n")
        .trim(),
      screenshot: await normaliseScreenshot(new Uint8Array(shot)),
      has_login_form,
      has_payment_form,
      ...walls,
      imageText,
      downloadsWritten: written,
      popupsClosed,
      serviceWorkers: context.serviceWorkers().length,
    };
  }

  // The browser starts (or is reused) under its own bound; then the whole render, the context's setup included, runs
  // under one deadline. The context's close gets 5 seconds more, and a browser that does not close it is dropped, so
  // no worker waits on it again. The render's egress proxy closes with it, ending every outbound connection.
  const replayRefusals: string[] = [];
  // `recordHar` (§38, live only): the visit's every response, bodies embedded, written to that file when the visit's
  // context closes, so a replay archive and the capture it is checked against come from the same visit. `replay` overrides
  // the renderer's own archive for one visit so one shared browser can replay a whole corpus.
  async function render(url: string, call: { recordHar?: string; replay?: ReplayArchive } = {}): Promise<Capture> {
    const mine = current();
    const browser = await mine;
    const replay = call.replay ?? options.replay;
    const egress = replay
      ? { refused: [] as string[], listen: async () => "", close: () => undefined }
      : openEgress(allowOrigins, checkedLookup);
    const proxy = replay ? "" : await egress.listen();
    const deadline = Date.now() + limitMs;
    let timer: NodeJS.Timeout | undefined;
    let context: BrowserContext | undefined;
    let abandoned = false;
    const work = (async () => {
      const made = await browser.newContext({
        // The crop the screenshot keeps (§26): readers and picture share one layout, and what is on top can be asked
        // anywhere in it.
        viewport: { width: MAX_WIDTH, height: MAX_HEIGHT },
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
        ignoreHTTPSErrors: false,
        // `<-loopback>` sends loopback addresses through the proxy too, where they are refused. In replay (§38)
        // there is no proxy and no egress: every request is answered from the archive or refused.
        ...(replay ? {} : { proxy: { server: proxy, bypass: "<-loopback>" } }),
        ...(call.recordHar && !replay ? { recordHar: { path: call.recordHar, content: "embed" as const } } : {}),
      });
      if (replay) {
        const respond = replayResponder(replay);
        await made.route("**/*", async (route) => {
          const req = route.request();
          const entry = respond(req.url(), req.method(), req.postData() ?? "");
          if (!entry) {
            replayRefusals.push(req.url());
            await route.abort();
            return;
          }
          await route.fulfill({
            status: entry.status ?? 200,
            headers: entry.headers ?? {},
            body: Buffer.from(entry.bodyBase64, "base64"),
          });
        });
      }
      // Made after the deadline gave up on this render: closed here, since nothing else will.
      if (abandoned) {
        void bounded(made.close());
        throw new RenderTimeout("the render passed its deadline while its context was made");
      }
      context = made;
      contexts.add(context);
      await context.routeWebSocket(/.*/, (socket) => socket.close());
      return capture(context, url, deadline, egress);
    })();
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RenderTimeout(`the render passed ${limitMs / 1000} seconds`)), limitMs);
    });
    try {
      return await Promise.race([work, limit]);
    } catch (error) {
      if (error instanceof RenderTimeout || /Timeout \d+ms exceeded/.test((error as Error).message))
        throw new RenderTimeout((error as Error).message.split("\n")[0]);
      // The shared browser died under this page (killed for memory, crashed): the browser's fault, retried, never the
      // page's exclusion. The page's own error can arrive before the browser reports its disconnection, so that report
      // is awaited briefly.
      if (browser.isConnected())
        await new Promise<void>((settle) => {
          const done = setTimeout(settle, 500);
          browser.once("disconnected", () => {
            clearTimeout(done);
            settle();
          });
        });
      if (
        !browser.isConnected() ||
        /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(
          String((error as Error)?.message),
        )
      )
        throw new BrowserFault(
          `the browser closed under the page: ${String((error as Error)?.message).split("\n")[0]}`,
        );
      throw error;
    } finally {
      abandoned = true;
      clearTimeout(timer);
      work.catch(() => undefined); // a render abandoned at its deadline still settles somewhere: nothing waits on it
      egress.close();
      if (context) {
        contexts.delete(context);
        if (!(await bounded(context.close()))) {
          // The browser did not close the context: it is dropped, and the next render starts a new one.
          if (session === mine) session = null;
          void bounded(browser.close());
        }
      }
    }
  }

  return {
    render,
    // §38: every request replay refused because it was not in the archive, in the order it was asked for.
    replayRefusals: () => [...replayRefusals],
    openContexts: () => contexts.size,
    launches: () => launched,
    warmups: () => warmed,
    close: async () => {
      const open = session;
      session = null;
      if (open) await bounded(open.then((b) => b.close()));
    },
  };
}

// The journal: one JSON line per event, `started` before a render and `stored`, `excluded` or `retry` after it, and
// `reopened` when an exclusion a fault of the renderer made is cleared, so the next run renders the page again.
export type JournalEvent = {
  url: string;
  event: "started" | "stored" | "excluded" | "retry" | "reopened" | "run";
  // A batch run's start (`run`): its list and how many renders it held at once (§18's render receipt).
  list?: string;
  concurrency?: number;
  id?: string;
  reason?: string;
  // A retry the browser's own failure caused: it never counts toward the page's tries (§26).
  fault?: "browser";
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
  /net::ERR_(CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT|ABORTED)|TIMED_OUT|NETWORK_CHANGED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)/;

export type BatchResult = { stored: number; excluded: number; retry: number; skipped: number; recovered: number };

export type Recheck = {
  checked: number;
  removed: string[];
  damaged: string[];
  unassessed: string[];
  rerendered: string[];
};

// A removal in progress: written before the page is removed and cleared once its exclusion is in the journal, so a stop
// between the two leaves the intent for the next recheck to finish (plan review gap 8).
// `reopen`: the page is rendered again by the next run (a capture stored before its evidence was kept), so its
// exclusion is followed by a `reopened` line.
type Removal = { id: string; url: string; reason: string; reopen?: boolean };
const intentFile = (journal: string) => `${journal}.removing.json`;

function removeAndRecord(store: ReturnType<typeof openStore>, journal: string, removal: Removal): void {
  const file = intentFile(journal);
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, JSON.stringify(removal));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  // The intent's name is made durable before the page goes, so a crash never keeps the removal and loses its record.
  const folder = openSync(dirname(file), "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
  finishRemoval(store, journal, removal);
}

function finishRemoval(store: ReturnType<typeof openStore>, journal: string, removal: Removal): void {
  store.removePage(removal.id); // false when a stop came after it: the page is already gone
  const last = readJournal(journal)
    .filter((event) => event.url === removal.url)
    .at(-1);
  const done = removal.reopen
    ? last?.event === "reopened" && last.reason === removal.reason
    : last?.event === "excluded" && last.reason === removal.reason;
  if (!done) {
    if (!(last?.event === "excluded" && last.reason === removal.reason))
      appendJournal(journal, { url: removal.url, event: "excluded", reason: removal.reason });
    if (removal.reopen) appendJournal(journal, { url: removal.url, event: "reopened", reason: removal.reason });
  }
  unlinkSync(intentFile(journal));
}

// Audits every stored benign page with the challenge check as it reads now: each page's files are verified against
// their hashes first (a damaged or unreadable record is listed, never passed as clean), and a refused page is taken out
// and recorded excluded so no run stores it again, through an intent a stop cannot lose. A removal a stopped recheck
// left is finished first.
// A stored benign capture judged as admission judges it, from the evidence kept with it: `clear`, `wall` (admission
// would refuse it), or `unassessed` (stored before every structural reading was kept, and showing no wall in its text:
// a CAPTCHA, a consent wall or an image cover leaves no words). One judgement for the recheck and for the freeze.
// Evidence is complete only with every structural reading admission takes; a record without them is a legacy capture.
export function fullEvidence(page: StoredPage): StoredPage["evidence"] | undefined {
  const kept = page.evidence;
  return kept &&
    typeof kept.captcha === "boolean" &&
    typeof kept.consentWall === "boolean" &&
    typeof kept.challengeCover === "boolean" &&
    typeof kept.wall === "boolean"
    ? kept
    : undefined;
}

export function assessCapture(page: StoredPage, text: string): "clear" | "wall" | "unassessed" {
  const kept = page.evidence;
  const evidence = fullEvidence(page);
  const wall =
    Boolean(evidence?.captcha || evidence?.consentWall || evidence?.challengeCover || evidence?.wall) ||
    wallShown({ title: kept?.title ?? "", text, overlays: kept?.overlays ?? "" }) ||
    NO_SITE.test(text.slice(0, 2000));
  if (wall) return "wall";
  return evidence ? "clear" : "unassessed";
}

export function recheckStored(
  store: ReturnType<typeof openStore>,
  journal: string,
  options: { rerenderLegacy?: boolean } = {},
): Recheck {
  if (existsSync(intentFile(journal)))
    finishRemoval(store, journal, JSON.parse(readFileSync(intentFile(journal), "utf-8")) as Removal);
  const result: Recheck = { checked: 0, removed: [], damaged: [], unassessed: [], rerendered: [] };
  // Its own run in the journal, so what it records never extends a render run's time (§18 round 1).
  appendJournal(journal, { url: "", event: "run", list: "recheck" });
  const benign = (id: string) => /^benign-/.test(id);
  result.damaged.push(...store.verify().damaged.filter(benign));
  for (const page of store.manifest({ tolerant: true })) {
    if (!page.source.startsWith("benign-") || result.damaged.includes(page.id)) continue;
    const read = store.readVerifiedPage(page.id);
    if (!read) {
      result.damaged.push(page.id);
      continue;
    }
    result.checked++;
    const verdict = assessCapture(read.page, read.text);
    // A legacy capture is rendered again under the current rules, when asked: the page goes, and the next run
    // renders its URL afresh.
    if (!fullEvidence(read.page) && options.rerenderLegacy && read.page.url) {
      removeAndRecord(store, journal, {
        id: page.id,
        url: read.page.url,
        reason: "stored before its evidence was kept; rendered again under the current rules",
        reopen: true,
      });
      result.rerendered.push(page.id);
      continue;
    }
    if (verdict === "unassessed") {
      result.unassessed.push(page.id);
      continue;
    }
    if (verdict === "clear") continue;
    removeAndRecord(store, journal, {
      id: page.id,
      url: page.url ?? page.id,
      reason: "a challenge page (found on a recheck)",
    });
    result.removed.push(page.id);
  }
  return result;
}

export type RenderReceipt = {
  list: string;
  list_sha256: string;
  urls: number;
  stored: number;
  excluded: Record<string, number>;
  unfinished: string[];
  missing_pages: string[];
  // Every listed URL's latest terminal outcome: its page id when stored (verified against its hashes), its reason when
  // excluded; an unfinished URL has none.
  outcomes: Record<string, { stored: string } | { excluded: string }>;
  retries: { page: number; browser: number };
  concurrency: number[];
  // Each run of this list, from its `run` event to the last of this list's events before the next run began; runs
  // journalled before runs were recorded are measured by their events' gaps (each up to five minutes).
  runs: { started: string; ended: string; seconds: number; concurrency: number }[];
  earlier_seconds: number;
  active_seconds: number;
};

// The widened render's receipt (§18): the list it rendered (its URLs' SHA-256), each listed URL's latest terminal
// outcome (stored, with its page whole in the store, or excluded with its reason; a URL at `retry`, `started` or never
// met is unfinished), the retries it took, and the time and concurrency of each run. Written temp-then-replace and read
// back whole.
export function renderReceipt(list: UrlList, journal: string, store: ReturnType<typeof openStore>): RenderReceipt {
  const urls = new Set(list.entries.map((entry) => entry.url));
  const last = new Map<string, JournalEvent>();
  const retries = { page: 0, browser: 0 };
  const concurrency = new Set<number>();
  const runs: RenderReceipt["runs"] = [];
  const earlier: number[] = [];
  let open: { started: number; last: number; concurrency: number } | null = null;
  let anyRun = false;
  const close = () => {
    if (open)
      runs.push({
        started: new Date(open.started).toISOString(),
        ended: new Date(open.last).toISOString(),
        seconds: Math.round((open.last - open.started) / 1000),
        concurrency: open.concurrency,
      });
    open = null;
  };
  for (const event of readJournal(journal)) {
    const at = Date.parse(event.at);
    if (event.event === "run") {
      anyRun = true;
      close();
      if (event.list === list.name) {
        open = { started: at, last: at, concurrency: event.concurrency ?? 0 };
        if (event.concurrency) concurrency.add(event.concurrency);
      }
      continue;
    }
    if (!urls.has(event.url)) continue;
    if (open) open.last = at;
    else if (!anyRun) earlier.push(at);
    if (event.event === "retry") retries[event.fault === "browser" ? "browser" : "page"]++;
    // A reopened page goes back to unfinished until its next outcome.
    last.set(event.url, event);
  }
  close();
  let earlierSeconds = 0;
  for (let i = 1; i < earlier.length; i++) {
    const gap = ((earlier[i] as number) - (earlier[i - 1] as number)) / 1000;
    if (gap <= 300) earlierSeconds += gap;
  }
  const receipt: RenderReceipt = {
    list: list.name,
    list_sha256: createHash("sha256")
      .update([...urls].sort().join("\n"))
      .digest("hex"),
    urls: urls.size,
    stored: 0,
    excluded: {},
    unfinished: [],
    missing_pages: [],
    outcomes: {},
    retries,
    concurrency: [...concurrency].sort((a, b) => a - b),
    runs,
    earlier_seconds: Math.round(earlierSeconds),
    active_seconds: Math.round(earlierSeconds + runs.reduce((sum, run) => sum + run.seconds, 0)),
  };
  for (const url of [...urls].sort()) {
    const event = last.get(url);
    if (event?.event === "stored") {
      // Whole, not merely listed: a page whose screenshot or text no longer matches its hashes is missing.
      if (event.id && store.readVerifiedPage(event.id)) {
        receipt.stored++;
        receipt.outcomes[url] = { stored: event.id };
      } else receipt.missing_pages.push(url);
    } else if (event?.event === "excluded") {
      const reason = (event.reason ?? "").replace(/ \(.*$/, "");
      receipt.excluded[reason] = (receipt.excluded[reason] ?? 0) + 1;
      receipt.outcomes[url] = { excluded: event.reason ?? "" };
    } else receipt.unfinished.push(url);
  }
  return receipt;
}

// Reopens every page whose last outcome is an exclusion whose reason matches: the record stays, and a `reopened` line
// after it names the reason, so the next run renders the page again from its first try. A stored page is never
// reopened. Returns the URLs reopened.
export function reopenExcluded(journal: string, matching: RegExp): string[] {
  const last = new Map<string, JournalEvent>();
  for (const event of readJournal(journal)) if (event.event !== "started") last.set(event.url, event);
  const reopened: string[] = [];
  for (const [url, event] of last) {
    if (event.event !== "excluded" || !matching.test(event.reason ?? "")) continue;
    // Its own run in the journal, as a recheck's is.
    if (!reopened.length) appendJournal(journal, { url: "", event: "run", list: "reopen" });
    appendJournal(journal, { url, event: "reopened", reason: event.reason ?? "" });
    reopened.push(url);
  }
  return reopened;
}

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
    if (event.event === "run") continue; // a run's start, not a page's
    const entry = state.get(event.url) ?? { open: false, retries: 0 };
    if (event.event === "started") entry.open = true;
    else {
      entry.open = false;
      if (event.event === "retry") {
        if (event.fault !== "browser") entry.retries++;
      } else if (event.event === "reopened") {
        delete entry.outcome;
        entry.retries = 0;
      } else entry.outcome = event.event;
    }
    state.set(event.url, entry);
  }
  // A damaged page's record is left out here (coverage reports it); it does not stop the run.
  const stored = store.manifest({ tolerant: true });
  const byUrl = new Map(stored.flatMap((page) => (page.url ? [[page.url, page.id] as const] : [])));
  // The listed URL each stored page was rendered from: a page is its content, so a second URL that renders the same
  // bytes is the same page, recorded as excluded, never as a second store.
  const urlById = new Map(stored.flatMap((page) => (page.url ? [[page.id, page.url] as const] : [])));
  const result: BatchResult = { stored: 0, excluded: 0, retry: 0, skipped: 0, recovered: 0 };
  appendJournal(journal, { url: "", event: "run", list: list.name, concurrency: options.concurrency ?? 4 });
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
      // The browser's failure is not the page's: it is tried again, and never counts toward the page's three tries.
      if (error instanceof BrowserFault) {
        appendJournal(journal, { url: entry.url, event: "retry", reason, fault: "browser" });
        result.retry++;
        return;
      }
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
      evidence: evidenceOf(capture),
    });
    const first = urlById.get(id);
    if (first && first !== entry.url) {
      appendJournal(journal, { url: entry.url, event: "excluded", reason: `the same page as ${first}` });
      result.excluded++;
      return;
    }
    urlById.set(id, entry.url);
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
export function benignCoverage(store: Pick<ReturnType<typeof openStore>, "manifest" | "readPage" | "verify">) {
  const problems: string[] = [];
  // A benign page whose record does not read is a problem, not the end of the count.
  for (const id of store.verify().damaged.filter((id) => id.startsWith("benign-"))) problems.push(`${id}: damaged`);
  const byKind: Record<string, number> = {};
  let total = 0;
  let southAfrica = 0;
  for (const page of store.manifest({ tolerant: true }).filter((p) => p.origin === "benign")) {
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
  let screenshot: Uint8Array;
  let text: string;
  try {
    ({ screenshot, text } = store.readPage(page.id));
  } catch {
    return "its files do not read";
  }
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

// The command line: `run [majestic|benign-sa] [--concurrency N]` (N pages rendered at once, 1 to 16, 4 by default),
// `coverage` or `--coverage`. A string is the usage error.
export function parseCommand(
  args: string[],
): { command: string; only?: string; concurrency: number; matching?: RegExp; rerenderLegacy?: boolean } | string {
  const rest = [...args];
  let concurrency = 4;
  const at = rest.indexOf("--concurrency");
  if (at >= 0) {
    const value = rest[at + 1] ?? "";
    concurrency = /^\d{1,2}$/.test(value) ? Number(value) : Number.NaN;
    if (!(concurrency >= 1 && concurrency <= 16)) return "--concurrency takes a whole number from 1 to 16";
    rest.splice(at, 2);
  }
  // `reopen --matching <pattern>`: the exclusions a renderer fault made, by their recorded reason.
  if (rest[0] === "reopen") {
    if (rest.length !== 3 || rest[1] !== "--matching" || !rest[2])
      return "usage: render.ts reopen --matching <pattern>";
    try {
      return { command: "reopen", concurrency, matching: new RegExp(rest[2]) };
    } catch (error) {
      return `--matching is not a pattern: ${(error as Error).message}`;
    }
  }
  const [given, only] = rest;
  // `--coverage` is the spelling §6's checkpoint names; `coverage` the subcommand's.
  const command = given === "--coverage" ? "coverage" : (given ?? "");
  if ((command === "coverage" || command === "recheck") && rest.length === 1) return { command, concurrency };
  // `receipt majestic|benign-sa`: the list's render receipt (§18).
  if (command === "receipt" && rest.length === 2 && (rest[1] === "majestic" || rest[1] === "benign-sa"))
    return { command, only: rest[1], concurrency };
  // `recheck --rerender-legacy`: every page stored before its evidence was kept is rendered again by the next run.
  if (command === "recheck" && rest.length === 2 && rest[1] === "--rerender-legacy")
    return { command, concurrency, rerenderLegacy: true };
  if (command !== "run" || rest.length > 2 || (only && only !== "majestic" && only !== "benign-sa"))
    return "usage: node scripts/glimmer/render.ts run [majestic|benign-sa] [--concurrency N] | coverage | --coverage | recheck | reopen --matching <pattern>";
  return only ? { command, only, concurrency } : { command, concurrency };
}

if (import.meta.filename === process.argv[1]) {
  const parsed = parseCommand(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(2);
  }
  const { command, only, concurrency, matching, rerenderLegacy } = parsed;
  const dir = storeDir();
  const store = openStore(dir);
  if (command === "coverage") {
    const coverage = benignCoverage(store);
    console.log(JSON.stringify({ ...coverage, problems: coverage.problems.slice(0, 20) }, null, 2));
    process.exit(coverage.met ? 0 : 1);
  }
  if (command === "recheck") {
    const result = recheckStored(store, join(dir, "raw/benign/progress.jsonl"), {
      rerenderLegacy: rerenderLegacy === true,
    });
    console.log(
      JSON.stringify({
        ...result,
        damaged: result.damaged.slice(0, 20),
        unassessed: result.unassessed.slice(0, 20),
        rerendered: result.rerendered.length,
      }),
    );
    // Clean only when every page was verified and judged: zero removals alone is not clean.
    process.exit(result.damaged.length || result.unassessed.length ? 1 : 0);
  }
  if (command === "receipt" && only) {
    const list =
      only === "majestic"
        ? majesticList(readFileSync(join(dir, "raw/majestic/top.csv"), "utf-8"))
        : saList(readFileSync(join(ROOT, "eval/glimmer/benign-sa-urls.txt"), "utf-8"));
    const receipt = renderReceipt(list, join(dir, "raw/benign/progress.jsonl"), store);
    const file = join(dir, "raw", only === "majestic" ? "majestic" : "benign", "RENDER.json");
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    const written = `${JSON.stringify(receipt)}\n`;
    writeFileSync(temporary, written);
    renameSync(temporary, file);
    if (readFileSync(file, "utf-8") !== written) {
      console.error("render: the render receipt did not read back as written");
      process.exit(1);
    }
    const short = {
      ...receipt,
      outcomes: Object.keys(receipt.outcomes).length,
      unfinished: receipt.unfinished.length,
      missing_pages: receipt.missing_pages.length,
    };
    // Written out before the exit: a summary over 64 KB (thousands of distinct exclusion reasons) piped to another
    // program is otherwise cut off when the process exits with the write still queued.
    await new Promise((resolve) => process.stdout.write(`${JSON.stringify(short)}\n`, resolve));
    // Complete only when every listed URL has its terminal outcome and every stored one its page.
    process.exit(receipt.unfinished.length || receipt.missing_pages.length ? 1 : 0);
  }
  if (command === "reopen" && matching) {
    const reopened = reopenExcluded(join(dir, "raw/benign/progress.jsonl"), matching);
    console.log(`reopened ${reopened.length} excluded pages`);
    process.exit(0);
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
          concurrency,
        });
        console.log(`${list.name}: ${JSON.stringify(result)}`);
        if (result.retry === 0) break;
      }
    }
  } finally {
    await renderer.close();
  }
}
