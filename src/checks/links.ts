// Every link in a case (D02 T07 §1; spec 4.3): read by the Workflow's `checks` step into `CaseView.links`, since a
// check never reads storage, from the summary's HTML and text, each body part cut for reading (read whole from R2), the
// HTML and SVG attachments (from the read `htmlAttachmentsOf` already makes) and PDF attachments' `/URI` actions. Each
// link keeps where it came from and its anchor text, so the report can say "the button labelled View invoice goes to
// ...", and §2 and §3 follow the same list. `link.text_mismatch` reads it: anchor text naming one domain on a link to
// another is evidence in itself.
import { bounded, plain } from "./auth";
import { registrable } from "./brand-schema";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { decodeEntities } from "./hidden-text";
import { unicodeLabel } from "./lookalike";
import type { CheckRegistry } from "./registry";
import { sniff } from "./sniff";

export const MAX_LINKS = 50;
// The longest URL kept (and carried across a chunk edge), and the longest anchor text.
export const MAX_URL = 2_048;
export const MAX_ANCHOR = 200;
export const TEXT_CHUNK = 64 * 1024;
export const MAX_PDFS = 10;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_INFLATED = 10 * 1024 * 1024;
// Relative URLs held until the document's base is known, and distinct links remembered past the cap to count them.
const MAX_PENDING = 500;
const MAX_SEEN = 10_000;
const MAX_MISMATCH_ITEMS = 20;
export const MAX_UNREAD_NAMED = 20;

export type LinkKind = "href" | "form" | "frame" | "image" | "refresh" | "text" | "pdf";
export type Link = {
  // As the source wrote it (character references decoded), at most MAX_URL characters.
  raw: string;
  href: string;
  // Lower-case ASCII (A-labels), and the same host in Unicode for display.
  host: string;
  display: string;
  kind: LinkKind;
  // `summary`, a cut part's key, or an attachment's key.
  part: string;
  anchor: string | null;
};
export type Unread = {
  key: string;
  why: "missing" | "charset" | "encrypted" | "damaged" | "too-large" | "too-many";
};
// Up to MAX_LINKS links; `more` counts the distinct links past them.
export type Links = { items: Link[]; more: number; unread: Unread[] };
// A link as an HTML document gives it: absolute, before it is parsed.
export type HtmlLink = { url: string; kind: LinkKind; anchor: string | null };

// A host for display: each A-label in Unicode, when it is a valid one.
const displayOf = (host: string) =>
  host
    .split(".")
    .map((label) => (label.startsWith("xn--") ? (unicodeLabel(label) ?? label) : label))
    .join(".");

// A URL as a link, or null: only an absolute `http:` or `https:` URL is one; `base` resolves a relative one.
export function parseLink(raw: string, base: string | null = null): Pick<Link, "href" | "host" | "display"> | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL) return null;
  let url: URL | null = null;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) url = new URL(text);
    else if (base) url = new URL(text, base);
  } catch {
    return null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  if (url.href.length > MAX_URL) return null;
  return { href: url.href, host: url.hostname, display: displayOf(url.hostname) };
}

// The case's links as they are found: each distinct (by `href` and anchor text) kept once, the first MAX_LINKS kept and
// the rest counted.
export class LinkLog {
  readonly items: Link[] = [];
  readonly unread: Unread[] = [];
  more = 0;
  private readonly seen = new Set<string>();

  add(raw: string, kind: LinkKind, part: string, anchor: string | null = null): void {
    const parsed = parseLink(raw);
    if (!parsed) return;
    const key = `${parsed.href}\u0000${anchor ?? ""}`;
    if (this.seen.has(key)) return;
    if (this.items.length >= MAX_LINKS) {
      if (this.seen.size < MAX_SEEN + MAX_LINKS) this.seen.add(key);
      this.more++;
      return;
    }
    this.seen.add(key);
    this.items.push({ raw: raw.trim().slice(0, MAX_URL), ...parsed, kind, part, anchor });
  }

