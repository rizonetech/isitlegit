// Macros, encrypted archives and executables in attachments (D02 T04 §3; spec 4.3 and 4.6, malware-type attachments set
// the deterministic floor). The Workflow's `checks` step reads each attachment's structure by bounded R2 reads and puts
// what it found in the view (`attachmentRisks`); three checks map it to items. A structure that cannot be read is said to
// be not checked, never taken as clean; a storage error is thrown, so the step is retried.

import { readCompoundFile } from "../intake/cfb";
import { ParseError } from "../intake/mime";
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { decodeLzma, LzmaError } from "./lzma";
import type { CheckRegistry } from "./registry";
import { oleObject, packagedFile, rtfObjects } from "./rtf";
import { SNIFF_BYTES, sniff } from "./sniff";

export const MAX_RISK_ATTACHMENTS = 20;
export const MAX_OLE_BYTES = 10 * 1024 * 1024;
export const MAX_DIRECTORY_BYTES = 1024 * 1024;
export const MAX_RAR_HEADERS = 1_000;
export const MAX_RAR_READS = 64;
export const MAX_RAR_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 10;

export type RiskKind = "macro" | "encrypted" | "executable";
// `by` says what established the finding, for an honest summary (completion review): the bytes, a structure inside the
// file, or only its name.
export type RiskFinding = {
  kind: RiskKind;
  where: string;
  how: string;
  by: "bytes" | "structure" | "name";
  type?: string;
};
// `nested` names archives inside an archive, which are not opened (completion review: named, never silently skipped).
export type AttachmentRisk = {
  key: string;
  filename: string;
  findings: RiskFinding[];
  notChecked: string | null;
  nested: string[];
  // A RAR, 7z or CAB archive: what is read of it (a RAR or 7z's encryption) leaves its members' names unread, so the
  // macro and program checks have not looked inside it (D02 T01 §3's round 3).
  membersUnread?: true;
  // A ZIP's members not read by their content (D02 T04 §8): damaged, encrypted, another method, or past a bound.
  membersNotRead?: number;
  // An RTF document's embedded objects not read (D02 T04 §9): damaged, linked, past a bound, or of a kind not read.
  objectsNotRead?: number;
};
export type AttachmentRisks = { items: AttachmentRisk[]; unread: number };

// Names that run code when opened (spec 4.3), and the macro-enabled Office names (ECMA-376).
const EXECUTABLE_NAMES = new Set([
  "exe",
  "scr",
  "com",
  "pif",
  "bat",
  "cmd",
  "js",
  "jse",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "ps1",
  "hta",
  "lnk",
  "iso",
  "img",
  "msi",
  "jar",
  "cpl",
]);
const MACRO_NAMES = new Set(["docm", "xlsm", "pptm", "dotm", "xltm", "potm", "xlam", "ppam", "sldm"]);
const EXECUTABLE_BYTES = new Set(["pe", "elf", "macho", "lnk", "script", "iso"]);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name
        .slice(dot + 1)
        .trim()
        .toLowerCase()
    : "";
};
const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 2 ** 32;

export class Unreadable extends Error {}

async function range(bucket: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new Unreadable("the attachment is missing");
  return new Uint8Array(await object.arrayBuffer());
}

// A ZIP's central directory entries (APPNOTE 4.3.12): each name and whether it is encrypted (general purpose bit 0). The
// directory must hold exactly the entries its end record counts, each whole (completion review: no damaged directory
// reads as an empty one).
// A member as the central directory gives it: its names, whether its own flag marks it encrypted, and where its data
// lies (method, compressed size, local header offset), for a member whose content is read (OpenDocument's manifest).
export type ZipEntry = { names: string[]; encrypted: boolean; method: number; compressed: number; offset: number };
export const MAX_MANIFEST_BYTES = 64 * 1024;

// A member's content, stored or deflated, at most MAX_MANIFEST_BYTES each way; null when it cannot be read so.
// A member read whole, at most MAX_MANIFEST_BYTES, from any byte source: an attachment's R2 ranges or a nested ZIP in
// memory (round 1: a nested OpenDocument package's manifest is read as the attachment's is).
async function memberBytes(src: Source, entry: ZipEntry): Promise<Uint8Array | null> {
  const size = src.size;
  if (entry.compressed > MAX_MANIFEST_BYTES || entry.offset === 0xffffffff || entry.offset + 30 > size) return null;
  const local = await src.read(entry.offset, 30);
  if (local.length < 30 || u32(local, 0) !== 0x04034b50) return null;
  const start = entry.offset + 30 + u16(local, 26) + u16(local, 28);
  if (start + entry.compressed > size) return null;
  const data = await src.read(start, entry.compressed);
  if (entry.method === 0) return data;
  if (entry.method !== 8) return null;
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANIFEST_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// Archive members read by their content (D02 T04 §8): each member's first SNIFF_BYTES sniffed for a program, and a
// ZIP inside a ZIP opened one level down, within bounds shared by both levels of one attachment. A member that cannot be
// read (damaged, encrypted, another method, past a bound) is counted, never taken as clean; an R2 failure throws.
export const MAX_MEMBERS_READ = 200;
export const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
export const MAX_NESTED_BYTES = 8 * 1024 * 1024;
export const MAX_MEMBER_PACKED_BYTES = 1024 * 1024;
// What sniff() calls a ZIP container: a plain ZIP, an Office Open XML file, an OpenDocument file (completion review).
const ZIP_CONTAINERS = new Set(["zip", "docx", "xlsx", "pptx", "ooxml", "odf"]);
export type Budget = { members: number; expanded: number };
export class MemberDamaged extends Error {}

// Up to `want` bytes inflated from `packed`, each byte counted against the attachment's budget; "budget" when the
// budget runs out first. `cut`: the packed bytes are a prefix of the member's data, so a stream that stops at the
// prefix's end is not damaged, but what it gave is not the member's first `want` bytes either: "short", counted as
// not read (round 1: empty deflate blocks can push a program's bytes past the prefix).
export async function inflate(
  packed: Uint8Array,
  want: number,
  budget: Budget,
  cut: boolean,
): Promise<Uint8Array | "budget" | "short"> {
  // The input fed in 64 KiB pieces as the output is read, so reading stops at `want` before a cut prefix's end is
  // reached: a stream that errors discards the output it had queued (WHATWG Streams), so a prefix given whole would
  // lose bytes it holds (round 1).
  let fed = 0;
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (fed >= packed.length) return controller.close();
        controller.enqueue(packed.slice(fed, fed + 65_536));
        fed += 65_536;
      },
    },
    { highWaterMark: 0 },
  );
  const reader = input.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < want) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.expanded += value.byteLength;
      if (budget.expanded > MAX_EXPANDED_BYTES) return "budget";
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    if (!cut) throw new MemberDamaged("its deflated data is damaged");
    if (total < want) return "short";
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, want));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= out.length) break;
    out.set(chunk.subarray(0, out.length - at), at);
    at += chunk.byteLength;
  }
  return out;
}

