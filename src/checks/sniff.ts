// What an attachment really is, read from its first bytes, never its name or declared type (D02 T04 §1): the types a
// forwarded invoice's attachments come as, and the ones a lure hides behind them. Apart from the upload door's own sniffer
// (src/intake/sniff.ts), which decides what a member may upload.
export type SniffedType =
  | "pdf"
  | "zip"
  | "docx"
  | "xlsx"
  | "pptx"
  | "ooxml"
  | "ole"
  | "pe"
  | "elf"
  | "macho"
  | "rar"
  | "7z"
  | "iso"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "html"
  | "svg"
  | "lnk"
  | "script"
  | "text";

// Enough of a file to read every signature here: ISO 9660's `CD001` sits at offset 32769.
export const SNIFF_BYTES = 36 * 1024;
// The most attachments a case has read for sniffing; the rest are counted as not compared.
export const MAX_SNIFFED = 20;
export const READ_CONCURRENCY = 4;

// Each attachment's first SNIFF_BYTES from R2, as base64, for the view (the `checks` step reads them, since a check never
// reaches the store); one missing from R2 is counted with those past MAX_SNIFFED.
export async function attachmentHeadsOf(
  bucket: R2Bucket,
  attachments: readonly { key: string }[],
): Promise<{ heads: { key: string; head: string }[]; unread: number }> {
  // The first MAX_SNIFFED attachments are compared, each stored key read once: identical attachments share a key
  // (storage keeps content once), so fifty copies are one read and still only twenty comparisons (round 1).
  const listed = attachments.slice(0, MAX_SNIFFED);
  const keys = [...new Set(listed.map((a) => a.key))];
  const read: ({ key: string; head: string } | null)[] = new Array(keys.length).fill(null);
  // Four reads at a time (completion review), in order of the attachments however they finish.
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < keys.length; i = next++) {
      const key = keys[i] as string;
      // A missing object is counted; any other storage error fails the step, which the Workflow retries (plan review).
      const object = await bucket.get(key, { range: { offset: 0, length: SNIFF_BYTES } });
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      let text = "";
      for (let j = 0; j < bytes.length; j += 0x8000) text += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
      read[i] = { key, head: btoa(text) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, keys.length) }, worker));
  const heads = read.filter((h): h is { key: string; head: string } => h !== null);
  const found = new Set(heads.map((h) => h.key));
  // Not compared: every attachment past MAX_SNIFFED, and every one whose stored object is missing.
  const unread = attachments.length - listed.length + listed.filter((a) => !found.has(a.key)).length;
  return { heads, unread };
}

const at = (bytes: Uint8Array, offset: number, ...signature: number[]) =>
  signature.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));
const LNK_CLSID = [0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46];

// An OOXML package's kind from the names of the ZIP's local file entries within the bytes read.
function zipKind(bytes: Uint8Array): SniffedType {
  const names: string[] = [];
  for (let i = 0; i + 30 <= bytes.length && names.length < 64; ) {
    if (!at(bytes, i, 0x50, 0x4b, 0x03, 0x04)) break;
    const nameLength = (bytes[i + 26] ?? 0) | ((bytes[i + 27] ?? 0) << 8);
    const extraLength = (bytes[i + 28] ?? 0) | ((bytes[i + 29] ?? 0) << 8);
    const compressed =
      (bytes[i + 18] ?? 0) | ((bytes[i + 19] ?? 0) << 8) | ((bytes[i + 20] ?? 0) << 16) | ((bytes[i + 21] ?? 0) << 24);
    names.push(ascii(bytes, i + 30, nameLength));
    // A data descriptor (flag bit 3) leaves the size unknown here: stop at the names read so far.
    if ((bytes[i + 6] ?? 0) & 0x08) break;
    i += 30 + nameLength + extraLength + (compressed >>> 0);
  }
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  if (names.includes("[Content_Types].xml")) return "ooxml";
  return "zip";
}

// Text is UTF-8 (or ASCII) with no NUL and few control characters in what was read.
function isText(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  let control = 0;
  for (const b of bytes.subarray(0, 4096)) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  } catch {
    // A multi-byte character cut by the 4 KiB slice is still text; any other bad sequence is not.
    if (bytes.length <= 4096) return false;
  }
  return control * 100 <= Math.min(bytes.length, 4096);
}