  // An HTML or SVG document's links, from `part`, and the relative ones past its bound counted: added after the read,
  // never as `more += await`, which would write back the count from before the read over every link it counted.
  async html(input: string | ReadableStream<Uint8Array>, part: string): Promise<void> {
    const dropped = await htmlLinks(input, (l) => this.add(l.url, l.kind, part, l.anchor));
    this.more += dropped;
  }

  // Another list's links, its count of those past the cap carried (completion review: an attachment's links).
  merge(links: Links): void {
    for (const l of links.items) this.add(l.raw, l.kind, l.part, l.anchor);
    this.more += links.more;
    this.unread.push(...links.unread.slice(0, MAX_LINKS));
  }

  result(): Links {
    return { items: this.items, more: this.more, unread: this.unread };
  }
}

// Anchor text as shown: references decoded, white space collapsed, bounded; null when empty.
function anchorOf(text: string): string | null {
  const shown = decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR);
  return shown || null;
}

// `srcset`'s URLs (HTML, parsing a srcset attribute): each candidate a run of non-space characters, its trailing
// commas not part of it, then a descriptor up to the next comma.
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length && urls.length < 100) {
    while (i < value.length && /[\s,]/.test(value[i] as string)) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value[i] as string)) i++;
    let url = value.slice(start, i);
    const bare = url.replace(/,+$/, "");
    if (bare.length !== url.length) url = bare;
    // A descriptor follows: skip it to the comma that ends this candidate.
    else while (i < value.length && value[i] !== ",") i++;
    if (url) urls.push(url);
  }
  return urls;
}

