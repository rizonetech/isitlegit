// More PDF encodings and protected files (D06 T02 §5; ISO 32000-1 7.4 and 7.6): each new filter and a chain read a
// genuine and a doctored file exactly, decoding stays inside the shared budget, damaged data and unsupported encryption
// are named, and an empty-password RC4 file reads its strings, its page content and an earlier revision's object. The
// encoded streams and encrypted files are Ghostscript's (test/node/make-pdf-encodings.ts, PROVENANCE.md).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analysePdf, FORENSIC_KINDS } from "../../src/invoice/forensics";
import {
  byteString,
  definitionAt,
  dictOf,
  isStream,
  MAX_STREAM_DECODED,
  MAX_TOTAL_DECODED,
  OverBudget,
  type PdfFile,
  type PdfStream,
  readPdf,
  resolve,
  streamData,
  textOf,
} from "../../src/invoice/pdf";
import { readContent } from "../../src/invoice/pdf-content";
import { md5, objectKey, rc4 } from "../../src/invoice/pdf-crypt";
import { fixture } from "../fixtures/pdf-encodings/load";
import { generated } from "../fixtures/pdf-forensics/load";
import { BANK_INFO, docObjects, POP_LINES } from "./forensics-fixtures";
import { appendUpdate, buildPdf, type Obj, toBytes } from "./pdf-writer";

// The samples test/node/make-pdf-encodings.ts gave Ghostscript's TIFF predictor (its `tiffSamples`, the same formula):
// 4 rows of 5 pixels of 3 components, most significant bits first, each row padded to a whole byte.
function tiffSamples(depth: number): Uint8Array {
  const samples = 15;
  const rowBytes = Math.ceil((samples * depth) / 8);
  const out = new Uint8Array(4 * rowBytes);
  for (let row = 0; row < 4; row++)
    for (let i = 0; i < samples; i++) {
      // 16-bit samples span the whole range, so the predictor's sums carry between bytes and wrap (round 5).
      const v = depth === 16 ? (row * 9973 + i * 4321 + 60000) % 65536 : (row * 7 + i * 3 + 1) % 2 ** depth;
      if (depth === 16) {
        out[row * rowBytes + 2 * i] = v >> 8;
        out[row * rowBytes + 2 * i + 1] = v & 0xff;
      } else if (depth === 8) out[row * rowBytes + i] = v;
      else {
        const at = row * rowBytes + ((i * depth) >> 3);
        out[at] = (out[at] as number) | (v << (8 - depth - ((i * depth) & 7)));
      }
    }
  return out;
}

// The XMP packet the maker encoded with each filter (make-pdf-encodings.ts, XMP).
const XMP_PRODUCER = "<pdf:Producer>KestrelStatements 4.2</pdf:Producer>";
const POP_TEXT = POP_LINES.map((l) => l.text);

const SETS = {
  lzw: "/LZWDecode",
  a85: "/ASCII85Decode",
  ahx: "/ASCIIHexDecode",
  rl: "/RunLengthDecode",
  chain: "[/ASCII85Decode /LZWDecode]",
} as const;

const stream = (filter: string, data: Uint8Array, dict = ""): Obj => ({
  dict: `<<${dict} /Filter ${filter}>>`,
  stream: data,
});

// The proof of payment with its page content and XMP metadata stored through `filter` (Ghostscript's encoding), and
// its doctored twin: a later save replacing the content with the amount changed, stored the same way.
async function pair(name: keyof typeof SETS): Promise<{ genuine: Uint8Array; doctored: Uint8Array }> {
  const filter = SETS[name];
  const { objects, size } = docObjects({ lines: POP_LINES, info: BANK_INFO });
  objects[2] = "<</Type /Catalog /Pages 3 0 R /Metadata 11 0 R>>";
  objects[5] = stream(filter, fixture(`${name}-content.bin`));
  objects[11] = stream(filter, fixture(`${name}-xmp.bin`), "/Type /Metadata /Subtype /XML");
  const all = Math.max(size, 12);
  const genuine = await buildPdf({ objects, root: 2, info: 6, size: all });
  const doctored = await appendUpdate(genuine, {
    objects: { 5: stream(filter, fixture(`${name}-edited.bin`)) },
    root: 2,
    info: 6,
    size: all,
  });
  return { genuine, doctored };
}

const pageText = async (file: PdfFile) => (await readContent(file)).pages[0]?.runs.map((r) => r.text) ?? [];
const info = (file: PdfFile, key: string) =>
  textOf(resolve(file, dictOf(file, file.trailer?.entries.get("Info"))?.entries.get(key)));
async function xmp(file: PdfFile): Promise<string | null> {
  const meta = resolve(file, dictOf(file, file.trailer?.entries.get("Root"))?.entries.get("Metadata"));
  const data = isStream(meta) ? await streamData(file, meta) : null;
  return data ? new TextDecoder().decode(data) : null;
}
// The object number a trailer entry refers to.
function refNum(file: PdfFile, key: string): number {
  const ref = file.trailer?.entries.get(key);
  if (!ref || typeof ref !== "object" || !("num" in ref)) throw new Error(`no ${key} reference`);
  return ref.num;
}
const allRan = (r: Awaited<ReturnType<typeof analysePdf>>) => {
  for (const k of FORENSIC_KINDS) expect(r.coverage[k], k).toEqual({ status: "ran", reason: null });
};

