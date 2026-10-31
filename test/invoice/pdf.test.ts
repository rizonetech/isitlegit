// The bounded PDF reader (D06 T02 §1): the cross-reference chain decides which definition of an object is current, a
// damaged chain falls back to a scan that says so, and every hostile or unsupported input ends as a named reason.
import { describe, expect, it } from "vitest";
import { dictOf, inflate, MAX_PDF_BYTES, readPdf, resolve, textOf } from "../../src/invoice/pdf";
import { BANK_INFO, editedPop, genuinePop, infoDict, makeDoc, POP_LINES } from "./forensics-fixtures";
import { appendUpdate, buildPdf, deflate, latin1, toBytes } from "./pdf-writer";

const producerOf = async (bytes: Uint8Array) => {
  const file = await readPdf(bytes);
  return textOf(resolve(file, dictOf(file, file.trailer?.entries.get("Info"))?.entries.get("Producer")));
};

describe("readPdf", () => {
  it("reads the same document through a table, a cross-reference stream with object streams, and a hybrid file", async () => {
    for (const xref of ["table", "stream", "stream-predictor", "hybrid"] as const) {
      const bytes = await makeDoc({ lines: POP_LINES, info: BANK_INFO, xref });
      const file = await readPdf(bytes);
      expect(file.unread, xref).toEqual([]);
      expect(file.scanned).toBe(false);
      expect(await producerOf(bytes), xref).toBe("KestrelStatements 4.2");
      expect(dictOf(file, file.trailer?.entries.get("Root"))?.entries.has("Pages"), xref).toBe(true);
    }
  });

  it("resolves a replaced object to its newer definition and a freed one to nothing", async () => {
    const edited = await appendUpdate(await genuinePop(), {
      objects: { 6: infoDict({ producer: "Replaced" }) },
      root: 2,
      info: 6,
      size: 12,
      freed: [9],
    });
    const file = await readPdf(edited);
    expect(file.sections).toHaveLength(2);
    expect(await producerOf(edited)).toBe("Replaced");
    // Object 9 was never written; object 7 (the font) was, and survives the update.
    expect(file.objects.has(9)).toBe(false);
    expect(file.objects.has(7)).toBe(true);
  });

  it("frees an object an update deletes, even though its old bytes are still in the file", async () => {
    const edited = await appendUpdate(await genuinePop(), { objects: {}, root: 2, info: 6, size: 12, freed: [7] });
    const file = await readPdf(edited);
    expect(file.objects.has(7)).toBe(false);
    expect(file.text.includes("/BaseFont /Helvetica")).toBe(true);
  });

  it("never reads object headers or end markers inside a stream as objects or revisions", async () => {
    const decoy = "99 0 obj\n<</Producer (Decoy)>>\nendobj\n%%EOF\nstartxref\n0\n%%EOF\n";
    const bytes = await makeDoc({
      lines: POP_LINES,
      info: BANK_INFO,
      objects: { 11: { dict: "<<>>", stream: decoy } },
    });
    const file = await readPdf(bytes);
    expect(file.objects.has(99)).toBe(false);
    expect(file.sections).toHaveLength(1);
  });

  it("falls back to a scan with a reason when the chain is damaged, the newest definition winning", async () => {
    const bytes = await editedPop();
    const text = latin1(bytes);
    const broken = toBytes(text.replace(/startxref\s+\d+\s+%%EOF\s*$/, "startxref\n999999999\n%%EOF\n"));
    const file = await readPdf(broken);
    expect(file.scanned).toBe(true);
    expect(file.unread.join(" ")).toMatch(/cross-reference section is damaged/);
    expect(await producerOf(broken)).toBe("KestrelStatements 4.2");
  });

  it("names an encrypted file, an unsupported filter, a TIFF predictor and a damaged stream, and never throws", async () => {
    const encrypted = await buildPdf({
      objects: {
        2: "<</Type /Catalog /Pages 3 0 R>>",
        3: "<</Type /Pages /Kids [] /Count 0>>",
        4: "<</Filter /Standard /V 2>>",
      },
      root: 2,
      size: 5,
      trailerExtra: " /Encrypt 4 0 R /ID [<00> <00>]",
    });
    expect((await readPdf(encrypted)).unread.join(" ")).toMatch(/encrypted/);

    const withFilter = (dict: string, data: Uint8Array) =>
      buildPdf({
        objects: {
          2: "<</Type /Catalog /Pages 3 0 R /Metadata 5 0 R>>",
          3: "<</Type /Pages /Kids [] /Count 0>>",
          5: { dict, stream: data },
        },
        root: 2,
        size: 6,
      });
    // LZW and TIFF prediction are read since D06 T02 §5; a filter still not read (JBIG2) and a TIFF depth the standard
    // does not permit (3 bits) are named.
    const lzw = await readPdf(await withFilter("<</Type /Metadata /Filter /JBIG2Decode>>", toBytes("x")));
    const { streamData } = await import("../../src/invoice/pdf");
    const meta = (f: typeof lzw) => resolve(f, dictOf(f, f.trailer?.entries.get("Root"))?.entries.get("Metadata"));
    expect(await streamData(lzw, meta(lzw) as never)).toBeNull();
    expect(lzw.unread.join(" ")).toMatch(/filter that is not read \(JBIG2Decode\)/);

    const tiff = await readPdf(
      await withFilter(
        "<</Type /Metadata /Filter /FlateDecode /DecodeParms <</Predictor 2 /BitsPerComponent 3>>>>",
        await deflate(toBytes("x")),
      ),
    );
    expect(await streamData(tiff, meta(tiff) as never)).toBeNull();
    expect(tiff.unread.join(" ")).toMatch(/TIFF prediction is not read/);

    const damaged = await readPdf(
      await withFilter("<</Type /Metadata /Filter /FlateDecode>>", toBytes("not zlib at all")),
    );
    expect(await streamData(damaged, meta(damaged) as never)).toBeNull();
    expect(damaged.unread.join(" ")).toMatch(/compressed stream is damaged/);
  });

  it("names a truncated object, a reference to a missing object, a file with no header and one over the limit", async () => {
    const bytes = await genuinePop();
    const text = latin1(bytes);
    // Object 7, the font, cut off mid-dictionary: its offset still points at it.
    const truncated = toBytes(
      text.replace("/BaseFont /Helvetica /Encoding /WinAnsiEncoding>>", "/BaseFont /Helvetica"),
    );
    const file = await readPdf(truncated);
    expect(file.unread.join(" ")).toMatch(/could not be read/);
    const missing = await readPdf(
      await makeDoc({ lines: POP_LINES, objects: { 3: "<</Type /Pages /Kids [4 0 R 40 0 R] /Count 2>>" } }),
    );
    expect(resolve(missing, { kind: "ref", num: 40, gen: 0 })).toBeUndefined();
    expect((await readPdf(toBytes("hello"))).unread).toEqual(["the file has no PDF header"]);
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    expect((await readPdf(big)).unread).toEqual(["the file is larger than 25 MiB"]);
  });

  it("stops inflating at its limit, so a decompression bomb costs at most that", async () => {
    const bomb = await deflate(new Uint8Array(16 * 1024 * 1024));
    expect(await inflate(bomb, 1024 * 1024)).toBe("too-large");
  });
});