// A member's first `want` bytes (stored, or deflated from at most `packedLimit` of its data); null for a method this
// does not read; "budget" past the attachment's expansion bound; MemberDamaged when its headers or data do not hold.
export async function memberData(
  src: Source,
  entry: ZipEntry,
  want: number,
  budget: Budget,
  packedLimit: number,
): Promise<Uint8Array | "budget" | "short" | null> {
  if (entry.method !== 0 && entry.method !== 8) return null;
  if (entry.offset === 0xffffffff || entry.offset + 30 > src.size)
    throw new MemberDamaged("its header is past the end");
  const local = await src.read(entry.offset, 30);
  if (local.length < 30 || u32(local, 0) !== 0x04034b50) throw new MemberDamaged("its local header is missing");
  const start = entry.offset + 30 + u16(local, 26) + u16(local, 28);
  if (start + entry.compressed > src.size) throw new MemberDamaged("its data runs past the end");
  // An empty member (a directory, an empty file) has nothing to read; R2 refuses a range of no bytes.
  if (entry.compressed === 0) return new Uint8Array(0);
  if (entry.method === 0) return src.read(start, Math.min(entry.compressed, want));
  // The budget spent: no further member is inflated (completion review), so a long tail of members costs no work.
  if (budget.expanded >= MAX_EXPANDED_BYTES) return "budget";
  const length = Math.min(entry.compressed, packedLimit);
  return inflate(await src.read(start, length), want, budget, length < entry.compressed);
}

// One archive's members by their content, and a ZIP among them opened one level down (depth 2 at most). `where` names
// the archive as the finding gives it; the count returned is the members not read.
async function memberContents(
  src: Source,
  entries: ZipEntry[],
  where: string,
  depth: number,
  budget: Budget,
  add: (f: RiskFinding) => void,
  nested: string[],
): Promise<number> {
  let notRead = 0;
  for (const entry of entries) {
    const member = entry.names[0] ?? "";
    if (member.endsWith("/")) continue;
    if (entry.encrypted || budget.members >= MAX_MEMBERS_READ) {
      notRead++;
      continue;
    }
    budget.members++;
    let head: Uint8Array | "budget" | "short" | null;
    try {
      head = await memberData(src, entry, SNIFF_BYTES, budget, MAX_MEMBER_PACKED_BYTES);
    } catch (error) {
      if (!(error instanceof MemberDamaged)) throw error;
      notRead++;
      continue;
    }
    if (head === null || head === "budget" || head === "short") {
      notRead++;
      continue;
    }
    const path = `${where} > ${member}`;
    const type = sniff(head);
    if (type && EXECUTABLE_BYTES.has(type))
      add({ kind: "executable", where: path, how: `its contents (${type})`, by: "bytes", type });
    const inside = path.slice(path.indexOf(" > ") + 3);
    // A RAR, 7z or CAB known by its bytes, whatever its name: named, not opened (completion reviews).
    if (type === "rar" || type === "7z" || type === "cab") {
      if (nested.length < MAX_FINDINGS && !nested.includes(inside)) nested.push(inside);
      continue;
    }
    // An RTF member's embedded objects are read as an attached RTF's are, one level down and within the same budget;
    // one at the second level is counted as not read (§9's round 2: a packaged ZIP's RTF was skipped unread).
    if (type === "rtf") {
      if (depth >= 2) {
        notRead++;
        continue;
      }
      let doc: Uint8Array | "budget" | "short" | null;
      try {
        doc = await memberData(src, entry, MAX_NESTED_BYTES + 1, budget, MAX_NESTED_BYTES);
      } catch (error) {
        if (!(error instanceof MemberDamaged)) throw error;
        doc = null;
      }
      if (doc === null || doc === "budget" || doc === "short" || doc.length > MAX_NESTED_BYTES) {
        notRead++;
        continue;
      }
      const read = await rtfContents(doc, path, add, nested, depth + 1, budget);
      notRead += read.objects + read.members;
      continue;
    }
    // A legacy Office file (a compound file, `.doc`, `.xls`, whatever its name) is read for a VBA project as an attached
    // one is, within the member bounds; one that cannot be read whole is counted as not read (D02 T04 §8's round 4:
    // a macro-bearing .doc in a ZIP passed with full coverage).
    if (type === "ole") {
      let file: Uint8Array | "budget" | "short" | null;
      try {
        file = await memberData(src, entry, MAX_OLE_BYTES + 1, budget, MAX_OLE_BYTES);
      } catch (error) {
        if (!(error instanceof MemberDamaged)) throw error;
        file = null;
      }
      if (file === null || file === "budget" || file === "short" || file.length > MAX_OLE_BYTES) {
        notRead++;
        continue;
      }
      try {
        if (oleMacros(file)) add({ kind: "macro", where: path, how: "a VBA project in the file", by: "structure" });
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        notRead++;
      }
      continue;
    }
    // A ZIP inside, an Office or OpenDocument file among them (each is a ZIP): opened when this is the first level
    // and it fits; otherwise named, not opened. A member named .zip whose bytes are not a ZIP that begins at its first
    // byte (text or other bytes in front of one, which a ZIP reader still extracts) is not opened either, so it is named:
    // its name is the one reason the unopened-archive warning leaves .zip out (D02 T04 §8's round 2).
    if (!type || !ZIP_CONTAINERS.has(type)) {
      // Any name the member answers to, its Unicode Path name among them (an unpacker shows that one).
      const zipName = entry.names.find((n) => extensionOf(n.split("/").pop() ?? n) === "zip");
      if (zipName !== undefined) {
        const named = `${inside.slice(0, inside.length - member.length)}${zipName}`;
        if (nested.length < MAX_FINDINGS && !nested.includes(named)) nested.push(named);
      }
      continue;
    }
    if (depth >= 2) {
      if (nested.length < MAX_FINDINGS) nested.push(inside);
      continue;
    }
    let whole: Uint8Array | "budget" | "short" | null;
    try {
      whole = await memberData(src, entry, MAX_NESTED_BYTES + 1, budget, MAX_NESTED_BYTES);
    } catch (error) {
      if (!(error instanceof MemberDamaged)) throw error;
      whole = null;
    }
    if (whole === null || whole === "budget" || whole === "short" || whole.length > MAX_NESTED_BYTES) {
      if (nested.length < MAX_FINDINGS) nested.push(inside);
      continue;
    }
    const inner = bufferSource(whole);
    let innerEntries: ZipEntry[];
    try {
      innerEntries = await zipEntriesFrom(inner);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      notRead++;
      continue;
    }
    entryNames(innerEntries, path, add, nested);
    notRead += await packageManifest(inner, innerEntries, type, path, add);
    notRead += await memberContents(inner, innerEntries, path, depth + 1, budget, add, nested);
  }
  return notRead;
}

// A nested OpenDocument package's password protection is in its manifest, as the attachment's is (round 1): 1 when
// the manifest cannot be read (counted as not read), 0 otherwise, an encrypted package said to be one.
async function packageManifest(
  src: Source,
  entries: ZipEntry[],
  type: string,
  where: string,
  add: (f: RiskFinding) => void,
): Promise<number> {
  const manifest = entries.find((e) => e.names.includes("META-INF/manifest.xml"));
  if (type !== "odf" && !manifest) return 0;
  const bytes = manifest ? await memberBytes(src, manifest) : null;
  const encrypted = bytes ? manifestEncrypted(bytes) : null;
  if (encrypted === null) return 1;
  if (encrypted) add({ kind: "encrypted", where, how: "a password-protected OpenDocument file", by: "structure" });
  return 0;
}