describe("filters", () => {
  for (const name of Object.keys(SETS) as (keyof typeof SETS)[])
    it(`reads ${name} streams exactly and finds the doctored twin's edit`, async () => {
      const { genuine, doctored } = await pair(name);
      const file = await readPdf(genuine);
      expect(file.unread).toEqual([]);
      expect(await pageText(file)).toEqual(POP_TEXT);
      expect(info(file, "Producer")).toBe("KestrelStatements 4.2");
      expect(await xmp(file)).toContain(XMP_PRODUCER);
      const clean = await analysePdf(genuine);
      expect(clean.findings).toEqual([]);
      expect(clean.unread).toEqual([]);
      allRan(clean);
      const edited = await analysePdf(doctored);
      expect(edited.findings.map((f) => f.kind)).toEqual(["revisions"]);
      expect(edited.findings[0]?.detail).toMatchObject({ edits: 1, revisions: 2 });
      expect(edited.unread).toEqual([]);
      allRan(edited);
      const later = await readPdf(doctored);
      expect(await pageText(later)).toEqual(POP_TEXT.map((t) => (t.startsWith("Amount") ? "Amount: R 112 450.00" : t)));
    });

  it("reads a TIFF-predicted cross-reference stream as its PNG twin, without scanning", async () => {
    const { objects, size } = docObjects({ lines: POP_LINES, info: BANK_INFO });
    const tiff = await readPdf(await buildPdf({ objects, root: 2, info: 6, size, xref: "stream-tiff" }));
    const png = await readPdf(await buildPdf({ objects, root: 2, info: 6, size, xref: "stream-predictor" }));
    expect(tiff.unread).toEqual([]);
    expect(tiff.scanned).toBe(false);
    expect(png.scanned).toBe(false);
    expect([...tiff.objects.keys()].sort()).toEqual([...png.objects.keys()].sort());
    expect(await pageText(tiff)).toEqual(POP_TEXT);
    expect(await pageText(tiff)).toEqual(await pageText(png));
  });

  it("undoes Ghostscript's TIFF predictor at every depth the standard permits (completion review)", async () => {
    for (const depth of [1, 2, 4, 8, 16]) {
      const parms = ` /DecodeParms <</Predictor 2 /Colors 3 /BitsPerComponent ${depth} /Columns 5>>`;
      const file = await holding([stream("/LZWDecode", fixture(`tiff-${depth}.bin`), parms)]);
      const data = await streamData(file, file.objects.get(20) as PdfStream);
      expect(data, `depth ${depth}`).toEqual(tiffSamples(depth));
      expect(file.unread, `depth ${depth}`).toEqual([]);
    }
  });

  it("undoes Ghostscript's PNG predictor at sub-byte depths, a row as wide as its bits (round 1)", async () => {
    for (const depth of [1, 2, 4]) {
      const parms = ` /DecodeParms <</Predictor 15 /Colors 3 /BitsPerComponent ${depth} /Columns 5>>`;
      const file = await holding([stream("/LZWDecode", fixture(`png-${depth}.bin`), parms)]);
      expect(await streamData(file, file.objects.get(20) as PdfStream), `depth ${depth}`).toEqual(tiffSamples(depth));
      expect(file.unread, `depth ${depth}`).toEqual([]);
    }
  });

  it("names a TIFF predictor of a depth the standard does not permit", async () => {
    const file = await readPdf(
      await buildPdf({
        objects: {
          2: "<</Type /Catalog /Pages 3 0 R>>",
          3: "<</Type /Pages /Kids [] /Count 0>>",
          5: stream("/LZWDecode", fixture("lzw-content.bin"), " /DecodeParms <</Predictor 2 /BitsPerComponent 3>>"),
        },
        root: 2,
        size: 6,
      }),
    );
    expect(await streamData(file, file.objects.get(5) as PdfStream)).toBeNull();
    expect(file.unread.join(" ")).toMatch(/TIFF prediction is not read/);
  });
});

// One file holding each of `streams` as objects 20 and up.
async function holding(streams: Obj[]): Promise<PdfFile> {
  const objects: Record<number, Obj> = {
    2: "<</Type /Catalog /Pages 3 0 R>>",
    3: "<</Type /Pages /Kids [] /Count 0>>",
  };
  streams.forEach((s, i) => {
    objects[20 + i] = s;
  });
  return readPdf(await buildPdf({ objects, root: 2, size: 20 + streams.length }));
}

describe("the budget", () => {
  it("stops an LZW expansion at one stream's cap, never past it, and says so in the coverage", async () => {
    const file = await holding([stream("/LZWDecode", fixture("lzw-zeros.bin"))]);
    expect(await streamData(file, file.objects.get(20) as PdfStream)).toBeNull();
    expect(file.unread.join(" ")).toMatch(/decodes to more than 8 MiB/);
    // What the stage read, then exactly the cap it wrote.
    expect(file.budget.decoded).toBe(fixture("lzw-zeros.bin").length + MAX_STREAM_DECODED);

    const { objects, size } = docObjects({ lines: POP_LINES, info: BANK_INFO });
    objects[2] = "<</Type /Catalog /Pages 3 0 R /Metadata 11 0 R>>";
    objects[11] = stream("/LZWDecode", fixture("lzw-zeros.bin"), "/Type /Metadata /Subtype /XML");
    const r = await analysePdf(await buildPdf({ objects, root: 2, info: 6, size: Math.max(size, 12) }));
    expect(r.unread.join(" ")).toMatch(/decodes to more than 8 MiB/);
    expect(r.coverage.producer).toEqual({ status: "partial", reason: expect.stringMatching(/8 MiB/) });
  });

  it("charges every stage of every stream, so RunLength expansions stop at the total's cap", async () => {
    // Seven streams of 7.5 MiB each (RunLength inside LZW), each within one stream's cap, 52.5 MiB together.
    const file = await holding(
      Array.from({ length: 7 }, () => stream("[/LZWDecode /RunLengthDecode]", fixture("rl-zeros.bin"))),
    );
    const read: (number | null)[] = [];
    for (let i = 0; i < 7; i++)
      read.push((await streamData(file, file.objects.get(20 + i) as PdfStream))?.length ?? null);
    expect(read.slice(0, 6)).toEqual(Array(6).fill(7.5 * 1024 * 1024));
    expect(read[6]).toBeNull();
    expect(file.unread.join(" ")).toMatch(/decodes to more than the space left/);
    expect(file.budget.decoded).toBe(MAX_TOTAL_DECODED);
    expect(await streamData(file, file.objects.get(20) as PdfStream)).toBeNull();
    expect(file.unread.join(" ")).toMatch(/past 48 MiB was not read/);
  });
});

