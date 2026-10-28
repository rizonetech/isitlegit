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
// in their place kept losing to header syntax postal-mime already reads (rounds 2 and 3), so the parsing stays with it.
import PostalMime, { decodeWords } from "postal-mime";

export type Forward = {
  // The message to analyse: the attached original, or the forward itself when it was inline.
  original: Uint8Array;
  format: "eml" | "msg";
  headersAvailable: boolean;
  path: "rfc822" | "eml" | "msg" | "inline";
  // Further attached messages that were not chosen.
  otherOriginals: number;
};

// A message postal-mime refused (its limits on nesting, parts and header size, or a malformed structure). The
// Workflow turns it into a partial report (§7).
export class ParseError extends Error {
  override name = "ParseError";
}

// The parts of postal-mime 4.1.4's node tree this reads. WORKAROUND: postal-mime has no public way to parse without
// rendering, so this drives its line reader and reads its tree directly; the version is pinned exactly in package.json,
// and test/intake/forward.test.ts fails if an upgrade moves any of these.
type Node = {
  contentType: { parsed: { value: string; params: Record<string, string | undefined> }; multipart: string | false };
  contentDisposition: { parsed: { params: Record<string, string | undefined> } };
  childNodes: Node[];
  content: ArrayBuffer | null;
};
type Reader = {
  started: boolean;
  buf: ArrayBuffer;
  av: Uint8Array;
  readPos: number;
  root: Node;
  readLine(): { bytes: Uint8Array; lineBreak: Uint8Array; done: boolean };
  processLine(bytes: Uint8Array, lineBreak: Uint8Array, done: boolean): Promise<void>;
  finalize(): Promise<void>;
};

type Candidate = { kind: "rfc822" | "eml" | "msg"; content: Uint8Array };

export async function extractOriginal(raw: Uint8Array): Promise<Forward> {
  const root = await structure(raw);
  const found: Candidate[] = [];
  collect(root, found);
  // A forward whose whole body is the original: postal-mime ends an unterminated last line with a line break, so the
  // body's own bytes are taken as sent when it carries no transfer encoding (RFC 2046 allows none for a message).
  if (
    found.length === 1 &&
    root.contentType.parsed.value.toLowerCase() === "message/rfc822" &&
    !root.contentType.multipart
  )
    found[0] = { kind: "rfc822", content: bodyOf(raw) ?? (found[0] as Candidate).content };
  const pick = (kind: Candidate["kind"]) => found.find((c) => c.kind === kind);
  const chosen = pick("rfc822") ?? pick("eml") ?? pick("msg");
  if (!chosen) return { original: raw, format: "eml", headersAvailable: false, path: "inline", otherOriginals: 0 };
  return {
    original: chosen.content,
    format: chosen.kind === "msg" ? "msg" : "eml",
    headersAvailable: true,
    path: chosen.kind,
    otherOriginals: found.length - 1,
  };
}

// postal-mime's first stage: every line read into its MIME tree, every part decoded, nothing rendered.
async function structure(raw: Uint8Array): Promise<Node> {
  const reader = new PostalMime({ forceRfc822Attachments: true }) as unknown as Reader;
  try {
    reader.started = true;
    reader.buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    reader.av = new Uint8Array(reader.buf);
    reader.readPos = 0;
    while (reader.readPos < reader.av.length) {
      const line = reader.readLine();
      await reader.processLine(line.bytes, line.lineBreak, line.done);
    }
    if (reader.av.length === 0) await reader.finalize();
  } catch (error) {
    throw new ParseError(`the forward could not be parsed: ${(error as Error).message}`);
  }
  return reader.root;
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

// The attached messages under a node, in order: multiparts are walked, an attached message is not walked into.
function collect(node: Node, found: Candidate[]): void {
  if (node.contentType.multipart) {
    for (const child of node.childNodes) collect(child, found);
    return;
  }
  const type = node.contentType.parsed.value.toLowerCase();
  const rawName = node.contentDisposition.parsed.params.filename ?? node.contentType.parsed.params.name ?? "";
  const name = decodeWords(rawName.replace(/\r?\n[ \t]*/g, " "))
    .trim()
    .toLowerCase();
  const kind =
    type === "message/rfc822" ? "rfc822" : name.endsWith(".eml") ? "eml" : name.endsWith(".msg") ? "msg" : null;
  if (kind) found.push({ kind, content: new Uint8Array(node.content ?? new ArrayBuffer(0)) });
}
