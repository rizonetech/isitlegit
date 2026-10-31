// An Office Open XML document's text, for the instruction phrases (D02 T05 §4; ECMA-376): a Word document's body,
// headers, footers, notes and comments; a workbook's shared strings and every worksheet's inline strings; a
// presentation's slides and notes. Read through the bounded ZIP reading of D02 T04 (`zipEntriesFrom`, `memberData`),
// every member's bytes, stored or deflated, counted against one expansion budget. The text is assembled as it is read:
// the runs of a paragraph join without a space, a tab or a break is a space or a line, and each paragraph, cell, row
// and slide ends a line. What could not be read is named, never dropped.
import {
  type Budget,
  bufferSource,
  MAX_EXPANDED_BYTES,
  MemberDamaged,
  memberData,
  type ZipEntry,
  zipEntriesFrom,
} from "./attachment-risk";

// A member is read whole, at most this much of it.
export const MAX_XML_BYTES = 4 * 1024 * 1024;

export type DocumentText = { text: string; unread: string[] };

// The parts that hold text a reader sees, in reading order.
const PARTS: readonly RegExp[] = [
  /^word\/document\.xml$/,
  /^word\/(?:header|footer)\d*\.xml$/,
  /^word\/(?:footnotes|endnotes|comments)\.xml$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/worksheets\/sheet\d+\.xml$/,
  /^ppt\/slides\/slide\d+\.xml$/,
  /^ppt\/notesSlides\/notesSlide\d+\.xml$/,
];
const order = (name: string) => PARTS.findIndex((p) => p.test(name));
const numbered = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

// Text elements (`w:t`, `t`, `a:t`) by local name; the elements that end a line, and those that are a space.
const TEXT = new Set(["t"]);
const LINE_END = new Set(["p", "tr", "si", "row", "c", "sld", "notes", "txBody"]);
const SPACE = new Set(["tab"]);
const BREAK = new Set(["br", "cr"]);

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decodeEntities(text: string): string | null {
  let bad = false;
  const out = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, name: string) => {
    if (!match.endsWith(";")) {
      bad = true;
      return match;
    }
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        bad = true;
        return "";
      }
      return String.fromCodePoint(code);
    }
    const value = ENTITY[name];
    if (value === undefined) bad = true;
    return value ?? "";
  });
  return bad ? null : out;
}

// A part's characters by its encoding: a byte order mark, or UTF-16 told by its first `<` (XML 1.0 appendix F), else
// UTF-8 (completion review: a UTF-16 part read as UTF-8 lost its text silently).
function decodeXml(data: Uint8Array): string {
  const [a, b] = [data[0], data[1]];
  if (a === 0xff && b === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (a === 0xfe && b === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  if (a === 0x3c && b === 0x00) return new TextDecoder("utf-16le").decode(data);
  if (a === 0x00 && b === 0x3c) return new TextDecoder("utf-16be").decode(data);
  return new TextDecoder().decode(data);
}

// One part's text: the character data of its text elements, with the line and space rules above; `ok` false when the
// XML did not hold (an unclosed tag, an entity that is not one), with what was read before it kept.
export function xmlText(xml: string): { text: string; ok: boolean } {
  let text = "";
  let lastAdded = "";
  let inText = 0;
  let at = 0;
  // The open elements, so a close that does not match is caught (completion review: only text elements were tracked).
  const nesting: string[] = [];
  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    const chunk = open < 0 ? xml.slice(at) : xml.slice(at, open);
    if (inText > 0 && chunk) {
      const decoded = decodeEntities(chunk);
      if (decoded === null) return { text, ok: false };
      text += decoded;
      if (decoded) lastAdded = decoded[decoded.length - 1] as string;
    }
    if (open < 0) break;
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open);
      if (end < 0) return { text, ok: false };
      if (inText > 0 && end > open + 9) {
        text += xml.slice(open + 9, end);
        lastAdded = xml[end - 1] as string;
      }
      at = end + 3;
      continue;
    }
    if (xml.startsWith("<!--", open) || xml.startsWith("<?", open) || xml.startsWith("<!", open)) {
      const close = xml.startsWith("<!--", open) ? "-->" : ">";
      const end = xml.indexOf(close, open);
      if (end < 0) return { text, ok: false };
      at = end + close.length;
      continue;
    }
    const end = xml.indexOf(">", open);
    if (end < 0) return { text, ok: false };
    const tag = xml.slice(open + 1, end);
    const closing = tag.startsWith("/");
    const selfClosing = tag.endsWith("/");
    const qname = (closing ? tag.slice(1) : tag).split(/[\s/]/)[0] ?? "";
    const local = qname.includes(":") ? qname.slice(qname.indexOf(":") + 1) : qname;
    if (closing) {
      if (nesting.pop() !== qname) return { text, ok: false };
    } else if (!selfClosing && nesting.length < 10_000) nesting.push(qname);
    if (TEXT.has(local) && !selfClosing) inText += closing ? -1 : 1;
    if (inText < 0) return { text, ok: false };
    if (!closing && SPACE.has(local)) {
      text += " ";
      lastAdded = " ";
    }
    if (!closing && BREAK.has(local)) {
      text += "\n";
      lastAdded = "\n";
    }
    // Whether the text ends a line, by the last character added: asking a string built by `+=` for its end flattens
    // it each time, which is quadratic on a long part.
    if ((closing || selfClosing) && LINE_END.has(local) && lastAdded !== "\n") {
      text += "\n";
      lastAdded = "\n";
    }
    at = end + 1;
  }
  return { text, ok: inText === 0 && nesting.length === 0 };
}