describe("data that fails or stops late (completion review)", () => {
  it("charges a damaged stream's expansion, so seven that fail late still stop at the total's cap", async () => {
    // 7.5 MiB of zeros as RunLength runs of 128, then a run cut short: each stream expands fully before it fails.
    const runs = new Uint8Array((7.5 * 1024 * 1024) / 64 + 2);
    for (let i = 0; i + 1 < runs.length - 2; i += 2) runs[i] = 129;
    runs.set([10, 65], runs.length - 2);
    const file = await holding(Array.from({ length: 7 }, () => stream("/RunLengthDecode", runs)));
    for (let i = 0; i < 7; i++) expect(await streamData(file, file.objects.get(20 + i) as PdfStream)).toBeNull();
    expect(file.unread.join(" ")).toMatch(/damaged \(RunLengthDecode\)/);
    expect(file.unread.join(" ")).toMatch(/decodes to more than the space left/);
    expect(file.budget.decoded).toBe(MAX_TOTAL_DECODED);
  });

  it("reads LZW data that stops without its end-of-data code, and names it as possibly cut short", async () => {
    // The 9-bit codes 256 (clear), 65 ("A") and then nothing: no 257.
    const file = await holding([stream("/LZWDecode", Uint8Array.from([0x80, 0x10, 0x40]))]);
    expect(await streamData(file, file.objects.get(20) as PdfStream)).toEqual(Uint8Array.from([65]));
    expect(file.unread.join(" ")).toMatch(/LZWDecode stream ends without its end-of-data marker/);

    // Ghostscript's page content with its last two bytes gone: the text that decoded is read, the checks partial.
    const content = fixture("lzw-content.bin");
    const { objects, size } = docObjects({ lines: POP_LINES, info: BANK_INFO });
    objects[5] = stream("/LZWDecode", content.subarray(0, content.length - 2));
    const r = await analysePdf(await buildPdf({ objects, root: 2, info: 6, size }));
    expect(r.unread.join(" ")).toMatch(/may be cut short/);
    expect(r.coverage.fonts.status).toBe("partial");
  });

  it("names RunLength, ASCII85 and ASCIIHex data that stops without its end-of-data marker", async () => {
    for (const [filter, data] of [
      ["/RunLengthDecode", Uint8Array.from([1, 65, 66])],
      ["/ASCII85Decode", toBytes("87cUR")],
      ["/ASCIIHexDecode", toBytes("4142")],
    ] as const) {
      const file = await holding([stream(filter, data)]);
      expect(await streamData(file, file.objects.get(20) as PdfStream), filter).not.toBeNull();
      expect(file.unread.join(" "), filter).toMatch(/ends without its end-of-data marker/);
    }
  });
});

describe("decoder input (round 2)", () => {
  it("charges what each stage reads, so a stream of white space read once per reference stops at the cap", async () => {
    // 1 MiB of ASCIIHex white space, which decodes to nothing, drawn 200 times by one page.
    const blank = toBytes(`${" ".repeat(1024 * 1024)}>`);
    const { objects } = docObjects({ lines: POP_LINES, info: BANK_INFO });
    objects[20] = stream("/ASCIIHexDecode", blank);
    objects[4] = (objects[4] as string).replace("/Contents 5 0 R", `/Contents [5 0 R${" 20 0 R".repeat(200)}]`);
    const r = await analysePdf(await buildPdf({ objects, root: 2, info: 6, size: 21 }));
    expect(r.work.decoded).toBeLessThanOrEqual(MAX_TOTAL_DECODED);
    expect(r.work.decoded).toBeGreaterThan(MAX_TOTAL_DECODED - blank.length);
    expect(r.unread.join(" ")).toMatch(/past 48 MiB was not read/);
    expect(r.coverage.fonts.status).toBe("partial");
  });
});

describe("decryption work (round 3)", () => {
  it("charges decrypting an unfiltered stream, so one drawn again and again stops at the cap", async () => {
    // rc4-r2.pdf with a later save adding a 1 MiB unfiltered stream, decrypted on every read.
    const base = fixture("rc4-r2.pdf");
    const file0 = await readPdf(base);
    const ids = file0.trailer?.entries.get("ID");
    const id = Array.isArray(ids) && ids[0] && typeof ids[0] === "object" && "bytes" in ids[0] ? ids[0].bytes : "";
    const hex = Buffer.from(toBytes(id)).toString("hex");
    const size = file0.trailer?.entries.get("Size") as number;
    const bytes = await appendUpdate(base, {
      objects: { [size]: { dict: "<<>>", stream: new Uint8Array(1024 * 1024).fill(0x41) } },
      root: refNum(file0, "Root"),
      info: refNum(file0, "Info"),
      size: size + 1,
      trailerExtra: ` /Encrypt ${refNum(file0, "Encrypt")} 0 R /ID [<${hex}> <${hex}>]`,
    });
    const file = await readPdf(bytes);
    expect(file.decrypted).toBe(true);
    const big = file.objects.get(size) as PdfStream;
    let read = 0;
    for (let i = 0; i < 60; i++) if (await streamData(file, big)) read++;
    expect(read).toBe(47);
    expect(file.budget.decoded).toBeLessThanOrEqual(MAX_TOTAL_DECODED);
    expect(file.unread.join(" ")).toMatch(/past 48 MiB was not read/);
  });
});

describe("string decryption work (round 4)", () => {
  it("charges decrypting strings, so an object read again and again stops at the cap with OverBudget", async () => {
    // rc4-r2.pdf with a later save adding an object holding a 1 MiB string, decrypted on every read of it.
    const base = fixture("rc4-r2.pdf");
    const file0 = await readPdf(base);
    const ids = file0.trailer?.entries.get("ID");
    const id = Array.isArray(ids) && ids[0] && typeof ids[0] === "object" && "bytes" in ids[0] ? ids[0].bytes : "";
    const hex = Buffer.from(toBytes(id)).toString("hex");
    const size = file0.trailer?.entries.get("Size") as number;
    const bytes = await appendUpdate(base, {
      objects: { [size]: `<</Junk (${"A".repeat(1024 * 1024)})>>` },
      root: refNum(file0, "Root"),
      info: refNum(file0, "Info"),
      size: size + 1,
      trailerExtra: ` /Encrypt ${refNum(file0, "Encrypt")} 0 R /ID [<${hex}> <${hex}>]`,
    });
    const file = await readPdf(bytes);
    expect(file.decrypted).toBe(true);
    let reads = 0;
    let stopped: unknown = null;
    for (let i = 0; i < 60 && !stopped; i++) {
      try {
        await definitionAt(file, 0, size);
        reads++;
      } catch (error) {
        stopped = error;
      }
    }
    expect(stopped).toBeInstanceOf(OverBudget);
    expect(reads).toBeLessThan(48);
    expect(file.budget.decoded).toBeLessThanOrEqual(MAX_TOTAL_DECODED + 1024 * 1024);
  });
});

