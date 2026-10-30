// HTML and SVG attachments (D02 T04 §2; spec 4.3): an HTML file opened from disk is a page no link check sees, often a
// copied login page that posts the password elsewhere, or a smuggling loader that builds a file in the browser from a
// long base64 string and downloads it. The Workflow's `checks` step reads each such attachment (bounded) and analyses
// it here; the check maps the features to items: any HTML or SVG attachment is medium, a login page or a loader high.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { decodeEntities } from "./hidden-text";
import type { CheckRegistry } from "./registry";
import { sniff } from "./sniff";

export const MAX_HTML_ATTACHMENTS = 10;
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
// A base64 run this long is a payload, not an inline icon (spec 4.3: over 10 KB).
export const LONG_BASE64 = 10 * 1024;

export type HtmlFeatures = {
  passwordField: boolean;
  cardField: boolean;
  // Absolute http(s) form actions: a page opened from disk has no site, so any of them posts off it.
  formActions: string[];
  longBase64: boolean;
  builds: boolean;
  downloads: boolean;
  smuggling: boolean;
  // How the loader works, for an honest summary (completion review): script that builds the file, or a link that
  // downloads its own data.
  smugglingBy: "script" | "link" | null;
  // Whether the file was longer than MAX_HTML_BYTES, so only its start was read.
  truncated: boolean;
};
export type HtmlAttachment = { key: string; filename: string; kind: "html" | "svg"; features: HtmlFeatures };

