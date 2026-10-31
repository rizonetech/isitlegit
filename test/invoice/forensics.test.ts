// PDF forensics (D06 T02 §1; spec 4.5a): each finding on its doctored fixture, silence on each genuine and control
// fixture, coverage instead of a clean result for what could not be read, bounded work on hostile files, and evidence
// that fits the store.
import { describe, expect, it } from "vitest";
import { evidenceIn } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import {
  analysePdf,
  FORENSIC_CHECKS,
  fontFamily,
  forensicsCoverage,
  forensicsEvidence,
  type PdfForensics,
  pdfDate,
  statedDay,
} from "../../src/invoice/forensics";
import {
  BANK_INFO,
  COURIER,
  editedPop,
  genuinePop,
  HELVETICA,
  HELVETICA_BOLD,
  IMAGE,
  INVOICE_LINES,
  makeDoc,
  metadataOnly,
  POP_LINES,
  signedPop,
  signedThenEdited,
  TIMES,
} from "./forensics-fixtures";
import { appendUpdate, contentOf, latin1, type TextLine, toBytes } from "./pdf-writer";

const kinds = (r: PdfForensics) => r.findings.map((f) => f.kind).sort();
const amountIn = (font: string, lines = POP_LINES): TextLine[] =>
  lines.map((l) => (l.text.startsWith("Amount") ? { ...l, font } : l));

describe("revisions", () => {
  it("finds an edit that changes what the page shows, and none in the genuine file", async () => {
    const edited = await analysePdf(await editedPop());
    expect(kinds(edited)).toEqual(["revisions"]);
    expect(edited.findings[0]?.detail).toMatchObject({ edits: 1, revisions: 2, afterSignature: false });
    expect((await analysePdf(await genuinePop())).findings).toEqual([]);
  });

  it("does not count a linearized file's first-page section, but counts an update to it", async () => {
    const linearized = await makeDoc({ lines: POP_LINES, info: BANK_INFO, linearized: true });
    const genuine = await analysePdf(linearized);
    expect(genuine.findings).toEqual([]);
    expect(genuine.coverage.revisions).toEqual({ status: "ran", reason: null });
    const updated = await analysePdf(await editedPop(linearized));
    expect(kinds(updated)).toEqual(["revisions"]);
    expect(updated.findings[0]?.detail).toMatchObject({ edits: 1, revisions: 2, linearizedLengthChanged: true });
  });

  it("does not count a signature or a metadata-only save as an edit, and calls an edit after signing out", async () => {
    expect((await analysePdf(await signedPop())).findings).toEqual([]);
    expect((await analysePdf(await metadataOnly())).findings).toEqual([]);
    const after = await analysePdf(await signedThenEdited());
    expect(after.findings[0]).toMatchObject({ kind: "revisions", detail: { afterSignature: true, edits: 1 } });
    expect(after.findings[0]?.says).toMatch(/after it was signed/);
  });

  it("counts a visible annotation added by a later save as an edit", async () => {
    const annotated = await appendUpdate(await genuinePop(), {
      objects: {
        4: "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 7 0 R>>>> /Contents 5 0 R /Annots [20 0 R]>>",
        20: "<</Type /Annot /Subtype /FreeText /Rect [72 615 200 632] /Contents (R 112 450.00) /DA (/Helv 11 Tf)>>",
      },
      root: 2,
      info: 6,
      size: 21,
    });
    expect(kinds(await analysePdf(annotated))).toEqual(["revisions"]);
  });
});

