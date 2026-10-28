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
  forceRfc822Attachments: boolean;
  rfc822NestingDepth: number;
  readLine(): { bytes: Uint8Array; lineBreak: Uint8Array; done: boolean };
  processLine(bytes: Uint8Array, lineBreak: Uint8Array, done: boolean): Promise<void>;
  finalize(): Promise<void>;
  hasReportParts(): boolean;
  isInlineTextNode(node: MimeNode): boolean;
  collectNode(node: MimeNode, alternative: false, related: boolean): Promise<void>;
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
  // The second stage over the tree as it now stands.
  finish(): Promise<Email>;
};

// The first stage over `raw`, every attached message kept as an attachment (`forceRfc822Attachments`).
export async function readTree(raw: Uint8Array): Promise<Parsing> {
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
      try {
        reader.forceRfc822Attachments = true;
        await reader.collectNode(reader.root, false, false);
        if (reader.rfc822NestingDepth === 0) reader.renderTextContent();
        const message = reader.buildMessage();
        reader.encodeAttachments();
        return message;
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