// An RTF document's embedded objects (D02 T04 §9), read without opening or running them: each `\objdata` decoded as
// an OLE 1.0 object, a `Package` object's packaged file read by its name and its bytes, any object's bytes read as an
// attachment's are (a program by its bytes, a compound file's VBA project, a ZIP container opened as a nested ZIP).
// The count returned is the objects not read: damaged, linked, past a bound, or of a kind not read.
export const MAX_RTF_BYTES = 16 * 1024 * 1024;
async function rtfContents(
  doc: Uint8Array,
  name: string,
  add: (f: RiskFinding) => void,
  nested: string[],
  depth = 1,
  budget: Budget = { members: 0, expanded: 0 },
): Promise<{ objects: number; members: number }> {
  const { objects, more } = rtfObjects(doc);
  let notRead = more;
  let members = 0;
  for (const [index, object] of objects.entries()) {
    const ole = "bytes" in object ? oleObject(object.bytes) : null;
    if (ole === null || ole === "linked") {
      notRead++;
      continue;
    }
    const packaged = ole.className.toLowerCase() === "package" ? packagedFile(ole.data) : null;
    if (ole.className.toLowerCase() === "package" && !packaged) {
      notRead++;
      continue;
    }
    const where = `${name} > object ${index + 1}${packaged ? ` (${packaged.name})` : ""}`;
    if (packaged) {
      // Its name, and the source and temporary paths it is written to and opened from (round 1).
      const exts = new Set(
        [packaged.name, packaged.sourcePath, packaged.tempPath]
          .map((path) => path.split(/[\\/]/).pop() ?? "")
          .filter(Boolean)
          .map(extensionOf),
      );
      for (const ext of exts) {
        if (EXECUTABLE_NAMES.has(ext))
          add({ kind: "executable", where, how: `its name (.${ext})`, by: "name", type: ext });
        if (MACRO_NAMES.has(ext)) add({ kind: "macro", where, how: `its name (.${ext})`, by: "name" });
      }
    }
    const bytes = packaged ? packaged.data : ole.data;
    const type = sniff(bytes.subarray(0, SNIFF_BYTES));
    if (type && EXECUTABLE_BYTES.has(type))
      add({ kind: "executable", where, how: `its contents (${type})`, by: "bytes", type });
    if (type === "ole") {
      try {
        if (oleMacros(bytes))
          add({ kind: "macro", where, how: "a VBA project in the embedded document", by: "structure" });
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        notRead++;
      }
    } else if (type && ZIP_CONTAINERS.has(type)) {
      // A ZIP in an object is one level below this document; past the second level it is counted, not opened. The
      // levels are shared with ZIPs and RTFs alike, so no chain of them recurses without end (round 2).
      if (depth >= 2) {
        notRead++;
        continue;
      }
      const inner = bufferSource(bytes);
      let entries: ZipEntry[];
      try {
        entries = await zipEntriesFrom(inner);
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        notRead++;
        continue;
      }
      entryNames(entries, where, add, nested);
      members += await packageManifest(inner, entries, type, where, add);
      members += await memberContents(inner, entries, where, depth + 1, budget, add, nested);
    } else if (type === "rtf") {
      // An RTF inside an object is read as the document is, one level down and within the same budget; one deeper is
      // counted as not read (round 1: a packaged RTF was taken as read).
      if (depth >= 2) notRead++;
      else {
        const inner = await rtfContents(bytes, where, add, nested, depth + 1, budget);
        notRead += inner.objects;
        members += inner.members;
      }
    } else if (type === "rar" || type === "7z" || type === "cab") notRead++;
  }
  return { objects: notRead, members };
}

// Whether an OpenDocument manifest marks any entry encrypted (ODF 1.3 part 2, 3.8): read as XML, not as text (round 1):
// in its own encoding (a byte order mark, UTF-16 by its first bytes, or the declaration's), its comments, CDATA and
// processing instructions removed, and an `encryption-data` element found. Null when it cannot be decoded.
export function manifestEncrypted(bytes: Uint8Array): boolean | null {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes[0] === 0x3c && bytes[1] === 0x00) encoding = "utf-16le";
  else if (bytes[0] === 0x00 && bytes[1] === 0x3c) encoding = "utf-16be";
  else {
    const declared = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(
      new TextDecoder("latin1").decode(bytes.subarray(0, 200)),
    )?.[1];
    if (declared) encoding = declared;
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  // Comments, CDATA and processing instructions removed, each by one forward search (linear).
  let plain = "";
  for (let at = 0; at < text.length; ) {
    const next = text.indexOf("<", at);
    if (next < 0) {
      plain += text.slice(at);
      break;
    }
    plain += text.slice(at, next);
    const close = text.startsWith("<!--", next)
      ? "-->"
      : text.startsWith("<![CDATA[", next)
        ? "]]>"
        : text.startsWith("<?", next)
          ? "?>"
          : null;
    if (!close) {
      plain += "<";
      at = next + 1;
      continue;
    }
    const end = text.indexOf(close, next + 2);
    at = end < 0 ? text.length : end + close.length;
  }
  // The element by its local name under any prefix, or none (round 2: a namespace spelled with a character reference,
  // or bound to a Unicode prefix, defeated matching the declaration as text). `encryption-data` is the manifest's
  // element for an encrypted entry and nothing else, so this errs only towards saying a document is protected. The
  // prefix stops at `<`, so the names tried never overlap and the scan is linear.
  return /<(?:[^\s/>:!?<]+:)?encryption-data[\s/>]/.test(plain);
}

// Where an archive's bytes come from (D02 T04 §8): R2's ranges for an attachment, a buffer for a ZIP read out of one.
export type Source = { size: number; read: (offset: number, length: number) => Promise<Uint8Array> };
const r2Source = (bucket: R2Bucket, key: string, size: number): Source => ({
  size,
  read: (offset, length) => range(bucket, key, offset, length),
});
export const bufferSource = (bytes: Uint8Array): Source => ({
  size: bytes.length,
  read: async (offset, length) => bytes.subarray(offset, offset + length),
});

const zipEntries = (bucket: R2Bucket, key: string, size: number) => zipEntriesFrom(r2Source(bucket, key, size));