describe("producer", () => {
  it("flags a bank's proof of payment saved by a consumer editor", async () => {
    const r = await analysePdf(await makeDoc({ lines: POP_LINES, info: { ...BANK_INFO, producer: "iLovePDF" } }));
    expect(r.issuer).toBe("bank");
    expect(r.findings[0]).toMatchObject({ kind: "producer", detail: { tool: "iLovePDF" } });
  });

  it("never flags a supplier's own invoice made in a word processor that names its bank, or asks for a POP", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: INVOICE_LINES,
        info: { producer: "Microsoft® Word for Microsoft 365", creator: "Microsoft® Word" },
      }),
    );
    expect(r.issuer).toBe("unknown");
    expect(r.findings).toEqual([]);
    expect(r.coverage.producer.status).toBe("ran");
  });

  it("does not take a heading lower on the page, or a long sentence, as the issuer's", async () => {
    const low = POP_LINES.map((l, i) => (i === 0 ? { ...l, y: 300 } : l));
    expect((await analysePdf(await makeDoc({ lines: low, info: { producer: "iLovePDF" } }))).issuer).toBe("unknown");
    const sentence = POP_LINES.map((l, i) =>
      i === 0
        ? { ...l, size: 10, text: "Proof of payment must be emailed to us within seven working days of this statement" }
        : l,
    );
    expect((await analysePdf(await makeDoc({ lines: sentence, info: { producer: "iLovePDF" } }))).issuer).toBe(
      "unknown",
    );
  });

  it("says unavailable when the file names no program", async () => {
    const r = await analysePdf(await makeDoc({ lines: POP_LINES, info: { created: "20261020101500" } }));
    expect(r.coverage.producer).toEqual({ status: "unavailable", reason: "the file names no program that made it" });
  });
});

describe("dates", () => {
  it("flags a modification after the payment date the document states", async () => {
    const r = await analysePdf(
      await makeDoc({ lines: POP_LINES, info: { ...BANK_INFO, modified: "20261028142200+02'00'" } }),
    );
    expect(r.findings[0]).toMatchObject({ kind: "dates", detail: { paymentDate: "2026-10-20" } });
    expect(r.findings[0]?.says).toBe("was modified on 2026-10-28, after the payment date it states (2026-10-20)");
  });

  it("flags a proof of payment created before the payment it confirms", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        info: {
          producer: "KestrelStatements 4.2",
          created: "20261015090000+02'00'",
          modified: "20261015090000+02'00'",
        },
      }),
    );
    expect(r.findings[0]?.says).toBe("was created on 2026-10-15, before the payment it confirms (2026-10-20)");
  });

  it("stays silent on a POP downloaded a month later, created and modified together", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        info: {
          producer: "KestrelStatements 4.2",
          created: "20261125080000+02'00'",
          modified: "20261125080000+02'00'",
        },
      }),
    );
    expect(r.findings).toEqual([]);
    expect(r.coverage.dates.status).toBe("ran");
  });

  it("says unavailable when the document states no payment date", async () => {
    const lines = POP_LINES.filter((l) => !l.text.startsWith("Date paid"));
    const r = await analysePdf(await makeDoc({ lines, info: { ...BANK_INFO, modified: "20261028142200+02'00'" } }));
    expect(r.coverage.dates).toEqual({ status: "unavailable", reason: "the document states no payment date" });
  });

  it("reads PDF dates in their own offset and the days documents write", () => {
    expect(pdfDate("D:20261020235900-05'00'")).toMatchObject({ day: "2026-10-20", utc: Date.UTC(2026, 9, 21, 4, 59) });
    expect(pdfDate("D:2026")?.day).toBe("2026-01-01");
    expect(pdfDate("D:20261340")).toBeNull();
    expect(statedDay("Paid on 20 Oktober 2026")).toBe("2026-10-20");
    expect(statedDay("Date paid: 20/10/2026")).toBe("2026-10-20");
    expect(statedDay("Payment date: October 20, 2026")).toBe("2026-10-20");
  });
});

