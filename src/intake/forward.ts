// The original message inside a forward (D01 T01 §4; spec 4.1). Forwarding as an attachment keeps the original's
// headers, which the authentication checks need; a normal (inline) forward loses them. This finds the original, or
// says the headers are missing, and counts any further attached messages so the member hears that only one was
// checked rather than having the others silently dropped.
//
// The first `message/rfc822` part wins, else the first attachment named `*.eml`, else the first `*.msg` (RFC 2046
// section 5.2.1); the type outranks the order. Only the outermost attachments count: an original that itself carries a
// message stays whole for parsing (§5).
//
// Only the forward's MIME structure is walked here, never its bodies rendered: postal-mime's full parse turns plain
// text into HTML and normalizes calendar parts, so a crafted text part exhausted 128 MiB and a `.msg` sent as
// text/calendar came back altered (D01 T01 §4 round 1). postal-mime still decodes each part's own header block (types,
// RFC 2231 and encoded-word filenames); the walk finds the parts (RFC 2046 section 5.1.1) and undoes only the transfer
// encoding of the one chosen, so its bytes are exactly the ones sent.
import PostalMime from "postal-mime";

export type Forward = {
  // The message to analyse: the attached original, or the forward itself when it was inline.
  original: Uint8Array;
  format: "eml" | "msg";
  headersAvailable: boolean;
  path: "rfc822" | "eml" | "msg" | "inline";
  // Further attached messages that were not chosen.
  otherOriginals: number;
};

// A message the walk refused (too deep, too many parts, a header block with no end, a header postal-mime would not
// read). The Workflow turns it into a partial report (§7).
export class ParseError extends Error {
  override name = "ParseError";
}

// Bounds on the walk, well beyond any real forward. A boundary is at most 70 characters (RFC 2046 section 5.1.1).
const MAX_DEPTH = 32;
const MAX_PARTS = 1000;
const MAX_HEADER_BLOCK = 64 * 1024;
const MAX_BOUNDARY = 70;

type Candidate = { kind: "rfc822" | "eml" | "msg"; body: Uint8Array; encoding: string };

export async function extractOriginal(raw: Uint8Array): Promise<Forward> {
  const found: Candidate[] = [];
  await walk(raw, "", 0, { parts: 0 }, found);
  const pick = (kind: Candidate["kind"]) => found.find((c) => c.kind === kind);
  const chosen = pick("rfc822") ?? pick("eml") ?? pick("msg");
  if (!chosen) return { original: raw, format: "eml", headersAvailable: false, path: "inline", otherOriginals: 0 };
  return {
    original: decodeTransfer(chosen.body, chosen.encoding),
    format: chosen.kind === "msg" ? "msg" : "eml",
    headersAvailable: true,
    path: chosen.kind,
    otherOriginals: found.length - 1,
  };
}

// One MIME entity: its header block read by postal-mime, then either its multipart children walked or, as a leaf, kept
// when it is an attached message. An attached message is not walked into. `parent` is the enclosing multipart's type:
// inside `multipart/digest` a part with no Content-Type is a message (RFC 2046 section 5.1.5).
async function walk(
  entity: Uint8Array,
  parent: string,
  depth: number,
  count: { parts: number },
  found: Candidate[],
): Promise<void> {
  count.parts += 1;
  if (depth > MAX_DEPTH) throw new ParseError("the forward nests its parts too deeply");
  if (count.parts > MAX_PARTS) throw new ParseError("the forward has too many parts");
  const split = headerEnd(entity);
  if (!split) throw new ParseError("a part's header block has no end");
  const head = new TextDecoder().decode(entity.subarray(0, split.headers));
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(`${head}\r\n\r\n`, { forceRfc822Attachments: true });
  } catch (error) {
    throw new ParseError(`a part's headers could not be read: ${(error as Error).message}`);
  }
  const header = (name: string) => parsed.headers.find((h) => h.key.trim().toLowerCase() === name)?.value;
  const contentType = header("content-type");
  const mediaType = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const encoding = (header("content-transfer-encoding") ?? "").trim().toLowerCase();
  const body = entity.subarray(split.body);
  if (mediaType.startsWith("multipart/")) {
    const boundary = parameters(contentType ?? "").get("boundary") ?? "";
    if (!boundary) return;
    if (boundary.length > MAX_BOUNDARY) throw new ParseError("a multipart boundary is longer than 70 characters");
    for (const part of parts(body, boundary)) await walk(part, mediaType, depth + 1, count, found);
    return;
  }
  if (contentType === undefined && parent === "multipart/digest") {
    found.push({ kind: "rfc822", body, encoding });
    return;
  }
  const attachment = parsed.attachments[0];
  // A forward whose whole body is the original (a top-level message/rfc822) counts as attached, like a part.
  if (!attachment) return;
  const name = (attachment.filename ?? "").trim().toLowerCase();
  const kind =
    attachment.mimeType.toLowerCase() === "message/rfc822"
      ? "rfc822"
      : name.endsWith(".eml")
        ? "eml"
        : name.endsWith(".msg")
          ? "msg"
          : null;
  if (kind) found.push({ kind, body, encoding });
}

