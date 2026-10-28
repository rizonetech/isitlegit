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

// Bounds on the walk, well beyond any real forward.
const MAX_DEPTH = 32;
const MAX_PARTS = 1000;
const MAX_HEADER_BLOCK = 64 * 1024;

type Candidate = { kind: "rfc822" | "eml" | "msg"; body: Uint8Array; encoding: string };

export async function extractOriginal(raw: Uint8Array): Promise<Forward> {
  const found: Candidate[] = [];
  await walk(raw, 0, { parts: 0 }, found);
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
// when it is an attached message. An attached message is not walked into.
async function walk(entity: Uint8Array, depth: number, count: { parts: number }, found: Candidate[]): Promise<void> {
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
  const header = (name: string) => parsed.headers.find((h) => h.key.trim().toLowerCase() === name)?.value ?? "";
  const contentType = header("content-type");
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const body = entity.subarray(split.body);
  if (mediaType.startsWith("multipart/")) {
    const boundary = parameter(contentType, "boundary");
    if (!boundary) return;
    for (const part of parts(body, boundary)) await walk(part, depth + 1, count, found);
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
  if (kind) found.push({ kind, body, encoding: header("content-transfer-encoding").trim().toLowerCase() });
}

// Where an entity's header block ends and its body starts (after the first empty line), or null within the bound.
function headerEnd(entity: Uint8Array): { headers: number; body: number } | null {
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
function* parts(body: Uint8Array, boundary: string): Generator<Uint8Array> {
  const dash = new TextEncoder().encode(`--${boundary}`);
  let start = -1;
  let at = 0;
  while (at <= body.length - dash.length) {
    const hit = indexOf(body, dash, at);
    if (hit < 0) break;
    const lineStart = hit === 0 || body[hit - 1] === 0x0a;
    const after = hit + dash.length;
    if (!lineStart) {
      at = after;
      continue;
    }
    if (start >= 0) {
      let end = hit;
      if (body[end - 1] === 0x0a) end -= 1;
      if (body[end - 1] === 0x0d) end -= 1;
      yield body.subarray(start, Math.max(start, end));
    }
    if (body[after] === 0x2d && body[after + 1] === 0x2d) return;
    const eol = body.indexOf(0x0a, after);
    if (eol < 0) return;
    start = eol + 1;
    at = start;
  }
  // No closing delimiter: the last part runs to the end.
  if (start >= 0 && start < body.length) yield body.subarray(start);
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  for (let i = haystack.indexOf(first as number, from); i >= 0 && i <= haystack.length - needle.length; ) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = haystack.indexOf(first as number, i + 1);
  }
  return -1;
}

// A Content-Type parameter's value (quoted or a token), or "".
function parameter(value: string, name: string): string {
  const pattern = new RegExp(`;\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))`, "i");
  const match = pattern.exec(value);
  return (match?.[1]?.replace(/\\(.)/g, "$1") ?? match?.[2] ?? "").trim();
}

// The part's bytes with its transfer encoding undone: base64 and quoted-printable decoded, anything else as sent.
function decodeTransfer(body: Uint8Array, encoding: string): Uint8Array {
  if (encoding === "base64") {
    // The alphabet and its padding only (line breaks and stray characters dropped), cut to whole 4-character groups.
    const text = new TextDecoder()
      .decode(body)
      .replace(/[^A-Za-z0-9+/=]/g, "")
      .replace(/=+$/, "");
    const whole = text.length - (text.length % 4 === 1 ? 1 : 0);
    const binary = atob(text.slice(0, whole).padEnd(Math.ceil(whole / 4) * 4, "="));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  if (encoding === "quoted-printable") {
    const out: number[] = [];
    for (let i = 0; i < body.length; i++) {
      const byte = body[i] as number;
      if (byte !== 0x3d) {
        out.push(byte);
        continue;
      }
      // A soft line break (=CRLF or =LF) joins lines; =XX is one byte; anything else stays as written.
      if (body[i + 1] === 0x0d && body[i + 2] === 0x0a) i += 2;
      else if (body[i + 1] === 0x0a) i += 1;
      else {
        const hex = String.fromCharCode(body[i + 1] ?? 0, body[i + 2] ?? 0);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          i += 2;
        } else out.push(byte);
      }
    }
    return Uint8Array.from(out);
  }
  return body;
}