const CARD = /card.?num|cardnumber|cc.?num|\bcvv\b|\bcvc\b|security.?code|expir|exp.?date|exp.?month|exp.?year/i;
const BUILDS = /new\s+Blob\s*\(|\batob\s*\(|data:[a-z0-9.+/-]*;base64,|Uint8Array\s*\.\s*from\s*\(/i;
// A download in script: a download attribute set, a save call, or an object URL with a click or a navigation anywhere
// in the script (completion review: no proximity limit between them).
const DOWNLOAD_DIRECT = /\.download\s*=|setAttribute\s*\(\s*["'`]download["'`]|msSaveOrOpenBlob|msSaveBlob/i;
const DATA_URL = /data:[^"'`\s]*;base64,/i;
const OBJECT_URL = /createObjectURL/i;
const OPENS = /\.click\s*\(|location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\(/i;
const downloadsIn = (script: string) =>
  DOWNLOAD_DIRECT.test(script) || ((OBJECT_URL.test(script) || DATA_URL.test(script)) && OPENS.test(script));

// The longest run of base64 characters in a text, found in one pass.
function longestBase64(text: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const b64 =
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
    run = b64 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

// The features of one HTML or SVG document.
export async function analyseHtml(html: string, truncated = false): Promise<HtmlFeatures> {
  let passwordField = false;
  let cardField = false;
  let dataDownload = false;
  const formActions: string[] = [];
  let script = "";
  let dataBase64 = 0;
  // Labels name fields too (completion review): a label's text for an input's id, and the open label an input sits in.
  const labelFor = new Map<string, string>();
  const inputIds: string[] = [];
  const openLabels: { text: string; for: string | null; wraps: boolean }[] = [];
  // An attribute as a browser reads it: its character references decoded (round 1).
  const attr = (e: Element, name: string) => {
    const value = e.getAttribute(name);
    return value === null ? null : decodeEntities(value);
  };
  await new HTMLRewriter()
    .on("label", {
      element(e) {
        const label = { text: "", for: attr(e, "for"), wraps: false };
        openLabels.push(label);
        e.onEndTag(() => {
          openLabels.splice(openLabels.lastIndexOf(label), 1);
          if (label.for) labelFor.set(label.for, `${labelFor.get(label.for) ?? ""} ${label.text}`);
          if (label.wraps && CARD.test(label.text)) cardField = true;
        });
      },
      text(chunk) {
        const label = openLabels[openLabels.length - 1];
        if (label && label.text.length < 1024) label.text += chunk.text;
      },
    })
    .on("input, select", {
      element(e) {
        const type = (attr(e, "type") ?? "").toLowerCase();
        if (type === "password") passwordField = true;
        const hints = ["name", "id", "placeholder", "aria-label", "autocomplete"].map((a) => attr(e, a) ?? "");
        // Any `cc-` token, after the section and billing tokens autocomplete allows before it (round 2).
        const tokens = (attr(e, "autocomplete") ?? "").toLowerCase().split(/\s+/);
        if (tokens.some((t) => t.startsWith("cc-")) || hints.some((h) => CARD.test(h))) cardField = true;
        const id = attr(e, "id");
        if (id && inputIds.length < 10_000) inputIds.push(id);
        const wrapping = openLabels[openLabels.length - 1];
        if (wrapping) wrapping.wraps = true;
      },
    })
    .on("form", {
      element(e) {
        const action = (attr(e, "action") ?? "").trim();
        if (/^https?:\/\//i.test(action) && formActions.length < 20) formActions.push(action.slice(0, 2048));
      },
    })
    .on("a, area", {
      element(e) {
        // A link that downloads its own `data:` payload: the loader written as markup (plan review), judged on this
        // link's payload alone.
        const href = attr(e, "href") ?? "";
        if (!e.hasAttribute("download") || !/^\s*data:[^,]*;base64,/i.test(href)) return;
        const run = longestBase64(href.slice(href.indexOf(",") + 1));
        dataBase64 = Math.max(dataBase64, run);
        if (run > LONG_BASE64) dataDownload = true;
      },
    })
    .on("script", {
      text(chunk) {
        if (script.length < MAX_HTML_BYTES) script += chunk.text;
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .body?.pipeTo(new WritableStream());
  // Labels left open at the end of the document still name what they wrap (round 1: a browser shows them).
  for (const label of openLabels) {
    if (label.wraps && CARD.test(label.text)) cardField = true;
    if (label.for) labelFor.set(label.for, `${labelFor.get(label.for) ?? ""} ${label.text}`);
  }
  if (inputIds.some((id) => CARD.test(labelFor.get(id) ?? ""))) cardField = true;
  // A loader in script: its own long payload, built into a file and downloaded, all in script (plan review: a large
  // inline image beside an ordinary download link is no loader).
  const longBase64 = longestBase64(script) > LONG_BASE64 || dataBase64 > LONG_BASE64;
  const builds = BUILDS.test(script) || dataDownload;
  const downloads = downloadsIn(script) || dataDownload;
  const smuggling = dataDownload || (longestBase64(script) > LONG_BASE64 && BUILDS.test(script) && downloadsIn(script));
  const smugglingBy = dataDownload ? "link" : smuggling ? "script" : null;
  return { passwordField, cardField, formActions, longBase64, builds, downloads, smuggling, smugglingBy, truncated };
}

// An attachment's bytes as text, by HTML's own encoding sniffing (simplified; plan review: an attachment's MIME charset
// is not kept): a byte order mark, then a `charset` declared in its first 1024 bytes, then strict UTF-8, then
// windows-1252, which reads any byte.
export function decodeHtml(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  // The declaration outside comments; a declared UTF-16 is read as UTF-8, as browsers do (WHATWG HTML, prescan), since
  // bytes that reached this point carry no UTF-16 byte order mark (completion review).
  const head = String.fromCharCode(...bytes.subarray(0, 1024)).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const declared = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_.:-]+)/i.exec(head)?.[1];
  if (declared) {
    try {
      // The label's resolved encoding decides, not its spelling (round 1: `unicode` and `csUnicode` name UTF-16).
      const decoder = new TextDecoder(declared);
      return (decoder.encoding.startsWith("utf-16") ? new TextDecoder("utf-8") : decoder).decode(bytes);
    } catch {
      // A charset the runtime does not know: read on by the next rule.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
// Whether an attachment is HTML or SVG: by its bytes when they were read, else its name or declared type.
function kindOf(attachment: CaseView["attachments"][number], head: string | undefined): "html" | "svg" | null {
  const sniffed = head ? sniff(Uint8Array.from(atob(head), (c) => c.charCodeAt(0))) : null;
  if (sniffed === "html") return "html";
  if (sniffed === "svg") return "svg";
  const ext = attachment.filename.includes(".") ? extensionOf(attachment.filename) : "";
  const type = attachment.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ext === "svg" || type === "image/svg+xml") return "svg";
  if (
    ["html", "htm", "xhtml", "shtml", "mht"].includes(ext) ||
    type === "text/html" ||
    type === "application/xhtml+xml"
  )
    return "html";
  return null;
}

// Each HTML or SVG attachment read from R2 (at most MAX_HTML_ATTACHMENTS, MAX_HTML_BYTES of each) and analysed, for the
// view; the rest are counted. A missing object is counted; any other storage error is thrown, so the step is retried.
export async function htmlAttachmentsOf(
  bucket: R2Bucket,
  view: Pick<CaseView, "attachments" | "attachmentHeads">,
): Promise<{ items: HtmlAttachment[]; unread: number } | null> {
  const heads = new Map((view.attachmentHeads?.heads ?? []).map((h) => [h.key, h.head]));
  const found = view.attachments
    .map((a) => ({ a, kind: kindOf(a, heads.get(a.key)) }))
    .filter((x): x is { a: CaseView["attachments"][number]; kind: "html" | "svg" } => x.kind !== null);
  if (!found.length) return null;
  const items: HtmlAttachment[] = [];
  let unread = Math.max(0, found.length - MAX_HTML_ATTACHMENTS);
  for (const { a, kind } of found.slice(0, MAX_HTML_ATTACHMENTS)) {
    const object = await bucket.get(a.key, { range: { offset: 0, length: MAX_HTML_BYTES } });
    if (!object) {
      unread++;
      continue;
    }
    // Past MAX_HTML_BYTES only the start is read, and the item says so (plan review).
    const html = decodeHtml(new Uint8Array(await object.arrayBuffer()));
    items.push({
      key: a.key,
      filename: a.filename,
      kind,
      features: await analyseHtml(html, object.size > MAX_HTML_BYTES),
    });
  }
  return { items, unread };
}

const WHAT = (f: HtmlFeatures) =>
  [
    f.passwordField ? "a password field" : "",
    f.cardField ? "a card field" : "",
    f.formActions.length ? "a form that sends what is typed to a website" : "",
    f.smugglingBy === "script" ? "script that builds a file from a hidden payload and downloads it" : "",
    f.smugglingBy === "link" ? "a link that downloads a file hidden inside the page" : "",
  ].filter(Boolean);

export function htmlAttachmentEvidence(view: CaseView): EvidenceDraft[] {
  const read = view.htmlAttachments;
  if (!read) return [];
  const items: EvidenceDraft[] = read.items.map(({ key, filename, kind, features }) => {
    const found = WHAT(features);
    const name = plain(filename || "An attachment", 80);
    return {
      check: "attachment.html",
      severity: found.length ? "high" : "medium",
      summary: bounded(
        found.length
          ? `${name} is a web page that opens from your computer, with ${found.join(", ")}${features.truncated ? "; only its first 5 MB were read" : ""}.`
          : `${name} is ${kind === "svg" ? "an SVG image, which can hold a web page" : "a web page"} that opens from your computer, where link checks do not reach${features.truncated ? "; only its first 5 MB were read" : ""}.`,
      ),
      detail: fittedDetail({ filename, kind, ...features }) as EvidenceDraft["detail"],
      artefacts: [key],
    };
  });
  if (read.unread > 0)
    items.push({
      check: "attachment.html",
      severity: "info",
      summary: bounded(`${read.unread} more web-page attachments were not read.`),
      detail: { checked: false, unread: read.unread },
      artefacts: [],
    });
  return items;
}

export function registerHtmlAttachmentCheck(registry: CheckRegistry): void {
  registry.register({ name: "attachment.html", needs: [], timeoutMs: 1_000, run: htmlAttachmentEvidence });
}