export async function zipEntriesFrom(src: Source): Promise<ZipEntry[]> {
  const size = src.size;
  if (size < 22) throw new Unreadable("it is too short to be a ZIP archive");
  const tailStart = Math.max(0, size - 65_557);
  const tail = await src.read(tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Unreadable("its central directory was not found");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64 (APPNOTE 4.3.14, 4.3.15): the locator just before the record names the ZIP64 end record.
    const locator = eocd - 20;
    if (locator < 0 || u32(tail, locator) !== 0x07064b50) throw new Unreadable("its ZIP64 directory was not found");
    const record = u64(tail, locator + 8);
    if (record + 56 > size) throw new Unreadable("its ZIP64 directory points past its end");
    const z64 = await src.read(record, 56);
    if (z64.length < 56 || u32(z64, 0) !== 0x06064b50) throw new Unreadable("its ZIP64 directory was not found");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  if (cdSize > MAX_DIRECTORY_BYTES) throw new Unreadable("its directory is larger than is read");
  if (cdOffset + cdSize > size) throw new Unreadable("its directory points past its end");
  const cd = cdSize ? await src.read(cdOffset, cdSize) : new Uint8Array(0);
  if (cd.length !== cdSize) throw new Unreadable("its directory is truncated");
  const entries: ZipEntry[] = [];
  let at = 0;
  while (at < cd.length) {
    if (at + 46 > cd.length || u32(cd, at) !== 0x02014b50) throw new Unreadable("its directory is malformed");
    const nameLength = u16(cd, at + 28);
    const end = at + 46 + nameLength + u16(cd, at + 30) + u16(cd, at + 32);
    if (end > cd.length) throw new Unreadable("its directory is truncated");
    const raw = cd.subarray(at + 46, at + 46 + nameLength);
    const names = [new TextDecoder().decode(raw)];
    // The Unicode Path extra field (APPNOTE 4.6.9, 0x7075): another name for the member, which unpackers show; taken
    // when its CRC matches the legacy name, as the note asks (round 1: `invoice.pdf` hiding `invoice.pdf.exe`).
    const extraEnd = at + 46 + nameLength + u16(cd, at + 30);
    let legacyCrc: number | undefined;
    for (let x = at + 46 + nameLength; x + 4 <= extraEnd; ) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (x + 4 + len > extraEnd) break;
      if (id === 0x7075 && len >= 5 && cd[x + 4] === 1) {
        // The legacy name's CRC once per member, however many fields repeat it (round 2).
        if (legacyCrc === undefined) legacyCrc = crc32(raw);
        if (u32(cd, x + 5) === legacyCrc) names.push(new TextDecoder().decode(cd.subarray(x + 9, x + 4 + len)));
      }
      x += 4 + len;
    }
    entries.push({
      names,
      encrypted: (u16(cd, at + 8) & 1) === 1,
      method: u16(cd, at + 10),
      compressed: u32(cd, at + 20),
      offset: u32(cd, at + 42),
    });
    at = end;
  }
  if (entries.length !== count) throw new Unreadable("its directory does not hold the entries it counts");
  return entries;
}

// CRC-32 (ISO-HDLC, as ZIP uses it), for the Unicode Path field's check.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// An OLE compound file's macro storage or stream (MS-OVBA 2.2): `Macros`, `_VBA_PROJECT_CUR` or `_VBA_PROJECT`.
function oleMacros(bytes: Uint8Array): boolean {
  let file: ReturnType<typeof readCompoundFile>;
  try {
    file = readCompoundFile(bytes);
  } catch (error) {
    if (error instanceof ParseError) throw new Unreadable("it is not a readable compound file");
    throw error;
  }
  return file.entries.some((e) => /^(macros|_vba_project_cur|_vba_project)$/i.test(e.name));
}

// A RAR5 variable-length integer (RAR 5 technote): its value and length.
function vint(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 10; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw new Unreadable("a header is truncated");
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  throw new Unreadable("a header number is malformed");
}

// A window over an attachment that reads ahead in 64 KiB pieces and serves headers from what it holds, so a run of small
// members costs one read, not one read each (completion review), within MAX_RAR_READS and MAX_RAR_BYTES.
class Window {
  start = 0;
  bytes: Uint8Array = new Uint8Array(0);
  reads = 0;
  read = 0;
  constructor(
    private bucket: R2Bucket,
    private key: string,
    private size: number,
  ) {}
  // At least `length` bytes from `at` (fewer only at the end of the file); null when the caps are reached.
  async at(at: number, length: number): Promise<Uint8Array | null> {
    const held = at >= this.start && at + length <= this.start + this.bytes.length;
    if (!held) {
      // Every request within what the budget has left (round 1: a declared 8 MiB header was read whole).
      const left = MAX_RAR_BYTES - this.read;
      if (this.reads >= MAX_RAR_READS || length > left) return null;
      const want = Math.min(Math.max(length, 64 * 1024), this.size - at, left);
      this.bytes = await range(this.bucket, this.key, at, want);
      this.start = at;
      this.reads++;
      this.read += this.bytes.length;
    }
    return this.bytes.subarray(at - this.start);
  }
}

// Whether a RAR archive is encrypted, walked header by header, each payload skipped by its validated length; null when
// the walk stopped at its caps before the end (not fully checked). A walk that runs past the end, or a RAR5 archive
// that ends without its end-of-archive header, is damaged (completion review).
async function rarEncrypted(bucket: R2Bucket, key: string, size: number, rar5: boolean): Promise<boolean | null> {
  const window = new Window(bucket, key, size);
  let at = rar5 ? 8 : 7;
  for (let headers = 0; headers < MAX_RAR_HEADERS; headers++) {
    if (at === size) {
      if (rar5) throw new Unreadable("the archive ends before its end header");
      return false;
    }
    if (at > size) throw new Unreadable("a member runs past the end of the archive");
    const head = await window.at(at, Math.min(32, size - at));
    if (!head) return null;
    if (rar5) {
      const [headerSize, sizeLength] = vint(head, 4);
      // The header size is at most three bytes long (RAR 5 technote), so at most 2 MiB.
      if (sizeLength > 3) throw new Unreadable("a header claims a size RAR does not allow");
      const block = 4 + sizeLength;
      if (at + block + headerSize > size) throw new Unreadable("a header runs past the end of the archive");
      const whole = await window.at(at, block + headerSize);
      if (!whole) return null;
      let p = block;
      const [type, tl] = vint(whole, p);
      p += tl;
      const [flags, fl] = vint(whole, p);
      p += fl;
      let extraSize = 0;
      let dataSize = 0;
      if (flags & 1) {
        const [v, l] = vint(whole, p);
        extraSize = v;
        p += l;
      }
      if (flags & 2) {
        const [v, l] = vint(whole, p);
        dataSize = v;
        p += l;
      }
      if (extraSize > headerSize) throw new Unreadable("a header's extra area is longer than the header");
      if (type === 4) return true;
      if (type === 5) return false;
      if ((type === 2 || type === 3) && extraSize > 0) {
        // The extra area ends the header: a record of type 1 is the file's encryption record.
        let r = block + headerSize - extraSize;
        while (r < block + headerSize) {
          const [recordSize, rl] = vint(whole, r);
          const [recordType] = vint(whole, r + rl);
          if (recordType === 1) return true;
          r += rl + recordSize;
        }
      }
      at += block + headerSize + dataSize;
    } else {
      if (head.length < 7) throw new Unreadable("a header is truncated");
      const type = head[2];
      const flags = u16(head, 3);
      const headerSize = u16(head, 5);
      if (headerSize < 7) throw new Unreadable("a header is malformed");
      if (type === 0x73 && flags & 0x0080) return true;
      if (type === 0x7b) return false;
      const whole = await window.at(at, Math.min(headerSize, size - at));
      if (!whole) return null;
      if (whole.length < headerSize) throw new Unreadable("a header runs past the end of the archive");
      if (type === 0x74 && flags & 0x0004) return true;
      let addSize = flags & 0x8000 ? u32(whole, 7) : 0;
      if (type === 0x74 && flags & 0x0100) addSize += u32(whole, 7 + 25) * 2 ** 32;
      at += headerSize + addSize;
    }
  }
  return null;
}