// The document's text from its bytes, and what of it was not read. Throws `Unreadable` (from the ZIP reader) when the
// archive itself cannot be read; a storage failure cannot happen here, the bytes being in memory.
export async function ooxmlText(
  bytes: Uint8Array,
  budget: Budget = { members: 0, expanded: 0 },
): Promise<DocumentText> {
  const src = bufferSource(bytes);
  const entries = await zipEntriesFrom(src);
  const parts = entries
    .map((entry) => ({ entry, name: entry.names[0] ?? "" }))
    .filter(({ name }) => order(name) >= 0)
    .sort((a, b) => order(a.name) - order(b.name) || numbered(a.name, b.name));
  const unread: string[] = [];
  let text = "";
  for (const { entry, name } of parts) {
    const data = await partBytes(src, entry, budget);
    if (typeof data === "string") {
      unread.push(`${name}: ${data}`);
      continue;
    }
    const read = xmlText(decodeXml(data));
    text += read.text.endsWith("\n") || read.text === "" ? read.text : `${read.text}\n`;
    if (!read.ok) unread.push(`${name}: its XML could not be read past a point`);
  }
  return { text, unread };
}

// A part's bytes, or why they were not read. A stored part is counted against the budget as a deflated one is
// (`memberData` counts only what it inflates), so stored members cannot pass the bound together.
async function partBytes(
  src: ReturnType<typeof bufferSource>,
  entry: ZipEntry,
  budget: Budget,
): Promise<Uint8Array | string> {
  if (entry.encrypted) return "it is encrypted";
  if (entry.method === 0) {
    if (budget.expanded + entry.compressed > MAX_EXPANDED_BYTES) return "the document's expansion limit was reached";
    if (entry.compressed > MAX_XML_BYTES) return "it is larger than is read";
  }
  let data: Uint8Array | "budget" | "short" | null;
  try {
    data = await memberData(src, entry, MAX_XML_BYTES + 1, budget, MAX_XML_BYTES);
  } catch (error) {
    if (error instanceof MemberDamaged) return "it is damaged";
    throw error;
  }
  if (data === null) return "it is compressed by a method that is not read";
  if (data === "budget") return "the document's expansion limit was reached";
  if (data === "short" || data.length > MAX_XML_BYTES) return "it is larger than is read";
  if (entry.method === 0) budget.expanded += data.length;
  return data;
}
