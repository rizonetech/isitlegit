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
// A file msgreader cannot read, or one it reads as holding nothing, is a ParseError, so the case ends partial
// naming why rather than as an empty message. A body held only as compressed RTF is read (D01 T01 §13, ./rtf).
import PostalMime from "postal-mime";
import { type CfbEntry, type CompoundFile, child, hide, readCompoundFile } from "./cfb";
import { ParseError } from "./mime";
import { loadMsgReader, loadMsgreaderConstants } from "./msgreader";
import type { MsgSender } from "./original-header";
import { BODY_PART_LIMIT, BODY_TOTAL_LIMIT, KEPT_PARTS_LIMIT, type ParsedMessage } from "./parse";
import { decompressRtf, rtfToHtml, rtfToText } from "./rtf";

export async function parseMsg(
  bytes: Uint8Array,
): Promise<{ parsed: ParsedMessage; headersAvailable: boolean; sender: MsgSender }> {
  try {
    return await read(bytes);
  } catch (error) {
    // Anything msgreader or a malformed property throws is a refusal like any other, never an untyped crash.
    if (error instanceof ParseError) throw error;
    throw new ParseError(`the .msg could not be read: ${(error as Error).message}`);
  }
}

type Fields = ReturnType<InstanceType<ReturnType<typeof loadMsgReader>>["getFileData"]>;

// String properties other than the top-level bodies (with the named-property names and the named binary properties
// msgreader decodes, below): each at most this many bytes, and all of them together at most
// STRING_TOTAL_LIMIT. msgreader builds a string a character at a time, so a 17 MB Unicode body exhausted 128 MiB before
// any limit applied (round 1); the top-level bodies are read and cut here instead, and a larger other property (a
// subject, the transport headers, an embedded message's body) is a ParseError rather than a crash.
export const STRING_PROPERTY_LIMIT = 1024 * 1024;
export const STRING_TOTAL_LIMIT = 4 * 1024 * 1024;