// A 7z NUMBER (7zFormat.txt): the first byte's leading one bits say how many bytes follow.
function number7z(b: Uint8Array, at: number): [number, number] {
  const first = b[at];
  if (first === undefined) throw new Unreadable("its header is truncated");
  let mask = 0x80;
  let extra = 0;
  while (extra < 8 && first & mask) {
    extra++;
    mask >>= 1;
  }
  let value = extra < 8 ? first & (mask - 1) : 0;
  let low = 0;
  for (let i = 0; i < extra; i++) {
    const byte = b[at + 1 + i];
    if (byte === undefined) throw new Unreadable("its header is truncated");
    low += byte * 2 ** (8 * i);
  }
  value = value * 2 ** (8 * extra) + low;
  return [value, 1 + extra];
}

// The coder IDs of a 7z StreamsInfo's folders (7zFormat.txt: PackInfo, then UnPackInfo's folders and their coders),
// parsed as records, never matched as loose bytes (completion review: a filename holding the AES ID is no coder).
function coders7z(b: Uint8Array, start: number): { ids: string[]; end: number | null } {
  const ids: string[] = [];
  let p = start;
  const num = () => {
    const [v, l] = number7z(b, p);
    p += l;
    return v;
  };
  const byte = () => {
    const v = b[p];
    if (v === undefined) throw new Unreadable("its header is truncated");
    p++;
    return v;
  };
  const skipBits = (count: number) => {
    const allDefined = byte();
    if (!allDefined) p += Math.ceil(count / 8);
  };
  for (;;) {
    const id = byte();
    if (id === 0x00) return { ids, end: p };
    if (id === 0x06) {
      // PackInfo: PackPos, NumPackStreams, then optional sizes (0x09) and CRCs (0x0A), ended by 0x00.
      num();
      const streams = num();
      for (let k = byte(); k !== 0x00; k = byte()) {
        if (k === 0x09) for (let i = 0; i < streams; i++) num();
        else if (k === 0x0a) {
          skipBits(streams);
          p += 4 * streams;
        } else throw new Unreadable("its header has an unknown pack record");
      }
    } else if (id === 0x07) {
      // UnPackInfo: kFolder, NumFolders, External (0 here), each folder's coders, then the unpack sizes and CRCs.
      if (byte() !== 0x0b) throw new Unreadable("its header has no folder record");
      const folders = num();
      if (folders > 1_000) throw new Unreadable("its header names more folders than are read");
      if (byte() !== 0x00) throw new Unreadable("its header keeps its folders elsewhere");
      let outputs = 0;
      for (let f = 0; f < folders; f++) {
        const coderCount = num();
        if (coderCount > 64) throw new Unreadable("a folder names more coders than are read");
        let inTotal = 0;
        let outTotal = 0;
        for (let c = 0; c < coderCount; c++) {
          const flags = byte();
          const idSize = flags & 0x0f;
          ids.push([...b.subarray(p, p + idSize)].map((x) => x.toString(16).padStart(2, "0")).join(""));
          p += idSize;
          let ins = 1;
          let outs = 1;
          if (flags & 0x10) {
            ins = num();
            outs = num();
          }
          inTotal += ins;
          outTotal += outs;
          if (flags & 0x20) {
            // The size first: `p += num()` would read p before num() moves it.
            const propertiesSize = num();
            p += propertiesSize;
          }
        }
        // Bind pairs (NumOutStreams - 1 of them) and the packed streams' indexes when more than one.
        for (let i = 0; i < outTotal - 1; i++) {
          num();
          num();
        }
        const packed = inTotal - (outTotal - 1);
        if (packed > 1) for (let i = 0; i < packed; i++) num();
        outputs += outTotal;
      }
      if (byte() !== 0x0c) throw new Unreadable("its header has no unpack sizes");
      for (let i = 0; i < outputs; i++) num();
      for (let k = byte(); k !== 0x00; k = byte()) {
        if (k === 0x0a) {
          skipBits(folders);
          p += 4 * folders;
        } else throw new Unreadable("its header has an unknown folder record");
      }
    } else if (id === 0x08) {
      // SubStreamsInfo: not needed for the coders, which are all read by now; where this streams info ends is not known.
      return { ids, end: null };
    } else throw new Unreadable("its header has an unknown record");
    if (p > b.length) throw new Unreadable("its header is truncated");
  }
}
const AES_7Z = "06f10701";
const LZMA_7Z = "030101";

// An encoded header's one packed stream (kEncodedHeader, 7zFormat.txt): where it is from the end of the start header,
// how long it is, its coder and that coder's properties, and how long it unpacks to. Exactly one pack stream, one folder
// and one simple coder are read (as 7-Zip writes a compressed header); anything else is not checked (D02 T04 §7).
function encodedStream(b: Uint8Array): {
  packPos: number;
  packSize: number;
  coder: string;
  props: Uint8Array;
  unpack: number;
  crc: number | null;
  packCrc: number | null;
} {
  let p = 1;
  const num = () => {
    const [v, l] = number7z(b, p);
    p += l;
    return v;
  };
  const byte = () => {
    const v = b[p];
    if (v === undefined) throw new Unreadable("its header is truncated");
    p++;
    return v;
  };
  if (byte() !== 0x06) throw new Unreadable("its compressed header has no pack record");
  const packPos = num();
  if (num() !== 1) throw new Unreadable("its compressed header is packed in more than one stream");
  let packSize: number | null = null;
  let packCrc: number | null = null;
  for (let k = byte(); k !== 0x00; k = byte()) {
    if (k === 0x09) packSize = num();
    else if (k === 0x0a) {
      // The packed stream's CRC (kCRC: all defined, then one CRC for the one stream), checked before decoding.
      if (byte() !== 0x01) throw new Unreadable("its compressed header's checksum is not given whole");
      if (p + 4 > b.length) throw new Unreadable("its header is truncated");
      packCrc = u32(b, p);
      p += 4;
    } else throw new Unreadable("its compressed header has an unknown pack record");
  }
  if (packSize === null) throw new Unreadable("its compressed header gives no packed size");
  if (byte() !== 0x07 || byte() !== 0x0b) throw new Unreadable("its compressed header has no folder record");
  if (num() !== 1 || byte() !== 0x00) throw new Unreadable("its compressed header is not one folder");
  if (num() !== 1) throw new Unreadable("its compressed header is not one coder");
  const flags = byte();
  if (flags & 0x10) throw new Unreadable("its compressed header's coder is not a simple one");
  const idSize = flags & 0x0f;
  const coder = [...b.subarray(p, p + idSize)].map((x) => x.toString(16).padStart(2, "0")).join("");
  p += idSize;
  let props: Uint8Array = new Uint8Array(0);
  if (flags & 0x20) {
    const length = num();
    props = b.subarray(p, p + length);
    p += length;
  }
  if (p > b.length) throw new Unreadable("its header is truncated");
  if (byte() !== 0x0c) throw new Unreadable("its compressed header gives no unpacked size");
  const unpack = num();
  // The decoded header's CRC (kCRC: all-defined, then one CRC for the one folder), when the archive gives it.
  let crc: number | null = null;
  for (let k = byte(); k !== 0x00; k = byte()) {
    if (k !== 0x0a) throw new Unreadable("its compressed header has an unknown folder record");
    if (byte() !== 0x01) throw new Unreadable("its compressed header's checksum is not given whole");
    if (p + 4 > b.length) throw new Unreadable("its header is truncated");
    crc = u32(b, p);
    p += 4;
  }
  // Then the StreamsInfo ends: a SubStreamsInfo (kSubStreamsInfo, 0x08), which could carry the header's digest where
  // it is not read, or any other record after the folders, is not checked, never taken as a clean header (§7 round 2).
  if (byte() !== 0x00) throw new Unreadable("its compressed header has a record after its folders that is not read");
  return { packPos, packSize, packCrc, coder, props, unpack, crc };
}

