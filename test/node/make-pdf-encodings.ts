// Makes the encoding and encryption fixtures (D06 T02 §5) with Ghostscript, an encoder independent of the reader under
// test: its own PostScript filters write each encoded stream, and `pdfwrite` writes the files encrypted with an empty
// user password (RC4, revisions 2 and 3) and one that needs a password. Run from the repository root:
// `node test/node/make-pdf-encodings.ts`. Needs `gs` on PATH. Every document is synthetic, of a fictional bank, and
// says so. The tests assemble the filter fixtures into files with the test writer; the encrypted files are Ghostscript's
// own, the doctored twin adding one update encrypted here under the key the known passwords give (ISO 32000-1 7.6.3.3,
// algorithms 2 and 3), so the reader's own key derivation is proven on Ghostscript's files, not on this one.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteString, dictOf, isStream, readPdf, resolve, streamData } from "../../src/invoice/pdf.ts";
import { rc4 } from "../../src/invoice/pdf-crypt.ts";
import { appendUpdate, deflate } from "../invoice/pdf-writer.ts";

const OUT = join(import.meta.dirname, "../fixtures/pdf-encodings");
const work = mkdtempSync(join(tmpdir(), "pdf-encodings-"));

// Atomic: a temporary file in the destination folder, then a rename.
function save(name: string, bytes: Uint8Array) {
  const tmp = join(OUT, `.${name}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(OUT, name));
}

const ps = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

// --- Encoded streams --------------------------------------------------------------------------------------------

// The PostScript encode filter for each PDF decode filter, with the operands it takes.
const ENCODE: Record<string, string> = {
  LZWDecode: "/LZWEncode filter",
  ASCII85Decode: "/ASCII85Encode filter",
  ASCIIHexDecode: "/ASCIIHexEncode filter",
  RunLengthDecode: "0 /RunLengthEncode filter",
};

// `data` encoded so that the PDF filter list `filters` decodes it, the first filter applied first when decoding: the
// file is wrapped in the first filter's encoder, then the next, and the data written through the last.
function gsEncode(name: string, data: Uint8Array, filters: string[]): Uint8Array {
  const input = join(work, `${name}.in`);
  const output = join(work, `${name}.out`);
  writeFileSync(input, data);
  const layers = filters.map((f, i) => `/f${i + 1} f${i} ${ENCODE[f]} def`).join("\n");
  const top = `f${filters.length}`;
  const close = filters.map((_, i) => `f${filters.length - i} closefile`).join(" ");
  const program = `/in ${ps(input)} (r) file def
/f0 ${ps(output)} (w) file def
${layers}
/buf 65536 string def
{ in buf readstring exch ${top} exch writestring not {exit} if } loop
${close} f0 closefile
`;
  const src = join(work, `${name}.ps`);
  writeFileSync(src, program);
  execFileSync("gs", [
    "-q",
    "-dNODISPLAY",
    "-dBATCH",
    "-dNOPAUSE",
    `--permit-file-read=${work}/`,
    `--permit-file-write=${work}/`,
    src,
  ]);
  return new Uint8Array(readFileSync(output));
}

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// The proof of payment's page content, as the test writer's `contentOf` writes it for POP_LINES (forensics-fixtures),
// and the same page with its amount changed.
const LINES: [number, number, string][] = [
  [18, 760, "Proof of Payment"],
  [10, 740, "Kestrel Bank Limited (fictional) - SYNTHETIC TEST DOCUMENT"],
  [11, 700, "Date paid: 2026-10-20"],
  [11, 680, "Beneficiary: Hadeda Couriers (Pty) Ltd"],
  [11, 660, "Account number: 62004417731"],
  [11, 640, "Branch code: 250655"],
  [11, 620, "Amount: R 12 450.00"],
  [11, 600, "Reference: INV-2026-0412"],
];
const content = (amount: string) =>
  `${LINES.map(([size, y, text]) => `BT /F1 ${size} Tf 72 ${y} Td ${ps(text.startsWith("Amount") ? `Amount: ${amount}` : text)} Tj ET`).join("\n")}\n`;
const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><pdf:Producer>KestrelStatements 4.2</pdf:Producer><xmp:CreateDate>2026-10-20T10:15:00+02:00</xmp:CreateDate><xmp:ModifyDate>2026-10-20T10:15:00+02:00</xmp:ModifyDate></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;

const STREAM_SETS: Record<string, string[]> = {
  lzw: ["LZWDecode"],
  a85: ["ASCII85Decode"],
  ahx: ["ASCIIHexDecode"],
  rl: ["RunLengthDecode"],
  chain: ["ASCII85Decode", "LZWDecode"],
};

// --- Encrypted files --------------------------------------------------------------------------------------------

const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const md5 = (...parts: Uint8Array[]) => {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const padded = (password: string) => Uint8Array.from([...bytes(password), ...PADDING].slice(0, 32));

// The file key Ghostscript used for owner password `owner`, an empty user password, permissions -4 and the file's first
// ID (algorithm 3 for /O, then algorithm 2).
function fileKey(revision: 2 | 3, id: Uint8Array): Uint8Array {
  const n = revision === 2 ? 5 : 16;
  let ownerHash = md5(padded("owner"));
  if (revision === 3) for (let i = 0; i < 50; i++) ownerHash = md5(ownerHash.subarray(0, n));
  const ownerKey = ownerHash.subarray(0, n);
  let o = rc4(ownerKey, padded(""));
  if (revision === 3)
    for (let i = 1; i <= 19; i++)
      o = rc4(
        ownerKey.map((b) => b ^ i),
        o,
      );
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, -4, true);
  let key = md5(padded(""), o, p, id);
  if (revision === 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  return key.subarray(0, n);
}

const objectKey = (key: Uint8Array, num: number, gen: number) =>
  md5(
    key,
    Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
  ).subarray(0, Math.min(key.length + 5, 16));

const DOCINFO =
  "[ /Title (Payment INV-2026-0412) /Creator (KestrelStatements 4.2) /CreationDate (D:20261020101500+02'00') /ModDate (D:20261020101500+02'00') /DOCINFO pdfmark";

function ghostscript(name: string, extra: string[] = []): Uint8Array {
  const body = LINES.map(
    ([size, y, text]) => `/Helvetica findfont ${size} scalefont setfont 72 ${y} moveto ${ps(text)} show`,
  ).join("\n");
  const src = join(work, `${name}.ps`);
  const out = join(work, `${name}.pdf`);
  writeFileSync(src, `%!PS\n${DOCINFO}\n${body}\nshowpage\n`);
  execFileSync("gs", [
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-sDEVICE=pdfwrite",
    ...extra,
    `-sOutputFile=${out}`,
    src,
  ]);
  return new Uint8Array(readFileSync(out));
}

// Revision 2 files are written in the classic layout (a cross-reference table, every object direct), so their strings
// are each encrypted under their own object's key; revision 3 files pack objects into encrypted object streams. Both
// layouts are then proven.
const layout = (revision: 2 | 3) => (revision === 2 ? ["-dWriteObjStms=false", "-dWriteXRefStm=false"] : []);

const encryption = (revision: 2 | 3, user = "") => [
  ...layout(revision),
  "-sOwnerPassword=owner",
  `-sUserPassword=${user}`,
  `-dEncryptionR=${revision}`,
  `-dKeyLength=${revision === 2 ? 40 : 128}`,
];

// The doctored twin of an encrypted file: one update replacing its page content with the amount drawn over, encrypted
// under the file's key. The object numbers come from the same document written without encryption, which Ghostscript
// numbers the same way (checked: the content object is a stream at that number in the encrypted file too).
async function encryptedEdit(encrypted: Uint8Array, revision: 2 | 3): Promise<Uint8Array> {
  const plain = await readPdf(ghostscript(`plain-${revision}`, layout(revision)));
  const root = plain.trailer?.entries.get("Root");
  const info = plain.trailer?.entries.get("Info");
  const size = plain.trailer?.entries.get("Size");
  const pages = dictOf(plain, dictOf(plain, root)?.entries.get("Pages"));
  const kids = resolve(plain, pages?.entries.get("Kids"));
  const page = Array.isArray(kids) ? dictOf(plain, kids[0]) : null;
  const ref = page?.entries.get("Contents") as { num: number } | undefined;
  const contents = resolve(plain, ref as never);
  const fonts = dictOf(plain, dictOf(plain, page?.entries.get("Resources"))?.entries.get("Font"));
  const fontName = fonts ? [...fonts.entries.keys()][0] : undefined;
  if (!ref || !isStream(contents) || !fontName || typeof size !== "number")
    throw new Error("unexpected Ghostscript output");
  const text = byteString(encrypted);
  if (!new RegExp(`(^|[\\r\\n])${ref.num} 0 obj\\s*<<[^>]*/Length`).test(text))
    throw new Error("the encrypted file numbers its content differently");
  const idHex = /\/ID\s*\[\s*<([0-9A-Fa-f]+)>/.exec(text)?.[1];
  if (!idHex) throw new Error("no file ID");
  const id = Uint8Array.from(idHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const encryptRef = /\/Encrypt\s+(\d+)\s+0\s+R/.exec(text)?.[1];
  const data = await streamData(plain, contents);
  if (!data || !encryptRef) throw new Error("unreadable Ghostscript content");
  const edited = `${byteString(data)}\nq 1 0 0 1 0 0 cm BT /${fontName} 11 Tf 120 620 Td (112 450.00) Tj ET Q`;
  const sealed = rc4(objectKey(fileKey(revision, id), ref.num, 0), await deflate(bytes(edited)));
  return appendUpdate(encrypted, {
    objects: { [ref.num]: { dict: "<</Filter /FlateDecode>>", stream: sealed } },
    root: (root as { num: number }).num,
    info: info && typeof info === "object" ? (info as { num: number }).num : undefined,
    size,
    trailerExtra: ` /Encrypt ${encryptRef} 0 R /ID [<${idHex}> <${idHex}>]`,
  });
}

try {
  for (const [name, filters] of Object.entries(STREAM_SETS)) {
    save(`${name}-content.bin`, gsEncode(`${name}-content`, bytes(content("R 12 450.00")), filters));
    save(`${name}-edited.bin`, gsEncode(`${name}-edited`, bytes(content("R 112 450.00")), filters));
    save(`${name}-xmp.bin`, gsEncode(`${name}-xmp`, bytes(XMP), filters));
  }
  // Expansion: 9 MiB of zeros through LZW (past one stream's cap), and 7.5 MiB through RunLength inside LZW (within
  // one stream's cap, past the total's when seven streams carry it).
  save("lzw-zeros.bin", gsEncode("lzw-zeros", new Uint8Array(9 * 1024 * 1024), ["LZWDecode"]));
  save("rl-zeros.bin", gsEncode("rl-zeros", new Uint8Array(7.5 * 1024 * 1024), ["LZWDecode", "RunLengthDecode"]));
  for (const revision of [2, 3] as const) {
    const genuine = ghostscript(`rc4-r${revision}`, encryption(revision));
    save(`rc4-r${revision}.pdf`, genuine);
    save(`rc4-r${revision}-edited.pdf`, await encryptedEdit(genuine, revision));
  }
  save("rc4-password.pdf", ghostscript("rc4-password", encryption(2, "secret")));
} finally {
  rmSync(work, { recursive: true, force: true });
}