// msgreader recognises entries by name prefix, from its own constants: a property stream by "__substg1." (its key is
// then the characters from the twelfth, case ignored, and the second four name the type it decodes by: 001F Unicode,
// 001E 8-bit), an attachment, a recipient and the named-property map by theirs. Every name in one of those families
// must be the one spelling [MS-OXMSG] 2.1 gives it, so no entry reaches msgreader under a spelling the bounds below do
// not see (a suffix on a single-valued property, "__substg1.X_", round 2 and 4). The prefixes come from msgreader
// itself, so an upgrade that changes them changes these checks with it.
const family = () => loadMsgreaderConstants().MSG.FIELD.PREFIX;
const spellings = (): [string, RegExp][] => [
  [family().DOCUMENT, /^__substg1\.0_(?:[0-9a-f]{8}|[0-9a-f]{4}1[0-9a-f]{3}-[0-9a-f]{8})$/i],
  [family().ATTACHMENT, /^__attach_version1\.0_#[0-9a-f]{8}$/i],
  [family().RECIPIENT, /^__recip_version1\.0_#[0-9a-f]{8}$/i],
  [family().NAMEID, /^__nameid_version1\.0$/],
];
const keyOf = (entry: CfbEntry) =>
  entry.name.startsWith(family().DOCUMENT) ? entry.name.slice(12).toLowerCase() : null;
const typeOf = (entry: CfbEntry) => keyOf(entry)?.slice(4, 8) ?? null;
const isString = (entry: CfbEntry) => typeOf(entry) === "001f" || typeOf(entry) === "001e";
const is8Bit = (entry: CfbEntry) => typeOf(entry) === "001e";
// A named property's value as binary (class 0x8000 and up): msgreader parses some (voting buttons, time zones, a
// recurrence) into strings, so they count against the same limits as text.
const isNamedBinary = (entry: CfbEntry) => {
  const key = keyOf(entry);
  return key !== null && key.slice(4, 8) === "0102" && Number.parseInt(key.slice(0, 4), 16) >= 0x8000;
};

// The named-property names msgreader decodes, in bytes, repeats counted: it reads every storage whose name starts
// "__nameid_version1.0" that holds the GUID (0002), entry (0003) and string (0004) streams, and decodes the string an
// entry points at once for each entry ([MS-OXMSG] 2.2.3), so one long name referred to by many entries costs each time.
// An entry pointing outside the string stream is a ParseError. Also the property indexes whose numeric id is 0x8216
// (PidLidAppointmentRecur, [MS-OXPROPS] 2.22), in any property set: msgreader parses those as a recurrence.
function namedProperties(file: CompoundFile): { nameBytes: number; recurrences: Set<number> } {
  let total = 0;
  const recurrences = new Set<number>();
  for (const storage of file.entries) {
    if (storage.kind !== "storage" || !storage.name.startsWith(family().NAMEID)) continue;
    const table = (key: string) => storage.children.find((e) => e.kind === "stream" && keyOf(e) === key) ?? null;
    const [guids, entries, strings] = [table("00020102"), table("00030102"), table("00040102")];
    if (!guids || !entries || !strings) continue;
    const entryBytes = file.read(entries);
    const stringBytes = file.read(strings);
    const entryView = new DataView(entryBytes.buffer, entryBytes.byteOffset, entryBytes.byteLength);
    const stringView = new DataView(stringBytes.buffer, stringBytes.byteOffset, stringBytes.byteLength);
    for (let at = 0; at + 8 <= entryBytes.byteLength; at += 8) {
      if (!(entryView.getUint16(at + 4, true) & 1)) {
        if (entryView.getUint32(at, true) === 0x8216) recurrences.add(entryView.getUint16(at + 6, true));
        continue;
      }
      const offset = entryView.getUint32(at, true);
      const length = offset + 4 <= stringBytes.byteLength ? stringView.getUint32(offset, true) : -1;
      if (length < 0 || offset + 4 + length > stringBytes.byteLength)
        throw new ParseError("a named property of the .msg names a string outside its string stream");
      total += length;
    }
  }
  return { nameBytes: total, recurrences };
}

// A recurrence as msgreader's parser reads it ([MS-OXOCAL] 2.2.1.44.1): it allocates the deleted and the modified
// instance dates from their 32-bit counts before reading them, so counts the stream cannot hold are refused here.
// One whose versions it does not read (not 0x3004) it drops before the counts.
function checkRecurrence(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22 || view.getUint16(0, true) !== 0x3004 || view.getUint16(2, true) !== 0x3004) return;
  const pattern = view.getUint16(6, true);
  // The pattern-specific part: a week's or a month's 4 bytes, an nth month's 8 (types 1; 2, 4, 10, 12; 3, 11).
  let at = 22 + ([1, 2, 4, 10, 12].includes(pattern) ? 4 : [3, 11].includes(pattern) ? 8 : 0) + 12;
  for (const what of ["deleted", "modified"]) {
    if (at + 4 > bytes.byteLength) return;
    const count = view.getUint32(at, true);
    if (count > (bytes.byteLength - at - 4) / 4)
      throw new ParseError(`a recurrence in the .msg declares ${count} ${what} instances, more than it holds`);
    at += 4 + 4 * count;
  }
}

// The top-level bodies this reads itself ([MS-OXPROPS]: PidTagBody and PidTagHtml as Unicode or 8-bit strings).
const TEXT_UNICODE = "1000001f";
const TEXT_8BIT = "1000001e";
// PidTagSentRepresentingName and PidTagSentRepresentingEmailAddress, the message's From ([MS-OXPROPS]).
const SENT_REPRESENTING_NAME = "0042";
const SENT_REPRESENTING_EMAIL = "0065";
const HTML_UNICODE = "1013001f";
const HTML_8BIT = "1013001e";
const PROPERTIES = "__properties_version1.0";
const rootProperty = (file: CompoundFile, key: string) =>
  file.root.children.find((entry) => entry.kind === "stream" && keyOf(entry) === key) ?? null;

// The type a storage's property stream lists property `id` with, or null.
function listedType(file: CompoundFile, storage: CfbEntry, header: number, id: number) {
  const stream = child(storage, PROPERTIES);
  if (!stream) return null;
  const bytes = file.read(stream);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = header; at + 16 <= bytes.byteLength; at += 16)
    if (view.getUint16(at + 2, true) === id) return view.getUint16(at, true);
  return null;
}

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