describe("damaged data", () => {
  const cases: [string, Obj, RegExp][] = [
    ["ASCIIHex", stream("/ASCIIHexDecode", toBytes("4G>")), /damaged \(ASCIIHexDecode\)/],
    ["ASCII85", stream("/ASCII85Decode", toBytes("87cURD~x")), /damaged \(ASCII85Decode\)/],
    ["a truncated ASCII85 group", stream("/ASCII85Decode", toBytes("8~>")), /damaged \(ASCII85Decode\)/],
    ["RunLength", stream("/RunLengthDecode", Uint8Array.from([10, 65, 66])), /damaged \(RunLengthDecode\)/],
    // A 9-bit code of 300 before any table entry exists.
    ["LZW", stream("/LZWDecode", Uint8Array.from([0x96, 0x00])), /damaged \(LZWDecode\)/],
    // The hex stage reads; its output is RunLength data that ends inside a run.
    [
      "a chain's second stage",
      stream("[/ASCIIHexDecode /RunLengthDecode]", toBytes("0A41>")),
      /damaged \(RunLengthDecode\)/,
    ],
    ["an unknown filter", stream("/JBIG2Decode", toBytes("x")), /filter that is not read \(JBIG2Decode\)/],
    ["too many filters", stream("[/AHx /AHx /AHx /AHx /AHx]", toBytes("00>")), /more than 4 filters/],
  ];
  for (const [what, obj, reason] of cases)
    it(`names ${what} and never throws`, async () => {
      const file = await holding([obj]);
      expect(await streamData(file, file.objects.get(20) as PdfStream)).toBeNull();
      expect(file.unread.join(" ")).toMatch(reason);
    });
});

