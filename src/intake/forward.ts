// The original message inside a forward (D01 T01 §4; spec 4.1). Forwarding as an attachment keeps the original's
// headers, which the authentication checks need; a normal (inline) forward loses them. This finds the original, or
// says the headers are missing, and counts any further attached messages so the member hears that only one was
// checked rather than having the others silently dropped.
//
// The first `message/rfc822` part wins, else the first attachment named `*.eml`, else the first `*.msg` (RFC 2046
// section 5.2.1); the type outranks the order. Only the outermost attachments count: an original that itself carries a
// message stays whole for parsing (§5).
//
// postal-mime reads the forward's structure: its MIME tree, each part's structured headers (comments, quoting,
// repeated parameters, the digest default) and each part's transfer decoding. Only that first stage of its parse runs
// here, never the second, which renders plain text into HTML and normalizes calendar parts: an 8 MB crafted text part
// exhausted 128 MiB there and a `.msg` sent as text/calendar came back altered (D01 T01 §4 round 1). A walk of our own
// in their place kept losing to header syntax postal-mime already reads (rounds 2 and 3), so the parsing stays with it
// (`./mime`, which holds the marked workaround for running one stage).
import { decodeWords } from "postal-mime";
import { leaves, type MimeNode, ParseError, readTree } from "./mime";

export type Forward = {
  // The message to analyse: the attached original, or the forward itself when it was inline.
  original: Uint8Array;
  format: "eml" | "msg";
  headersAvailable: boolean;
  path: "rfc822" | "eml" | "msg" | "inline";
  // Further attached messages that were not chosen.
  otherOriginals: number;
};

export { ParseError };

// Transfer encodings that leave the bytes as they are ("" when none is declared).
const IDENTITY = new Set(["", "7bit", "8bit", "binary"]);

type Candidate = { kind: "rfc822" | "eml" | "msg"; content: Uint8Array };

async function candidatesOf(raw: Uint8Array): Promise<Candidate[]> {
  const { root } = await readTree(raw);
  const found: Candidate[] = [];
  for (const leaf of leaves(root)) collect(leaf, found);
  // A forward whose whole body is the original: postal-mime ends an unterminated last line with a line break, so the
  // body's own bytes are taken as sent when it carries no transfer encoding (RFC 2046 allows none for a message); one
  // that declares base64 or quoted-printable anyway keeps postal-mime's decoded bytes.
  if (
    found.length === 1 &&
    root.contentType.parsed.value.toLowerCase() === "message/rfc822" &&
    !root.contentType.multipart &&
    IDENTITY.has(root.contentTransferEncoding.encoding)
  )
    found[0] = { kind: "rfc822", content: bodyOf(raw) ?? (found[0] as Candidate).content };
  return found;
}

const chosenOf = (found: Candidate[]): Candidate | undefined =>
  found.find((c) => c.kind === "rfc822") ?? found.find((c) => c.kind === "eml") ?? found.find((c) => c.kind === "msg");

export async function extractOriginal(raw: Uint8Array): Promise<Forward> {
  const found = await candidatesOf(raw);
  const chosen = chosenOf(found);
  if (!chosen) return { original: raw, format: "eml", headersAvailable: false, path: "inline", otherOriginals: 0 };
  return {
    original: chosen.content,
    format: chosen.kind === "msg" ? "msg" : "eml",
    headersAvailable: true,
    path: chosen.kind,
    otherOriginals: found.length - 1,
  };
}

// The most originals one forward gets checked (D01 T01 §12): the chosen one and up to four more, each its own
// case; the rest are counted, named not checked in the reply, and never silently dropped.
export const MAX_ORIGINALS = 5;

export type Originals = {
  // The original §4 chooses, exactly as `extractOriginal` returns it.
  chosen: Forward;
  // The further originals in attachment order, up to the bound with the chosen one.
  others: { original: Uint8Array; format: "eml" | "msg"; path: "rfc822" | "eml" | "msg" }[];
  // Every supported original found, before the bound.
  total: number;
};

export async function extractOriginals(raw: Uint8Array): Promise<Originals> {
  const found = await candidatesOf(raw);
  const chosen = chosenOf(found);
  if (!chosen)
    return {
      chosen: { original: raw, format: "eml", headersAvailable: false, path: "inline", otherOriginals: 0 },
      others: [],
      total: 0,
    };
  const rest = found.filter((c) => c !== chosen);
  return {
    chosen: {
      original: chosen.content,
      format: chosen.kind === "msg" ? "msg" : "eml",
      headersAvailable: true,
      path: chosen.kind,
      otherOriginals: found.length - 1,
    },
    others: rest.slice(0, MAX_ORIGINALS - 1).map((c) => ({
      original: c.content,
      format: (c.kind === "msg" ? "msg" : "eml") as "eml" | "msg",
      path: c.kind,
    })),
    total: found.length,
  };
}

// The bytes after a message's header block, or null when it has no blank line.
function bodyOf(raw: Uint8Array): Uint8Array | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x0a) continue;
    if (raw[i + 1] === 0x0a) return raw.subarray(i + 2);
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) return raw.subarray(i + 3);
  }
  return null;
}

// A leaf that is an attached message, kept in order (the first stage never reads into an attached message).
function collect(node: MimeNode, found: Candidate[]): void {
  const type = node.contentType.parsed.value.toLowerCase();
  const rawName = node.contentDisposition.parsed.params.filename ?? node.contentType.parsed.params.name ?? "";
  const name = decodeWords(rawName.replace(/\r?\n[ \t]*/g, " "))
    .trim()
    .toLowerCase();
  const kind =
    type === "message/rfc822" ? "rfc822" : name.endsWith(".eml") ? "eml" : name.endsWith(".msg") ? "msg" : null;
  if (kind) found.push({ kind, content: new Uint8Array(node.content ?? new ArrayBuffer(0)) });
}