// The URL a `<meta http-equiv="refresh">` sends to (HTML, the refresh state): after its delay, a `;` or `,`, an
// optional `url=`, and an optional quote.
export function refreshUrl(content: string): string | null {
  const m = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?(["']?)(.*)$/is.exec(content);
  if (!m) return null;
  let url = (m[2] as string).trim();
  if (m[1] && url.includes(m[1])) url = url.slice(0, url.indexOf(m[1]));
  return url || null;
}

// The links in one HTML or SVG document, streamed through HTMLRewriter: `a` and `area` (`href`, else SVG's
// `xlink:href`), forms and their buttons' targets, frames, images and refreshes. A relative URL counts only under an
// absolute `<base href>`, the document's first, wherever it stands, as a browser resolves it; a scheme-relative one
// takes the base's scheme, else `https:`. Returns how many relative URLs were past MAX_PENDING, so not read.
export async function htmlLinks(
  input: string | ReadableStream<Uint8Array>,
  emit: (link: HtmlLink) => void,
): Promise<number> {
  let dropped = 0;
  let base: string | null = null;
  let baseSeen = false;
  const pending: HtmlLink[] = [];
  const found = (raw: string | null, kind: LinkKind, anchor: string | null) => {
    if (raw === null) return;
    const url = raw.trim();
    if (!url || url.length > MAX_URL) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) emit({ url, kind, anchor });
    else if (pending.length < MAX_PENDING) pending.push({ url, kind, anchor });
    else dropped++;
  };
  const attr = (e: Element, name: string) => {
    const value = e.getAttribute(name);
    return value === null ? null : decodeEntities(value);
  };
  // Anchors open where text is being read; each collects its text until its end tag.
  const open: { url: string | null; text: string }[] = [];
  await new HTMLRewriter()
    .on("base", {
      element(e) {
        if (baseSeen) return;
        const href = attr(e, "href");
        if (href === null) return;
        baseSeen = true;
        try {
          const url = new URL(href.trim());
          if (url.protocol === "http:" || url.protocol === "https:") base = url.href;
        } catch {
          // A base that is not an absolute URL resolves nothing here.
        }
      },
    })
    .on("a", {
      element(e) {
        const anchor = { url: attr(e, "href") ?? attr(e, "xlink:href"), text: "" };
        open.push(anchor);
        try {
          e.onEndTag(() => {
            open.splice(open.lastIndexOf(anchor), 1);
            found(anchor.url, "href", anchorOf(anchor.text));
          });
        } catch {
          // A self-closed SVG `<a/>` has no end tag and no text.
          open.splice(open.lastIndexOf(anchor), 1);
          found(anchor.url, "href", null);
        }
      },
    })
    .on("area", {
      element(e) {
        found(attr(e, "href"), "href", anchorOf(attr(e, "alt") ?? ""));
      },
    })
    .on("form", {
      element(e) {
        found(attr(e, "action"), "form", null);
      },
    })
    .on("button, input", {
      element(e) {
        found(attr(e, "formaction"), "form", anchorOf(attr(e, "value") ?? ""));
      },
    })
    .on("iframe, frame", {
      element(e) {
        found(attr(e, "src"), "frame", null);
      },
    })
    .on("img, source", {
      element(e) {
        found(attr(e, "src"), "image", anchorOf(attr(e, "alt") ?? ""));
        for (const url of srcsetUrls(attr(e, "srcset") ?? "")) found(url, "image", null);
      },
    })
    .on("meta", {
      element(e) {
        if ((attr(e, "http-equiv") ?? "").trim().toLowerCase() !== "refresh") return;
        found(refreshUrl(attr(e, "content") ?? ""), "refresh", null);
      },
    })
    .onDocument({
      text(chunk) {
        for (const anchor of open) if (anchor.text.length < MAX_ANCHOR * 4) anchor.text += chunk.text;
      },
    })
    .transform(new Response(input, { headers: { "content-type": "text/html" } }))
    .body?.pipeTo(new WritableStream());
  // Anchors left open at the end of the document are links still.
  for (const anchor of open) found(anchor.url, "href", anchorOf(anchor.text));
  for (const link of pending) {
    const against: string | null = base ?? (link.url.startsWith("//") ? "https://scheme.invalid/" : null);
    if (!against) continue;
    try {
      emit({ ...link, url: new URL(link.url, against).href });
    } catch {
      // Not a URL even against the base.
    }
  }
  return dropped;
}

// A plain-text URL: `http://` or `https://`, or a host starting `www.`, then RFC 3986's characters (and letters and
// digits beyond ASCII, as IRIs write them).
const TEXT_URL = /(?:https?:\/\/|\bwww\.)[\p{L}\p{M}\p{N}\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

// A text URL without the punctuation that ends a sentence around it, and without a closing bracket it never opened.
// The brackets are counted once and each character is looked at once, so a URL ending in thousands of them costs no
// more than its length (round 1: splitting it again for each character was quadratic).
export function trimTextUrl(found: string): string {
  const open: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
  const close: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (const c of found) {
    if (c in open) open[c] = (open[c] as number) + 1;
    else if (c in close) close[c] = (close[c] as number) + 1;
  }
  let end = found.length;
  while (end > 0) {
    const last = found[end - 1] as string;
    if (".,;:!?'\"".includes(last)) end--;
    else if (last in CLOSERS && (close[last] as number) > (open[CLOSERS[last] as string] as number)) {
      close[last] = (close[last] as number) - 1;
      end--;
    } else break;
  }
  return found.slice(0, end);
}

// Plain-text URLs from a stream of text: each chunk joined to the end of the one before (up to MAX_URL characters
// after the last URL found, or from the start of a URL the chunk ended in), so a URL across a chunk edge is found once.
export class TextLinks {
  private buffer = "";
  constructor(private readonly emit: (url: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    this.scan(false);
  }

  end(): void {
    this.scan(true);
    this.buffer = "";
  }

  private scan(final: boolean) {
    const text = this.buffer;
    const keepFrom = final ? text.length : Math.max(0, text.length - MAX_URL);
    let emitted = 0;
    for (const m of text.matchAll(TEXT_URL)) {
      const end = m.index + m[0].length;
      // A URL the chunk may cut, read again with the next chunk: it lies within the last MAX_URL characters kept, or is
      // too long to be a link.
      if (!final && end === text.length) break;
      emitted = end;
      // Too long to be a link however it is trimmed: not trimmed at all.
      if (m[0].length > MAX_URL * 2) continue;
      const url = trimTextUrl(m[0]);
      this.emit(/^www\./i.test(url) ? `http://${url}` : url);
    }
    this.buffer = text.slice(Math.max(keepFrom, emitted));
  }
}

// A PDF literal string from its opening parenthesis (PDF 32000-1 7.3.4.2): escapes decoded, nested parentheses kept.
function literalString(text: string, from: number): string {
  let out = "";
  let depth = 1;
  for (let i = from; i < text.length && out.length <= MAX_URL; i++) {
    const c = text[i] as string;
    if (c === "\\") {
      const n = text[++i];
      if (n === undefined) break;
      const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (n in escapes) out += escapes[n];
      else if (/[0-7]/.test(n)) {
        let digits = n;
        while (digits.length < 3 && /[0-7]/.test(text[i + 1] ?? "")) digits += text[++i];
        out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
      } else if (n === "\r") {
        if (text[i + 1] === "\n") i++;
      } else if (n !== "\n") out += n;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) break;
    out += c;
  }
  return out;
}

// A PDF hex string from its opening `<` (7.3.4.3): white space ignored, a missing last digit read as 0.
function hexString(text: string, from: number): string {
  const end = text.indexOf(">", from);
  const hex = text.slice(from, end < 0 ? from + MAX_URL * 2 : Math.min(end, from + MAX_URL * 4)).replace(/\s/g, "");
  let out = "";
  for (let i = 0; i < hex.length; i += 2)
    out += String.fromCharCode(Number.parseInt((hex.slice(i, i + 2) + "0").slice(0, 2), 16));
  return out;
}

// Past white space and comments (PDF 32000-1 7.2.3, 7.2.4), from `i`.
function skipSpace(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /[\0\t\n\f\r ]/.test(text[i] as string)) i++;
    if (text[i] !== "%") return i;
    while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
  }
}

// The string object at `i`, literal or hex; null when another object stands there.
function stringAt(text: string, i: number): string | null {
  if (text[i] === "(") return literalString(text, i + 1);
  if (text[i] === "<" && text[i + 1] !== "<") return hexString(text, i + 1);
  return null;
}

// Where a literal string that opens at `from` (after its parenthesis) ends: past its closing parenthesis.
function literalEnd(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

const DELIMITER = /[\0\t\n\f\r ()<>[\]{}/%]/;

// Each `/URI` value in a PDF's text (its bytes read one character per byte), read as tokens in one pass: comments,
// strings and stream data are stepped over, so `/URI` written inside them is no key (round 3: fifty commented decoys
// pushed out the one real link). The key is matched however its name is written (`#` escapes, 7.3.5); its value, past
// white space and comments, is a string, or a reference to one (`12 0 R`) kept in `refs` to resolve.
function pdfUris(text: string, emit: (url: string) => void, refs: Set<string>) {
  let i = 0;
  let last = "";
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "%") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (c === "(") {
      i = literalEnd(text, i + 1);
      last = ")";
    } else if (c === "<" && text[i + 1] === "<") {
      // A dictionary opens: one token, so its second `<` never reads as a hex string's.
      i += 2;
      last = "<<";
    } else if (c === "<") {
      const end = text.indexOf(">", i);
      i = end < 0 ? text.length : end + 1;
      last = ">";
    } else if (c === "/") {
      let j = i + 1;
      while (j < text.length && !DELIMITER.test(text[j] as string)) j++;
      const name = text
        .slice(i + 1, j)
        .replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      i = j;
      last = "/";
      if (name !== "URI") continue;
      const at = skipSpace(text, i);
      const value = stringAt(text, at);
      if (value !== null) emit(value);
      else {
        const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(text.slice(at, at + 40));
        // Each object once, however many annotations name it (round 1: a cap on occurrences hid a later link).
        if (ref) refs.add(`${ref[1]} ${ref[2]}`);
      }
    } else if (c === "s" && last === ">>" && /^stream(?:\r\n|\n|\r)/.test(text.slice(i, i + 8))) {
      // A stream's data is bytes, not tokens: stepped over to its end.
      const end = text.indexOf("endstream", i + 6);
      i = end < 0 ? text.length : end + 9;
      last = "";
    } else {
      if (c === ">" && text[i + 1] === ">") {
        last = ">>";
        i += 2;
        continue;
      }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
}

// Inflated bytes, or "too-large" past `budget`, or null when they do not inflate.
async function inflate(bytes: Uint8Array, budget: number): Promise<Uint8Array | "too-large" | null> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      total += read.value.byteLength;
      if (total > budget) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(read.value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const binary = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32_768) text += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  return text;
};

// The `/URI` actions in a PDF's bytes: in its objects as written and in its compressed object streams (`/Type /ObjStm`,
// FlateDecode), inflated up to MAX_INFLATED in all, a value given by reference read from the object it names. An
// encrypted file's strings cannot be read, nor those of an object stream that does not inflate or a reference to no
// string: it says so (completion review: a damaged file must not pass as one with no links), as it does past the bound.
export async function pdfLinks(
  bytes: Uint8Array,
  emit: (url: string) => void,
): Promise<"encrypted" | "damaged" | "too-large" | null> {
  const text = binary(bytes);
  if (/\/Encrypt\b/.test(text)) return "encrypted";
  const refs = new Set<string>();
  pdfUris(text, emit, refs);
  // Each object stream's objects by number (7.5.7): its header's pairs of number and offset after `/First`.
  const packed = new Map<string, string>();
  let damaged = false;
  let budget = MAX_INFLATED;
  for (const m of text.matchAll(/\bobj\s*<<([\s\S]{0,4096}?)>>\s*stream(?:\r\n|\n|\r)/g)) {
    // Names compared as written or `#`-escaped (7.3.5; round 1: `/Obj#53tm` is `/ObjStm`).
    // Comments read as the white space they are (7.2.3; round 2: `/Type % note` then `/ObjStm`).
    const dict = (m[1] as string)
      .replace(/%[^\r\n]*/g, " ")
      .replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (!/\/Type\s*\/ObjStm\b/.test(dict) || !/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict))
      continue;
    const start = m.index + m[0].length;
    // A direct length, whole (round 2: `12 0 R` once read as `1`); else up to `endstream` and its end of line.
    const length = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
    let end = length ? start + Number(length[1]) : text.indexOf("endstream", start);
    if (!length) while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
    if (end <= start) {
      damaged = true;
      continue;
    }
    const inflated = await inflate(bytes.subarray(start, Math.min(end, bytes.length)), budget);
    if (inflated === "too-large") return "too-large";
    if (!inflated) {
      damaged = true;
      continue;
    }
    budget -= inflated.byteLength;
    const objects = binary(inflated);
    pdfUris(objects, emit, refs);
    const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? Number.NaN);
    const header = Number.isNaN(first) ? [] : objects.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < header.length && i < 2 * MAX_PENDING; i += 2)
      packed.set(
        `${header[i]} 0`,
        objects.slice(first + (header[i + 1] as number), first + (header[i + 1] as number) + MAX_URL * 4),
      );
  }
  // Past MAX_PENDING distinct objects named, the file is more than is read.
  if (refs.size > MAX_PENDING) return "too-large";
  for (const ref of refs) {
    const [num, gen] = ref.split(" ");
    const direct = new RegExp(`(?:^|[^0-9])${num}\\s+${gen}\\s+obj\\b`).exec(text);
    const body = direct
      ? text.slice(direct.index + direct[0].length, direct.index + direct[0].length + MAX_URL * 4)
      : packed.get(ref);
    const value = body === undefined ? null : stringAt(body, skipSpace(body, 0));
    if (value === null) damaged = true;
    else emit(value);
  }
  return damaged ? "damaged" : null;
}