describe("empty-password RC4", () => {
  for (const revision of [2, 3])
    it(`opens a revision ${revision} file, reading its strings, page content and metadata`, async () => {
      const file = await readPdf(fixture(`rc4-r${revision}.pdf`));
      expect(file.decrypted).toBe(true);
      expect(file.encrypted).toBe(false);
      expect(file.unread).toEqual([]);
      expect(info(file, "Title")).toBe("Payment INV-2026-0412");
      expect(info(file, "Creator")).toBe("KestrelStatements 4.2");
      expect(info(file, "CreationDate")).toBe("D:20261020101500+02'00'");
      expect(await pageText(file)).toEqual(POP_TEXT);
      expect(await xmp(file)).toContain("Payment INV-2026-0412");
      const r = await analysePdf(fixture(`rc4-r${revision}.pdf`));
      expect(r.findings).toEqual([]);
      expect(r.unread).toEqual([]);
      allRan(r);
    });

  for (const revision of [2, 3])
    it(`finds a revision ${revision} file's later save and decrypts the revision it replaced`, async () => {
      const bytes = fixture(`rc4-r${revision}-edited.pdf`);
      const r = await analysePdf(bytes);
      expect(r.findings.map((f) => f.kind)).toEqual(["revisions"]);
      expect(r.unread).toEqual([]);
      allRan(r);
      const file = await readPdf(bytes);
      expect(file.sections).toHaveLength(2);
      const pages = dictOf(file, dictOf(file, file.trailer?.entries.get("Root"))?.entries.get("Pages"));
      const kids = resolve(file, pages?.entries.get("Kids"));
      const first = Array.isArray(kids) ? dictOf(file, kids[0]) : null;
      const ref = first?.entries.get("Contents") as { num: number };
      const current = file.objects.get(ref.num);
      const earlier = await definitionAt(file, 1, ref.num);
      if (!isStream(current) || !isStream(earlier)) throw new Error("no content streams");
      const now = byteString((await streamData(file, current)) ?? new Uint8Array());
      const before = byteString((await streamData(file, earlier)) ?? new Uint8Array());
      // The earlier revision is Ghostscript's own encryption, decrypted through definitionAt: real content operators.
      expect(before).toMatch(/BT[\s\S]*Tj|BT[\s\S]*TJ/);
      expect(now.startsWith(before)).toBe(true);
      expect(now).toMatch(/\(112 450\.00\) Tj ET Q$/);
      expect(await pageText(file)).toContain("112 450.00");
      // An object as the first revision defined it, its strings decrypted under its own key.
      const infoRef = file.trailer?.entries.get("Info") as { num: number };
      const original = await definitionAt(file, 1, infoRef.num);
      expect(textOf(dictOf(file, original ?? undefined)?.entries.get("Title"))).toBe("Payment INV-2026-0412");
    });

  it("never guesses a password: a file that needs one stays unread, named, its checks unavailable", async () => {
    const file = await readPdf(fixture("rc4-password.pdf"));
    expect(file.encrypted).toBe(true);
    expect(file.decrypted).toBe(false);
    expect(file.unread).toEqual([
      "the file is encrypted, so its text and metadata were not read (it needs a password to open)",
    ]);
    const r = await analysePdf(fixture("rc4-password.pdf"));
    // Its ciphertext is never decoded as data, which would add reasons that are not the cause.
    expect(r.unread).toEqual(file.unread);
    for (const k of ["producer", "dates", "fonts", "overlay"] as const)
      expect(r.coverage[k].status).toBe("unavailable");
  });

  it("compares a password file's revisions without decoding its ciphertext as data", async () => {
    const base = fixture("rc4-password.pdf");
    const file = await readPdf(base);
    const pages = dictOf(file, dictOf(file, file.trailer?.entries.get("Root"))?.entries.get("Pages"));
    const kids = resolve(file, pages?.entries.get("Kids"));
    const page = Array.isArray(kids) ? dictOf(file, kids[0]) : null;
    const ref = page?.entries.get("Contents") as { num: number };
    const encrypt = file.trailer?.entries.get("Encrypt") as { num: number };
    const ids = file.trailer?.entries.get("ID");
    const id = Array.isArray(ids) && ids[0] && typeof ids[0] === "object" && "bytes" in ids[0] ? ids[0].bytes : "";
    const hex = Buffer.from(toBytes(id)).toString("hex");
    const updated = await appendUpdate(base, {
      objects: {
        [ref.num]: { dict: "<<>>", stream: "a later save, under a key this reader does not have", compress: true },
      },
      root: refNum(file, "Root"),
      info: refNum(file, "Info"),
      size: file.trailer?.entries.get("Size") as number,
      trailerExtra: ` /Encrypt ${encrypt.num} 0 R /ID [<${hex}> <${hex}>]`,
    });
    const r = await analysePdf(updated);
    expect(r.unread).toEqual([
      "the file is encrypted, so its text and metadata were not read (it needs a password to open)",
    ]);
  });

  // A file whose last startxref points nowhere, so the reader scans for its objects (round 1).
  const unchained = (bytes: Uint8Array) => {
    const text = byteString(bytes);
    const at = text.lastIndexOf("startxref");
    return toBytes(text.slice(0, at) + text.slice(at).replace(/startxref\s+\d+/, "startxref\n0"));
  };

  it("keeps a scanned password file encrypted and named, never reading its ciphertext as data (round 1)", async () => {
    const file = await readPdf(unchained(fixture("rc4-password.pdf")));
    expect(file.scanned).toBe(true);
    expect(file.encrypted).toBe(true);
    expect(file.unread.join(" ")).toMatch(/needs a password to open/);
    const r = await analysePdf(unchained(fixture("rc4-password.pdf")));
    for (const k of ["producer", "dates", "fonts", "overlay"] as const)
      expect(r.coverage[k].status).toBe("unavailable");
  });

  for (const revision of [2, 3])
    it(`opens a scanned revision ${revision} file, decrypting each object once (round 1)`, async () => {
      const file = await readPdf(unchained(fixture(`rc4-r${revision}.pdf`)));
      expect(file.scanned).toBe(true);
      expect(file.decrypted).toBe(true);
      expect(info(file, "Title")).toBe("Payment INV-2026-0412");
      expect(await pageText(file)).toEqual(POP_TEXT);
    });

  it("refuses a revision 3 /U shorter than its 32 bytes, though its first 16 authenticate (round 1)", async () => {
    // rc4-r3.pdf with /U cut to its first 16 bytes, written as hex in the same length so every offset still holds.
    const text = byteString(fixture("rc4-r3.pdf"));
    const start = text.indexOf("/U", text.indexOf("/Filter /Standard")) + 2;
    let i = text.indexOf("(", start);
    const open = i;
    const bytes: number[] = [];
    for (let depth = 0, done = false; !done; i++) {
      const c = text[i] as string;
      if (c === "\\") {
        const n = text[++i] as string;
        if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(text[i + 1] as string)) oct += text[++i];
          bytes.push(Number.parseInt(oct, 8));
        } else bytes.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 } as Record<string, number>)[n] ?? n.charCodeAt(0));
      } else if (c === "(") {
        if (depth++ > 0) bytes.push(40);
      } else if (c === ")") {
        if (--depth === 0) done = true;
        else bytes.push(41);
      } else if (depth > 0) bytes.push(c.charCodeAt(0));
    }
    expect(bytes).toHaveLength(32);
    const hex = `<${Buffer.from(bytes.slice(0, 16)).toString("hex")}>`;
    expect(hex.length).toBeLessThanOrEqual(i - open);
    const cut = toBytes(text.slice(0, open) + hex.padEnd(i - open, " ") + text.slice(i));
    const file = await readPdf(cut);
    expect(file.decrypted).toBe(false);
    expect(file.encrypted).toBe(true);
    expect(file.unread.join(" ")).toMatch(/malformed/);
  });

  const refused: [string, string, RegExp][] = [
    ["a malformed dictionary", "<</Filter /Standard /V 2 /R 3 /Length 128 /O (short) /U (short) /P -4>>", /malformed/],
    [
      "a key length out of range",
      `<</Filter /Standard /V 2 /R 3 /Length 256 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4>>`,
      /malformed/,
    ],
    ["another security handler", "<</Filter /Adobe.PubSec /V 2 /R 3>>", /other than the standard one/],
    [
      "an unknown revision",
      `<</Filter /Standard /V 3 /R 5 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4>>`,
      /AES|unsupported/,
    ],
    [
      "revision 1",
      `<</Filter /Standard /V 0 /R 1 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4>>`,
      /unsupported encryption version/,
    ],
    // D06 T02 §6, correction 10: malformed AES dictionaries.
    [
      "revision 5",
      `<</Filter /Standard /V 5 /R 5 /CF <</StdCF <</CFM /AESV3>>>> /StmF /StdCF /StrF /StdCF /O <${"00".repeat(48)}> /U <${"00".repeat(48)}> /UE <${"00".repeat(32)}> /OE <${"00".repeat(32)}> /P -4>>`,
      /unsupported encryption version/,
    ],
    [
      "a revision 6 /UE of the wrong length",
      `<</Filter /Standard /V 5 /R 6 /CF <</StdCF <</CFM /AESV3>>>> /StmF /StdCF /StrF /StdCF /O <${"00".repeat(48)}> /U <${"00".repeat(48)}> /UE <${"00".repeat(16)}> /P -4>>`,
      /malformed/,
    ],
    [
      "a revision 6 /U of the wrong length",
      `<</Filter /Standard /V 5 /R 6 /CF <</StdCF <</CFM /AESV3>>>> /StmF /StdCF /StrF /StdCF /O <${"00".repeat(48)}> /U <${"00".repeat(32)}> /UE <${"00".repeat(32)}> /P -4>>`,
      /malformed/,
    ],
    [
      "a stream filter with no /CF",
      `<</Filter /Standard /V 4 /R 4 /StmF /StdCF /StrF /StdCF /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4>>`,
      /a crypt filter its encryption dictionary does not define/,
    ],
    [
      "a crypt filter method not read",
      `<</Filter /Standard /V 4 /R 4 /CF <</StdCF <</CFM /AESV9>>>> /StmF /StdCF /StrF /StdCF /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4>>`,
      /a crypt filter method not read here/,
    ],
    // AES is read since D06 T02 §6: a revision 4 dictionary the empty password does not open needs one.
    [
      "an AES-128 file the empty password does not open",
      `<</Filter /Standard /V 4 /R 4 /CF <</StdCF <</CFM /AESV2 /Length 16>>>> /StmF /StdCF /StrF /StdCF /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4>>`,
      /it needs a password to open/,
    ],
  ];
  for (const [what, dict, reason] of refused)
    it(`refuses ${what} by name, with no clean coverage`, async () => {
      const bytes = await buildPdf({
        objects: { 2: "<</Type /Catalog /Pages 3 0 R>>", 3: "<</Type /Pages /Kids [] /Count 0>>", 4: dict },
        root: 2,
        size: 5,
        trailerExtra: " /Encrypt 4 0 R /ID [<0011> <0011>]",
      });
      const file = await readPdf(bytes);
      expect(file.encrypted).toBe(true);
      expect(file.unread.join(" ")).toMatch(reason);
      const r = await analysePdf(bytes);
      for (const k of ["producer", "dates", "fonts", "overlay"] as const)
        expect(r.coverage[k].status).toBe("unavailable");
    });

  it("derives MD5 as Node's crypto does and RC4 as its published vector", async () => {
    for (const s of ["", "a", "message digest", "x".repeat(1000)]) {
      const node = new Uint8Array(createHash("md5").update(s).digest());
      expect(await md5(toBytes(s))).toEqual(node);
    }
    // RC4 test vector: key "Key", plaintext "Plaintext".
    expect(Buffer.from(rc4(toBytes("Key"), toBytes("Plaintext"))).toString("hex")).toBe("bbf316e8d940af0ad3");
  });
});

