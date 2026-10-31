// The original message parsed into headers, bodies and attachments (D01 T01 §5; spec 4.2), and stored for the pipeline:
// every attachment and inline image an artefact in R2, then the parsed summary at `raw/<caseId>/parsed.json`, which
// passes between Workflow steps by key, never by value (stack doc: a step's output is at most 1 MiB).
//
// postal-mime parses (./mime). Its rendering of the body text is bounded first: each body part it would render is cut
// to 1 MiB, and all of them together to 2 MiB, before its second stage runs, since rendering unbounded text exhausted
// 128 MiB (D01 T01 §4 round 1; twenty parts under the per-part limit did as well). A cut part is kept whole in R2 and
// listed in the summary's `truncated`, which the link and hidden-text checks read in full (D02 T07 §1, D02 T05 §1).
// Attachments are never cut: only what postal-mime renders as body text is.
import type { Forward } from "./forward";
import { leaves, ParseError, readTree } from "./mime";
import { putAttachment, putParsed, type Store, type Stored } from "./store";

export { ParseError };

export const BODY_PART_LIMIT = 1024 * 1024;
export const BODY_TOTAL_LIMIT = 2 * 1024 * 1024;
// Cut parts kept whole, each its own artefact: past this, a message of thousands of tiny parts would mean as many
// writes, so further cut parts are counted as `omitted`, which the evidence reports as not checked (D02 T01 §1).
export const KEPT_PARTS_LIMIT = 50;

export type ParsedAttachment = {
  filename: string | null;
  mediaType: string;
  contentId: string | null;
  disposition: string | null;
  // The charset to read a text attachment's bytes with (as `charsetOf` reads it), or null (D02 T05 §2).
  charset: string | null;
  bytes: Uint8Array;
};

export type ParsedMessage = {
  // Every header field in order, repeats kept (the Received chain needs them), with its name as written.
  headers: { name: string; value: string }[];
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
  // Body parts cut before rendering: each one's whole bytes, its media type and charset (needed to read the bytes back)
  // and how much was kept.
  truncated: { mediaType: string; charset: string | null; full: Uint8Array; keptBytes: number }[];
  // Further cut parts, past KEPT_PARTS_LIMIT, not kept.
  omitted: number;
};

export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const parsing = await readTree(raw);
  const truncated: ParsedMessage["truncated"] = [];
  let budget = BODY_TOTAL_LIMIT;
  let omitted = 0;
  for (const leaf of leaves(parsing.root)) {
    if (!leaf.content || !parsing.isBodyText(leaf)) continue;
    const size = leaf.content.byteLength;
    const kept = Math.min(size, BODY_PART_LIMIT, budget);
    budget -= kept;
    if (kept === size) continue;
    const mediaType = leaf.contentType.parsed.value.toLowerCase();
    if (truncated.length < KEPT_PARTS_LIMIT)
      truncated.push({
        mediaType,
        charset: charsetOf(leaf.contentType.parsed.params.charset, mediaType, leaf.content),
        full: new Uint8Array(leaf.content),
        keptBytes: kept,
      });
    else omitted += 1;
    leaf.content = leaf.content.slice(0, kept);
  }
  const { email, attachmentBytes, attachmentCharsets } = await parsing.finish();
  return {
    headers: email.headers.map((h) => ({ name: h.originalKey, value: h.value })),
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map((a, i) => ({
      filename: a.filename,
      mediaType: a.mimeType,
      contentId: a.contentId ?? null,
      disposition: a.disposition ?? null,
      charset: charsetOf(
        attachmentCharsets[i] ?? undefined,
        a.mimeType.toLowerCase(),
        (attachmentBytes[i] as Uint8Array).buffer as ArrayBuffer,
      ),
      // The part's own transfer-decoded bytes, never postal-mime's rewrite of a calendar part.
      bytes: attachmentBytes[i] as Uint8Array,
    })),
    truncated,
    omitted,
  };
}

// The charset to read a part's bytes with: its Content-Type parameter, else for HTML a `<meta charset>` or
// `<meta http-equiv="Content-Type" content="...charset=...">` in its first kilobyte (as postal-mime reads the kept
// part), else null. Only a name a charset can have is kept: IANA's are at most 40 characters of a small set (RFC 2978
// 2.3), so a hostile parameter of megabytes is not carried into the summary and every record made from it (D02 T01 §2
// round 1).
const CHARSET = /^[a-z0-9!#$%&'+^_`{}~.:-]{1,40}$/;
function charsetOf(parameter: string | undefined, mediaType: string, content: ArrayBuffer): string | null {
  const declared = parameter?.trim().toLowerCase();
  if (declared) return CHARSET.test(declared) ? declared : null;
  if (mediaType !== "text/html") return null;
  const head = new TextDecoder().decode(new Uint8Array(content, 0, Math.min(content.byteLength, 1024)));
  const meta = /<meta\b[^>]*?charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i.exec(head);
  const found = meta?.[1]?.toLowerCase();
  return found && CHARSET.test(found) ? found : null;
}

export type ParsedSummary = {
  headers: ParsedMessage["headers"];
  text: string | null;
  html: string | null;
  attachments: {
    key: string;
    filename: string;
    mediaType: string;
    contentId: string | null;
    disposition: string | null;
    charset: string | null;
    bytes: number;
  }[];
  truncated: { mediaType: string; charset: string | null; key: string; fullBytes: number; keptBytes: number }[];
  omitted: number;
  forward: Pick<Forward, "path" | "headersAvailable" | "otherOriginals">;
};

// Stores every attachment and every cut body part, then the summary, last: a summary never names an artefact that is
// not there, and a failure partway leaves none. The store's writes are create-only and answer a repeat of the same
// content with the same row (D01 T01 §2), so a retried step completes without conflict.
export async function storeParsed(
  store: Store,
  caseId: string,
  parsed: ParsedMessage,
  forward: Forward,
): Promise<ParsedSummary> {
  const attachments: ParsedSummary["attachments"] = [];
  for (const [i, a] of parsed.attachments.entries()) {
    const filename = a.filename?.trim() || `attachment-${i + 1}`;
    const stored: Stored = await putAttachment(
      store,
      caseId,
      filename,
      a.bytes,
      a.mediaType || "application/octet-stream",
    );
    attachments.push({
      key: stored.key,
      filename,
      // The part's own declared type: two parts with the same bytes and name share one stored object, whose row keeps
      // the first one's type, and a mismatch between declared type and content is evidence (attachment checks).
      mediaType: a.mediaType || "application/octet-stream",
      contentId: a.contentId,
      disposition: a.disposition,
      charset: a.charset,
      bytes: stored.bytes,
    });
  }
  const truncated: ParsedSummary["truncated"] = [];
  for (const [i, part] of parsed.truncated.entries()) {
    const extension = part.mediaType === "text/html" ? "html" : "txt";
    const stored = await putAttachment(store, caseId, `body-${i + 1}.${extension}`, part.full, part.mediaType);
    truncated.push({
      mediaType: part.mediaType,
      charset: part.charset,
      key: stored.key,
      fullBytes: stored.bytes,
      keptBytes: part.keptBytes,
    });
  }
  const summary: ParsedSummary = {
    headers: parsed.headers,
    text: parsed.text,
    html: parsed.html,
    attachments,
    truncated,
    omitted: parsed.omitted,
    forward: { path: forward.path, headersAvailable: forward.headersAvailable, otherOriginals: forward.otherOriginals },
  };
  await putParsed(store, caseId, summary);
  return summary;
}
