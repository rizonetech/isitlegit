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
  try {
    return await read(bytes);
  } catch (error) {
    // Anything msgreader or a malformed property throws is a refusal like any other, never an untyped crash.
    if (error instanceof ParseError) throw error;
    throw new ParseError(`the .msg could not be read: ${(error as Error).message}`);
  }
}

type Fields = ReturnType<MsgReader["getFileData"]>;

// Opens the file and reads its properties, 8-bit strings decoded in `ansiEncoding` (msgreader's own option).
function open(bytes: Uint8Array, ansiEncoding?: string): { reader: MsgReader; data: Fields } {
  const reader = new MsgReader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (ansiEncoding) reader.parserConfig = { ansiEncoding };
  guardSizes(reader, bytes.byteLength);
  const data = reader.getFileData();
  if (data.error || data.dataType !== "msg")
    throw new ParseError(`the .msg could not be read: ${data.error ?? "not a message"}`);
  return { reader, data };
}

// WORKAROUND: msgreader allocates each stream at the size its directory entry declares before reading it, so one forged
// size in a 10 KB file asked for 256 MiB (§6 completion review). It has no bound of its own; its directory is read in
// one step (Reader.parse) before any stream, so that step is wrapped to refuse a declared stream larger than the file,
// or streams declaring more together than the file can hold. Pinned at 1.29.0; the test with a forged size fails if an
// upgrade moves the step.
function guardSizes(reader: MsgReader, fileBytes: number) {
  const inner = (
    reader as unknown as { reader: { parse(): void; propertyData?: ({ sizeBlock?: number } | undefined)[] } }
  ).reader;
  const parse = inner.parse.bind(inner);
  inner.parse = () => {
    parse();
    let declared = 0;
    for (const entry of inner.propertyData ?? []) {
      const size = entry?.sizeBlock ?? 0;
      if (size > fileBytes)
        throw new ParseError(`a stream in the .msg declares ${size} bytes, more than the file holds`);
      declared += size;
    }
    // The mini stream lives inside the root entry's stream, so a sound file's streams declare at most about twice it.
    if (declared > 2 * fileBytes + 65_536)
      throw new ParseError("the .msg's streams declare more bytes than the file can hold");
  };
}

async function read(bytes: Uint8Array): Promise<{ parsed: ParsedMessage; headersAvailable: boolean }> {
  let { reader, data } = open(bytes);
  // 8-bit (ANSI) string properties are in the message's own code page (PidTagMessageCodepage); read again in it, so
  // "€100" in code page 1252 is not "\u0080100".
  const messageCodepage = data.messageCodepage;
  if (typeof messageCodepage === "number" && messageCodepage !== 1200 && messageCodepage !== 65001)
    ({ reader, data } = open(bytes, codepageLabel(messageCodepage)));
  const transport = optionalString(data.headers, "transport headers")?.trim() ? (data.headers as string) : null;
  const body = optionalString(data.body, "text body");
  const bodyHtml = optionalString(data.bodyHtml, "HTML body");
  const subject = optionalString(data.subject, "subject");
  if (data.html !== undefined && !(data.html instanceof Uint8Array))
    throw new ParseError("the .msg's HTML property is not binary");
  if (data.attachments !== undefined && !Array.isArray(data.attachments))
    throw new ParseError("the .msg's attachments are malformed");
  const htmlBytes = data.html?.length ? data.html : null;
  const hasBody = !!(body?.length || htmlBytes || bodyHtml?.length);
  if (!hasBody && data.compressedRtf?.length)
    throw new ParseError("the .msg's body is only compressed RTF, which is not read yet (D01 T01 §13)");
  if (!hasBody && !subject && !transport && !data.attachments?.length)
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
  const textBytes = body ? new TextEncoder().encode(body) : null;
  const text = textBytes ? new TextDecoder().decode(bound(textBytes, "text/plain", "utf-8")) : null;
  let html: string | null = null;
  if (htmlBytes) {
    // The HTML's own code page (PidTagInternetCodepage), UTF-8 when it names none.
    const charset = data.internetCodepage === undefined ? "utf-8" : codepageLabel(data.internetCodepage);
    html = decode(bound(htmlBytes, "text/html", charset), charset);
  } else if (bodyHtml) {
    html = new TextDecoder().decode(bound(new TextEncoder().encode(bodyHtml), "text/html", "utf-8"));
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

// A string property's value, null when absent; any other type is a malformed property.
function optionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ParseError(`the .msg's ${what} is not text`);
  return value;
}

// The WHATWG encoding label for a Windows code page ([MS-OXCMAIL] lists the ones Outlook writes); one with no label is
// a ParseError rather than a guess, since a wrong decoder silently changes the evidence.
const CODEPAGES: Record<number, string> = {
  708: "iso-8859-6",
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1200: "utf-16le",
  1201: "utf-16be",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  10007: "x-mac-cyrillic",
  20127: "us-ascii",
  20866: "koi8-r",
  20932: "euc-jp",
  20936: "gb2312",
  21866: "koi8-u",
  28591: "iso-8859-1",
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28599: "iso-8859-9",
  28603: "iso-8859-13",
  28605: "iso-8859-15",
  38598: "iso-8859-8-i",
  50220: "iso-2022-jp",
  50221: "iso-2022-jp",
  50222: "iso-2022-jp",
  51932: "euc-jp",
  51936: "gb2312",
  51949: "euc-kr",
  54936: "gb18030",
  65001: "utf-8",
};
function codepageLabel(codepage: number): string {
  const label = CODEPAGES[codepage];
  if (!label) throw new ParseError(`the .msg uses code page ${codepage}, which has no decoder here`);
  return label;
}

// Bytes in a charset the runtime knows (every label above is a WHATWG one).
const decode = (bytes: Uint8Array, charset: string) => new TextDecoder(charset).decode(bytes);
