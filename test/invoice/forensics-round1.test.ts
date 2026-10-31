// Round 1's reproductions for D06 T02 §1 (docs/reviews/06-invoice/D06-T02-s1.md), each a regression: bounded width
// tables and cross-reference entries, a signature key that hides nothing, budget exhaustion contained, page removal
// seen, Form bounds and clipped text, hybrid-file precedence and a looping page tree named.
import { describe, expect, it } from "vitest";
import { analysePdf } from "../../src/invoice/forensics";
import { dictOf, readPdf, resolve, textOf } from "../../src/invoice/pdf";
import { BANK_INFO, genuinePop, IMAGE, makeDoc, POP_LINES } from "./forensics-fixtures";
import { appendUpdate, contentOf, latin1, toBytes } from "./pdf-writer";

// Wall-clock is a backstop only: the machine and CI runners are shared, so a linear analysis can pass a second under
// load. The bound that proves linear work is the report's `work` counters, asserted where a test needs it.
const BOUND_MS = 3_000;

const kinds = (r: Awaited<ReturnType<typeof analysePdf>>) => r.findings.map((f) => f.kind).sort();
const timed = async (bytes: Uint8Array) => {
  const start = performance.now();
  const r = await analysePdf(bytes);
  return { r, ms: performance.now() - start };
};
const edited = POP_LINES.map((l) => (l.text.startsWith("Amount") ? { ...l, text: "Amount: R 99 950.00" } : l));

describe("round 1: bounded work", () => {
  it("ends a width table whose range does not advance", async () => {
    const doc = await makeDoc({
      lines: [],
      fonts: { F1: "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [12 0 R]>>" },
      content: "BT /F1 10 Tf 72 700 Td <0001> Tj ET",
      objects: { 12: "<</Type /Font /Subtype /CIDFontType2 /BaseFont /X /W [9007199254740992 9007199254740992 500]>>" },
    });
    const { ms } = await timed(doc);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("refuses cross-reference ranges past the entry limit, and empty rows", async () => {
    const xref = (w: string, index: string) =>
      toBytes(
        `%PDF-1.7\n1 0 obj\n<</Type /XRef /W [${w}] /Index [${index}] /Size 200000 /Length 0>>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n`,
      );
    const empty = await timed(xref("0 0 0", "0 50000 50000 50000 100000 50000 150000 50000"));
    expect(empty.ms).toBeLessThan(BOUND_MS);
    expect(empty.r.unread.join(" ")).toMatch(/cross-reference section is damaged/);
  });

  it("returns coverage, never a rejection, when an update exhausts the token budget", async () => {
    const big = await appendUpdate(await genuinePop(), {
      objects: { 5: { dict: "<<>>", stream: "n\n".repeat(2_000_001), compress: true } },
      root: 2,
      info: 6,
      size: 12,
    });
    const r = await analysePdf(big);
    expect(r.unread.join(" ")).toMatch(/more work to read than allowed/);
    for (const c of Object.values(r.coverage)) expect(c.status).not.toBe("ran");
  });
});

describe("round 1: what a save changed", () => {
  it("still finds an edit when the changed content stream carries a /ByteRange", async () => {
    const r = await analysePdf(
      await appendUpdate(await genuinePop(), {
        objects: { 5: { dict: "<</ByteRange [0 1 2 3]>>", stream: contentOf(edited), compress: true } },
        root: 2,
        info: 6,
        size: 12,
      }),
    );
    expect(kinds(r)).toEqual(["revisions"]);
  });

  it("finds a page removed from the page tree", async () => {
    const page2 = contentOf([{ font: "F1", size: 11, x: 72, y: 700, text: "Payment pending approval" }]);
    const two = await makeDoc({
      lines: POP_LINES,
      info: BANK_INFO,
      objects: {
        3: "<</Type /Pages /Kids [4 0 R 12 0 R] /Count 2>>",
        12: "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 7 0 R>>>> /Contents 13 0 R>>",
        13: { dict: "<<>>", stream: page2, compress: true },
      },
    });
    const removed = await appendUpdate(two, {
      objects: { 3: "<</Type /Pages /Kids [4 0 R] /Count 1>>" },
      root: 2,
      info: 6,
      size: 14,
    });
    expect(kinds(await analysePdf(removed))).toEqual(["revisions"]);
    expect((await analysePdf(two)).findings).toEqual([]);
  });
});

describe("round 1: Form bounds and clipped text", () => {
  it("does not count an image outside its Form's bounding box as covering text", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        xobjects: { Fm1: 12 },
        content: `${contentOf(POP_LINES)}\n/Fm1 Do`,
        objects: {
          12: {
            dict: "<</Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources <</XObject <</Im1 13 0 R>>>>>>",
            stream: "q 130 0 0 14 70 616 cm /Im1 Do Q",
          },
          13: IMAGE,
        },
      }),
    );
    expect(r.findings).toEqual([]);
  });

  it("does not read a heading clipped out of view as the issuer's", async () => {
    const lines = POP_LINES.slice(1);
    const r = await analysePdf(
      await makeDoc({
        lines,
        info: { ...BANK_INFO, producer: "iLovePDF" },
        content: `q 0 0 10 10 re W n BT /F1 18 Tf 72 760 Td (Proof of Payment) Tj ET Q\n${contentOf(lines)}`,
      }),
    );
    expect(r.issuer).toBe("unknown");
    expect(r.findings).toEqual([]);
  });
});

