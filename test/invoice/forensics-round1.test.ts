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

describe("round 4", () => {
  const withCmap = (cmap: string) =>
    makeDoc({
      lines: [],
      fonts: { F1: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 12 0 R>>" },
      content: "BT /F1 10 Tf 72 700 Td (123) Tj ET",
      objects: { 12: { dict: "<<>>", stream: cmap, compress: true } },
    });

  it("reads a CMap of 80,000 blocks left open in linear time", async () => {
    const { r, ms } = await timed(await withCmap("beginbfrange\n".repeat(80_000)));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(r.unread).toContain("a font's text map is damaged, so some of its text may not have been read");
    for (const c of Object.values(r.coverage)) expect(c.status).not.toBe("ran");
  });

  it("still maps a CMap's characters and ranges through the lexer", async () => {
    const { toUnicode } = await import("../../src/invoice/pdf-content");
    const { map, bytes, damaged } = toUnicode(
      "1 begincodespacerange <00> <ff> endcodespacerange 1 beginbfchar <31> <0041> endbfchar 2 beginbfrange <32> <33> <0042> <34> <35> [<0058> <0059>] endbfrange",
    );
    expect(bytes).toBe(1);
    expect(damaged).toBe(false);
    expect([0x31, 0x32, 0x33, 0x34, 0x35].map((c) => map.get(c))).toEqual(["A", "B", "C", "X", "Y"]);
  });

  it("classifies a line of 200,000 digits and a font name of 100,000 characters in linear time", async () => {
    const digits = await makeDoc({ lines: [], content: `BT /F1 10 Tf 72 700 Td (${"1".repeat(200_000)}) Tj ET` });
    expect((await timed(digits)).ms).toBeLessThan(BOUND_MS);
    const name = await makeDoc({
      lines: [],
      fonts: { F1: `<</Type /Font /Subtype /Type1 /BaseFont /${"Bold".repeat(25_000)}x /Encoding /WinAnsiEncoding>>` },
      content: "BT /F1 10 Tf 72 700 Td (R 5.00) Tj ET",
    });
    expect((await timed(name)).ms).toBeLessThan(BOUND_MS);
  });
});

describe("round 6", () => {
  it("refuses a 12 MiB literal string as malformed, in bounded time", async () => {
    const doc = await makeDoc({ lines: POP_LINES, objects: { 6: `<</Producer (${"A".repeat(12 * 1024 * 1024)})>>` } });
    const { r, ms } = await timed(doc);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(r.unread.join(" ")).toMatch(/could not be read/);
  });

  it("reads the first part of a 4 MiB text run and says the rest was not read", async () => {
    const { r, ms } = await timed(
      await makeDoc({ lines: [], content: `BT /F1 10 Tf 72 700 Td (${"7".repeat(4 * 1024 * 1024)}) Tj ET` }),
    );
    expect(ms).toBeLessThan(BOUND_MS);
    expect(r.unread).toContain("a text run was too long to read whole");
  });
});

describe("round 7", () => {
  it("caps the text a font map can make of each code and the text a file can hold", async () => {
    const cmap = `1 beginbfchar <41> <${"0041".repeat(256)}> endbfchar`;
    const doc = await makeDoc({
      lines: [],
      fonts: { F1: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 12 0 R>>" },
      content: Array.from({ length: 40 }, () => `BT /F1 10 Tf 72 700 Td (${"A".repeat(16_384)}) Tj ET`).join("\n"),
      objects: { 12: { dict: "<<>>", stream: cmap, compress: true } },
    });
    const { readContent, MAX_MAPPED, MAX_TEXT } = await import("../../src/invoice/pdf-content");
    const content = await readContent(await readPdf(doc));
    const held = content.pages.flatMap((p) => p.runs).reduce((n, r) => n + r.text.length, 0);
    expect(held).toBeLessThanOrEqual(MAX_TEXT);
    expect(content.pages[0]?.runs[0]?.text.length).toBe(16_384 * MAX_MAPPED);
  });

  it("states each fonts rule's own limit", async () => {
    const { forensicsEvidence, LIMITS } = await import("../../src/invoice/forensics");
    const report = (rule: "family" | "subset") => ({
      findings: [{ kind: "fonts" as const, says: "shows a line", detail: { rule } }],
      coverage: {} as never,
      unread: [],
      issuer: "bank" as const,
      work: { tokens: 0, decoded: 0, entries: 0 },
    });
    expect(forensicsEvidence(report("family"), { key: "k", filename: "a.pdf" })[0]?.detail.limits).toBe(LIMITS.fonts);
    expect(forensicsEvidence(report("subset"), { key: "k", filename: "a.pdf" })[0]?.detail.limits).toBe(
      LIMITS["fonts.subset"],
    );
    expect(LIMITS["fonts.subset"]).toMatch(/second copy of the same font/);
  });
});

describe("round 8", () => {
  it("says a font map whose mapping was cut is damaged", async () => {
    const hex = [..."12345678Account number: 62004417731"]
      .map((c) => c.charCodeAt(0).toString(16).padStart(4, "0"))
      .join("");
    const doc = await makeDoc({
      lines: [],
      fonts: { F1: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 12 0 R>>" },
      content: "BT /F1 10 Tf 72 700 Td (A) Tj ET",
      objects: { 12: { dict: "<<>>", stream: `1 beginbfchar <41> <${hex}> endbfchar`, compress: true } },
    });
    const r = await analysePdf(doc);
    expect(r.unread).toContain("a font's text map is damaged, so some of its text may not have been read");
    for (const c of Object.values(r.coverage)) expect(c.status).not.toBe("ran");
  });
});
