// An attached Outlook .msg parsed into the same ParsedMessage as a MIME original (D01 T01 §6; spec 4.2), which
// storeParsed (§5) stores. @kenjiuno/msgreader reads the compound file; it runs in the Worker under nodejs_compat.
//
// The headers are the message's transport headers (PidTagTransportMessageHeaders), read by postal-mime as a header
// block; a .msg without them (a draft, or a message saved before sending) has none, so `headersAvailable` is false and
// §7 applies that to the case. The HTML body is the binary PidTagHtml in its code page (PidTagInternetCodepage), as
// Outlook stores it. Each attachment keeps its content id, so the HTML's `cid:` references resolve, and an embedded
// Outlook message is stored as the .msg bytes msgreader exports for it. The bodies are cut to §5's limits.
//
// A file msgreader cannot read, one it reads as holding nothing, and one whose body is only compressed RTF are each a
// ParseError, so the case ends partial naming why rather than as an empty message (reading RTF bodies: D01 T01 §13).
import MsgReader from "@kenjiuno/msgreader";
import PostalMime from "postal-mime";
import { ParseError } from "./mime";
import { BODY_PART_LIMIT, BODY_TOTAL_LIMIT, KEPT_PARTS_LIMIT, type ParsedMessage } from "./parse";

export async function parseMsg(bytes: Uint8Array): Promise<{ parsed: ParsedMessage; headersAvailable: boolean }> {
  let reader: MsgReader;
  let data: ReturnType<MsgReader["getFileData"]>;
  try {
    reader = new MsgReader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    data = reader.getFileData();
  } catch (error) {
    throw new ParseError(`the .msg could not be read: ${(error as Error).message}`);
  }
  if (data.error || data.dataType !== "msg")
    throw new ParseError(`the .msg could not be read: ${data.error ?? "not a message"}`);
  const transport = data.headers?.trim() ? data.headers : null;
  const htmlBytes = data.html?.length ? data.html : null;
  const hasBody = !!(data.body?.length || htmlBytes || data.bodyHtml?.length);
  if (!hasBody && data.compressedRtf?.length)
    throw new ParseError("the .msg's body is only compressed RTF, which is not read yet (D01 T01 §13)");
  if (!hasBody && !data.subject && !transport && !data.attachments?.length)
    throw new ParseError("the .msg holds nothing readable (an empty or cut-off file)");

  // The bodies, cut to §5's limits with each cut part kept whole.
  const truncated: ParsedMessage["truncated"] = [];
  let budget = BODY_TOTAL_LIMIT;
  const bound = (full: Uint8Array, mediaType: string, charset: string | null) => {
    const kept = Math.min(full.byteLength, BODY_PART_LIMIT, budget);
    budget -= kept;
    if (kept < full.byteLength && truncated.length < KEPT_PARTS_LIMIT)
      truncated.push({ mediaType, charset, full, keptBytes: kept });
    return full.subarray(0, kept);
  };
  const textBytes = data.body ? new TextEncoder().encode(data.body) : null;
  const text = textBytes ? new TextDecoder().decode(bound(textBytes, "text/plain", "utf-8")) : null;
  let html: string | null = null;
  if (htmlBytes) {
    const charset = codepageLabel(data.internetCodepage);
    html = decode(bound(htmlBytes, "text/html", charset), charset);
  } else if (data.bodyHtml) {
    html = new TextDecoder().decode(bound(new TextEncoder().encode(data.bodyHtml), "text/html", "utf-8"));
  }

  const attachments: ParsedMessage["attachments"] = [];
  for (const field of data.attachments ?? []) {
    let exported: { fileName: string; content: Uint8Array };
    try {
      exported = reader.getAttachment(field);
    } catch (error) {
      throw new ParseError(`an attachment of the .msg could not be read: ${(error as Error).message}`);
    }
    const embedded = field.innerMsgContent === true;
    const contentId = field.pidContentId?.trim() ? `<${field.pidContentId.trim().replace(/^<|>$/g, "")}>` : null;
    attachments.push({
      filename: exported.fileName || field.fileName || null,
      mediaType: embedded
        ? "application/vnd.ms-outlook"
        : field.attachMimeTag?.trim().toLowerCase() || "application/octet-stream",
      contentId,
      disposition: contentId ? "inline" : "attachment",
      bytes: exported.content,
    });
  }

  return {
    parsed: {
      headers: transport ? await headersOf(transport) : [],
      text,
      html,
      attachments,
      truncated,
      omitted: 0,
    },
    headersAvailable: transport !== null,
  };
}

// Transport headers in order with repeats, read by postal-mime from the header block alone (nothing is rendered).
async function headersOf(block: string): Promise<ParsedMessage["headers"]> {
  try {
    const email = await PostalMime.parse(`${block.replace(/(\r?\n)+$/, "")}\r\n\r\n`);
    return email.headers.map((h) => ({ name: h.originalKey, value: h.value }));
  } catch (error) {
    throw new ParseError(`the .msg's transport headers could not be read: ${(error as Error).message}`);
  }
}

// The encoding label for a Windows code page (PidTagInternetCodepage), or UTF-8 when it names none or one unknown.
const CODEPAGES: Record<number, string> = {
  65001: "utf-8",
  1200: "utf-16le",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  20127: "us-ascii",
  28591: "iso-8859-1",
  28592: "iso-8859-2",
  28605: "iso-8859-15",
  50220: "iso-2022-jp",
  51932: "euc-jp",
  54936: "gb18030",
};
const codepageLabel = (codepage: number | undefined) => (codepage && CODEPAGES[codepage]) || "utf-8";

// Bytes in a charset, falling back to UTF-8 when the runtime does not know the label.
function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
