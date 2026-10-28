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

export type ParsedAttachment = {
  filename: string | null;
  mediaType: string;
  contentId: string | null;
  disposition: string | null;
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
};

export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const parsing = await readTree(raw);
  const truncated: ParsedMessage["truncated"] = [];
  let budget = BODY_TOTAL_LIMIT;
  for (const leaf of leaves(parsing.root)) {
    if (!leaf.content || !parsing.isBodyText(leaf)) continue;
    const size = leaf.content.byteLength;
    const kept = Math.min(size, BODY_PART_LIMIT, budget);
    budget -= kept;
    if (kept === size) continue;
    truncated.push({
      mediaType: leaf.contentType.parsed.value.toLowerCase(),
      charset: leaf.contentType.parsed.params.charset?.trim().toLowerCase() || null,
      full: new Uint8Array(leaf.content),
      keptBytes: kept,
    });
    leaf.content = leaf.content.slice(0, kept);
  }
  const { email, attachmentBytes } = await parsing.finish();
  return {
    headers: email.headers.map((h) => ({ name: h.originalKey, value: h.value })),
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map((a, i) => ({
      filename: a.filename,
      mediaType: a.mimeType,
      contentId: a.contentId ?? null,
      disposition: a.disposition ?? null,
      // The part's own transfer-decoded bytes, never postal-mime's rewrite of a calendar part.
      bytes: attachmentBytes[i] as Uint8Array,
    })),
    truncated,
  };
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
    bytes: number;
  }[];
  truncated: { mediaType: string; charset: string | null; key: string; fullBytes: number; keptBytes: number }[];
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
    forward: { path: forward.path, headersAvailable: forward.headersAvailable, otherOriginals: forward.otherOriginals },
  };
  await putParsed(store, caseId, summary);
  return summary;
}