// The plain header an LZMA-compressed one holds (D02 T04 §7): its packed range read from R2 within the archive and
// MAX_DIRECTORY_BYTES, decoded within MAX_DIRECTORY_BYTES by the reference decoder (./lzma). A failure to decode is
// not checked with its reason; an R2 failure throws, so the step retries.
async function decodedHeader(bucket: R2Bucket, key: string, size: number, header: Uint8Array): Promise<Uint8Array> {
  const { packPos, packSize, packCrc, coder, props, unpack, crc } = encodedStream(header);
  if (coder !== LZMA_7Z || props.length !== 5) throw new Unreadable("its header is compressed with a coder not read");
  // A packed stream holds at least the coder's five starting bytes; nothing shorter reaches R2 (§7 round 1: a zero
  // length is an R2 range error, not an unreadable archive).
  if (packSize < 5) throw new Unreadable("its compressed header is too short to hold a stream");
  if (packSize > MAX_DIRECTORY_BYTES || unpack > MAX_DIRECTORY_BYTES)
    throw new Unreadable("its compressed header is larger than is read");
  if (32 + packPos + packSize > size) throw new Unreadable("its compressed header points past its end");
  const packed = await range(bucket, key, 32 + packPos, packSize);
  if (packed.length < packSize) throw new Unreadable("its compressed header is truncated");
  if (packCrc !== null && crc32(packed) !== packCrc)
    throw new Unreadable("its compressed header's checksum does not match");
  let plain: Uint8Array;
  try {
    plain = decodeLzma(packed, props[0] as number, unpack, MAX_DIRECTORY_BYTES);
  } catch (error) {
    if (error instanceof LzmaError)
      throw new Unreadable(`its compressed header could not be decoded (${error.message})`);
    throw error;
  }
  // A header that decodes but is not what the archive says it is, is damaged: never read as a clean answer (§7's
  // completion review).
  if (crc !== null && crc32(plain) !== crc) throw new Unreadable("its compressed header's checksum does not match");
  if (plain[0] !== 0x01) throw new Unreadable("its compressed header does not hold a header");
  return plain;
}

// Whether a 7z archive is encrypted: its next header read by range, its coder records parsed. A plain header's main and
// additional streams, or an encoded header's own coders: AES there means encryption, whatever else it names. An encoded
// header of one LZMA coder (as 7-Zip writes by default) is decoded and read as a plain one (D02 T04 §7); any other is
// not checked.
async function sevenZipEncrypted(bucket: R2Bucket, key: string, size: number): Promise<boolean> {
  if (size < 32) throw new Unreadable("it is too short to be a 7z archive");
  const start = await range(bucket, key, 0, 32);
  if (start.length < 32) throw new Unreadable("its start header is truncated");
  // The start header's own checksum, and the one it gives for the next header (7zFormat.txt, SignatureHeader): a
  // mismatch is a damaged archive, not checked, never read as clean (§7's completion review).
  if (crc32(start.subarray(12, 32)) !== u32(start, 8))
    throw new Unreadable("its start header's checksum does not match");
  const offset = u64(start, 12);
  const length = u64(start, 20);
  if (length === 0) return false;
  if (length > MAX_DIRECTORY_BYTES) throw new Unreadable("its header is larger than is read");
  if (32 + offset + length > size) throw new Unreadable("its header points past its end");
  const header = await range(bucket, key, 32 + offset, length);
  if (header.length < length) throw new Unreadable("its header is truncated");
  if (crc32(header) !== u32(start, 28)) throw new Unreadable("its header's checksum does not match");
  if (header[0] === 0x17) {
    const { ids } = coders7z(header, 1);
    if (ids.includes(AES_7Z)) return true;
    return plainHeaderEncrypted(await decodedHeader(bucket, key, size, header));
  }
  return plainHeaderEncrypted(header);
}

// A plain 7z header's coders (kHeader): AES among them means its files are encrypted.
function plainHeaderEncrypted(header: Uint8Array): boolean {
  if (header[0] !== 0x01) throw new Unreadable("its header is malformed");
  // kHeader: archive properties (0x02, skipped by their sizes), then additional (0x03) and main (0x04) streams.
  let p = 1;
  const ids: string[] = [];
  if (header[p] === 0x02) {
    p++;
    for (let t = header[p]; t !== 0x00; t = header[p]) {
      // A property running past the header, or a list never ended, is malformed (round 3).
      if (t === undefined) throw new Unreadable("its header is truncated");
      p++;
      const [len, l] = number7z(header, p);
      p += l + len;
      if (p > header.length) throw new Unreadable("its header is truncated");
    }
    p++;
  }
  // What follows must be streams info, files info or the header's end.
  if (header[p] === undefined || ![0x00, 0x03, 0x04, 0x05].includes(header[p] as number))
    throw new Unreadable("its header is malformed");
  // Additional streams, then main streams: both are read (round 1: the additional streams hid the main ones' AES).
  if (header[p] === 0x03) {
    const additional = coders7z(header, p + 1);
    ids.push(...additional.ids);
    if (additional.end === null) {
      if (ids.includes(AES_7Z)) return true;
      throw new Unreadable("its header's additional streams could not be read past");
    }
    p = additional.end;
  }
  if (header[p] === 0x04) ids.push(...coders7z(header, p + 1).ids);
  return ids.includes(AES_7Z);
}

