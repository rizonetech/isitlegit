// postal-mime 4.1.4's parse in its two stages (D01 T01 §4 and §5). Its first stage reads every line into a MIME tree:
// each part's structured headers (comments, quoting, repeated parameters, the digest default) and its transfer-decoded
// bytes. Its second stage collects text and attachments from that tree, renders plain text into HTML (and HTML into
// text) and builds the result. Run whole, the second stage exhausted 128 MiB on an 8 MB crafted text part (§4 round 1),
// so callers run the first stage, look at or bound the tree, and run the second only when they need its result.
//
// WORKAROUND: postal-mime has no public way to stop between the stages, so this drives its line reader and reads its
// tree directly, through the members below. The version is pinned exactly in package.json, and the intake tests fail
// if an upgrade moves any of them.
import PostalMime, { type Email } from "postal-mime";

export type MimeNode = {
  contentType: {
    parsed: { value: string; params: Record<string, string | undefined> };
    multipart: string | false;
  };
  contentDisposition: { parsed: { value: string; params: Record<string, string | undefined> } };
  contentTransferEncoding: { encoding: string };
  childNodes: MimeNode[];
  content: ArrayBuffer | null;
};

type Reader = {
  started: boolean;
  buf: ArrayBuffer;
  av: Uint8Array;
  readPos: number;
  root: MimeNode;
  attachments: { mimeType: string }[];
  forceRfc822Attachments: boolean;
  rfc822NestingDepth: number;
  readLine(): { bytes: Uint8Array; lineBreak: Uint8Array; done: boolean };
  processLine(bytes: Uint8Array, lineBreak: Uint8Array, done: boolean): Promise<void>;
  finalize(): Promise<void>;
  hasReportParts(): boolean;
  isInlineTextNode(node: MimeNode): boolean;
  collectNode(node: MimeNode, alternative: false, related: boolean): Promise<void>;
  collectAttachment(node: MimeNode, ...rest: unknown[]): void;
  renderTextContent(): void;
  buildMessage(): Email;
  encodeAttachments(): void;
};

// A message postal-mime refused (its limits on nesting, parts and header size, or a malformed structure). The
// Workflow turns it into a partial report (D01 T01 §7).
export class ParseError extends Error {
  override name = "ParseError";
}

export type Parsing = {
  root: MimeNode;
  // Whether postal-mime would render this node as body text (a text/plain or text/html part that is not an attachment).
  isBodyText(node: MimeNode): boolean;
  // The second stage over the tree as it now stands, with each attachment's own transfer-decoded bytes beside it in
  // order: postal-mime rewrites a text/calendar or application/ics attachment as UTF-8 text, which is not what was sent.
  finish(): Promise<{ email: Email; attachmentBytes: Uint8Array[] }>;
};

// The first stage over `raw`, every attached message kept as an attachment (`forceRfc822Attachments`).
export async function readTree(raw: Uint8Array): Promise<Parsing> {
  const reader = new PostalMime({ forceRfc822Attachments: true }) as unknown as Reader;
  try {
    reader.started = true;
    // The caller's bytes, not a copy (a forward is up to 25 MiB), unless they are a view into a larger buffer.
    reader.buf = (
      raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? raw.buffer
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    ) as ArrayBuffer;
    reader.av = new Uint8Array(reader.buf);
    reader.readPos = 0;
    while (reader.readPos < reader.av.length) {
      const line = reader.readLine();
      // A last line with no line break gets a synthesized LF from postal-mime, which its decoders write into the part:
      // a binary attachment ending the message would gain a byte. The bytes actually there (none, or a lone CR) go
      // instead.
      const lineBreak =
        line.done && reader.av[reader.av.length - 1] !== 0x0a
          ? reader.av.subarray(line.bytes.byteOffset + line.bytes.byteLength, reader.av.length)
          : line.lineBreak;
      await reader.processLine(line.bytes, lineBreak, line.done);
    }
    // The end-of-input flush for every part still open (a last part with no closing boundary); a no-op for parts
    // already finished.
    await reader.finalize();
  } catch (error) {
    throw new ParseError(`the message could not be parsed: ${(error as Error).message}`);
  }
  return {
    root: reader.root,
    isBodyText: (node) => reader.isInlineTextNode(node),
    // postal-mime's own parse() after its read loop, unchanged.
    finish: async () => {
      const collected: MimeNode[] = [];
      const collect = reader.collectAttachment.bind(reader);
      reader.collectAttachment = (node, ...rest) => {
        collected.push(node);
        // postal-mime decodes a calendar part as text and rewrites it, unbounded (a 12 MB calendar exhausted 128 MiB,
        // round 1); its bytes are taken from the node anyway, so it is collected as plain bytes and its type restored.
        const type = node.contentType.parsed.value;
        const calendar = type === "text/calendar" || type === "application/ics";
        if (calendar) node.contentType.parsed.value = "application/octet-stream";
        try {
          collect(node, ...rest);
        } finally {
          if (calendar) {
            node.contentType.parsed.value = type;
            const last = reader.attachments[reader.attachments.length - 1];
            if (last) last.mimeType = type;
          }
        }
      };
      try {
        reader.forceRfc822Attachments = true;
        await reader.collectNode(reader.root, false, false);
        if (reader.rfc822NestingDepth === 0) reader.renderTextContent();
        const email = reader.buildMessage();
        reader.encodeAttachments();
        if (collected.length !== email.attachments.length)
          throw new Error(
            `${collected.length} attachment parts were collected for ${email.attachments.length} attachments`,
          );
        return { email, attachmentBytes: collected.map((node) => new Uint8Array(node.content ?? new ArrayBuffer(0))) };
      } catch (error) {
        throw new ParseError(`the message could not be parsed: ${(error as Error).message}`);
      }
    },
  };
}

// The leaves of the tree in document order.
export function* leaves(node: MimeNode): Generator<MimeNode> {
  if (!node.contentType.multipart) {
    yield node;
    return;
  }
  for (const child of node.childNodes) yield* leaves(child);
}