describe("fonts", () => {
  it("flags an amount drawn in a family the document uses nowhere else, beside its other amounts", async () => {
    const lines = [...amountIn("F2"), { font: "F1", size: 11, x: 72, y: 580, text: "Fee: R 5.00" }];
    const r = await analysePdf(await makeDoc({ lines, fonts: { F1: HELVETICA, F2: TIMES } }));
    expect(r.findings[0]).toMatchObject({
      kind: "fonts",
      detail: { font: "Times-Roman", otherFont: "Helvetica", rule: "family" },
    });
    expect(r.findings[0]?.says).toContain("Amount: R 12 450.00");
  });

  it("stays silent on a bold total in the body family, and on one numeric font used for every amount", async () => {
    const bold = [...amountIn("F2"), { font: "F1", size: 11, x: 72, y: 580, text: "Fee: R 5.00" }];
    expect(
      (await analysePdf(await makeDoc({ lines: bold, fonts: { F1: HELVETICA, F2: HELVETICA_BOLD } }))).findings,
    ).toEqual([]);
    // Every amount and account value in Courier, on lines of their own, the labels in Helvetica.
    const numeric: TextLine[] = [
      ...POP_LINES.filter((l) => !/\d/.test(l.text) || /Date/.test(l.text)),
      { font: "F2", size: 11, x: 72, y: 660, text: "62004417731" },
      { font: "F2", size: 11, x: 72, y: 620, text: "R 12 450.00" },
    ];
    expect(
      (await analysePdf(await makeDoc({ lines: numeric, fonts: { F1: HELVETICA, F2: COURIER } }))).findings,
    ).toEqual([]);
  });

  it("flags a second subset of the same font on one page used only on an amount, not subsets on merged pages", async () => {
    const arial = (tag: string) =>
      `<</Type /Font /Subtype /TrueType /BaseFont /${tag}+Arial /FirstChar 32 /LastChar 126 /Encoding /WinAnsiEncoding>>`;
    const r = await analysePdf(
      await makeDoc({ lines: amountIn("F2"), fonts: { F1: arial("AAAAAA"), F2: arial("BBBBBB") } }),
    );
    expect(r.findings[0]).toMatchObject({ kind: "fonts", detail: { rule: "subset", font: "BBBBBB+Arial" } });
    // Two pages, each with its own subset: a merge, not an edit.
    const page2 = contentOf(POP_LINES.map((l) => ({ ...l, font: "F2" })));
    const merged = await makeDoc({
      lines: POP_LINES,
      fonts: { F1: arial("AAAAAA") },
      objects: {
        3: "<</Type /Pages /Kids [4 0 R 12 0 R] /Count 2>>",
        12: "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F2 14 0 R>>>> /Contents 13 0 R>>",
        13: { dict: "<<>>", stream: page2, compress: true },
        14: arial("BBBBBB"),
      },
    });
    expect((await analysePdf(merged)).findings).toEqual([]);
  });

  it("names font families without subset tags or styles", () => {
    expect(fontFamily("ABCDEF+Arial-BoldMT")).toBe("arial");
    expect(fontFamily("Helvetica-Bold")).toBe("helvetica");
    expect(fontFamily("TimesNewRomanPS-ItalicMT")).toBe("timesnewroman");
  });
});

