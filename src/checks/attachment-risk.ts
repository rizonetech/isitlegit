// Macros, encrypted archives and executables in attachments (D02 T04 §3; spec 4.3 and 4.6, malware-type attachments set
// the deterministic floor). The Workflow's `checks` step reads each attachment's structure by bounded R2 reads and puts
// what it found in the view (`attachmentRisks`); three checks map it to items. A structure that cannot be read is said to
// be not checked, never taken as clean; a storage error is thrown, so the step is retried.

import { readCompoundFile } from "../intake/cfb";
import { ParseError } from "../intake/mime";
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";
import { sniff } from "./sniff";

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

class Unreadable extends Error {}

async function range(bucket: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new Unreadable("the attachment is missing");
  return new Uint8Array(await object.arrayBuffer());
}

// A ZIP's central directory entries (APPNOTE 4.3.12): each name and whether it is encrypted (general purpose bit 0). The
// directory must hold exactly the entries its end record counts, each whole (completion review: no damaged directory
// reads as an empty one).
async function zipEntries(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<{ name: string; encrypted: boolean }[]> {
  if (size < 22) throw new Unreadable("it is too short to be a ZIP archive");
  const tailStart = Math.max(0, size - 65_557);
  const tail = await range(bucket, key, tailStart, size - tailStart);
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
    const z64 = await range(bucket, key, record, 56);
    if (z64.length < 56 || u32(z64, 0) !== 0x06064b50) throw new Unreadable("its ZIP64 directory was not found");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  if (cdSize > MAX_DIRECTORY_BYTES) throw new Unreadable("its directory is larger than is read");
  if (cdOffset + cdSize > size) throw new Unreadable("its directory points past its end");
  const cd = cdSize ? await range(bucket, key, cdOffset, cdSize) : new Uint8Array(0);
  if (cd.length !== cdSize) throw new Unreadable("its directory is truncated");
  const entries: { name: string; encrypted: boolean }[] = [];
  let at = 0;
  while (at < cd.length) {
    if (at + 46 > cd.length || u32(cd, at) !== 0x02014b50) throw new Unreadable("its directory is malformed");
    const nameLength = u16(cd, at + 28);
    const end = at + 46 + nameLength + u16(cd, at + 30) + u16(cd, at + 32);
    if (end > cd.length) throw new Unreadable("its directory is truncated");
    entries.push({
      name: new TextDecoder().decode(cd.subarray(at + 46, at + 46 + nameLength)),
      encrypted: (u16(cd, at + 8) & 1) === 1,
    });
    at = end;
  }
  if (entries.length !== count) throw new Unreadable("its directory does not hold the entries it counts");
  return entries;
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
      if (this.reads >= MAX_RAR_READS || this.read >= MAX_RAR_BYTES) return null;
      const want = Math.min(Math.max(length, 64 * 1024), this.size - at);
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
function coders7z(b: Uint8Array, start: number): string[] {
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
    if (id === 0x00) return ids;
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
      // SubStreamsInfo: not needed for the coders; the coders are all read by now.
      return ids;
    } else throw new Unreadable("its header has an unknown record");
    if (p > b.length) throw new Unreadable("its header is truncated");
  }
}
const AES_7Z = "06f10701";

// Whether a 7z archive is encrypted: its next header read by range, its coder records parsed. A plain header's main and
// additional streams, or an encoded header's own coders: AES there means encryption; an encoded header with any other
// coder (LZMA, as 7-Zip writes by default) hides the header, so the archive is not checked (§7 reads those).
async function sevenZipEncrypted(bucket: R2Bucket, key: string, size: number): Promise<boolean> {
  if (size < 32) throw new Unreadable("it is too short to be a 7z archive");
  const start = await range(bucket, key, 0, 32);
  if (start.length < 32) throw new Unreadable("its start header is truncated");
  const offset = u64(start, 12);
  const length = u64(start, 20);
  if (length === 0) return false;
  if (length > MAX_DIRECTORY_BYTES) throw new Unreadable("its header is larger than is read");
  if (32 + offset + length > size) throw new Unreadable("its header points past its end");
  const header = await range(bucket, key, 32 + offset, length);
  if (header.length < length) throw new Unreadable("its header is truncated");
  if (header[0] === 0x17) {
    const ids = coders7z(header, 1);
    if (ids.includes(AES_7Z)) return true;
    throw new Unreadable("its header is compressed, which is not read yet");
  }
  if (header[0] !== 0x01) throw new Unreadable("its header is malformed");
  // kHeader: archive properties (0x02, skipped by their sizes), then additional (0x03) and main (0x04) streams.
  let p = 1;
  const ids: string[] = [];
  if (header[p] === 0x02) {
    p++;
    for (let t = header[p]; t !== undefined && t !== 0x00; t = header[p]) {
      p++;
      const [len, l] = number7z(header, p);
      p += l + len;
    }
    p++;
  }
  for (const record of [0x03, 0x04])
    if (header[p] === record) {
      ids.push(...coders7z(header, p + 1));
      // The streams info's end is not needed: the coders are what is read.
      break;
    }
  return ids.includes(AES_7Z);
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
  try {
    const size = attachment.bytes;
    if (sniffed === "zip" || sniffed === "docx" || sniffed === "xlsx" || sniffed === "pptx" || sniffed === "ooxml") {
      for (const entry of await zipEntries(bucket, attachment.key, size)) {
        const inner = entry.name.split("/").pop() ?? entry.name;
        const where = `${name} > ${entry.name}`;
        if (entry.encrypted) add({ kind: "encrypted", where, how: "an encrypted entry", by: "structure" });
        if (/(^|\/)vbaProject\.bin$/i.test(entry.name))
          add({ kind: "macro", where, how: "a VBA project", by: "structure" });
        const innerExt = extensionOf(inner);
        if (EXECUTABLE_NAMES.has(innerExt))
          add({ kind: "executable", where, how: `its name (.${innerExt})`, by: "name", type: innerExt });
        if (MACRO_NAMES.has(innerExt)) add({ kind: "macro", where, how: `its name (.${innerExt})`, by: "name" });
        if (ARCHIVE_NAMES.has(innerExt) && nested.length < MAX_FINDINGS) nested.push(entry.name);
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
    } else if (sniffed === "7z") {
      if (await sevenZipEncrypted(bucket, attachment.key, size))
        add({ kind: "encrypted", where: name, how: "an encrypted 7z archive", by: "structure" });
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    notChecked = error.message;
  }
  return { key: attachment.key, filename: name, findings, notChecked, nested };
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
          detail: { checked: false, filename: risk.filename, reason: risk.notChecked },
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

export function registerAttachmentRiskChecks(registry: CheckRegistry): void {
  registry.register({ name: "attachment.macro", needs: [], timeoutMs: 1_000, run: macroEvidence });
  registry.register({
    name: "attachment.encrypted_archive",
    needs: [],
    timeoutMs: 1_000,
    run: encryptedArchiveEvidence,
  });
  registry.register({ name: "attachment.executable", needs: [], timeoutMs: 1_000, run: executableEvidence });
}