const isPdf = (a: CaseView["attachments"][number], head: string | undefined) =>
  (head ? sniff(Uint8Array.from(atob(head), (c) => c.charCodeAt(0))) === "pdf" : false) ||
  a.mediaType.split(";")[0]?.trim().toLowerCase() === "application/pdf" ||
  /\.pdf$/i.test(a.filename);

// The case's links, for the view: null for an uploaded file other than a PDF. A missing object or an undecodable
// charset is named in `unread`; any other storage error is thrown, so the step is retried.
export async function linksOf(
  bucket: R2Bucket,
  view: Pick<
    CaseView,
    "source" | "text" | "html" | "truncated" | "attachments" | "attachmentHeads" | "htmlAttachments"
  >,
): Promise<Links | null> {
  const log = new LinkLog();
  const pdfs: { key: string }[] = [];
  if (view.source.kind === "upload") {
    if (view.source.mediaType.split(";")[0]?.trim().toLowerCase() !== "application/pdf") return null;
    pdfs.push({ key: view.source.key });
  } else {
    if (view.html !== null) await log.html(view.html, "summary");
    if (view.text !== null) {
      const text = new TextLinks((url) => log.add(url, "text", "summary"));
      text.feed(view.text);
      text.end();
    }
    for (const part of view.truncated) {
      const type = part.mediaType.split(";")[0]?.trim().toLowerCase();
      if (type !== "text/html" && type !== "text/plain") continue;
      const charset = part.charset ?? "utf-8";
      try {
        new TextDecoder(charset);
      } catch {
        log.unread.push({ key: part.key, why: "charset" });
        continue;
      }
      const object = await bucket.get(part.key);
      if (!object) {
        log.unread.push({ key: part.key, why: "missing" });
        continue;
      }
      const decoded = object.body.pipeThrough(new TextDecoderStream(charset));
      if (type === "text/html") {
        await log.html(decoded.pipeThrough(new TextEncoderStream()), part.key);
        continue;
      }
      // Read in TEXT_CHUNK pieces, whatever size the stream gives.
      const text = new TextLinks((url) => log.add(url, "text", part.key));
      const reader = decoded.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        for (let i = 0; i < chunk.value.length; i += TEXT_CHUNK) text.feed(chunk.value.slice(i, i + TEXT_CHUNK));
      text.end();
    }
    // The HTML and SVG attachments' links, and those not read whole or at all (completion review).
    for (const attachment of view.htmlAttachments?.items ?? []) {
      log.merge(attachment.links);
      if (attachment.features.truncated) log.unread.push({ key: attachment.key, why: "too-large" });
    }
    log.unread.push(...(view.htmlAttachments?.skipped ?? []));
    const heads = new Map((view.attachmentHeads?.heads ?? []).map((h) => [h.key, h.head]));
    pdfs.push(...view.attachments.filter((a) => isPdf(a, heads.get(a.key))));
  }
  for (const [i, { key }] of pdfs.entries()) {
    if (i >= MAX_PDFS) {
      log.unread.push({ key, why: "too-many" });
      continue;
    }
    const object = await bucket.get(key, { range: { offset: 0, length: MAX_PDF_BYTES } });
    if (!object) {
      log.unread.push({ key, why: "missing" });
      continue;
    }
    const outcome = await pdfLinks(new Uint8Array(await object.arrayBuffer()), (url) => log.add(url, "pdf", key));
    if (outcome) log.unread.push({ key, why: outcome });
    else if (object.size > MAX_PDF_BYTES) log.unread.push({ key, why: "too-large" });
  }
  return log.result();
}