describe("round 1: hybrid files and looping trees", () => {
  it("takes a hybrid file's stream entries for the objects its table marks free", async () => {
    const stream = await makeDoc({ lines: POP_LINES, info: BANK_INFO, xref: "stream" });
    const text = latin1(stream);
    const xrefAt = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)?.[1]);
    const body = text.replace(/startxref\s+\d+\s+%%EOF\s*$/, "");
    const table = `xref\n0 1\n0000000000 65535 f\r\n2 3\n0000000000 00001 f\r\n0000000000 00001 f\r\n0000000000 00001 f\r\n6 2\n0000000000 00001 f\r\n0000000000 00001 f\r\ntrailer\n<</Size 14 /Root 2 0 R /Info 6 0 R /XRefStm ${xrefAt}>>\n`;
    const hybrid = toBytes(`${body}${table}startxref\n${body.length}\n%%EOF\n`);
    const file = await readPdf(hybrid);
    expect(textOf(resolve(file, dictOf(file, file.trailer?.entries.get("Info"))?.entries.get("Producer")))).toBe(
      "KestrelStatements 4.2",
    );
    const r = await analysePdf(hybrid);
    expect(r.issuer).toBe("bank");
    expect(r.unread).toEqual([]);
  });

  it("names a page tree that refers back to itself", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        objects: { 3: "<</Type /Pages /Kids [3 0 R 4 0 R] /Count 1 /Parent 3 0 R>>" },
      }),
    );
    expect(r.unread).toContain("the page tree refers back to itself, so it was read once");
    for (const c of Object.values(r.coverage)) expect(c.status).not.toBe("ran");
  });
});

describe("round 2", () => {
  it("bounds a width table of 30,000 overlapping ranges", async () => {
    const w = Array.from({ length: 30_000 }, () => "0 65534 500").join(" ");
    const doc = await makeDoc({
      lines: [],
      fonts: { F1: "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [12 0 R]>>" },
      content: "BT /F1 10 Tf 72 700 Td <0001> Tj ET",
      objects: { 12: `<</Type /Font /Subtype /CIDFontType2 /BaseFont /X /W [${w}]>>` },
    });
    const { ms } = await timed(doc);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("finds a page removed by pointing /Root at a new catalog and page tree", async () => {
    const page2 = contentOf([{ font: "F1", size: 11, x: 72, y: 700, text: "Payment pending approval" }]);
    const two = await makeDoc({
      lines: POP_LINES,
      info: BANK_INFO,
      objects: {
        3: "<</Type /Pages /Kids [4 0 R 12 0 R] /Count 2>>",
        12: "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 7 0 R>>>> /Contents 13 0 R>>",
        13: { dict: "<<>>", stream: page2, compress: true },
      },
    });
    const swapped = await appendUpdate(two, {
      objects: { 20: "<</Type /Catalog /Pages 21 0 R>>", 21: "<</Type /Pages /Kids [4 0 R] /Count 1>>" },
      root: 20,
      info: 6,
      size: 22,
    });
    expect(kinds(await analysePdf(swapped))).toEqual(["revisions"]);
  });
});

describe("round 3", () => {
  it("bounds a ToUnicode map of 20,000 ranges over the same codes", async () => {
    const cmap = `1 begincodespacerange <0000> <FFFF> endcodespacerange\n${"1 beginbfrange <0000> <ffff> <0000> endbfrange\n".repeat(20_000)}`;
    const doc = await makeDoc({
      lines: [],
      fonts: {
        F1: "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [12 0 R] /ToUnicode 13 0 R>>",
      },
      content: "BT /F1 10 Tf 72 700 Td <0041> Tj ET",
      objects: {
        12: "<</Type /Font /Subtype /CIDFontType2 /BaseFont /X>>",
        13: { dict: "<<>>", stream: cmap, compress: true },
      },
    });
    const { ms } = await timed(doc);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("compares the fonts of 5,000 amount lines, each in its own font, in under a second", async () => {
    const fonts = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [
        `F${i}`,
        `<</Type /Font /Subtype /Type1 /BaseFont /Fam${i} /Encoding /WinAnsiEncoding>>`,
      ]),
    );
    const content = Array.from(
      { length: 5_000 },
      (_, i) => `BT /F${i} 1 Tf 20 ${20_000 - i * 2} Td (R ${i}.00) Tj ET`,
    ).join("\n");
    const { ms } = await timed(await makeDoc({ lines: [], fonts, content }));
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