// D06 T02 §6: AES files with an empty user password, encrypted by qpdf 12.4.2 through pikepdf
// (test/node/make-pdf-aes.py), read to the plain twin they were made from (gs-genuine-pop.pdf).
describe("empty-password AES", () => {
  const plain = generated["gs-genuine-pop.pdf"];
  const kinds = async (bytes: Uint8Array) => (await analysePdf(bytes)).findings.map((f) => f.kind).sort();

  for (const name of ["aes-r4", "aes-r6", "aes-r4-nometa", "aes-r6-nometa", "aes-r4-objstm", "aes-r6-objstm"])
    it(`opens ${name}.pdf, reading its strings, page content and metadata as the plain twin's`, async () => {
      const file = await readPdf(fixture(`${name}.pdf`));
      const twin = await readPdf(plain);
      expect(file.decrypted).toBe(true);
      expect(file.encrypted).toBe(false);
      expect(file.unread).toEqual([]);
      for (const k of ["Title", "Creator", "Producer", "CreationDate", "ModDate"])
        expect(info(file, k), k).toBe(info(twin, k));
      expect(await pageText(file)).toEqual(await pageText(twin));
      expect(await xmp(file)).toBe(await xmp(twin));
      const r = await analysePdf(fixture(`${name}.pdf`));
      expect(r.findings.map((f) => f.kind).sort()).toEqual(await kinds(plain));
      expect(r.unread).toEqual([]);
      allRan(r);
    });

  for (const revision of [4, 6])
    it(`finds a revision ${revision} file's later edit and decrypts the revision it replaced`, async () => {
      const bytes = fixture(`aes-r${revision}-edited.pdf`);
      const r = await analysePdf(bytes);
      expect(r.findings.map((f) => f.kind)).toContain("revisions");
      expect(r.unread).toEqual([]);
      allRan(r);
      const file = await readPdf(bytes);
      expect(file.sections).toHaveLength(2);
      const pages = dictOf(file, dictOf(file, file.trailer?.entries.get("Root"))?.entries.get("Pages"));
      const kids = resolve(file, pages?.entries.get("Kids"));
      const first = Array.isArray(kids) ? dictOf(file, kids[0]) : null;
      const ref = first?.entries.get("Contents") as { num: number };
      const current = file.objects.get(ref.num);
      const earlier = await definitionAt(file, 1, ref.num);
      if (!isStream(current) || !isStream(earlier)) throw new Error("no content streams");
      const now = byteString((await streamData(file, current)) ?? new Uint8Array());
      const before = byteString((await streamData(file, earlier)) ?? new Uint8Array());
      // The earlier revision is qpdf's own AES, decrypted through definitionAt: real content operators.
      expect(before).toMatch(/BT[\s\S]*Tj|BT[\s\S]*TJ/);
      expect(now.startsWith(before)).toBe(true);
      expect(now).toMatch(/\(112 450\.00\) Tj ET Q$/);
      expect(await pageText(file)).toContain("112 450.00");
      const infoRef = file.trailer?.entries.get("Info") as { num: number };
      const original = await definitionAt(file, 1, infoRef.num);
      expect(textOf(dictOf(file, original ?? undefined)?.entries.get("Title"))).toBe("Payment INV-2026-0412");
    });

  for (const revision of [4, 6])
    it(`reads a revision ${revision} file saved again with its own Info as the same save of the plain twin`, async () => {
      const bytes = fixture(`aes-r${revision}-resaved.pdf`);
      const file = await readPdf(bytes);
      expect(file.sections).toHaveLength(2);
      expect(file.unread).toEqual([]);
      const infoRef = file.trailer?.entries.get("Info") as { num: number };
      const before = dictOf(file, (await definitionAt(file, 1, infoRef.num)) ?? undefined);
      const now = dictOf(file, file.objects.get(infoRef.num));
      for (const k of ["Title", "Creator", "Producer", "CreationDate", "ModDate"])
        expect(textOf(now?.entries.get(k)), k).toBe(textOf(before?.entries.get(k)));
      // The same save on the plain twin: its Info object written again, unchanged, in one update.
      const twin = await readPdf(plain);
      const twinInfo = twin.trailer?.entries.get("Info") as { num: number };
      const values = dictOf(twin, twin.objects.get(twinInfo.num));
      const entries = [...(values?.entries ?? [])].map(([k, v]) => `/${k} (${textOf(v)})`).join(" ");
      const root = twin.trailer?.entries.get("Root") as { num: number } | undefined;
      if (!root) throw new Error("the plain twin has no Root");
      const resaved = await appendUpdate(plain, {
        objects: { [twinInfo.num]: `<<${entries}>>` },
        root: root.num,
        info: twinInfo.num,
        size: twin.trailer?.entries.get("Size") as number,
      });
      expect(await kinds(bytes)).toEqual(await kinds(resaved));
      allRan(await analysePdf(bytes));
    });

  // Completion review gap 6: objects packed by qpdf in an object stream, their strings decrypted once, through the
  // container, and an earlier definition that was packed read back after a later save redefined it directly.
  for (const revision of [4, 6])
    it(`reads a revision ${revision} object-stream file's packed Info as it was before a later save`, async () => {
      const bytes = fixture(`aes-r${revision}-objstm-resaved.pdf`);
      const file = await readPdf(bytes);
      expect(file.sections).toHaveLength(2);
      expect(file.unread).toEqual([]);
      const twin = await readPdf(plain);
      const infoRef = file.trailer?.entries.get("Info") as { num: number };
      const before = dictOf(file, (await definitionAt(file, 1, infoRef.num)) ?? undefined);
      const now = dictOf(file, file.objects.get(infoRef.num));
      for (const k of ["Title", "Creator", "Producer", "CreationDate", "ModDate"]) {
        expect(textOf(before?.entries.get(k)), k).toBe(info(twin, k));
        expect(textOf(now?.entries.get(k)), k).toBe(info(twin, k));
      }
      expect(await pageText(file)).toEqual(await pageText(twin));
      allRan(await analysePdf(bytes));
    });

  // Completion review gap 5: revision 6's /Perms checked against the dictionary; a file whose /Perms is missing, not
  // one block, damaged or at odds with /P still opens, as qpdf opens it, and is named, never a clean read.
  it("names a crypt filter entry that is not a dictionary as malformed, never reading it as Identity (round 1)", async () => {
    const original = byteString(fixture("aes-r4.pdf"));
    const entry = /\/StdCF << \/AuthEvent \/DocOpen \/CFM \/AESV2 \/Length 16 >>/.exec(original)?.[0] as string;
    expect(entry).toBeDefined();
    const text = original.replace(entry, "/StdCF null".padEnd(entry.length, " "));
    const file = await readPdf(toBytes(text));
    expect(file.encrypted).toBe(true);
    expect(file.unread).toEqual([
      "the file is encrypted, so its text and metadata were not read (its encryption dictionary is malformed)",
    ]);
  });

  // Round 1: a signature dictionary's /Contents is never encrypted (ISO 32000-2 7.6.2), in an AES file or an RC4 one,
  // with /Type /Sig or with /Type left out.
  for (const name of ["aes-r6.pdf", "aes-r4.pdf", "rc4-r3.pdf"])
    for (const typed of [true, false])
      it(`keeps a signature's /Contents as stored in ${name} (${typed ? "/Type /Sig" : "no /Type"})`, async () => {
        const base = fixture(name);
        const file0 = await readPdf(base);
        const ids = file0.trailer?.entries.get("ID");
        const id = Array.isArray(ids) && ids[0] && typeof ids[0] === "object" && "bytes" in ids[0] ? ids[0].bytes : "";
        const hex = Buffer.from(toBytes(id)).toString("hex");
        const size = file0.trailer?.entries.get("Size") as number;
        const contents = "00".repeat(8192);
        const bytes = await appendUpdate(base, {
          objects: {
            [size]: `<<${typed ? "/Type /Sig " : ""}/Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20 30] /Contents <${contents}>>>`,
          },
          root: refNum(file0, "Root"),
          info: refNum(file0, "Info"),
          size: size + 1,
          trailerExtra: ` /Encrypt ${refNum(file0, "Encrypt")} 0 R /ID [<${hex}> <${hex}>]`,
        });
        const file = await readPdf(bytes);
        expect(file.unread).toEqual([]);
        const sig = dictOf(file, file.objects.get(size));
        const kept = sig?.entries.get("Contents") as { bytes: string } | undefined;
        expect(kept?.bytes).toBe("\0".repeat(8192));
        expect((await analysePdf(bytes)).unread).toEqual([]);
      });

  it("names a revision 6 file whose /Perms is missing, short, damaged or disagrees with /P", async () => {
    const original = byteString(fixture("aes-r6.pdf"));
    const perms = /\/Perms <([0-9a-f]{32})>/.exec(original);
    expect(perms).not.toBeNull();
    const whole = perms?.[0] as string;
    const same = (s: string) => s.padEnd(whole.length, " ");
    const cases: [string, string][] = [
      ["missing", original.replace(whole, same(""))],
      ["short", original.replace(whole, same("/Perms <00112233>"))],
      ["damaged", original.replace(whole, same(`/Perms <${"00".repeat(16)}>`))],
      ["at odds with /P", original.replace("/P -1028", "/P -1032")],
    ];
    for (const [what, text] of cases) {
      expect(text.length, what).toBe(original.length);
      const bytes = toBytes(text);
      const file = await readPdf(bytes);
      expect(file.decrypted, what).toBe(true);
      expect(file.unread, what).toEqual([
        "its permissions (/Perms) are missing or do not match its encryption dictionary",
      ]);
      expect(await pageText(file), what).toEqual(await pageText(await readPdf(plain)));
      const r = await analysePdf(bytes);
      expect(r.unread, what).toContain(
        "its permissions (/Perms) are missing or do not match its encryption dictionary",
      );
    }
  });

  it("never guesses a password: an AES-256 file that needs one stays unread, named, its checks unavailable", async () => {
    const file = await readPdf(fixture("aes-password.pdf"));
    expect(file.encrypted).toBe(true);
    expect(file.decrypted).toBe(false);
    expect(file.unread).toEqual([
      "the file is encrypted, so its text and metadata were not read (it needs a password to open)",
    ]);
    const r = await analysePdf(fixture("aes-password.pdf"));
    expect(r.unread).toEqual(file.unread);
    for (const k of ["producer", "dates", "fonts", "overlay"] as const)
      expect(r.coverage[k].status).toBe("unavailable");
  });
});

