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
export type Unread = { key: string; why: "missing" | "charset" | "encrypted" | "too-large" | "too-many" };
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
// takes the base's scheme, else `https:`.
export async function htmlLinks(
  input: string | ReadableStream<Uint8Array>,
  emit: (link: HtmlLink) => void,
): Promise<void> {
  let base: string | null = null;
  let baseSeen = false;
  const pending: HtmlLink[] = [];
  const found = (raw: string | null, kind: LinkKind, anchor: string | null) => {
    if (raw === null) return;
    const url = raw.trim();
    if (!url || url.length > MAX_URL) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) emit({ url, kind, anchor });
    else if (pending.length < MAX_PENDING) pending.push({ url, kind, anchor });
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
}

// A plain-text URL: `http://` or `https://`, or a host starting `www.`, then RFC 3986's characters (and letters and
// digits beyond ASCII, as IRIs write them).
const TEXT_URL = /(?:https?:\/\/|\bwww\.)[\p{L}\p{M}\p{N}\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

// A text URL without the punctuation that ends a sentence around it, and without a closing bracket it never opened.
export function trimTextUrl(found: string): string {
  let url = found;
  for (;;) {
    const last = url[url.length - 1] as string;
    if (".,;:!?'\"".includes(last)) url = url.slice(0, -1);
    else if (last in CLOSERS && url.split(CLOSERS[last] as string).length <= url.split(last).length - 1)
      url = url.slice(0, -1);
    else return url;
  }
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
      const url = trimTextUrl(m[0]);
      this.emit(/^www\./i.test(url) ? `http://${url}` : url);
      emitted = end;
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

// Each `/URI` string in a PDF's text (its bytes read one character per byte).
function pdfUris(text: string, emit: (url: string) => void) {
  for (const m of text.matchAll(/\/URI\s*([(<])(?!<)/g)) {
    const from = m.index + m[0].length;
    emit(m[1] === "(" ? literalString(text, from) : hexString(text, from));
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
// FlateDecode), inflated up to MAX_INFLATED in all. An encrypted file's strings cannot be read: it says so, as it does
// when its object streams inflate past the bound.
export async function pdfLinks(
  bytes: Uint8Array,
  emit: (url: string) => void,
): Promise<"encrypted" | "too-large" | null> {
  const text = binary(bytes);
  if (/\/Encrypt\b/.test(text)) return "encrypted";
  pdfUris(text, emit);
  let budget = MAX_INFLATED;
  for (const m of text.matchAll(/\bobj\s*<<([\s\S]{0,4096}?)>>\s*stream(?:\r\n|\n|\r)/g)) {
    const dict = m[1] as string;
    if (!/\/Type\s*\/ObjStm\b/.test(dict) || !/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict))
      continue;
    const start = m.index + m[0].length;
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const end = length ? start + Number(length[1]) : text.indexOf("endstream", start);
    if (end <= start) continue;
    const inflated = await inflate(bytes.subarray(start, Math.min(end, bytes.length)), budget);
    if (inflated === "too-large") return "too-large";
    if (!inflated) continue;
    budget -= inflated.byteLength;
    pdfUris(binary(inflated), emit);
  }
  return null;
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
    if (view.html !== null) await htmlLinks(view.html, (l) => log.add(l.url, l.kind, "summary", l.anchor));
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
        await htmlLinks(decoded.pipeThrough(new TextEncoderStream()), (l) =>
          log.add(l.url, l.kind, part.key, l.anchor),
        );
        continue;
      }
      // Read in TEXT_CHUNK pieces, whatever size the stream gives.
      const text = new TextLinks((url) => log.add(url, "text", part.key));
      const reader = decoded.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        for (let i = 0; i < chunk.value.length; i += TEXT_CHUNK) text.feed(chunk.value.slice(i, i + TEXT_CHUNK));
      text.end();
    }
    for (const attachment of view.htmlAttachments?.items ?? [])
      for (const l of attachment.links) log.add(l.url, l.kind, attachment.key, l.anchor);
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

// The first domain an anchor text shows, as its registrable domain in ASCII, and as shown; null when it shows none.
export function shownDomain(anchor: string): { shown: string; registrable: string } | null {
  for (const m of anchor.matchAll(SHOWN_DOMAIN)) {
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
    if (domain) return { shown, registrable: domain };
  }
  return null;
}

export function linkMismatchEvidence(view: CaseView): EvidenceDraft[] {
  const links = view.links;
  if (!links) return [];
  const items: EvidenceDraft[] = [];
  const said = new Set<string>();
  for (const link of links.items) {
    if (!link.anchor) continue;
    const shown = shownDomain(link.anchor);
    if (!shown) continue;
    const target = registrable(link.host) ?? link.host;
    if (shown.registrable === target) continue;
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
      detail: { checked: false, more: links.more, unread: links.unread.slice(0, 20) },
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
