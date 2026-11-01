import { describe, expect, it } from "vitest";
import { sniff } from "../../src/intake/sniff";
import { zip } from "../fixtures/attachments/archives";

// D01 T03 §13: a Word, Excel or PowerPoint file is taken as a document from its bytes (its ZIP central directory),
// and everything that only looks like one is refused.
const enc = (text: string) => new TextEncoder().encode(text);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const pkg = (part: string, more: { name: string; data?: Uint8Array }[] = []) =>
  zip([{ name: "[Content_Types].xml", data: enc("<Types/>") }, { name: part, data: enc("<x/>") }, ...more]);

describe("sniffing an Office document", () => {
  it("takes each kind by its central directory, whatever it is called", () => {
    expect(sniff(pkg("word/document.xml"))).toEqual({ kind: "document", mediaType: DOCX });
    expect(sniff(pkg("xl/workbook.xml"))).toEqual({ kind: "document", mediaType: XLSX });
    expect(sniff(pkg("ppt/presentation.xml"))).toEqual({ kind: "document", mediaType: PPTX });
  });

  it("refuses a plain ZIP, and one without the content-types part", () => {
    expect(sniff(zip([{ name: "readme.txt", data: enc("hi") }]))).toMatchObject({ refused: expect.any(String) });
    expect(sniff(zip([{ name: "word/document.xml", data: enc("<x/>") }]))).toMatchObject({
      refused: expect.any(String),
    });
  });

  it("refuses a macro package, wherever its macro part sits", () => {
    expect(sniff(pkg("word/document.xml", [{ name: "word/vbaProject.bin", data: enc("x") }]))).toMatchObject({
      refused: expect.any(String),
    });
    const late = pkg("word/document.xml", [
      ...Array.from({ length: 30 }, (_, i) => ({ name: `word/embeddings/e${i}.bin`, data: enc("x") })),
      { name: "word/vbaProject.bin", data: enc("x") },
    ]);
    expect(sniff(late)).toMatchObject({ refused: expect.any(String) });
  });

  it("refuses a directory it cannot read whole: truncated, inconsistent, or no end record", () => {
    const good = pkg("word/document.xml");
    expect(sniff(good.slice(0, good.length - 10))).toMatchObject({ refused: expect.any(String) });
    const lying = new Uint8Array(good);
    // Claim three thousand entries in the end record: past the bound, so the inspection is incomplete.
    const eocd = lying.length - 22;
    lying[eocd + 10] = 0xff;
    lying[eocd + 11] = 0x0b;
    expect(sniff(lying)).toMatchObject({ refused: expect.any(String) });
    expect(sniff(enc("PK\x03\x04not a zip at all"))).toMatchObject({ refused: expect.any(String) });
  });

  it("refuses a legacy Office file and a renamed executable", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(64).fill(0)]);
    expect(sniff(ole)).toMatchObject({ refused: expect.any(String) });
    expect(sniff(enc("MZ\x90\x00 an executable"))).toMatchObject({ refused: expect.any(String) });
  });
});
