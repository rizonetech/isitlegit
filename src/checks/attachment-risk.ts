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
export type RiskFinding = { kind: RiskKind; where: string; how: string };
export type AttachmentRisk = { key: string; filename: string; findings: RiskFinding[]; notChecked: string | null };
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

// A ZIP's central directory entries (APPNOTE 4.3.12): each name and whether it is encrypted (general purpose bit 0).
async function zipEntries(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<{ name: string; encrypted: boolean }[]> {
  const tailStart = Math.max(0, size - 65_557);
  const tail = await range(bucket, key, tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Unreadable("its central directory was not found");
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64 (APPNOTE 4.3.14, 4.3.15): the locator just before the record names the ZIP64 end record.
    const locator = eocd - 20;
    if (locator < 0 || u32(tail, locator) !== 0x07064b50) throw new Unreadable("its ZIP64 directory was not found");
    const record = u64(tail, locator + 8);
    const z64 = await range(bucket, key, record, 56);
    if (u32(z64, 0) !== 0x06064b50) throw new Unreadable("its ZIP64 directory was not found");
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  if (cdSize > MAX_DIRECTORY_BYTES) throw new Unreadable("its directory is larger than is read");
  if (cdOffset + cdSize > size) throw new Unreadable("its directory points past its end");
  const cd = await range(bucket, key, cdOffset, cdSize);
  const entries: { name: string; encrypted: boolean }[] = [];
  for (let at = 0; at + 46 <= cd.length; ) {
    if (u32(cd, at) !== 0x02014b50) throw new Unreadable("its directory is malformed");
    const nameLength = u16(cd, at + 28);
    const end = at + 46 + nameLength + u16(cd, at + 30) + u16(cd, at + 32);
    if (end > cd.length) throw new Unreadable("its directory is truncated");
    entries.push({
      name: new TextDecoder().decode(cd.subarray(at + 46, at + 46 + nameLength)),
      encrypted: (u16(cd, at + 8) & 1) === 1,
    });
    at = end;
  }
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

// Whether a RAR archive is encrypted, walked header by header by ranged reads, each payload skipped by its length; null
// when the walk stopped at its caps before the end (not fully checked), unless encryption was already found.
async function rarEncrypted(bucket: R2Bucket, key: string, size: number, rar5: boolean): Promise<boolean | null> {
  let at = rar5 ? 8 : 7;
  let reads = 0;
  let bytes = 0;
  for (let headers = 0; headers < MAX_RAR_HEADERS; headers++) {
    if (at >= size) return false;
    if (reads >= MAX_RAR_READS || bytes >= MAX_RAR_BYTES) return null;
    const window = await range(bucket, key, at, Math.min(64 * 1024, size - at));
    reads++;
    bytes += window.length;
    if (rar5) {
      const [headerSize, sizeLength] = vint(window, 4);
      const block = 4 + sizeLength;
      if (block + headerSize > window.length) throw new Unreadable("a header is longer than is read");
      let p = block;
      const [type, tl] = vint(window, p);
      p += tl;
      const [flags, fl] = vint(window, p);
      p += fl;
      let extraSize = 0;
      let dataSize = 0;
      if (flags & 1) {
        const [v, l] = vint(window, p);
        extraSize = v;
        p += l;
      }
      if (flags & 2) {
        const [v, l] = vint(window, p);
        dataSize = v;
        p += l;
      }
      if (type === 4) return true;
      if (type === 5) return false;
      if ((type === 2 || type === 3) && extraSize > 0) {
        // The extra area ends the header: a record of type 1 is the file's encryption record.
        let r = block + headerSize - extraSize;
        while (r < block + headerSize) {
          const [recordSize, rl] = vint(window, r);
          const [recordType] = vint(window, r + rl);
          if (recordType === 1) return true;
          r += rl + recordSize;
        }
      }
      at += block + headerSize + dataSize;
    } else {
      if (window.length < 7) throw new Unreadable("a header is truncated");
      const type = window[2];
      const flags = u16(window, 3);
      const headerSize = u16(window, 5);
      if (headerSize < 7) throw new Unreadable("a header is malformed");
      if (type === 0x73 && flags & 0x0080) return true;
      if (type === 0x74 && flags & 0x0004) return true;
      if (type === 0x7b) return false;
      let addSize = flags & 0x8000 ? u32(window, 7) : 0;
      if (type === 0x74 && flags & 0x0100) addSize += u32(window, 7 + 25) * 2 ** 32;
      at += headerSize + addSize;
    }
  }
  return null;
}

// A 7z archive's coders (7z format, 7zFormat.txt): the next header read by range; the AES coder (06 F1 07 01) there means
// encryption; an encoded header with another coder hides the header, so the archive is not checked (§7 reads those).
async function sevenZipEncrypted(bucket: R2Bucket, key: string, size: number): Promise<boolean> {
  const start = await range(bucket, key, 0, 32);
  const offset = u64(start, 12);
  const length = u64(start, 20);
  if (length === 0) return false;
  if (length > MAX_DIRECTORY_BYTES) throw new Unreadable("its header is larger than is read");
  if (32 + offset + length > size) throw new Unreadable("its header points past its end");
  const header = await range(bucket, key, 32 + offset, length);
  const aes = header.some(
    (_, i) => header[i] === 0x06 && header[i + 1] === 0xf1 && header[i + 2] === 0x07 && header[i + 3] === 0x01,
  );
  if (aes) return true;
  if (header[0] === 0x17) throw new Unreadable("its header is compressed, which is not read yet");
  return false;
}

// One attachment's risks, from its first bytes (already read) and its structure.
async function risksOf(
  bucket: R2Bucket,
  attachment: CaseView["attachments"][number],
  head: Uint8Array | null,
): Promise<AttachmentRisk> {
  const findings: RiskFinding[] = [];
  const add = (f: RiskFinding) => {
    if (findings.filter((x) => x.kind === f.kind).length < MAX_FINDINGS) findings.push(f);
  };
  const name = attachment.filename;
  const extension = extensionOf(name);
  const sniffed = head ? sniff(head) : null;
  if (sniffed && EXECUTABLE_BYTES.has(sniffed))
    add({ kind: "executable", where: name, how: `its contents (${sniffed})` });
  else if (EXECUTABLE_NAMES.has(extension)) add({ kind: "executable", where: name, how: `its name (.${extension})` });
  if (MACRO_NAMES.has(extension)) add({ kind: "macro", where: name, how: `its name (.${extension})` });
  let notChecked: string | null = null;
  try {
    const size = attachment.bytes;
    if (sniffed === "zip" || sniffed === "docx" || sniffed === "xlsx" || sniffed === "pptx" || sniffed === "ooxml") {
      for (const entry of await zipEntries(bucket, attachment.key, size)) {
        const inner = entry.name.split("/").pop() ?? entry.name;
        if (entry.encrypted) add({ kind: "encrypted", where: `${name} > ${entry.name}`, how: "an encrypted entry" });
        if (/(^|\/)vbaProject\.bin$/i.test(entry.name))
          add({ kind: "macro", where: `${name} > ${entry.name}`, how: "a VBA project" });
        const innerExt = extensionOf(inner);
        if (EXECUTABLE_NAMES.has(innerExt))
          add({ kind: "executable", where: `${name} > ${entry.name}`, how: `its name (.${innerExt})` });
        if (MACRO_NAMES.has(innerExt))
          add({ kind: "macro", where: `${name} > ${entry.name}`, how: `its name (.${innerExt})` });
      }
    } else if (sniffed === "ole") {
      if (size > MAX_OLE_BYTES) throw new Unreadable("it is larger than is read");
      if (oleMacros(await range(bucket, attachment.key, 0, size)))
        add({ kind: "macro", where: name, how: "a VBA project in the file" });
    } else if (sniffed === "rar") {
      const rar5 = head?.[6] === 0x01;
      const encrypted = await rarEncrypted(bucket, attachment.key, size, rar5);
      if (encrypted) add({ kind: "encrypted", where: name, how: "an encrypted RAR archive" });
      if (encrypted === null) notChecked = "the archive is longer than is walked";
    } else if (sniffed === "7z") {
      if (await sevenZipEncrypted(bucket, attachment.key, size))
        add({ kind: "encrypted", where: name, how: "an encrypted 7z archive" });
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    notChecked = error.message;
  }
  return { key: attachment.key, filename: name, findings, notChecked };
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

const CHECKS: Record<RiskKind, { check: string; severity: "critical" | "high"; says: string }> = {
  executable: { check: "attachment.executable", severity: "critical", says: "runs a program or script when opened" },
  macro: {
    check: "attachment.macro",
    severity: "high",
    says: "holds macros, code that can run when the document opens",
  },
  encrypted: {
    check: "attachment.encrypted_archive",
    severity: "high",
    says: "is a password-protected archive, which hides its contents from checks",
  },
};

function evidenceFor(kind: RiskKind, view: CaseView): EvidenceDraft[] {
  const read = view.attachmentRisks;
  if (!read) return [];
  const { check, severity, says } = CHECKS[kind];
  const items: EvidenceDraft[] = [];
  for (const risk of read.items) {
    const found = risk.findings.filter((f) => f.kind === kind);
    if (!found.length) continue;
    items.push({
      check,
      severity,
      summary: bounded(`${plain(found[0]?.where ?? risk.filename, 100)} ${says} (${found[0]?.how}).`),
      detail: fittedDetail({ filename: risk.filename, findings: found }) as EvidenceDraft["detail"],
      artefacts: [risk.key],
    });
  }
  // What could not be checked is said once, by the executable check: an attachment whose structure was not read, and
  // attachments past the limit.
  if (kind === "executable") {
    for (const risk of read.items.filter((r) => r.notChecked))
      items.push({
        check,
        severity: "info",
        summary: bounded(`${plain(risk.filename || "An attachment", 80)} was not fully checked: ${risk.notChecked}.`),
        detail: { checked: false, filename: risk.filename, reason: risk.notChecked },
        artefacts: [risk.key],
      });
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
