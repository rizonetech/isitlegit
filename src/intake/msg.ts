// An attached Outlook .msg parsed into the same ParsedMessage as a MIME original (D01 T01 §6; spec 4.2), which
// storeParsed (§5) stores. The compound file's structure is checked first (cfb.ts), since @kenjiuno/msgreader trusts it;
// msgreader then reads the properties (it runs in the Worker under nodejs_compat), except the top-level text and
// Unicode HTML bodies, which are read and cut here in their own charset.
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
import { type CfbEntry, type CompoundFile, child, hide, readCompoundFile } from "./cfb";
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

// String properties other than the top-level bodies: each at most this many bytes, and all of them together at most
// STRING_TOTAL_LIMIT. msgreader builds a string a character at a time, so a 17 MB Unicode body exhausted 128 MiB before
// any limit applied (round 1); the top-level bodies are read and cut here instead, and a larger other property (a
// subject, the transport headers, an embedded message's body) is a ParseError rather than a crash.
export const STRING_PROPERTY_LIMIT = 1024 * 1024;
export const STRING_TOTAL_LIMIT = 4 * 1024 * 1024;

// A property stream's key as msgreader reads it: the characters after "__substg1.0_", case ignored, whose second four
// name the type it decodes by (001F Unicode, 001E 8-bit); it reads nothing past the eighth. The bounds below classify
// streams the same way, and a name [MS-OXMSG] 2.1.4.1 does not allow (a suffix on a single-valued property, which
// msgreader would still decode as that property) is refused, so no stream escapes them under another spelling.
const PREFIX = "__substg1.0_";
const keyOf = (entry: CfbEntry) =>
  entry.name.startsWith(PREFIX) ? entry.name.slice(PREFIX.length).toLowerCase() : null;
const typeOf = (entry: CfbEntry) => keyOf(entry)?.slice(4, 8) ?? null;
const isString = (entry: CfbEntry) => typeOf(entry) === "001f" || typeOf(entry) === "001e";
const is8Bit = (entry: CfbEntry) => typeOf(entry) === "001e";
const WELL_FORMED = /^[0-9a-f]{8}$|^[0-9a-f]{4}1[0-9a-f]{3}-[0-9a-f]{8}$/;

// The top-level bodies this reads itself ([MS-OXPROPS]: PidTagBody as Unicode or 8-bit, PidTagHtml as Unicode).
const TEXT_UNICODE = "1000001f";
const TEXT_8BIT = "1000001e";
const HTML_UNICODE = "1013001f";
const PROPERTIES = "__properties_version1.0";
const rootProperty = (file: CompoundFile, key: string) =>
  file.root.children.find((entry) => entry.kind === "stream" && keyOf(entry) === key) ?? null;

// A fixed-size property from a storage's property stream ([MS-OXMSG] 2.4: a header of `header` bytes, then 16 bytes a
// property: tag, flags, value); the 32-bit value of property `id` with type `type`, or null.
function fixedProperty(file: CompoundFile, storage: CfbEntry, header: number, id: number, type: number) {
  const stream = child(storage, PROPERTIES);
  if (!stream) return null;
  const bytes = file.read(stream);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = header; at + 16 <= bytes.byteLength; at += 16)
    if (view.getUint16(at, true) === type && view.getUint16(at + 2, true) === id) return view.getUint32(at + 8, true);
  return null;
}

