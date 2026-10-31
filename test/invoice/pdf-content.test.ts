// What a PDF's pages draw (D06 T02 §1): text through ToUnicode and /Differences fonts, kerned TJ arrays, content
// arrays and nested Forms, each run placed on the page; an image-only page has no text to read.
import { describe, expect, it } from "vitest";
import { readPdf } from "../../src/invoice/pdf";
import { readContent } from "../../src/invoice/pdf-content";
import { IMAGE, makeDoc } from "./forensics-fixtures";

const read = async (bytes: Uint8Array) => readContent(await readPdf(bytes));
const texts = (c: Awaited<ReturnType<typeof read>>) => c.pages.flatMap((p) => p.runs.map((r) => r.text));

const CMAP = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0011> <002E> endbfchar
2 beginbfrange <0013> <001C> <0030> <0024> <0025> [<0041> <006D>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;

describe("readContent", () => {
  it("reads an Identity-H font's text through its ToUnicode map, with its widths", async () => {
    const bytes = await makeDoc({
      lines: [],
      fonts: {
        F1: "<</Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /DescendantFonts [12 0 R] /ToUnicode 13 0 R>>",
      },
      content: "BT /F1 10 Tf 100 700 Td <00240025000300140011001500160017> Tj ET",
      objects: {
        12: "<</Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Arial /CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /DW 600 /W [36 [700 800]]>>",
        13: { dict: "<<>>", stream: CMAP, compress: true },
      },
    });
    const c = await read(bytes);
    const run = c.pages[0]?.runs[0];
    expect(run?.text).toBe("Am 1.234");
    expect(run?.font).toBe("ABCDEF+Arial");
    // Widths: A 700, m 800, then six at the default 600, all at 10 points.
    expect(run?.box.x0).toBeCloseTo(100);
    expect(run?.box.x1).toBeCloseTo(100 + (0.7 + 0.8 + 6 * 0.6) * 10);
  });

  it("reads a simple font's /Differences glyph names", async () => {
    const bytes = await makeDoc({
      lines: [],
      fonts: {
        F1: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding <</Differences [1 /R /one /two /period /zero]>>>>",
      },
      content: "BT /F1 12 Tf 72 700 Td <0102030405> Tj ET",
    });
    expect(texts(await read(bytes))).toEqual(["R12.0"]);
  });

  it("places each run of a kerned TJ, a content array and text after T* on its own position", async () => {
    const bytes = await makeDoc({
      lines: [],
      content: ["BT /F1 10 Tf 14 TL 72 700 Td [(Am) -2000 (ount)] TJ", "T* (Second line) Tj ET"],
    });
    const c = await read(bytes);
    const [first, second, third] = c.pages[0]?.runs ?? [];
    expect([first?.text, second?.text, third?.text]).toEqual(["Am", "ount", "Second line"]);
    // The -2000 kern moves the second run 20 points right of where the first ended.
    expect((second?.box.x0 ?? 0) - (first?.box.x1 ?? 0)).toBeCloseTo(20);
    expect(third?.box.y0).toBeCloseTo(700 - 14 - 2);
  });

  it("draws a nested Form's text and image through the forms' matrices", async () => {
    const bytes = await makeDoc({
      lines: [],
      xobjects: { Fm1: 12 },
      content: "q 1 0 0 1 100 100 cm /Fm1 Do Q",
      objects: {
        12: {
          dict: "<</Type /XObject /Subtype /Form /BBox [0 0 500 500] /Matrix [1 0 0 1 10 0] /Resources <</Font <</F1 7 0 R>> /XObject <</Fm2 13 0 R>>>>>>",
          stream: "BT /F1 10 Tf 0 0 Td (Outer) Tj ET /Fm2 Do",
        },
        13: {
          dict: "<</Type /XObject /Subtype /Form /BBox [0 0 500 500] /Resources <</XObject <</Im1 14 0 R>>>>>>",
          stream: "q 50 0 0 20 5 5 cm /Im1 Do Q",
        },
        14: IMAGE,
      },
    });
    const c = await read(bytes);
    expect(c.pages[0]?.runs[0]?.text).toBe("Outer");
    expect(c.pages[0]?.runs[0]?.box.x0).toBeCloseTo(110);
    expect(c.pages[0]?.images[0]?.box).toEqual({ x0: 115, y0: 105, x1: 165, y1: 125 });
  });

  it("marks invisible text, a clipped image's box and a transparent image", async () => {
    const bytes = await makeDoc({
      lines: [],
      xobjects: { Im1: 12, Im2: 13 },
      content:
        "BT 3 Tr /F1 10 Tf 72 700 Td (OCR layer) Tj ET q 0 0 100 100 re W n 200 0 0 200 0 0 cm /Im1 Do Q q 10 0 0 10 300 300 cm /Im2 Do Q",
      objects: {
        12: IMAGE,
        13: {
          dict: "<</Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 12 0 R>>",
          stream: "\x80",
        },
      },
    });
    const c = await read(bytes);
    expect(c.pages[0]?.runs[0]?.visible).toBe(false);
    expect(c.pages[0]?.images[0]).toMatchObject({
      box: { x0: 0, y0: 0, x1: 100, y1: 100 },
      opaque: true,
      clipKnown: true,
    });
    expect(c.pages[0]?.images[1]?.opaque).toBe(false);
  });

  it("reads an image-only page as having no text", async () => {
    const bytes = await makeDoc({
      lines: [],
      xobjects: { Im1: 12 },
      content: "q 595 0 0 842 0 0 cm /Im1 Do Q",
      objects: { 12: IMAGE },
    });
    const c = await read(bytes);
    expect(c.pages[0]?.runs).toEqual([]);
    expect(c.pages[0]?.images).toHaveLength(1);
  });
});