async function read(
  bytes: Uint8Array,
): Promise<{ parsed: ParsedMessage; headersAvailable: boolean; sender: MsgSender }> {
  // The structure is checked before msgreader reads anything (cfb.ts), and a message needs its property stream and
  // message class ([MS-OXMSG] 2.4, [MS-OXCMSG] 2.2.1.3): any other compound file (a Word document renamed .msg) is not
  // one.
  const file = readCompoundFile(bytes);
  for (const entry of file.entries)
    for (const [prefix, spelling] of spellings())
      if (entry.name.startsWith(prefix) && !spelling.test(entry.name))
        throw new ParseError(`an entry of the .msg has a malformed name (${entry.name})`);
  if (!child(file.root, PROPERTIES))
    throw new ParseError("the .msg is not an Outlook message: it has no message properties");

  const decoded = file.entries.filter((entry) => entry.kind === "stream" && (isString(entry) || isNamedBinary(entry)));
  const bodies = new Set(
    [TEXT_UNICODE, TEXT_8BIT, HTML_UNICODE, HTML_8BIT].map((key) => rootProperty(file, key)).filter((e) => e !== null),
  );
  const named = namedProperties(file);
  let total = named.nameBytes;
  for (const entry of decoded) {
    if (bodies.has(entry)) continue;
    if (entry.size > STRING_PROPERTY_LIMIT)
      throw new ParseError(
        `a text property of the .msg (${entry.name}) is ${entry.size} bytes, more than ${STRING_PROPERTY_LIMIT}`,
      );
    total += entry.size;
  }
  if (total > STRING_TOTAL_LIMIT)
    throw new ParseError(`the .msg's text properties hold ${total} bytes, more than ${STRING_TOTAL_LIMIT}`);
  for (const entry of decoded)
    if (isNamedBinary(entry) && named.recurrences.has(Number.parseInt(keyOf(entry)?.slice(0, 4) ?? "0", 16) - 0x8000))
      checkRecurrence(file.read(entry));

  // 8-bit strings are in the message's code page (PidTagMessageCodepage), Windows-1252 when it names none (Outlook's
  // own default); msgreader decodes them with iconv-lite, which knows a few of the labels by other names.
  const messageCodepage = fixedProperty(file, file.root, 32, 0x3ffd, 0x0003) ?? 1252;
  const ansiLabel = codepageLabel(messageCodepage);
  const ansiEncoding = ICONV_NAMES[ansiLabel] ?? ansiLabel;
  const has8Bit = file.entries.some((entry) => entry.kind === "stream" && is8Bit(entry));
  if (has8Bit && (ansiLabel.startsWith("utf-16") || ansiEncoding === "iso-2022-jp"))
    throw new ParseError(`the .msg's 8-bit text is in code page ${messageCodepage}, which is not read`);

  // A message lists its message class in its property stream and names an Outlook item class ([MS-OXCMSG] 2.2.1.3:
  // "IPM..." or "REPORT..."); a stream of that name the property stream does not list is no message class.
  const classType = listedType(file, file.root, 32, 0x001a);
  const classEntry = rootProperty(file, classType === 0x001e ? "001a001e" : "001a001f");
  const messageClass =
    classEntry && classType !== null
      ? decode(file.read(classEntry), classType === 0x001e ? ansiLabel : "utf-16le").replace(/\0+$/, "")
      : "";
  if (!/^(IPM|REPORT)(\.|$)/i.test(messageClass))
    throw new ParseError("the .msg is not an Outlook message: it has no message class");

  // The bodies msgreader would decode a character at a time are hidden from it when they are over the limit.
  const large = [...bodies].filter((entry) => entry.size > STRING_PROPERTY_LIMIT);
  const MsgReader = loadMsgReader();
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
  const htmlString = htmlBytes ? null : (rootProperty(file, HTML_UNICODE) ?? rootProperty(file, HTML_8BIT));
  const hasBody = !!(textEntry?.size || htmlBytes || htmlString?.size);
  if (!hasBody && !data.compressedRtf?.length && !subject && !transport && !data.attachments?.length)
    throw new ParseError("the .msg holds nothing readable (an empty or cut-off file)");

  // The bodies, cut to §5's limits with each cut part kept whole in its own charset. A cut part's kept text ends at its
  // last whole character (a UTF-16 cut keeps whole code units; a decoder in streaming mode holds back a character cut
  // in two, in any multi-byte charset), so it does not end in a replacement character the full part does not have.
  const truncated: ParsedMessage["truncated"] = [];
  let budget = BODY_TOTAL_LIMIT;
  const bound = (full: Uint8Array, mediaType: string, charset: string) => {
    let kept = Math.min(full.byteLength, BODY_PART_LIMIT, budget);
    if (charset.startsWith("utf-16")) kept -= kept % 2;
    budget -= kept;
    if (kept < full.byteLength && truncated.length < KEPT_PARTS_LIMIT)
      truncated.push({ mediaType, charset, full, keptBytes: kept });
    return { kept: full.subarray(0, kept), cut: kept < full.byteLength };
  };
  const decodeBound = ({ kept, cut }: { kept: Uint8Array; cut: boolean }, charset: string) =>
    new TextDecoder(charset).decode(kept, { stream: cut });
  // A string stream's text without the terminating NULs some writers leave in it.
  const textOf = (entry: CfbEntry, mediaType: string, charset: string) =>
    decodeBound(bound(file.read(entry), mediaType, charset), charset).replace(/\0+$/, "");
  let text = textEntry?.size
    ? textOf(textEntry, "text/plain", keyOf(textEntry) === TEXT_UNICODE ? "utf-16le" : ansiLabel)
    : null;
  let html: string | null = null;
  if (htmlBytes) {
    // The HTML's own code page (PidTagInternetCodepage), UTF-8 when it names none.
    const charset = data.internetCodepage === undefined ? "utf-8" : codepageLabel(data.internetCodepage);
    html = decodeBound(bound(htmlBytes, "text/html", charset), charset);
  } else if (htmlString?.size) {
    html = textOf(htmlString, "text/html", keyOf(htmlString) === HTML_UNICODE ? "utf-16le" : ansiLabel);
  }
  // A body held only as compressed RTF (D01 T01 §13): decompressed within the same limits and read as the
  // HTML it encapsulates, else as plain text, through the same byte budget. A stream that lies, fails its
  // checksum or is not RTF refuses the message; a well-formed one with no text leaves the body empty.
  if (!text && !html && data.compressedRtf?.length) {
    const rtf = decompressRtf(data.compressedRtf, BODY_TOTAL_LIMIT);
    if (!new TextDecoder().decode(rtf.subarray(0, 5)).startsWith("{\\rtf"))
      throw new ParseError("the .msg's compressed RTF does not hold an RTF body");
    const encapsulated = rtfToHtml(rtf, ansiLabel);
    if (encapsulated !== null) {
      html = decodeBound(bound(new TextEncoder().encode(encapsulated), "text/html", "utf-8"), "utf-8");
    } else {
      const plain = rtfToText(rtf, ansiLabel);
      if (plain) text = decodeBound(bound(new TextEncoder().encode(plain), "text/plain", "utf-8"), "utf-8");
    }
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
    const displayName = optionalString(field.name, "attachment display name")?.trim();
    const contentId = optionalString(field.pidContentId, "attachment content id")?.trim()
      ? `<${(field.pidContentId as string).trim().replace(/^<|>$/g, "")}>`
      : null;
    attachments.push({
      // An embedded message's name is its display name (PidTagDisplayName) with ".msg", as Outlook saves it; msgreader's
      // own export name reads "undefined.msg" when there is none, so it is not used.
      filename: name || (embedded && displayName ? `${displayName}.msg` : null),
      mediaType: embedded
        ? "application/vnd.ms-outlook"
        : optionalString(field.attachMimeTag, "attachment type")?.trim().toLowerCase() || "application/octet-stream",
      contentId,
      disposition: contentId ? "inline" : "attachment",
      // An Outlook attachment carries no charset parameter: its bytes are read by their own marks (D02 T05 §2).
      charset: null,
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
    // Its own subject and From identity, which the report header reads when there are no transport headers (D01 T01 §16).
    sender: { subject: subject ?? null, ...fromIdentity(file, data, ansiLabel) },
  };
}

// The message's From as Outlook keeps it: the sent-representing properties ([MS-OXCMAIL] 2.2.3.2.3 maps From to them),
// which differ from the Sender ones when a delegate sent on another's behalf (round 1); the Sender group only when the
// file has none of them, as a message sent in its own name may. The SMTP address when there is one (an Exchange
// mailbox's own address is an X.500 name, which reads as none).
function fromIdentity(
  file: CompoundFile,
  data: Fields,
  ansiLabel: string,
): { name: string | null; address: string | null } {
  const text = (id: string) => {
    const entry = rootProperty(file, `${id}001f`) ?? rootProperty(file, `${id}001e`);
    if (!entry) return null;
    const unicode = keyOf(entry)?.endsWith("001f");
    const value = new TextDecoder(unicode ? "utf-16le" : ansiLabel).decode(file.read(entry)).replace(/\0+$/, "");
    return value.trim() ? value : null;
  };
  const representing = {
    name: text(SENT_REPRESENTING_NAME),
    address: optionalString(data.sentRepresentingSmtpAddress, "From address") ?? text(SENT_REPRESENTING_EMAIL) ?? null,
  };
  if (representing.name || representing.address) return representing;
  return {
    name: optionalString(data.senderName, "sender name") ?? null,
    address:
      optionalString(data.senderSmtpAddress, "sender address") ??
      optionalString(data.senderEmail, "sender address") ??
      null,
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
