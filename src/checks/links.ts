// Every link in a case (D02 T07 §1; spec 4.3): read by the Workflow's `checks` step into `CaseView.links`, since a
// check never reads storage, from the summary's HTML and text, each body part cut for reading (read whole from R2), the
// HTML and SVG attachments (from the read `htmlAttachmentsOf` already makes) and PDF attachments' `/URI` actions. Each
// link keeps where it came from and its anchor text, so the report can say "the button labelled View invoice goes to
// ...", and §2 and §3 follow the same list. `link.text_mismatch` reads it: anchor text naming one domain on a link to
// another is evidence in itself.
import { bounded, plain } from "./auth";
import { registrable } from "./brand-schema";
import type { CaseView } from "./case-view";
import { knownDomains } from "./domain-lookalike";
import type { EvidenceDraft } from "./evidence";
import type { Expansion, Landing } from "./expand";
import { MAX_FOLLOWED } from "./expand-limits";
import { decodeEntities } from "./hidden-text";
import { unicodeLabel } from "./lookalike";
import { counted, fitted } from "./outcome-summary";
import { type CheckRegistry, MAX_ITEMS_PER_CHECK } from "./registry";
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
    out += String.fromCharCode(Number.parseInt(`${hex.slice(i, i + 2)}0`.slice(0, 2), 16));
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
const SPACE = /[\0\t\n\f\r ]/;

// A dictionary's text as its names mean it: comments read as white space (7.2.3) and `#` escapes decoded (7.3.5).
const pdfDict = (dict: string) =>
  dict
    .replace(/%[^\r\n]*/g, " ")
    .replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

// What one pass over a PDF's tokens found: the objects each `/URI` names (to resolve), where each object `N G obj`
// begins, and each stream's dictionary and data.
type PdfScan = {
  refs: Set<string>;
  objects: Map<string, number>;
  streams: { dict: string; start: number; end: number }[];
  // A stream whose indirect length could not be resolved from a real object: stepped over as a viewer recovers it, so
  // the file is read as damaged, never as complete (round 7).
  uncertain: boolean;
};

// The file's cross-reference tables (7.5.4), from its last `startxref` back through each `/Prev`: object `N G` to its
// byte offset. A table is found by the offsets the file ends with, never by a search a comment could answer. Empty for
// a file whose cross-references are compressed streams (7.5.8), which are not read here.
function xrefOffsets(text: string): Map<string, number> {
  const offsets = new Map<string, number>();
  let at = Number(/startxref\s+(\d+)\s*(?:%%EOF)?\s*$/.exec(text.slice(-1_024))?.[1] ?? Number.NaN);
  for (let sections = 0; sections < 10 && Number.isInteger(at) && text.startsWith("xref", at); sections++) {
    let i = at + 4;
    for (;;) {
      const head = /^\s*(\d+)\s+(\d+)[ \t]*\r?\n?/.exec(text.slice(i, i + 40));
      if (!head) break;
      i += head[0].length;
      const first = Number(head[1]);
      const count = Math.min(Number(head[2]), 1_000_000 - offsets.size);
      for (let n = 0; n < count; n++) {
        const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(text.slice(i, i + 20));
        if (!entry) break;
        const key = `${first + n} ${Number(entry[2])}`;
        if (entry[3] === "n" && !offsets.has(key)) offsets.set(key, Number(entry[1]));
        i += 20;
      }
    }
    const trailer = /^\s*trailer\s*<<([\s\S]{0,4096}?)>>/.exec(text.slice(i, i + 4_200));
    at = Number(/\/Prev\s+(\d+)/.exec(trailer?.[1] ?? "")?.[1] ?? Number.NaN);
  }
  return offsets;
}