// Where an entity's header block ends and its body starts (after the first empty line), or null within the bound.
function headerEnd(entity: Uint8Array): { headers: number; body: number } | null {
  // No header fields at all: the part starts with its empty line (a digest's untyped message, RFC 2046 section 5.1.5).
  if (entity[0] === 0x0a) return { headers: 0, body: 1 };
  if (entity[0] === 0x0d && entity[1] === 0x0a) return { headers: 0, body: 2 };
  const limit = Math.min(entity.length, MAX_HEADER_BLOCK);
  for (let i = 0; i < limit; i++) {
    if (entity[i] !== 0x0a) continue;
    if (entity[i + 1] === 0x0a) return { headers: i, body: i + 2 };
    if (entity[i + 1] === 0x0d && entity[i + 2] === 0x0a) return { headers: i, body: i + 3 };
  }
  // A part with headers and no body at all.
  return entity.length < MAX_HEADER_BLOCK ? { headers: entity.length, body: entity.length } : null;
}

// The body parts of a multipart body (RFC 2046 section 5.1.1): each starts after a `--boundary` line and ends before
// the line break preceding the next delimiter, which belongs to the delimiter; the preamble and epilogue are dropped.
// Only line starts are compared, each against at most the delimiter's length, so the scan is linear in the body.
function* parts(body: Uint8Array, boundary: string): Generator<Uint8Array> {
  const dash = new TextEncoder().encode(`--${boundary}`);
  let start = -1;
  for (let line = 0; line < body.length; ) {
    const next = body.indexOf(0x0a, line);
    const lineEnd = next < 0 ? body.length : next;
    if (startsWith(body, line, lineEnd, dash)) {
      if (start >= 0) {
        let end = line;
        if (body[end - 1] === 0x0a) end -= 1;
        if (body[end - 1] === 0x0d) end -= 1;
        yield body.subarray(start, Math.max(start, end));
      }
      const after = line + dash.length;
      if (body[after] === 0x2d && body[after + 1] === 0x2d) return;
      start = next < 0 ? body.length : next + 1;
    }
    if (next < 0) break;
    line = next + 1;
  }
  // No closing delimiter: the last part runs to the end.
  if (start >= 0 && start < body.length) yield body.subarray(start);
}

// Whether the line from `at` to `end` starts with `prefix`.
function startsWith(bytes: Uint8Array, at: number, end: number, prefix: Uint8Array): boolean {
  if (end - at < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

// A header value's parameters (RFC 2045 section 5.1): `;`-separated `name=value` pairs, a value a token or a quoted
// string; a `;` or `=` inside quotes is part of the value, so no parameter is read out of another's quoted text. Names
// are lower case; the first of a repeated name wins.
function parameters(value: string): Map<string, string> {
  const out = new Map<string, string>();
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (quoted && c === "\\") {
      current += c + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      pieces.push(current);
      current = "";
    } else current += c;
  }
  pieces.push(current);
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq < 1) continue;
    const name = piece.slice(0, eq).trim().toLowerCase();
    let v = piece.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    if (!out.has(name)) out.set(name, v);
  }
  return out;
}

// The part's bytes with its transfer encoding undone: base64 and quoted-printable decoded byte by byte into one buffer
// no larger than the part, anything else as sent. Malformed base64 is a `ParseError`.
function decodeTransfer(body: Uint8Array, encoding: string): Uint8Array {
  if (encoding === "base64") return decodeBase64(body);
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

const BASE64 = new Int16Array(256).fill(-1);
for (const [i, c] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries())
  BASE64[c.charCodeAt(0)] = i;

function decodeBase64(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((body.length * 3) / 4));
  let size = 0;
  let quad = 0;
  let filled = 0;
  let padded = false;
  for (const byte of body) {
    if (byte === 0x0d || byte === 0x0a || byte === 0x20 || byte === 0x09) continue;
    if (byte === 0x3d) {
      padded = true;
      continue;
    }
    const value = BASE64[byte] ?? -1;
    if (value < 0) throw new ParseError("an attachment's base64 has a character outside the alphabet");
    if (padded) throw new ParseError("an attachment's base64 continues after its padding");
    quad = (quad << 6) | value;
    filled += 1;
    if (filled === 4) {
      out[size++] = (quad >> 16) & 0xff;
      out[size++] = (quad >> 8) & 0xff;
      out[size++] = quad & 0xff;
      quad = 0;
      filled = 0;
    }
  }
  if (filled === 1) throw new ParseError("an attachment's base64 ends mid-byte");
  if (filled === 2) out[size++] = (quad >> 4) & 0xff;
  if (filled === 3) {
    out[size++] = (quad >> 10) & 0xff;
    out[size++] = (quad >> 2) & 0xff;
  }
  return out.subarray(0, size);
}

function decodeQuotedPrintable(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length);
  let size = 0;
  const hex = (b: number | undefined) =>
    b === undefined
      ? -1
      : b >= 0x30 && b <= 0x39
        ? b - 0x30
        : b >= 0x41 && b <= 0x46
          ? b - 0x37
          : b >= 0x61 && b <= 0x66
            ? b - 0x57
            : -1;
  for (let i = 0; i < body.length; i++) {
    const byte = body[i] as number;
    if (byte !== 0x3d) {
      out[size++] = byte;
      continue;
    }
    // A soft line break (=CRLF or =LF) joins lines; =XX is one byte; anything else stays as written.
    if (body[i + 1] === 0x0d && body[i + 2] === 0x0a) i += 2;
    else if (body[i + 1] === 0x0a) i += 1;
    else {
      const high = hex(body[i + 1]);
      const low = hex(body[i + 2]);
      if (high >= 0 && low >= 0) {
        out[size++] = high * 16 + low;
        i += 2;
      } else out[size++] = byte;
    }
  }
  return out.subarray(0, size);
}
