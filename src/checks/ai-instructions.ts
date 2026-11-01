// Text written to steer an AI or a mail filter (D02 T05 §2; spec 4.3; the safety contract in AGENTS.md): "ignore
// previous instructions", a role given to an AI, an assistant told to mark the mail safe, chat-template markers, claims
// of verified safety. It is evidence against the mail wherever it sits: the body's visible or hidden text, its plain
// text, a text or HTML attachment. The `checks` step feeds every such text whole to the phrases (./instruction-phrases)
// and puts what they found in the view; the check states each match, and each text it could not read.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { type BodyPhrases, scanHtml } from "./hidden-text";
import { MAX_MATCHES, type PhraseLog, type PhraseMatch, PhraseStream } from "./instruction-phrases";
import type { CheckRegistry } from "./registry";
import { sniff } from "./sniff";

// Text and HTML attachments read whole, at most this many and this much of each; past either, what was not read is
// stated as not checked.
export const MAX_TEXT_ATTACHMENTS = 10;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type Instructions = {
  // How many texts were read (a body's visible, hidden or plain text, an attachment): 0 means nothing was examined.
  texts: number;
  matches: PhraseMatch[];
  more: number;
  notChecked: { location: string; why: string; artefact?: string }[];
  notCheckedMore: number;
};

// The log's streams for the body (the location names the kind of text) and what could not be read.
export function bodyPhrases(log: PhraseLog): BodyPhrases {
  return {
    stream: (kind) => new PhraseStream(log, kind, "body", kind !== "text"),
    unread: (key, why) =>
      log.unchecked(
        "body",
        why === "missing"
          ? "a cut body part could not be read"
          : `a body part's charset is not known (${key.split("/").pop()})`,
      ),
  };
}

const typeOf = (a: CaseView["attachments"][number]) => a.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
const extensionOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
// What an attachment is to this check: text read whole, HTML scanned, a document whose text is not read yet (D02 T05
// §4 owns it), or nothing to read.
function kindOf(a: CaseView["attachments"][number], head: Uint8Array | null): "text" | "html" | "document" | null {
  const sniffed = head ? sniff(head) : null;
  const type = typeOf(a);
  const ext = extensionOf(a.filename);
  if (sniffed === "html" || type === "text/html" || type === "application/xhtml+xml" || /^(?:html?|xhtml)$/.test(ext))
    return "html";
  if (sniffed === "pdf" || type === "application/pdf" || ext === "pdf") return "document";
  if (
    /^application\/(?:msword|rtf|vnd\.openxmlformats-officedocument\.|vnd\.ms-(?:excel|powerpoint)|vnd\.oasis\.opendocument\.)/.test(
      type,
    ) ||
    /^(?:docx?|xlsx?|pptx?|rtf|odt|ods|odp)$/.test(ext)
  )
    return "document";
  if (type.startsWith("text/") || /^(?:txt|csv|md|log|xml|json)$/.test(ext)) return "text";
  return null;
}

// The encoding to read a text attachment with: a byte order mark, else its declared charset, else for HTML a declared
// `<meta charset>` in its first kilobyte, else UTF-16 when every other byte of its head is zero (a UTF-16 text without a
// mark), else UTF-8. A declared charset (its MIME parameter, or an HTML attachment's meta charset) the runtime does not
// know is returned as `unknown`: the attachment is not checked (completion review: a meta charset fell through to UTF-8).
export function encodingOf(
  head: Uint8Array,
  declared: string | null | undefined,
  html: boolean,
): string | { unknown: string } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf-8";
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  const known = (label: string) => {
    try {
      return new TextDecoder(label).encoding;
    } catch {
      return null;
    }
  };
  if (declared) return known(declared) ?? { unknown: declared };
  if (html) {
    const text = String.fromCharCode(...head.subarray(0, 1024)).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    const meta = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_.:-]+)/i.exec(text)?.[1];
    if (meta) {
      const encoding = known(meta);
      if (!encoding) return { unknown: meta };
      // A declared UTF-16 without a mark is read as UTF-8, as browsers do (WHATWG HTML, prescan).
      return encoding.startsWith("utf-16") ? "utf-8" : encoding;
    }
  }
  const pairs = Math.floor(Math.min(head.length, 512) / 2);
  if (pairs >= 4) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < pairs; i++) {
      if (head[2 * i] === 0) evenZero++;
      if (head[2 * i + 1] === 0) oddZero++;
    }
    if (oddZero >= pairs * 0.9 && evenZero === 0) return "utf-16le";
    if (evenZero >= pairs * 0.9 && oddZero === 0) return "utf-16be";
  }
  return "utf-8";
}