// Where a stream's data ends (7.3.8): at its declared `/Length` when `endstream` follows it there, the length direct
// or the integer of the object it names (`lengthOf`, null when no real object gives one); else, as a viewer recovers a
// wrong length, at the first `endstream` less its end of line (round 4: data holding `endstream` and decoy links is
// stepped over by its length). `uncertain` says the recovery was used for a length that was named but not found.
function streamEnd(
  text: string,
  start: number,
  dict: string,
  lengthOf: (ref: string) => number | null,
): { end: number; uncertain: boolean } {
  const ends = (length: number) => /^[\0\t\n\f\r ]*endstream/.test(text.slice(start + length, start + length + 40));
  const direct = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
  if (direct && ends(Number(direct[1]))) return { end: start + Number(direct[1]), uncertain: false };
  const ref = /\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(dict);
  const length = ref ? lengthOf(`${ref[1]} ${ref[2]}`) : null;
  if (length !== null && ends(length)) return { end: start + length, uncertain: false };
  let end = text.indexOf("endstream", start);
  if (end < 0) return { end: text.length, uncertain: !!ref };
  while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return { end, uncertain: !!ref };
}

// A PDF's text (its bytes read one character per byte) read as tokens in one pass: comments, strings and stream data
// are stepped over, so `/URI` written inside them is no key (round 3), and an object is where its tokens say, never
// where a comment says (round 4). Each `/URI` key, however its name is written (`#` escapes), gives its value past
// white space and comments: a string, emitted, or a reference (`12 0 R`), kept in `scan.refs` to resolve.
function scanPdf(text: string, emit: (url: string) => void, scan: PdfScan) {
  let i = 0;
  let last = "";
  let ints: string[] = [];
  const dicts: number[] = [];
  let lastDict = "";
  // An indirect length (round 7: never from raw bytes a comment could write): the integer of an object the scan has
  // already read as tokens, else of the object the cross-reference table places, checked to be that object there.
  let xref: Map<string, number> | null = null;
  const integerAt = (at: number) => {
    const m = /^(\d+)\b/.exec(text.slice(skipSpace(text, at), skipSpace(text, at) + 20));
    return m ? Number(m[1]) : null;
  };
  const lengthOf = (ref: string): number | null => {
    const seen = scan.objects.get(ref);
    if (seen !== undefined) return integerAt(seen);
    xref ??= xrefOffsets(text);
    const offset = xref.get(ref);
    if (offset === undefined) return null;
    const head = /^(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(offset, offset + 40));
    return head && `${Number(head[1])} ${Number(head[2])}` === ref ? integerAt(offset + head[0].length) : null;
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    if (c === "%") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      i = literalEnd(text, i + 1);
      last = ")";
    } else if (c === "<" && text[i + 1] === "<") {
      dicts.push(i);
      i += 2;
      last = "<<";
    } else if (c === "<") {
      const end = text.indexOf(">", i);
      i = end < 0 ? text.length : end + 1;
      last = ">";
    } else if (c === ">" && text[i + 1] === ">") {
      const open = dicts.pop();
      if (open !== undefined && !dicts.length) lastDict = text.slice(open, Math.min(i + 2, open + 8_192));
      i += 2;
      last = ">>";
    } else if (c === "/") {
      let j = i + 1;
      while (j < text.length && !DELIMITER.test(text[j] as string)) j++;
      const name = pdfDict(text.slice(i + 1, j));
      i = j;
      last = "/";
      if (name === "URI") {
        const at = skipSpace(text, i);
        const value = stringAt(text, at);
        if (value !== null) emit(value);
        else {
          const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(text.slice(at, at + 40));
          // Each object once, however many annotations name it (round 1: a cap on occurrences hid a later link).
          if (ref) scan.refs.add(`${ref[1]} ${ref[2]}`);
        }
      }
    } else if (DELIMITER.test(c)) {
      i++;
      last = c;
    } else {
      let j = i;
      while (j < text.length && !DELIMITER.test(text[j] as string)) j++;
      const token = text.slice(i, j);
      i = j;
      if (token === "obj" && ints.length === 2) scan.objects.set(ints.join(" "), i);
      else if (token === "stream" && last === ">>") {
        // The data starts after the keyword's end of line, and is stepped over whole.
        if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
        else if (text[i] === "\n" || text[i] === "\r") i++;
        const dict = pdfDict(lastDict);
        const { end, uncertain } = streamEnd(text, i, dict, lengthOf);
        if (uncertain) scan.uncertain = true;
        scan.streams.push({ dict, start: i, end });
        const keyword = text.indexOf("endstream", end);
        i = keyword >= 0 && keyword - end < 40 ? keyword + 9 : end;
      }
      ints = /^\d+$/.test(token) ? [...ints, token].slice(-2) : [];
      last = token;
      continue;
    }
    ints = [];
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
  const scan: PdfScan = { refs: new Set(), objects: new Map(), streams: [], uncertain: false };
  scanPdf(text, emit, scan);
  // Each object stream's objects by number (7.5.7): its header's pairs of number and offset after `/First`.
  const packed = new Map<string, string>();
  let damaged = false;
  let budget = MAX_INFLATED;
  for (const { dict, start, end } of scan.streams) {
    if (!/\/Type\s*\/ObjStm\b/.test(dict) || !/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict))
      continue;
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
    scanPdf(objects, emit, { refs: scan.refs, objects: new Map(), streams: [], uncertain: false });
    const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? Number.NaN);
    const header = Number.isNaN(first) ? [] : objects.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < header.length && i < 2 * MAX_PENDING; i += 2) {
      const at = first + (header[i + 1] as number);
      packed.set(`${header[i]} 0`, objects.slice(at, at + MAX_URL * 4));
    }
  }
  // Past MAX_PENDING distinct objects named, the file is more than is read.
  if (scan.refs.size > MAX_PENDING) return "too-large";
  for (const ref of scan.refs) {
    const at = scan.objects.get(ref);
    const body = at === undefined ? packed.get(ref) : text.slice(at, at + MAX_URL * 4);
    const value = body === undefined ? null : stringAt(body, skipSpace(body, 0));
    if (value === null) damaged = true;
    else emit(value);
  }
  return damaged || scan.uncertain ? "damaged" : null;
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
        `${[
          links.more ? `${links.more} more links were not checked` : "",
          links.unread.length ? `${links.unread.length} parts or files could not be read for links` : "",
        ]
          .filter(Boolean)
          .join("; ")}.`,
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