// D06 T02 §6, correction 9: crypt filters chosen before decryption.
describe("AES crypt filters", () => {
  const plain = generated["gs-genuine-pop.pdf"];
  for (const name of ["aes-r4-strings-only", "aes-r4-crypt-identity"])
    it(`reads ${name}.pdf, its streams stored as is where its filters say, to the plain twin`, async () => {
      const file = await readPdf(fixture(`${name}.pdf`));
      const twin = await readPdf(plain);
      expect(file.decrypted).toBe(true);
      expect(file.unread).toEqual([]);
      expect(info(file, "Title")).toBe(info(twin, "Title"));
      expect(await pageText(file)).toEqual(await pageText(twin));
      allRan(await analysePdf(fixture(`${name}.pdf`)));
    });

  it("names malformed crypt filter parameters on a stream, never reading its data as Identity (round 2)", async () => {
    const original = byteString(fixture("aes-r4-crypt-identity.pdf"));
    const parms = "<< /Type /CryptFilterDecodeParms /Name /Identity >>";
    expect(original).toContain(parms);
    const bytes = toBytes(original.replace(parms, "42".padEnd(parms.length, " ")));
    const r = await analysePdf(bytes);
    expect(r.unread).toContain("a stream's crypt filter parameters are malformed");
    const file = await readPdf(bytes);
    const pages = dictOf(file, dictOf(file, file.trailer?.entries.get("Root"))?.entries.get("Pages"));
    const kids = resolve(file, pages?.entries.get("Kids"));
    const page = Array.isArray(kids) ? dictOf(file, kids[0]) : null;
    const ref = page?.entries.get("Contents") as { num: number } | undefined;
    if (!ref) throw new Error("no page content");
    const contents = file.objects.get(ref.num) as PdfStream;
    expect(await streamData(file, contents)).toBeNull();
  });

  it("names a stream filter its encryption dictionary does not define, never decoding the file as data", async () => {
    const file = await readPdf(fixture("aes-r4-unknown-filter.pdf"));
    expect(file.encrypted).toBe(true);
    expect(file.unread).toEqual([
      "the file is encrypted, so its text and metadata were not read (a crypt filter its encryption dictionary does not define)",
    ]);
    const r = await analysePdf(fixture("aes-r4-unknown-filter.pdf"));
    for (const k of ["producer", "dates", "fonts", "overlay"] as const)
      expect(r.coverage[k].status).toBe("unavailable");
  });
});