// One archive's members by their names: encrypted entries, macro projects and modules, program and macro names, and
// archives of kinds other than ZIP named as not opened (a ZIP is opened by its content, `memberContents`).
function entryNames(entries: ZipEntry[], where: string, add: (f: RiskFinding) => void, nested: string[]) {
  for (const zipped of entries)
    for (const entryName of new Set(zipped.names)) {
      const inner = entryName.split("/").pop() ?? entryName;
      const at = `${where} > ${entryName}`;
      if (zipped.encrypted) add({ kind: "encrypted", where: at, how: "an encrypted entry", by: "structure" });
      if (/(^|\/)vbaProject\.bin$/i.test(entryName))
        add({ kind: "macro", where: at, how: "a VBA project", by: "structure" });
      // An OpenDocument file's Basic macro module: `Basic/<library>/<module>.xml`, beside the library's own index
      // files (D02 T04 §5).
      if (/^Basic\/[^/]+\/(?!script-l[bc]\.xml$|dialog-l[bc]\.xml$)[^/]+\.xml$/i.test(entryName))
        add({ kind: "macro", where: at, how: "a Basic macro module", by: "structure" });
      // Its script macros in other languages (Python, JavaScript, BeanShell) under `Scripts/` (completion review).
      if (/^Scripts\/[^/]+\/.+[^/]$/i.test(entryName))
        add({ kind: "macro", where: at, how: "an embedded script macro", by: "structure" });
      const innerExt = extensionOf(inner);
      if (EXECUTABLE_NAMES.has(innerExt))
        add({ kind: "executable", where: at, how: `its name (.${innerExt})`, by: "name", type: innerExt });
      if (MACRO_NAMES.has(innerExt)) add({ kind: "macro", where: at, how: `its name (.${innerExt})`, by: "name" });
      const inside = at.slice(at.indexOf(" > ") + 3);
      if (ARCHIVE_NAMES.has(innerExt) && innerExt !== "zip" && nested.length < MAX_FINDINGS) nested.push(inside);
    }
}

const ARCHIVE_NAMES = new Set(["zip", "rar", "7z", "gz", "tgz", "tar", "cab", "arj", "lzh", "xz", "bz2"]);