describe("overlay", () => {
  const withImage = (place: string, before = false, extra = {}) => {
    const draw = `q ${place} cm /Im1 Do Q`;
    const text = contentOf(POP_LINES);
    return makeDoc({
      lines: POP_LINES,
      xobjects: { Im1: 12 },
      content: before ? `${draw}\n${text}` : `${text}\n${draw}`,
      objects: { 12: IMAGE, ...extra },
    });
  };

  it("flags an opaque image painted over the amount", async () => {
    const r = await analysePdf(await withImage("130 0 0 14 70 616"));
    expect(r.findings[0]).toMatchObject({ kind: "overlay", detail: { page: 1, onAmountOrAccountLine: true } });
    expect(r.findings[0]?.says).toMatch(/image placed over its text "Amount: R 12 450.00" on page 1/);
  });

  it("stays silent on a logo clear of the text, a background drawn first, OCR text under a scan, a clipped and a soft-masked image", async () => {
    expect((await analysePdf(await withImage("80 0 0 40 450 760"))).findings).toEqual([]);
    expect((await analysePdf(await withImage("595 0 0 842 0 0", true))).findings).toEqual([]);
    const ocr = await makeDoc({
      lines: [],
      xobjects: { Im1: 12 },
      content: `q 595 0 0 842 0 0 cm /Im1 Do Q\nBT 3 Tr /F1 11 Tf 72 620 Td (Amount: R 12 450.00) Tj ET`,
      objects: { 12: IMAGE },
    });
    expect((await analysePdf(ocr)).findings).toEqual([]);
    const clipped = await makeDoc({
      lines: POP_LINES,
      xobjects: { Im1: 12 },
      content: `${contentOf(POP_LINES)}\nq 450 750 100 50 re W n 595 0 0 842 0 0 cm /Im1 Do Q`,
      objects: { 12: IMAGE },
    });
    expect((await analysePdf(clipped)).findings).toEqual([]);
    const masked = await withImage("130 0 0 14 70 616", false, {
      12: { ...IMAGE, dict: IMAGE.dict.replace(">>", " /SMask 13 0 R>>") },
      13: IMAGE,
    });
    expect((await analysePdf(masked)).findings).toEqual([]);
  });

  it("is partial, not clean, when an image's clip is not a rectangle", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        xobjects: { Im1: 12 },
        content: `${contentOf(POP_LINES)}\nq 0 0 m 100 0 l 50 80 l h W n 130 0 0 14 70 616 cm /Im1 Do Q`,
        objects: { 12: IMAGE },
      }),
    );
    expect(r.coverage.overlay).toEqual({ status: "partial", reason: "an image's clipping shape was not read" });
  });
});