// Where a doctype ends: after its internal subset (`[...]`, whose declarations hold their own `>`), at the next `>`
// (XML 1.0 section 2.8; round 1). Zero when it does not end in the text read.
function doctypeEnd(text: string): number {
  // Quoted values (an entity's, a public identifier's) may hold `]` or `>`: only those outside quotes count (round 2).
  let quote = "";
  let subset = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") subset = true;
    else if (c === "]") subset = false;
    else if (c === ">" && !subset) return i + 1;
  }
  return 0;
}

// What follows an XML prolog (the declaration, comments, processing instructions and a doctype, in any order), bounded
// by the text read.
function prolog(text: string): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.trimStart();
    const end = trimmed.startsWith("<!--")
      ? trimmed.indexOf("-->") + 3
      : trimmed.startsWith("<?")
        ? trimmed.indexOf("?>") + 2
        : trimmed.startsWith("<!doctype")
          ? doctypeEnd(trimmed)
          : 0;
    if (end <= 2) return trimmed;
    rest = trimmed.slice(end);
  }
}

// A script, by markers in its first 4 KiB of text (a bounded, documented list; plan review): an interpreter line, a batch
// file, Windows Script Host or PowerShell (an HTML Application is caught first, in `sniff`). Anything else readable is
// text.
const SCRIPT = [
  /^\uFEFF?#!\//,
  /^\s*@echo\s+off\b/im,
  // A statement, at the start of a line, not a mention in prose (completion review).
  /^\s*(?:Set\s+\w+\s*=\s*)?(?:WScript\.(?:CreateObject|Echo|Sleep|Quit)\b|CreateObject\s*\(\s*["'](?:WScript|Scripting|Shell|MSXML2|ADODB)\.)/im,
  /^\s*(?:\$\w+\s*=\s*)?(?:Invoke-Expression|IEX)\s*[(\s$'"]/im,
  /^\s*powershell(?:\.exe)?\s+-(?:\w+\s+)*-?(?:EncodedCommand|enc|e|Command|c)\b/im,
];

export function sniff(bytes: Uint8Array): SniffedType | null {
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (at(bytes, 0, 0x50, 0x4b, 0x03, 0x04)) return zipKind(bytes);
  if (at(bytes, 0, 0x50, 0x4b, 0x05, 0x06)) return "zip";
  if (at(bytes, 0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "ole";
  if (at(bytes, 0, 0x4d, 0x5a)) return "pe";
  if (at(bytes, 0, 0x7f, 0x45, 0x4c, 0x46)) return "elf";
  if (
    at(bytes, 0, 0xfe, 0xed, 0xfa, 0xce) ||
    at(bytes, 0, 0xfe, 0xed, 0xfa, 0xcf) ||
    at(bytes, 0, 0xce, 0xfa, 0xed, 0xfe) ||
    at(bytes, 0, 0xcf, 0xfa, 0xed, 0xfe) ||
    at(bytes, 0, 0xca, 0xfe, 0xba, 0xbe)
  )
    return "macho";
  if (ascii(bytes, 0, 6) === "Rar!\x1a\x07") return "rar";
  if (at(bytes, 0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "7z";
  if (ascii(bytes, 32769, 5) === "CD001") return "iso";
  if (at(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(bytes, 0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (at(bytes, 0, 0x4c, 0x00, 0x00, 0x00) && at(bytes, 4, ...LNK_CLSID)) return "lnk";
  // UTF-16 text, as Windows writes scripts with a byte order mark, read as text too (completion review).
  const utf16 = at(bytes, 0, 0xff, 0xfe) ? "utf-16le" : at(bytes, 0, 0xfe, 0xff) ? "utf-16be" : null;
  if (utf16) return textType(new TextDecoder(utf16).decode(bytes.subarray(2, 8194)));
  if (!isText(bytes)) return null;
  return textType(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

// A text's type: an HTML Application (a script, whatever its first tag), HTML, SVG (after any XML prolog: declaration,
// comments, processing instructions, a doctype), another script, or text.
function textType(text: string): SniffedType {
  const head = text
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (/<hta:application\b/i.test(text)) return "script";
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (prolog(head).startsWith("<svg")) return "svg";
  if (SCRIPT.some((marker) => marker.test(text))) return "script";
  return "text";
}