// One attachment's risks, from its first bytes (already read) and its structure. An attachment whose first bytes could
// not be read has its structure unchecked, said so (completion review).
async function risksOf(
  bucket: R2Bucket,
  attachment: CaseView["attachments"][number],
  head: Uint8Array | null,
): Promise<AttachmentRisk> {
  const findings: RiskFinding[] = [];
  const nested: string[] = [];
  const add = (f: RiskFinding) => {
    if (findings.filter((x) => x.kind === f.kind).length < MAX_FINDINGS) findings.push(f);
  };
  const name = attachment.filename;
  const extension = extensionOf(name);
  const sniffed = head ? sniff(head) : null;
  if (sniffed && EXECUTABLE_BYTES.has(sniffed))
    add({ kind: "executable", where: name, how: `its contents (${sniffed})`, by: "bytes", type: sniffed });
  else if (EXECUTABLE_NAMES.has(extension))
    add({ kind: "executable", where: name, how: `its name (.${extension})`, by: "name", type: extension });
  if (MACRO_NAMES.has(extension)) add({ kind: "macro", where: name, how: `its name (.${extension})`, by: "name" });
  if (!head)
    return { key: attachment.key, filename: name, findings, notChecked: "its contents could not be read", nested };
  let notChecked: string | null = null;
  let membersUnread: true | undefined;
  let membersNotRead = 0;
  let objectsNotRead = 0;
  try {
    const size = attachment.bytes;
    // OpenDocument is a ZIP too, whose entries can carry programs and Basic macros (D02 T04 §5).
    if (
      sniffed === "zip" ||
      sniffed === "docx" ||
      sniffed === "xlsx" ||
      sniffed === "pptx" ||
      sniffed === "ooxml" ||
      sniffed === "odf"
    ) {
      const entries = await zipEntries(bucket, attachment.key, size);
      entryNames(entries, name, add, nested);
      // Each member by its content too, and a ZIP inside opened one level down (D02 T04 §8).
      membersNotRead = await memberContents(
        r2Source(bucket, attachment.key, size),
        entries,
        name,
        1,
        { members: 0, expanded: 0 },
        add,
        nested,
      );
      // An OpenDocument file's password protection is in its manifest, not the ZIP flag (ODF 1.3 part 2, 3.8):
      // read, bounded, so a protected document is said to be one (completion review).
      // Any ZIP holding an OpenDocument manifest is read as a package, whatever its first bytes said (round 1: one
      // without a `mimetype` member sniffs as a ZIP).
      const manifest = entries.find((e) => e.names.includes("META-INF/manifest.xml"));
      if (sniffed === "odf" || manifest) {
        const bytes = manifest ? await memberBytes(r2Source(bucket, attachment.key, size), manifest) : null;
        const encrypted = bytes ? manifestEncrypted(bytes) : null;
        if (encrypted === null) notChecked = "its manifest could not be read";
        else if (encrypted)
          add({ kind: "encrypted", where: name, how: "a password-protected OpenDocument file", by: "structure" });
      }
    } else if (sniffed === "rtf") {
      // A document past the bound is one object not read: what it embeds is unknown, never taken as nothing.
      if (size > MAX_RTF_BYTES) objectsNotRead = 1;
      else {
        const read = await rtfContents(await range(bucket, attachment.key, 0, size), name, add, nested);
        objectsNotRead = read.objects;
        membersNotRead += read.members;
      }
    } else if (sniffed === "ole") {
      if (size > MAX_OLE_BYTES) throw new Unreadable("it is larger than is read");
      if (oleMacros(await range(bucket, attachment.key, 0, size)))
        add({ kind: "macro", where: name, how: "a VBA project in the file", by: "structure" });
    } else if (sniffed === "rar") {
      const rar5 = head[6] === 0x01;
      const encrypted = await rarEncrypted(bucket, attachment.key, size, rar5);
      if (encrypted) add({ kind: "encrypted", where: name, how: "an encrypted RAR archive", by: "structure" });
      if (encrypted === null) notChecked = "the archive is longer than is walked";
      membersUnread = true;
    } else if (sniffed === "cab") {
      // A cabinet's members are not read: the macro and program checks are partial, never clean (D02 T04 §9's
      // completion review: one was checked as holding nothing).
      membersUnread = true;
    } else if (sniffed === "7z") {
      membersUnread = true;
      if (await sevenZipEncrypted(bucket, attachment.key, size))
        add({ kind: "encrypted", where: name, how: "an encrypted 7z archive", by: "structure" });
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    notChecked = error.message;
  }
  return {
    key: attachment.key,
    filename: name,
    findings,
    notChecked,
    nested,
    ...(membersUnread ? { membersUnread } : {}),
    ...(membersNotRead ? { membersNotRead } : {}),
    ...(objectsNotRead ? { objectsNotRead } : {}),
  };
}

// Each attachment's risks for the view, at most MAX_RISK_ATTACHMENTS of them, the rest counted.
export async function attachmentRisksOf(
  bucket: R2Bucket,
  view: Pick<CaseView, "attachments" | "attachmentHeads">,
): Promise<AttachmentRisks | null> {
  if (!view.attachments.length) return null;
  const heads = new Map((view.attachmentHeads?.heads ?? []).map((h) => [h.key, h.head]));
  const items: AttachmentRisk[] = [];
  for (const attachment of view.attachments.slice(0, MAX_RISK_ATTACHMENTS)) {
    const head = heads.get(attachment.key);
    items.push(await risksOf(bucket, attachment, head ? Uint8Array.from(atob(head), (c) => c.charCodeAt(0)) : null));
  }
  return { items, unread: Math.max(0, view.attachments.length - MAX_RISK_ATTACHMENTS) };
}

const CHECKS: Record<RiskKind, { check: string; severity: "critical" | "high" }> = {
  executable: { check: "attachment.executable", severity: "critical" },
  macro: { check: "attachment.macro", severity: "high" },
  encrypted: { check: "attachment.encrypted_archive", severity: "high" },
};

// What a finding establishes, in words that claim no more than it (completion review): a program found by its bytes is
// a program; a name alone is a name; a disk image can carry programs, it is not one.
function says(f: RiskFinding): string {
  if (f.kind === "encrypted") return "is a password-protected archive, which hides its contents from checks";
  if (f.kind === "macro")
    return f.by === "name"
      ? `is named as a macro-enabled document ${f.how.replace("its name ", "")}`
      : "holds macros, code that can run when the document opens";
  if (f.by === "name") return `is named as a program or script ${f.how.replace("its name ", "")}`;
  if (f.type === "iso") return "is a disk image, which can carry programs that run when it is opened";
  if (f.type === "lnk") return "is a Windows shortcut, which can run a program when it is opened";
  if (f.type === "script") return "is a script, which runs code when it is opened";
  return "is a program, which runs when it is opened";
}

function evidenceFor(kind: RiskKind, view: CaseView): EvidenceDraft[] {
  const read = view.attachmentRisks;
  if (!read) return [];
  const { check, severity } = CHECKS[kind];
  const items: EvidenceDraft[] = [];
  for (const risk of read.items) {
    const found = risk.findings.filter((f) => f.kind === kind);
    const first = found[0];
    if (!first) continue;
    items.push({
      check,
      severity,
      summary: bounded(`${plain(first.where, 100)} ${says(first)}.`),
      detail: fittedDetail({ filename: risk.filename, findings: found }) as EvidenceDraft["detail"],
      artefacts: [risk.key],
    });
  }
  // What could not be checked is said once, by the executable check: an attachment whose structure was not read, an
  // archive inside an archive (named, not opened), and attachments past the limit.
  if (kind === "executable") {
    for (const risk of read.items) {
      if (risk.notChecked)
        items.push({
          check,
          severity: "info",
          summary: bounded(`${plain(risk.filename || "An attachment", 80)} was not fully checked: ${risk.notChecked}.`),
          // Fitted like every detail: a filename of 70 KB never makes the item too large to store (round 1).
          detail: fittedDetail({
            checked: false,
            filename: risk.filename,
            reason: risk.notChecked,
          }) as EvidenceDraft["detail"],
          artefacts: [risk.key],
        });
      if (risk.nested.length)
        items.push({
          check,
          severity: "info",
          summary: bounded(
            `${plain(risk.filename || "An attachment", 60)} holds ${plain(risk.nested.join(", "), 80)}, an archive inside the archive, which was not opened.`,
          ),
          detail: fittedDetail({
            checked: false,
            filename: risk.filename,
            nested: risk.nested,
          }) as EvidenceDraft["detail"],
          artefacts: [risk.key],
        });
    }
    if (read.unread > 0)
      items.push({
        check,
        severity: "info",
        summary: bounded(`${read.unread} more attachments were not checked for programs, macros or encryption.`),
        detail: { checked: false, unread: read.unread },
        artefacts: [],
      });
  }
  return items;
}

export const executableEvidence = (view: CaseView) => evidenceFor("executable", view);
export const macroEvidence = (view: CaseView) => evidenceFor("macro", view);
export const encryptedArchiveEvidence = (view: CaseView) => evidenceFor("encrypted", view);

// How many attachments were read and how many were what the check looks for (D02 T01 §7): "3 read, none with macros".
export function attachmentSummary(view: Readonly<CaseView>, items: readonly EvidenceDraft[], what: string): string {
  // The files the step read for risks, an upload's included (completion review: `attachments` is empty for an upload).
  const read = view.attachmentRisks?.items.length ?? 0;
  return items.length ? `${items.length} of ${read} ${what}` : `${read} read, none ${what}`;
}

export function registerAttachmentRiskChecks(registry: CheckRegistry): void {
  // Without attachments each returns nothing: skipped, never clean (D02 T01 §3).
  const applies = (view: Readonly<CaseView>) => (view.attachmentRisks ? null : "the message has no attachments");
  // An attachment whose structure could not be read, one past the count read, or an archive inside an archive leaves
  // each of the three checks partial; a RAR or 7z archive's members leave the macro and program checks partial, since
  // only its encryption is read (completion review, rounds 2 and 3).
  const partialFor =
    (looksInside: boolean) =>
    (view: Readonly<CaseView>): string | null => {
      const read = view.attachmentRisks;
      if (!read) return null;
      const unread = read.items.filter((i) => i.notChecked !== null).length + read.unread;
      const nested = read.items.reduce((n, i) => n + i.nested.length, 0);
      const members = looksInside ? read.items.filter((i) => i.membersUnread && i.notChecked === null).length : 0;
      const zipMembers = looksInside ? read.items.reduce((n, i) => n + (i.membersNotRead ?? 0), 0) : 0;
      const objects = looksInside ? read.items.reduce((n, i) => n + (i.objectsNotRead ?? 0), 0) : 0;
      const parts = [
        unread ? `${unread} attachment${unread === 1 ? "" : "s"} could not be read` : "",
        nested ? `${nested} archive${nested === 1 ? "" : "s"} inside an archive not opened` : "",
        members ? `${members} RAR, 7z or CAB archive${members === 1 ? "'s" : "s'"} contents not read` : "",
        zipMembers ? `${zipMembers} archive member${zipMembers === 1 ? "" : "s"} not read by content` : "",
        objects ? `${objects} embedded object${objects === 1 ? "" : "s"} not read` : "",
      ].filter(Boolean);
      return parts.length ? parts.join(", ") : null;
    };

  registry.register({
    name: "attachment.macro",
    needs: [],
    timeoutMs: 1_000,
    run: macroEvidence,
    examined: (view) => (view.attachmentRisks?.items ?? []).map((i) => i.filename || i.key),
    summary: (view, items) => attachmentSummary(view, items, "with macros"),
    applies,
    partial: partialFor(true),
  });
  registry.register({
    name: "attachment.encrypted_archive",
    needs: [],
    timeoutMs: 1_000,
    run: encryptedArchiveEvidence,
    examined: (view) => (view.attachmentRisks?.items ?? []).map((i) => i.filename || i.key),
    summary: (view, items) => attachmentSummary(view, items, "encrypted"),
    applies,
    partial: partialFor(false),
  });
  registry.register({
    name: "attachment.executable",
    needs: [],
    timeoutMs: 1_000,
    run: executableEvidence,
    examined: (view) => (view.attachmentRisks?.items ?? []).map((i) => i.filename || i.key),
    summary: (view, items) => attachmentSummary(view, items, "executable"),
    applies,
    partial: partialFor(true),
  });
}