// The text and HTML attachments' text, fed whole to the log: HTML through the hidden-text scanner, so its hidden text
// is named as hidden. An attachment past the limits, one whose charset is not known, one whose object is missing and a
// document whose text is not read yet are each stated as not checked; any other storage error is thrown, so the step
// is retried.
export async function attachmentPhrases(
  bucket: R2Bucket,
  attachments: CaseView["attachments"],
  log: PhraseLog,
): Promise<void> {
  let read = 0;
  for (const a of attachments) {
    const head = await bucket.get(a.key, { range: { offset: 0, length: 1024 } });
    if (!head) {
      log.unchecked(`attachment:${a.filename}`, "its contents could not be read", a.key);
      continue;
    }
    const first = new Uint8Array(await head.arrayBuffer());
    const kind = kindOf(a, first);
    if (kind === null) continue;
    const where = `attachment:${a.filename}`;
    if (kind === "document") {
      log.unchecked(where, "the text of a document like this is not read for instructions yet", a.key);
      continue;
    }
    if (read >= MAX_TEXT_ATTACHMENTS) {
      log.unchecked(where, `only the first ${MAX_TEXT_ATTACHMENTS} text attachments are read`, a.key);
      continue;
    }
    read++;
    const encoding = encodingOf(first, a.charset, kind === "html");
    if (typeof encoding !== "string") {
      log.unchecked(where, `its charset (${plain(encoding.unknown, 40)}) is not one that can be read`, a.key);
      continue;
    }
    if (a.bytes > MAX_TEXT_BYTES)
      log.unchecked(where, `only its first ${MAX_TEXT_BYTES / 1024 / 1024} MiB were read`, a.key);
    const open = async () => {
      const object = await bucket.get(a.key, { range: { offset: 0, length: MAX_TEXT_BYTES } });
      if (!object) throw new Error(`the attachment ${a.key} disappeared while it was read`);
      return object.body.pipeThrough(new TextDecoderStream(encoding));
    };
    if (kind === "html") {
      // Each stored object is its own source: two attachments of one name stay apart (completion review).
      const visible = new PhraseStream(log, where, a.key, true);
      const hidden = new PhraseStream(log, `attachment-hidden:${a.filename}`, a.key, true);
      await scanHtml(async () => (await open()).pipeThrough(new TextEncoderStream()), "", undefined, {
        visible,
        hidden,
      });
      visible.end();
      hidden.end();
    } else {
      const stream = new PhraseStream(log, where, a.key, false);
      const reader = (await open()).getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) stream.feed(chunk.value);
      stream.end();
    }
  }
}

export const instructionsOf = (log: PhraseLog): Instructions => ({
  texts: log.texts,
  matches: log.matches,
  more: log.more,
  notChecked: log.notChecked,
  notCheckedMore: log.notCheckedMore,
});

const where = (location: string) =>
  location.startsWith("landing-hidden:")
    ? `in text hidden on the page the link reaches, ${plain(location.slice(15), 80)}`
    : location.startsWith("landing:")
      ? `in the page the link reaches, ${plain(location.slice(8), 80)}`
      : location === "visible"
        ? "in its visible text"
        : location === "hidden"
          ? "in text hidden from the reader"
          : location === "text"
            ? "in its plain-text version"
            : location.startsWith("attachment-hidden:")
              ? `in text hidden inside the attachment ${plain(location.slice(18), 80)}`
              : `in the attachment ${plain(location.slice(11), 80)}`;

// Where text was not checked, in a reader's words: the body, a landing page (or its hidden text), or an attachment.
const notCheckedPlace = (location: string): string =>
  location === "body"
    ? "part of the message body"
    : location.startsWith("landing-hidden:")
      ? `the hidden text of the page ${plain(location.slice(15), 80)}`
      : location.startsWith("landing:")
        ? `the page ${plain(location.slice(8), 80)}`
        : plain(location.slice(11), 80);

export function aiInstructionEvidence(view: CaseView): EvidenceDraft[] {
  const found = view.instructions;
  if (!found) return [];
  const items: EvidenceDraft[] = found.matches.map((m) => ({
    check: "content.ai_instructions",
    severity: "high",
    summary: bounded(
      `The message holds text written to steer an AI or a mail filter, ${where(m.location)}: "${plain(m.quote, 120)}"`,
    ),
    detail: fittedDetail({ pattern: m.pattern, quote: m.quote, location: m.location }) as EvidenceDraft["detail"],
    artefacts: m.artefact ? [m.artefact] : [view.raw],
  }));
  if (found.more > 0)
    items.push({
      check: "content.ai_instructions",
      severity: "high",
      summary: bounded(
        `${found.more} more passages written to steer an AI or a mail filter are not listed one by one.`,
      ),
      detail: { more: found.more },
      artefacts: [view.raw],
    });
  for (const n of found.notChecked)
    items.push({
      check: "content.ai_instructions",
      severity: "info",
      summary: bounded(`Not checked for text written to steer an AI: ${notCheckedPlace(n.location)}, since ${n.why}.`),
      detail: fittedDetail({ checked: false, location: n.location, reason: n.why }) as EvidenceDraft["detail"],
      artefacts: n.artefact ? [n.artefact] : [view.raw],
    });
  if (found.notCheckedMore > 0)
    items.push({
      check: "content.ai_instructions",
      severity: "info",
      summary: bounded(`${found.notCheckedMore} more texts were not checked for text written to steer an AI.`),
      detail: { checked: false, more: found.notCheckedMore },
      artefacts: [view.raw],
    });
  return items;
}

export function registerAiInstructionCheck(registry: CheckRegistry): void {
  registry.register({
    name: "content.ai_instructions",
    needs: [],
    timeoutMs: 1_000,
    run: aiInstructionEvidence,
    // Nothing read and nothing it could not read: skipped (round 1: a message holding only an image read as clean).
    applies: (view) =>
      view.instructions && (view.instructions.texts > 0 || view.instructions.notChecked.length)
        ? null
        : "no text was read",
    partial: (view) => {
      const n = (view.instructions?.notChecked.length ?? 0) + (view.instructions?.notCheckedMore ?? 0);
      return n ? `${n} text${n === 1 ? "" : "s"} could not be read` : null;
    },
  });
}

export { MAX_MATCHES };