async function read(bytes: Uint8Array): Promise<{ parsed: ParsedMessage; headersAvailable: boolean }> {
  // The structure is checked before msgreader reads anything (cfb.ts), and a message needs its property stream and
  // message class ([MS-OXMSG] 2.4, [MS-OXCMSG] 2.2.1.3): any other compound file (a Word document renamed .msg) is not
  // one.
  const file = readCompoundFile(bytes);
  for (const entry of file.entries) {
    const key = keyOf(entry);
    if (key !== null && !WELL_FORMED.test(key))
      throw new ParseError(`a property stream of the .msg has a malformed name (${entry.name})`);
  }
  if (!child(file.root, PROPERTIES) || !(rootProperty(file, "001a001f") || rootProperty(file, "001a001e")))
    throw new ParseError("the .msg is not an Outlook message: it has no message properties");

  const strings = file.entries.filter((entry) => entry.kind === "stream" && isString(entry));
  const bodies = new Set(
    [TEXT_UNICODE, TEXT_8BIT, HTML_UNICODE].map((key) => rootProperty(file, key)).filter((e) => e !== null),
  );
  let total = 0;
  for (const entry of strings) {
    if (bodies.has(entry)) continue;
    if (entry.size > STRING_PROPERTY_LIMIT)
      throw new ParseError(
        `a text property of the .msg (${entry.name}) is ${entry.size} bytes, more than ${STRING_PROPERTY_LIMIT}`,
      );
    total += entry.size;
  }
  if (total > STRING_TOTAL_LIMIT)
    throw new ParseError(`the .msg's text properties hold ${total} bytes, more than ${STRING_TOTAL_LIMIT}`);

  // 8-bit strings are in the message's code page (PidTagMessageCodepage), Windows-1252 when it names none (Outlook's
  // own default); msgreader decodes them with iconv-lite, which knows a few of the labels by other names.
  const messageCodepage = fixedProperty(file, file.root, 32, 0x3ffd, 0x0003) ?? 1252;
  const ansiLabel = codepageLabel(messageCodepage);
  const ansiEncoding = ICONV_NAMES[ansiLabel] ?? ansiLabel;
  const has8Bit = file.entries.some((entry) => entry.kind === "stream" && is8Bit(entry));
  if (has8Bit && (ansiLabel.startsWith("utf-16") || ansiEncoding === "iso-2022-jp"))
    throw new ParseError(`the .msg's 8-bit text is in code page ${messageCodepage}, which is not read`);

  // The bodies msgreader would decode a character at a time are hidden from it when they are over the limit.
  const large = [...bodies].filter((entry) => entry.size > STRING_PROPERTY_LIMIT);
  const reader = new MsgReader(new DataView(...viewOf(large.length ? hide(bytes, large) : bytes)));
  reader.parserConfig = { ansiEncoding };
  const data: Fields = reader.getFileData();
  if (data.error || data.dataType !== "msg")
    throw new ParseError(`the .msg could not be read: ${data.error ?? "not a message"}`);

  const transport = optionalString(data.headers, "transport headers")?.trim() ? (data.headers as string) : null;
  const subject = optionalString(data.subject, "subject");
  if (data.html !== undefined && !(data.html instanceof Uint8Array))
    throw new ParseError("the .msg's HTML property is not binary");
  if (data.attachments !== undefined && !Array.isArray(data.attachments))
    throw new ParseError("the .msg's attachments are malformed");
  const textEntry = rootProperty(file, TEXT_UNICODE) ?? rootProperty(file, TEXT_8BIT);
  const htmlBytes = data.html?.length ? data.html : null;
  const htmlUnicode = htmlBytes ? null : rootProperty(file, HTML_UNICODE);
  const hasBody = !!(textEntry?.size || htmlBytes || htmlUnicode?.size);
  if (!hasBody && data.compressedRtf?.length)
    throw new ParseError("the .msg's body is only compressed RTF, which is not read yet (D01 T01 §13)");
  if (!hasBody && !subject && !transport && !data.attachments?.length)
    throw new ParseError("the .msg holds nothing readable (an empty or cut-off file)");

  // The bodies, cut to §5's limits with each cut part kept whole in its own charset; a UTF-16 cut keeps whole code
  // units.
  const truncated: ParsedMessage["truncated"] = [];
  let budget = BODY_TOTAL_LIMIT;
  const bound = (full: Uint8Array, mediaType: string, charset: string) => {
    let kept = Math.min(full.byteLength, BODY_PART_LIMIT, budget);
    if (charset.startsWith("utf-16")) kept -= kept % 2;
    budget -= kept;
    if (kept < full.byteLength && truncated.length < KEPT_PARTS_LIMIT)
      truncated.push({ mediaType, charset, full, keptBytes: kept });
    return full.subarray(0, kept);
  };
  // A string stream's text without the terminating NULs some writers leave in it.
  const textOf = (entry: CfbEntry, mediaType: string, charset: string) =>
    decode(bound(file.read(entry), mediaType, charset), charset).replace(/\0+$/, "");
  const text = textEntry?.size
    ? textOf(textEntry, "text/plain", keyOf(textEntry) === TEXT_UNICODE ? "utf-16le" : ansiLabel)
    : null;
  let html: string | null = null;
  if (htmlBytes) {
    // The HTML's own code page (PidTagInternetCodepage), UTF-8 when it names none.
    const charset = data.internetCodepage === undefined ? "utf-8" : codepageLabel(data.internetCodepage);
    html = decode(bound(htmlBytes, "text/html", charset), charset);
  } else if (htmlUnicode?.size) {
    html = textOf(htmlUnicode, "text/html", "utf-16le");
  }

  const attachments: ParsedMessage["attachments"] = [];
  for (const field of data.attachments ?? []) {
    let exported: { fileName: string; content: Uint8Array };
    try {
      exported = reader.getAttachment(field);
    } catch (error) {
      throw new ParseError(`an attachment of the .msg could not be read: ${(error as Error).message}`);
    }
    // An embedded message is attach method 5 (PidTagAttachMethod, afEmbeddedMessage); msgreader marks every
    // attachment whose data is a storage, which an OLE object (method 6) is too ([MS-OXCMSG] 2.2.2.9).
    const storage =
      typeof field.folderId === "number" ? (file.entries.find((e) => e.id === field.folderId) ?? null) : null;
    const method = storage?.parent ? fixedProperty(file, storage.parent, 8, 0x3705, 0x0003) : null;
    const embedded = field.innerMsgContent === true && method === 5;
    // The long file name, else the short one ([MS-OXPROPS] PidTagAttachLongFilename, PidTagAttachFilename).
    const name =
      optionalString(field.fileName, "attachment file name") ||
      optionalString(field.fileNameShort, "attachment file name");
    const contentId = optionalString(field.pidContentId, "attachment content id")?.trim()
      ? `<${(field.pidContentId as string).trim().replace(/^<|>$/g, "")}>`
      : null;
    attachments.push({
      filename: embedded ? exported.fileName || name || null : name || null,
      mediaType: embedded
        ? "application/vnd.ms-outlook"
        : optionalString(field.attachMimeTag, "attachment type")?.trim().toLowerCase() || "application/octet-stream",
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

// iconv-lite's names for the labels above it knows by another name (msgreader decodes 8-bit strings with it); it has no
// ISO-2022-JP, so a message whose 8-bit strings are in that code page is refused.
const ICONV_NAMES: Record<string, string> = { "x-mac-cyrillic": "maccyrillic", "iso-8859-8-i": "iso-8859-8" };

const viewOf = (bytes: Uint8Array) => [bytes.buffer, bytes.byteOffset, bytes.byteLength] as const;

// Bytes in a charset the runtime knows (every label above is a WHATWG one).
const decode = (bytes: Uint8Array, charset: string) => new TextDecoder(charset).decode(bytes);