// D06 T02 §6, correction 10: AES decryption charged to the shared budget, and damaged AES data named, never thrown.
describe("AES work and damage", () => {
  // A string's or stream's AES data sealed as the file would be: AES-128 under the object's key, AES-256 under the file
  // key, through Web Crypto (a 16-byte IV, then CBC with PKCS#7 padding).
  async function seal(file: Awaited<ReturnType<typeof readPdf>>, num: number, data: Uint8Array): Promise<Uint8Array> {
    const crypt = file.crypt;
    if (!crypt) throw new Error("not opened");
    const key = crypt.strings === "aesv3" ? crypt.key : await objectKey(crypt.key, num, 0, true);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "AES-CBC" }, false, [
      "encrypt",
    ]);
    const out = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, data as Uint8Array<ArrayBuffer>),
    );
    const sealed = new Uint8Array(16 + out.length);
    sealed.set(iv);
    sealed.set(out, 16);
    return sealed;
  }
  // One later save on an AES fixture, keeping its encryption.
  async function update(name: string, objects: Record<number, Obj>) {
    const base = fixture(name);
    const file0 = await readPdf(base);
    const ids = file0.trailer?.entries.get("ID");
    const id = Array.isArray(ids) && ids[0] && typeof ids[0] === "object" && "bytes" in ids[0] ? ids[0].bytes : "";
    const hex = Buffer.from(toBytes(id)).toString("hex");
    const size = file0.trailer?.entries.get("Size") as number;
    return appendUpdate(base, {
      objects,
      root: refNum(file0, "Root"),
      info: refNum(file0, "Info"),
      size: Math.max(size, ...Object.keys(objects).map((k) => Number(k) + 1)),
      trailerExtra: ` /Encrypt ${refNum(file0, "Encrypt")} 0 R /ID [<${hex}> <${hex}>]`,
    });
  }
  const opened = async (name: string) => readPdf(fixture(name));

  for (const name of ["aes-r4.pdf", "aes-r6.pdf"]) {
    it(`charges decrypting a 1 MiB stream drawn again and again in ${name}, stopping at the cap`, async () => {
      const file0 = await opened(name);
      const size = file0.trailer?.entries.get("Size") as number;
      const bytes = await update(name, {
        [size]: { dict: "<<>>", stream: await seal(file0, size, new Uint8Array(1024 * 1024).fill(0x41)) },
      });
      const file = await readPdf(bytes);
      const big = file.objects.get(size) as PdfStream;
      let read = 0;
      for (let i = 0; i < 60; i++) if (await streamData(file, big)) read++;
      expect(read).toBeGreaterThan(40);
      expect(read).toBeLessThan(48);
      expect(file.budget.decoded).toBeLessThanOrEqual(MAX_TOTAL_DECODED);
      expect(file.unread.join(" ")).toMatch(/past 48 MiB was not read/);
    });

    it(`charges decrypting a 768 KiB string read again and again in ${name}, stopping with OverBudget`, async () => {
      const file0 = await opened(name);
      const size = file0.trailer?.entries.get("Size") as number;
      // Under the lexer's 1 MiB hex string cap, so the object is read and each read decrypts it.
      const hex = Buffer.from(await seal(file0, size, new Uint8Array(768 * 1024).fill(0x41))).toString("hex");
      const file = await readPdf(await update(name, { [size]: `<</Junk <${hex}>>>` }));
      let reads = 0;
      let stopped: unknown = null;
      for (let i = 0; i < 100 && !stopped; i++) {
        try {
          await definitionAt(file, 0, size);
          reads++;
        } catch (error) {
          stopped = error;
        }
      }
      expect(stopped).toBeInstanceOf(OverBudget);
      expect(reads).toBeLessThan(65);
    });

    it(`names damaged AES data in ${name} and never throws: a short IV, part blocks, failed padding, a damaged string`, async () => {
      const file0 = await opened(name);
      const contents = (() => {
        const pages = dictOf(file0, dictOf(file0, file0.trailer?.entries.get("Root"))?.entries.get("Pages"));
        const kids = resolve(file0, pages?.entries.get("Kids"));
        const page = Array.isArray(kids) ? dictOf(file0, kids[0]) : null;
        const ref = page?.entries.get("Contents") as { num: number } | undefined;
        if (!ref) throw new Error("no page content");
        return ref.num;
      })();
      // One block whose plaintext ends in 0x00, which no PKCS#7 padding does: the first block of sealing 16 zero bytes.
      const zeros = await seal(file0, contents, new Uint8Array(16));
      const badPadding = zeros.subarray(0, 32);
      const infoNum = refNum(file0, "Info");
      for (const [what, data] of [
        ["a short IV", new Uint8Array(8)],
        ["part blocks", new Uint8Array(16 + 15)],
        ["failed padding", badPadding],
      ] as const) {
        const bytes = await update(name, { [contents]: { dict: "<</Filter /FlateDecode>>", stream: data } });
        const file = await readPdf(bytes);
        expect(file.unread, what).toEqual([]);
        const r = await analysePdf(bytes);
        expect(r.unread.join(" "), what).toMatch(/a stream could not be decrypted \(its encrypted data is damaged\)/);
        expect(r.unread.length, what).toBeGreaterThan(0);
      }
      const bytes = await update(name, { [infoNum]: "<</Title <0011223344556677>>>" });
      const file = await readPdf(bytes);
      expect(file.unread.join(" ")).toMatch(/a string could not be decrypted/);
      expect((await analysePdf(bytes)).unread.length).toBeGreaterThan(0);
    });
  }
});

// D06 T02 §6, completion review excellence item 2: the reader's side of the timing comparison with qpdf
// (test/node/bench-pdf-aes.py), the same files and work: opened with the empty password, every string decrypted and
// every stream read, 30 times. The figures are recorded in docs/frontier-log.md; the bound here is a backstop only.
describe("AES reading time", () => {
  it("opens and reads the AES files, logging p50 and p95", async () => {
    for (const name of ["aes-r4.pdf", "aes-r6.pdf", "aes-r6-edited.pdf", "aes-r6-objstm-resaved.pdf"]) {
      const bytes = fixture(name);
      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        const file = await readPdf(bytes);
        for (const value of file.objects.values()) if (isStream(value)) await streamData(file, value);
        times.push(performance.now() - start);
        expect(file.unread, name).toEqual([]);
      }
      times.sort((a, b) => a - b);
      const p50 = times[15] as number;
      const p95 = times[Math.ceil(times.length * 0.95) - 1] as number;
      console.log(JSON.stringify({ event: "aes-timing", reader: "isitlegit", file: name, p50, p95 }));
      expect(p95, name).toBeLessThan(2000);
    }
  });
});