describe("evidence and coverage", () => {
  const registry = new CheckRegistry();
  for (const name of FORENSIC_CHECKS) registry.register({ name, needs: [], timeoutMs: 1_000, run: () => [] });
  const valid = (items: ReturnType<typeof forensicsEvidence>) =>
    items.forEach((item, i) => {
      evidenceIn(registry).parse({ ...item, id: `E${i + 1}` });
    });

  it("makes the doctored POP's items high, two groups agreeing, and each valid evidence", async () => {
    const lines = POP_LINES.map((l) => (l.text.startsWith("Amount") ? { ...l, text: "Amount: R 112 450.00" } : l));
    const doctored = await appendUpdate(await genuinePop(), {
      objects: {
        5: { dict: "<<>>", stream: contentOf(lines), compress: true },
        6: "<< /Producer (iLovePDF) /CreationDate (D:20261020101500+02'00') /ModDate (D:20261028142200+02'00')>>",
      },
      root: 2,
      info: 6,
      size: 12,
    });
    const r = await analysePdf(doctored);
    expect(kinds(r)).toEqual(["dates", "producer", "revisions"]);
    const items = forensicsEvidence(r, { key: "raw/case/attachments/0", filename: "pop.pdf" });
    expect(items.map((i) => i.severity)).toEqual(["high", "high", "high"]);
    expect(items[0]).toMatchObject({ check: "document.forensics.revisions", artefacts: ["raw/case/attachments/0"] });
    expect(items[0]?.summary).toBe(
      "pop.pdf was changed after it was first saved: a later save changed what its pages show.",
    );
    valid(items);
  });

  it("keeps revisions and dates alone at medium, being one group", async () => {
    const lines = POP_LINES.map((l) => (l.text.startsWith("Amount") ? { ...l, text: "Amount: R 112 450.00" } : l));
    const doctored = await appendUpdate(await genuinePop(), {
      objects: {
        5: { dict: "<<>>", stream: contentOf(lines), compress: true },
        6: "<< /Producer (KestrelStatements 4.2) /CreationDate (D:20261020101500+02'00') /ModDate (D:20261028142200+02'00')>>",
      },
      root: 2,
      info: 6,
      size: 12,
    });
    const r = await analysePdf(doctored);
    expect(kinds(r)).toEqual(["dates", "revisions"]);
    expect(forensicsEvidence(r, { key: "k", filename: "pop.pdf" }).map((i) => i.severity)).toEqual([
      "medium",
      "medium",
    ]);
  });

  it("keeps a 70 KB filename, hostile metadata and font names, and every finding inside the store's limits", async () => {
    const hostile = "<script>‮\n".repeat(400);
    const lines = [...amountIn("F2"), { font: "F1", size: 11, x: 72, y: 580, text: "Fee: R 5.00" }];
    const doc = await makeDoc({
      lines,
      fonts: {
        F1: HELVETICA,
        F2: `<</Type /Font /Subtype /Type1 /BaseFont /${"Evil".repeat(2000)} /Encoding /WinAnsiEncoding>>`,
      },
      xobjects: { Im1: 12 },
      extra: "q 130 0 0 14 70 616 cm /Im1 Do Q",
      objects: { 12: IMAGE },
      info: { producer: `iLovePDF ${"x".repeat(3000)}`, created: "20261020101500", modified: "20261028142200" },
    });
    const edited = await appendUpdate(doc, {
      objects: {
        5: {
          dict: "<<>>",
          stream: contentOf(lines, "q 130 0 0 14 70 616 cm /Im1 Do Q BT /F1 9 Tf 1 1 Td (x) Tj ET"),
          compress: true,
        },
      },
      root: 2,
      info: 6,
      size: 13,
    });
    const r = await analysePdf(edited);
    expect(kinds(r)).toEqual(["dates", "fonts", "overlay", "producer", "revisions"]);
    const items = forensicsEvidence(r, { key: "k", filename: `${hostile}${"a".repeat(70_000)}.pdf` });
    valid(items);
    for (const item of items) expect(item.summary).not.toMatch(/[<>‮\n]/);
  });

  it("gives an unreadable file coverage reasons and no finding", async () => {
    const r = await analysePdf(new TextEncoder().encode("this is not a pdf"));
    expect(r.findings).toEqual([]);
    expect(Object.values(forensicsCoverage(r))).toEqual(
      FORENSIC_CHECKS.map(() => ({ status: "unavailable", reason: "the file has no PDF header" })),
    );
  });

  it("reads revisions but not the rest of an encrypted file", async () => {
    const { buildPdf } = await import("./pdf-writer");
    const encrypted = await buildPdf({
      objects: {
        2: "<</Type /Catalog /Pages 3 0 R>>",
        3: "<</Type /Pages /Kids [] /Count 0>>",
        4: "<</Filter /Standard /V 2>>",
      },
      root: 2,
      size: 5,
      trailerExtra: " /Encrypt 4 0 R",
    });
    const r = await analysePdf(encrypted);
    expect(r.coverage.revisions.status).toBe("ran");
    expect(r.coverage.producer.reason).toMatch(/encrypted/);
  });

  it("says text-dependent checks are unavailable on an image-only page", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: [],
        xobjects: { Im1: 12 },
        content: "q 595 0 0 842 0 0 cm /Im1 Do Q",
        objects: { 12: IMAGE },
        info: { ...BANK_INFO, producer: "iLovePDF" },
      }),
    );
    expect(r.coverage.fonts.status).toBe("unavailable");
    expect(r.coverage.overlay.status).toBe("unavailable");
    expect(r.coverage.producer.status).toBe("unavailable");
  });
});