// The links read and their registrable domains (D02 T01 §7): "1, to fynbosfreight.example", fitted to the summary's
// length; the ASCII form, as a lookalike's Unicode is the card's to show.
export function linksSummary(view: Readonly<CaseView>): string | null {
  const items = view.links?.items ?? [];
  if (!items.length) return null;
  const domains = [...new Set(items.map((link) => registrable(link.host) ?? link.host))];
  return fitted(`${items.length}, to `, domains, `${items.length}, to ${counted(domains.length, "domain", "domains")}`);
}

export function registerLinkMismatchCheck(registry: CheckRegistry): void {
  registry.register({
    name: "link.text_mismatch",
    needs: [],
    timeoutMs: 1_000,
    run: linkMismatchEvidence,
    summary: linksSummary,
    examined: (view) => (view.links?.items ?? []).map((link) => link.href),
    // Links past a bound are links too (round 8): a case whose only links were not read is partial, never "no links".
    applies: (view) =>
      view.links?.items.length || view.links?.unread.length || view.links?.more ? null : "the case has no links",
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

// What the page settled on, per link (D02 T07 §2): a chain with a redirect in it, a download stopped, a link that could not
// be followed to its end, and a final site that is not the link's own. Pure: the checks step followed the links in Browser
// Run before the checks ran. Domains are read from the whole addresses the follower kept, never from display text.
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function followedWords(e: Expansion, redirects: number): string {
  const from = plain(hostOf(e.link) ?? e.link, 80);
  const at = e.finalHost ? plain(e.finalHost, 80) : null;
  const parts: string[] = [];
  if (redirects > 0) parts.push(`redirects ${redirects === 1 ? "once" : `${redirects} times`}`);
  if (at) parts.push(e.outcome === "done" ? `ends at ${at}` : `was last seen at ${at}`);
  if (e.downloads.length) parts.push("tried to download a file, which was stopped");
  if (e.refused.length && e.outcome !== "blocked")
    parts.push(`had ${plural(e.refused.length, "request")} refused by the safety rules`);
  if (e.outcome === "timeout") parts.push("did not finish in time");
  else if (e.outcome === "error") parts.push("could not be followed to its end");
  else if (e.outcome === "blocked")
    parts.push(`was not followed (${plain(e.reason ?? "refused by the safety rules", 120)})`);
  const last = parts.pop();
  return `The link to ${from} ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

const hostOf = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
};

export function linkRedirectEvidence(view: CaseView): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const e of view.expansions?.items ?? []) {
    const redirects = e.hops.filter((h) => h.location !== null).length;
    // Worth showing: a chain, a download stopped, or a link that did not get to its end, whatever the reason.
    if (redirects === 0 && e.downloads.length === 0 && e.refused.length === 0 && e.outcome === "done") continue;
    items.push({
      check: "link.redirects",
      severity: "info",
      summary: bounded(followedWords(e, redirects)),
      detail: {
        link: e.link,
        final: e.final,
        confirmed: e.outcome === "done",
        outcome: e.outcome,
        reason: e.reason,
        hops: e.hops.map((h) => ({ url: h.url, status: h.status, via: h.via })),
        downloads: e.downloads,
        refused: e.refused,
      },
      artefacts: [],
    });
  }
  return items;
}

export function linkFinalDomainEvidence(view: CaseView): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const e of view.expansions?.items ?? []) {
    const from = hostOf(e.link);
    const to = e.finalHost;
    if (!from || !to) continue;
    const first = registrable(from) ?? from;
    const last = registrable(to) ?? to;
    if (first === last) continue;
    items.push({
      check: "link.final_domain_changed",
      severity: "medium",
      summary: bounded(
        e.outcome === "done"
          ? `The link to ${plain(from, 80)} ends at a different site, ${plain(to, 80)}.`
          : `The link to ${plain(from, 80)} was last seen at a different site, ${plain(to, 80)}, before it stopped.`,
      ),
      detail: {
        link: e.link,
        final: e.final,
        confirmed: e.outcome === "done",
        from: first,
        to: last,
        outcome: e.outcome,
      },
      artefacts: [],
    });
  }
  return items;
}

// Links not followed through are links not checked: a case whose links were cut, timed out, failed or were refused, or
// whose links could not all be found, is partial, never a clean run (D02 T07 §2 plan review and completion review).
function expansionPartial(view: Readonly<CaseView>): string | null {
  const x = view.expansions;
  const links = view.links;
  const why = [
    ...(links?.more
      ? [`${plural(links.more, "link")} past the first ${MAX_LINKS} were not found, so not followed`]
      : []),
    ...(links?.unread.length
      ? [`${plural(links.unread.length, "part or file", "parts or files")} could not be read for links`]
      : []),
    ...(x?.skipped ?? []).map(
      (s) =>
        `${plural(s.count, "link")} ${s.count === 1 ? "was" : "were"} not followed (${s.why === "time" ? "out of time" : `past the first ${MAX_FOLLOWED}`})`,
    ),
    ...(["timeout", "error", "blocked"] as const).flatMap((o) => {
      const n = x?.items.filter((i) => i.outcome === o).length ?? 0;
      const what =
        o === "timeout" ? "timed out" : o === "error" ? "could not be followed" : "was refused by the safety rules";
      return n ? [`${plural(n, "link")} ${n === 1 || o === "timeout" ? what : what.replace("was ", "were ")}`] : [];
    }),
  ];
  return why.length ? why.join("; ") : null;
}

const expansionApplies = (view: Readonly<CaseView>): string | null => {
  const links = view.links;
  if (!links || (!links.items.length && !links.more && !links.unread.length)) return "the case has no links";
  return view.expansions ? null : "the links could not be followed just now";
};

// What a followed-link check says it saw (D02 T01 §7), from its own findings only: the items that are findings, not the
// notes saying part of the reading was left out.
const findings = (items: readonly EvidenceDraft[]) => items.filter((i) => i.detail.checked !== false).length;
const says =
  (one: string, many: string, none: string) => (_view: Readonly<CaseView>, items: readonly EvidenceDraft[]) => {
    const n = findings(items);
    return n ? counted(n, one, many) : none;
  };

export function registerLinkExpansionChecks(registry: CheckRegistry): void {
  for (const [name, run, summary] of [
    [
      "link.redirects",
      linkRedirectEvidence,
      says("link redirects elsewhere", "links redirect elsewhere", "no link redirects"),
    ],
    [
      "link.final_domain_changed",
      linkFinalDomainEvidence,
      says("link ends at a different site", "links end at a different site", "no link ends at a different site"),
    ],
  ] as const)
    registry.register({
      name,
      needs: [],
      timeoutMs: 1_000,
      run,
      applies: expansionApplies,
      partial: expansionPartial,
      summary,
      examined: (view) => (view.expansions?.items ?? []).map((e) => e.final ?? e.link),
    });
}

// What the settled page asks for (D02 T07 §3). The page's own screenshot and scans were taken where §2 followed the link; a
// link not followed to its end has no page read, and each thing the reading could not do is a coverage reason that makes
// these checks partial, so a followed link never hides an incomplete page.
const siteOf = (host: string | null) => (host ? (registrable(host) ?? host) : null);
const pageLabel = (e: Expansion) => plain(e.finalHost ?? hostOf(e.link) ?? e.link, 80);

// Why a page has no screenshot, in a reader's words (the card shows it beside the finding it belongs to).
const SHOT_WHY: Record<string, string> = {
  "too-large": "was too large to keep",
  timeout: "was not taken in time",
  error: "could not be taken",
  "not-stored": "could not be stored",
};
const shotNote = (landing: Landing | null) =>
  landing && landing.coverage.shot !== "taken" ? (SHOT_WHY[landing.coverage.shot] ?? null) : null;

// A check may return at most MAX_ITEMS_PER_CHECK items or the runner refuses them all, and a hostile page can hold more
// forms than that: the most serious are kept, and one note says how many were left out (and the check is partial).
const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
function capped(check: string, items: EvidenceDraft[], one: string, many: string): EvidenceDraft[] {
  if (items.length <= MAX_ITEMS_PER_CHECK) return items;
  const kept = [...items]
    .sort((a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5))
    .slice(0, MAX_ITEMS_PER_CHECK - 1);
  const more = items.length - kept.length;
  kept.push({
    check,
    severity: "info",
    summary: bounded(`${plural(more, one, many)} too many to list ${more === 1 ? "was" : "were"} left out.`),
    detail: { checked: false, more },
    artefacts: [],
  });
  return kept;
}
export const linkCredentialFormEvidence = (view: CaseView) =>
  capped("link.credential_form", credentialItems(view), "form or field", "forms or fields");
export const linkCardFormEvidence = (view: CaseView) =>
  capped("link.card_form", cardItems(view), "card form", "card forms");
export const linkLureButtonEvidence = (view: CaseView) => capped("link.lure_button", lureItems(view), "page", "pages");

// Each form a page holds is judged on its own: a login form is one finding, an unrelated newsletter form another, and a
// destination is a declared one (where the form is set to send what is typed), never a claim that anything was sent.
function credentialItems(view: CaseView): EvidenceDraft[] {
  const known = knownDomains(view);
  const items: EvidenceDraft[] = [];
  for (const e of view.expansions?.items ?? []) {
    const shotKey = e.landing?.shotKey ?? null;
    for (const scan of e.landing?.scans ?? []) {
      const here = siteOf(hostOf(scan.url));
      const unknown = here === null || !known.has(here);
      const where = `The page the link to ${pageLabel(e)} reaches${scan.frame ? " holds a frame that" : ""}`;
      const base = {
        link: e.link,
        page: scan.url,
        frame: scan.frame,
        knownSite: !unknown,
        shotKey,
        shot: shotNote(e.landing),
      };
      const draft = (severity: "high" | "medium", summary: string, extra: Record<string, unknown>): EvidenceDraft => ({
        check: "link.credential_form",
        severity,
        summary: bounded(summary),
        detail: { ...base, ...extra } as EvidenceDraft["detail"],
        artefacts: shotKey ? [shotKey] : [],
      });
      for (const form of scan.forms) {
        const sends = form.destinations.filter((d) => d.offDomain);
        const target = plain(sends[0]?.host ?? "another site", 80);
        if (form.passwordFields > 0)
          items.push(
            draft(
              sends.length > 0 || unknown ? "high" : "medium",
              `${where} asks for a password${sends.length > 0 ? ` and is set to send what is typed to ${target}` : ""}.`,
              {
                passwordFields: form.passwordFields,
                sends: sends.map((d) => ({ host: d.host, viaFormaction: d.viaFormaction })),
              },
            ),
          );
        else if (sends.length > 0)
          items.push(
            draft("medium", `${where} has a form set to send what is typed to ${target}.`, {
              passwordFields: 0,
              sends: sends.map((d) => ({ host: d.host, viaFormaction: d.viaFormaction })),
            }),
          );
      }
      if (scan.loosePasswordFields > 0)
        items.push(
          draft(unknown ? "high" : "medium", `${where} asks for a password.`, {
            passwordFields: scan.loosePasswordFields,
            sends: [],
          }),
        );
    }
  }
  return items;
}

function cardItems(view: CaseView): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const e of view.expansions?.items ?? []) {
    const shotKey = e.landing?.shotKey ?? null;
    for (const scan of e.landing?.scans ?? []) {
      const fields = scan.forms.reduce((n, f) => n + f.cardFields, 0) + scan.looseCardFields;
      if (fields === 0) continue;
      items.push({
        check: "link.card_form",
        severity: "high",
        summary: bounded(
          `The page the link to ${pageLabel(e)} reaches${scan.frame ? " holds a frame that" : ""} asks for card details (${plural(fields, "field")}).`,
        ),
        detail: {
          link: e.link,
          page: scan.url,
          frame: scan.frame,
          cardFields: fields,
          shotKey,
          shot: shotNote(e.landing),
        },
        artefacts: shotKey ? [shotKey] : [],
      });
    }
  }
  return items;
}

// A page (or frame) with almost nothing on it but a button that asks the reader to view, open or verify: what the
// walkthrough follows.
function lureItems(view: CaseView): EvidenceDraft[] {
  const items: EvidenceDraft[] = [];
  for (const e of view.expansions?.items ?? []) {
    const shotKey = e.landing?.shotKey ?? null;
    for (const scan of e.landing?.scans ?? []) {
      if (scan.lures.length === 0) continue;
      const fields =
        scan.loosePasswordFields +
        scan.looseCardFields +
        scan.forms.reduce((n, f) => n + f.passwordFields + f.cardFields, 0);
      if (fields > 0 || scan.forms.length > 0 || scan.text.length >= 400) continue;
      const lure = scan.lures[0];
      items.push({
        check: "link.lure_button",
        severity: "medium",
        summary: bounded(
          `The page the link to ${pageLabel(e)} reaches${scan.frame ? " holds a frame that" : ""} is nearly empty but for a button, "${plain(lure?.text ?? "", 60)}"${
            lure?.host ? `, which goes to ${plain(lure.host, 80)}` : ""
          }.`,
        ),
        detail: {
          link: e.link,
          page: scan.url,
          frame: scan.frame,
          buttons: scan.lures.map((l) => ({ text: l.text, host: l.host })),
          shotKey,
          shot: shotNote(e.landing),
        },
        artefacts: shotKey ? [shotKey] : [],
      });
    }
  }
  return items;
}

// What the reading of the pages could not do, in a reader's words; the redirect checks' own reasons come first.
function landingPartial(view: Readonly<CaseView>): string | null {
  const base = expansionPartial(view);
  const items = view.expansions?.items ?? [];
  const count = (test: (e: Expansion) => boolean) => items.filter((e) => e.landing && test(e)).length;
  const over = [
    credentialItems(view).length > MAX_ITEMS_PER_CHECK ? "more password or sending forms than could be listed" : null,
    cardItems(view).length > MAX_ITEMS_PER_CHECK ? "more card forms than could be listed" : null,
    lureItems(view).length > MAX_ITEMS_PER_CHECK ? "more lure pages than could be listed" : null,
  ].filter((x): x is string => x !== null);
  const why = [
    ...over,
    ...Object.entries(SHOT_WHY).flatMap(([k, words]) => {
      const n = count((e) => e.landing?.coverage.shot === k);
      return n ? [`${plural(n, "page")} had a screenshot that ${words}`] : [];
    }),
    ...(count((e) => e.landing?.coverage.scan === "failed")
      ? [
          `${plural(
            count((e) => e.landing?.coverage.scan === "failed"),
            "page",
          )} could not be read`,
        ]
      : []),
    ...(count((e) => (e.landing?.coverage.framesRead ?? 0) < (e.landing?.coverage.framesTotal ?? 0))
      ? [
          `${plural(
            count((e) => (e.landing?.coverage.framesRead ?? 0) < (e.landing?.coverage.framesTotal ?? 0)),
            "page",
          )} had frames that were not read`,
        ]
      : []),
    ...(count((e) => e.landing?.scans.some((s) => s.formsCut || s.formsTotal > s.forms.length) ?? false)
      ? ["a page had more forms than were read"]
      : []),
    ...(count((e) => (e.landing?.coverage.closedShadows ?? 0) > 0)
      ? [
          `${plural(
            count((e) => (e.landing?.coverage.closedShadows ?? 0) > 0),
            "page",
          )} had shadow trees that could not be read`,
        ]
      : []),
    ...(count((e) => e.landing?.coverage.closedShadows === null)
      ? [
          `${plural(
            count((e) => e.landing?.coverage.closedShadows === null),
            "page",
          )} could not be checked for shadow trees`,
        ]
      : []),
    ...(count((e) => e.landing?.scans.some((s) => s.shadowCut) ?? false)
      ? ["a page had more shadow trees than were read"]
      : []),
    ...(count((e) => e.landing?.scans.some((s) => s.luresCut) ?? false)
      ? ["a page had more buttons than were read"]
      : []),
    ...(count((e) => e.landing?.scans.some((s) => s.textCut || s.hiddenCut) ?? false)
      ? ["a page had more text than was read"]
      : []),
  ];
  return [base, ...why].filter(Boolean).join("; ") || null;
}

export function registerLandingChecks(registry: CheckRegistry): void {
  for (const [name, run, summary] of [
    [
      "link.credential_form",
      linkCredentialFormEvidence,
      says("page asks for what you type", "pages ask for what you type", "no page asks for what you type"),
    ],
    [
      "link.card_form",
      linkCardFormEvidence,
      says("page asks for card details", "pages ask for card details", "no page asks for card details"),
    ],
    [
      "link.lure_button",
      linkLureButtonEvidence,
      says("page is nearly empty with a button", "pages are nearly empty with a button", "no such page"),
    ],
  ] as const)
    registry.register({
      name,
      needs: [],
      timeoutMs: 1_000,
      run,
      applies: expansionApplies,
      partial: landingPartial,
      summary,
      // The landing checks read every scan of a followed page, frames included, so every scan's URL is
      // a target (round 1), not only the page it settled on.
      examined: (view) => [
        ...new Set((view.expansions?.items ?? []).flatMap((e) => (e.landing?.scans ?? []).map((s) => s.url))),
      ],
    });
}
