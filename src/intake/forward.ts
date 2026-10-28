// The original message inside a forward (D01 T01 §4; spec 4.1). Forwarding as an attachment keeps the original's
// headers, which the authentication checks need; a normal (inline) forward loses them. This finds the original, or
// says the headers are missing, and counts any further attached messages so the member hears that only one was
// checked rather than having the others silently dropped.
//
// The first `message/rfc822` part wins, else the first attachment named `*.eml`, else the first `*.msg` (RFC 2046
// section 5.2.1); the type outranks the order. Only the outermost attachment is taken: an original that itself carries
// a message stays whole for parsing (§5). postal-mime parses with `forceRfc822Attachments`, so an attached message is
// always its own bytes, never merged into the forward's body.
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

// A message the parser refused (its limits on nesting, parts and header size, or a malformed structure). The
// Workflow turns it into a partial report (§7).
export class ParseError extends Error {
  override name = "ParseError";
}

export async function extractOriginal(raw: Uint8Array): Promise<Forward> {
  let attachments: { mimeType: string; filename: string | null; content: ArrayBuffer | string | Uint8Array }[];
  try {
    attachments = (await PostalMime.parse(raw, { forceRfc822Attachments: true })).attachments;
  } catch (error) {
    throw new ParseError(`the forward could not be parsed: ${(error as Error).message}`);
  }
  const name = (a: { filename: string | null }) => (a.filename ?? "").trim().toLowerCase();
  const rfc822 = attachments.filter((a) => a.mimeType.toLowerCase() === "message/rfc822");
  const eml = attachments.filter((a) => a.mimeType.toLowerCase() !== "message/rfc822" && name(a).endsWith(".eml"));
  const msg = attachments.filter((a) => a.mimeType.toLowerCase() !== "message/rfc822" && name(a).endsWith(".msg"));
  const candidates = rfc822.length + eml.length + msg.length;
  const [chosen, path, format] = rfc822[0]
    ? ([rfc822[0], "rfc822", "eml"] as const)
    : eml[0]
      ? ([eml[0], "eml", "eml"] as const)
      : msg[0]
        ? ([msg[0], "msg", "msg"] as const)
        : ([null, "inline", "eml"] as const);
  if (!chosen) return { original: raw, format: "eml", headersAvailable: false, path: "inline", otherOriginals: 0 };
  return { original: bytesOf(chosen.content), format, headersAvailable: true, path, otherOriginals: candidates - 1 };
}

const bytesOf = (content: ArrayBuffer | string | Uint8Array) =>
  content instanceof Uint8Array
    ? content
    : typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content);