describe("bounded work on hostile files", () => {
  const timed = async (bytes: Uint8Array) => {
    const start = performance.now();
    const r = await analysePdf(bytes);
    return { r, ms: performance.now() - start };
  };

  it("ends a self-referencing page tree, a Form that draws itself and 20,000 nested arrays quickly with a reason", async () => {
    const loop = await makeDoc({
      lines: POP_LINES,
      objects: { 3: "<</Type /Pages /Kids [3 0 R 4 0 R] /Count 1 /Parent 3 0 R>>" },
    });
    const a = await timed(loop);
    expect(a.ms).toBeLessThan(1_000);
    const selfForm = await makeDoc({
      lines: [],
      xobjects: { Fm1: 12 },
      content: "/Fm1 Do",
      objects: {
        12: {
          dict: "<</Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources <</XObject <</Fm1 12 0 R>>>>>>",
          stream: "/Fm1 Do /Fm1 Do",
        },
      },
    });
    const b = await timed(selfForm);
    expect(b.ms).toBeLessThan(1_000);
    expect(b.r.unread.join(" ")).toMatch(/form draws itself/);
    const nested = await makeDoc({ lines: POP_LINES, objects: { 11: `${"[".repeat(20_000)}${"]".repeat(20_000)}` } });
    const c = await timed(nested);
    expect(c.ms).toBeLessThan(1_000);
    expect(c.r.unread.join(" ")).toMatch(/could not be read/);
  });

  it("follows a hybrid file's /XRefStm once, even when it names the table itself", async () => {
    const bytes = await makeDoc({ lines: POP_LINES, info: BANK_INFO });
    const text = latin1(bytes);
    const at = /startxref\s+(\d+)/.exec(text.slice(text.lastIndexOf("startxref")))?.[1];
    const looped = toBytes(text.replace("/Root 2 0 R", `/Root 2 0 R /XRefStm ${at}`));
    const r = await timed(looped);
    expect(r.ms).toBeLessThan(1_000);
    expect(r.r.coverage.revisions.status).toBe("ran");
  });

  it("reads 20,000 unterminated hex strings, streams without an end and inline images in linear time", async () => {
    const hex = Array.from({ length: 20_000 }, (_, i) => `${100 + i} 0 obj\n<${"a".repeat(50)}\nendobj`).join("\n");
    const streams = Array.from(
      { length: 20_000 },
      (_, i) => `${30_000 + i} 0 obj\n<</Length 999999>>\nstream\nxx`,
    ).join("\n");
    const literals = Array.from({ length: 20_000 }, (_, i) => `${60_000 + i} 0 obj\n(${"b".repeat(50)}\nendobj`).join(
      "\n",
    );
    const broken = toBytes(`%PDF-1.7\n${hex}\n${literals}\n${streams}\n${"z".repeat(4 * 1024 * 1024)}\n%%EOF\n`);
    const a = await timed(broken);
    expect(a.ms).toBeLessThan(1_000);
    expect(a.r.unread.join(" ")).toMatch(/could not be read/);
    const packed = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [100 + i, `<</N ${i} /S (${"c".repeat(20)})>>`]),
    );
    const many = await timed(await makeDoc({ lines: POP_LINES, xref: "stream", objects: packed }));
    expect(many.ms).toBeLessThan(1_000);
    expect(many.r.unread).toEqual([]);
    const inline = Array.from({ length: 20_000 }, () => "BI /W 1 /H 1 /BPC 8 /CS /G ID x EI").join("\n");
    const b = await timed(
      await makeDoc({ lines: [], content: `${inline}\nBI /W 1 ID ${"y".repeat(2 * 1024 * 1024)}` }),
    );
    expect(b.ms).toBeLessThan(1_000);
  });

  it("stops a decompression bomb at its limit and compares 5,000 images with 20,000 runs within the pair cap", async () => {
    const bomb = await makeDoc({ lines: POP_LINES, content: "x".repeat(16 * 1024 * 1024) });
    const a = await timed(bomb);
    expect(a.ms).toBeLessThan(1_000);
    expect(a.r.unread.join(" ")).toMatch(/decodes to more than 8 MiB/);
    const runs = Array.from(
      { length: 20_000 },
      (_, i) => `BT /F1 1 Tf ${i % 500} ${Math.floor(i / 500)} Td (a) Tj ET`,
    ).join("\n");
    const images = Array.from({ length: 5_000 }, () => "q 10 0 0 10 900 900 cm /Im1 Do Q").join("\n");
    const many = await makeDoc({
      lines: [],
      xobjects: { Im1: 12 },
      content: `${runs}\n${images}`,
      objects: { 12: IMAGE },
    });
    const b = await timed(many);
    expect(b.ms).toBeLessThan(1_000);
    expect(b.r.coverage.overlay).toEqual({
      status: "partial",
      reason: "too many images and text runs to compare them all",
    });
  });
});