// A domain written in anchor text: labels of letters, digits and hyphens, the last of letters.
const SHOWN_DOMAIN = /(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}[\p{L}\p{N}-]{0,61}/gu;
// Real top-level domains that are also file extensions: `invoice.zip` in anchor text names a file, not a site, unless
// written as one (`www.` or a scheme before it).
const FILE_TLDS = new Set(["zip", "mov", "md", "py", "sh", "rs", "pl", "ps"]);

// Every domain an anchor text shows (at most ten), each as shown and as its registrable domain in ASCII.
export function shownDomains(anchor: string): { shown: string; registrable: string }[] {
  const found: { shown: string; registrable: string }[] = [];
  for (const m of anchor.matchAll(SHOWN_DOMAIN)) {
    if (found.length >= 10) break;
    const shown = m[0].replace(/\.$/, "");
    const tld = shown.slice(shown.lastIndexOf(".") + 1).toLowerCase();
    const before = anchor.slice(Math.max(0, m.index - 3), m.index);
    if (FILE_TLDS.has(tld) && !/^www\./i.test(shown) && before !== "://") continue;
    let ascii: string;
    try {
      ascii = new URL(`http://${shown}`).hostname;
    } catch {
      continue;
    }
    const domain = registrable(ascii);
    if (domain) found.push({ shown, registrable: domain });
  }
  return found;
}

export function linkMismatchEvidence(view: CaseView): EvidenceDraft[] {
  const links = view.links;
  if (!links) return [];
  const items: EvidenceDraft[] = [];
  const said = new Set<string>();
  for (const link of links.items) {
    if (!link.anchor) continue;
    // Any domain the text shows that is not the link's own (completion review: not only the first).
    const target = registrable(link.host) ?? link.host;
    const shown = shownDomains(link.anchor).find((d) => d.registrable !== target);
    if (!shown) continue;
    const key = `${shown.registrable} ${link.host}`;
    if (said.has(key) || items.length >= MAX_MISMATCH_ITEMS) continue;
    said.add(key);
    items.push({
      check: "link.text_mismatch",
      severity: "medium",
      summary: bounded(`The link showing ${plain(shown.shown, 80)} goes to ${plain(link.display, 80)}.`),
      detail: { shown: shown.shown, target: link.host, href: link.href, kind: link.kind, part: link.part },
      artefacts: link.part === "summary" ? [] : [link.part],
    });
  }
  if (links.more || links.unread.length)
    items.push({
      check: "link.text_mismatch",
      severity: "info",
      summary: bounded(
        [
          links.more ? `${links.more} more links were not checked` : "",
          links.unread.length ? `${links.unread.length} parts or files could not be read for links` : "",
        ]
          .filter(Boolean)
          .join("; ") + ".",
      ),
      // The first MAX_UNREAD_NAMED unread named, the rest counted (the app lane's D07 T03 §31 completion review).
      detail: {
        checked: false,
        more: links.more,
        unread: links.unread.slice(0, MAX_UNREAD_NAMED),
        unreadMore: Math.max(0, links.unread.length - MAX_UNREAD_NAMED),
      },
      artefacts: [],
    });
  return items;
}

export function registerLinkMismatchCheck(registry: CheckRegistry): void {
  registry.register({
    name: "link.text_mismatch",
    needs: [],
    timeoutMs: 1_000,
    run: linkMismatchEvidence,
    applies: (view) => (view.links?.items.length || view.links?.unread.length ? null : "the case has no links"),
    partial: (view) => {
      const links = view.links;
      if (!links) return null;
      const why = [
        links.more ? `${links.more} links past the first ${MAX_LINKS} were not checked` : "",
        links.unread.length ? `${links.unread.length} parts or files could not be read for links` : "",
      ].filter(Boolean);
      return why.length ? why.join("; ") : null;
    },
  });
}
