// The completion review's reproductions for D06 T02 §1, each now a regression: what a later save really changed, state
// inherited by Forms, coverage after missing or damaged parts, generations, object boundaries, XMP serialisations,
// the date tolerance and bounded work on numeric text.
import { describe, expect, it } from "vitest";
import { analysePdf, forensicsEvidence, LIMITS } from "../../src/invoice/forensics";
import { readPdf, resolve } from "../../src/invoice/pdf";
import { BANK_INFO, genuinePop, IMAGE, makeDoc, POP_LINES } from "./forensics-fixtures";
import { appendUpdate, buildPdf, contentOf, deflate, latin1, toBytes } from "./pdf-writer";

const kinds = (r: Awaited<ReturnType<typeof analysePdf>>) => r.findings.map((f) => f.kind).sort();
const update = async (objects: Parameters<typeof appendUpdate>[1]["objects"], size = 12) =>
  appendUpdate(await genuinePop(), { objects, root: 2, info: 6, size });

describe("what a later save changed", () => {
  it("finds a page that lost its contents, and nothing in an identical copy of its content", async () => {
    const emptied = await update({
      4: "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 7 0 R>>>>>>",
    });
    expect(kinds(await analysePdf(emptied))).toEqual(["revisions"]);
    const same = await update({ 5: { dict: "<<>>", stream: contentOf(POP_LINES), compress: false } });
    expect((await analysePdf(same)).findings).toEqual([]);
  });
});

describe("Forms and transparency", () => {
  it("does not take an image in a Form drawn at zero alpha as covering the text", async () => {
    const doc = await makeDoc({
      lines: POP_LINES,
      xobjects: { Fm1: 12 },
      objects: {
        12: {
          dict: "<</Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources <</XObject <</Im1 13 0 R>>>>>>",
          stream: "q 130 0 0 14 70 616 cm /Im1 Do Q",
        },
        13: IMAGE,
        14: "<</Type /ExtGState /ca 0>>",
      },
      content: `${contentOf(POP_LINES)}\nq /GS0 gs /Fm1 Do Q`,
    });
    // The page's resources name the ExtGState too.
    const text = latin1(doc).replace("/XObject <</Fm1 12 0 R>>", "/XObject <</Fm1 12 0 R>> /ExtGState <</GS0 14 0 R>>");
    expect((await analysePdf(toBytes(text))).findings).toEqual([]);
  });

  it("does not read a transparent heading as the issuer's", async () => {
    const lines = POP_LINES.slice(1);
    const doc = await makeDoc({
      lines,
      info: { ...BANK_INFO, producer: "iLovePDF" },
      objects: { 14: "<</Type /ExtGState /ca 0>>" },
      content: `q /GS0 gs BT /F1 18 Tf 72 760 Td (Proof of Payment) Tj ET Q\n${contentOf(lines)}`,
    });
    const text = latin1(doc).replace(
      "/Resources <</Font <</F1 7 0 R>>>>",
      "/Resources <</Font <</F1 7 0 R>> /ExtGState <</GS0 14 0 R>>>>",
    );
    const r = await analysePdf(toBytes(text));
    expect(r.issuer).toBe("unknown");
    expect(r.findings).toEqual([]);
  });
});

describe("coverage after missing or damaged parts", () => {
  it("names a missing page and makes every check that ran partial", async () => {
    const r = await analysePdf(
      await makeDoc({ lines: POP_LINES, objects: { 3: "<</Type /Pages /Kids [4 0 R 40 0 R] /Count 2>>" } }),
    );
    expect(r.unread).toContain("a page the document lists is missing");
    for (const c of Object.values(r.coverage)) expect(c.status).not.toBe("ran");
  });

  it("names a damaged PNG prediction", async () => {
    const bad = await deflate(Uint8Array.from([9, 1, 2, 3]));
    const bytes = await buildPdf({
      objects: {
        2: "<</Type /Catalog /Pages 3 0 R /Metadata 5 0 R>>",
        3: "<</Type /Pages /Kids [] /Count 0>>",
        5: { dict: "<</Type /Metadata /Filter /FlateDecode /DecodeParms <</Predictor 12 /Columns 3>>>>", stream: bad },
      },
      root: 2,
      size: 6,
    });
    const r = await analysePdf(bytes);
    expect(r.unread).toContain("a stream's PNG prediction is damaged");
  });

  it("returns a reason, never a throw, for an object stream with a damaged header", async () => {
    // No cross-reference start, so the objects are scanned and the object stream's header is read directly.
    const bytes = toBytes(
      "%PDF-1.7\n1 0 obj\n<</Type /Catalog /Pages 3 0 R>>\nendobj\n11 0 obj\n<</Type /ObjStm /N 2 /First 10 /Length 10>>\nstream\n2 0 ( 3 12\nendstream\nendobj\n%%EOF\n",
    );
    const r = await analysePdf(bytes);
    expect(r.unread).toContain("an object stream's header is damaged");
  });

  it("follows no reference that names another generation", async () => {
    const file = await readPdf(await genuinePop());
    expect(resolve(file, { kind: "ref", num: 7, gen: 1 })).toBeUndefined();
    expect(file.unread).toContain("a reference names an object of another generation, which was not followed");
    expect(resolve(file, { kind: "ref", num: 7, gen: 0 })).toBeDefined();
  });
});

describe("object boundaries and metadata", () => {
  it("reads an information dictionary whose string contains endobj", async () => {
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        objects: {
          6: "<</Title (see endobj here) /Producer (iLovePDF) /CreationDate (D:20261020101500) /ModDate (D:20261020101500)>>",
        },
      }),
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["producer"]);
  });

  it("reads single-quoted, prefixed and entity-escaped XMP like its plain form", async () => {
    const xmp = `<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'><rdf:Description xmlns:xap='http://ns.adobe.com/xap/1.0/' xmlns:pdf='http://ns.adobe.com/pdf/1.3/' pdf:Producer='Microsoft&#174; Word' xap:CreateDate='2026-10-20T10:15:00+02:00'><xap:ModifyDate>2026-10-28T14:22:00+02:00</xap:ModifyDate></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const r = await analysePdf(
      await makeDoc({
        lines: POP_LINES,
        info: {},
        objects: {
          2: "<</Type /Catalog /Pages 3 0 R /Metadata 15 0 R>>",
          15: { dict: "<</Type /Metadata /Subtype /XML>>", stream: xmp },
        },
      }),
    );
    expect(kinds(r)).toEqual(["dates", "producer"]);
    expect(r.findings.find((f) => f.kind === "producer")?.detail).toMatchObject({
      tool: "Microsoft Word",
      xmpProducer: "Microsoft® Word",
    });
  });
});

describe("the one-day date tolerance", () => {
  const pop = (created: string, modified: string) =>
    makeDoc({ lines: POP_LINES, info: { producer: "KestrelStatements 4.2", created, modified } });

  it("allows a modification the day after the payment date, not two days after", async () => {
    expect((await analysePdf(await pop("20261020101500", "20261021090000"))).findings).toEqual([]);
    expect(kinds(await analysePdf(await pop("20261020101500", "20261022090000")))).toEqual(["dates"]);
  });

  it("allows a creation the day before the payment it confirms, not two days before", async () => {
    expect((await analysePdf(await pop("20261019230000", "20261019230000"))).findings).toEqual([]);
    expect(kinds(await analysePdf(await pop("20261018090000", "20261018090000")))).toEqual(["dates"]);
  });
});

describe("limits and bounded work", () => {
  it("carries what each finding can and cannot show", async () => {
    const r = await analysePdf(
      await update({
        5: {
          dict: "<<>>",
          stream: contentOf(
            POP_LINES.map((l) => (l.text.startsWith("Amount") ? { ...l, text: "Amount: R 99.00" } : l)),
          ),
        },
      }),
    );
    const [item] = forensicsEvidence(r, { key: "k", filename: "pop.pdf" });
    expect(item?.detail.limits).toBe(LIMITS.revisions);
    expect(LIMITS.revisions).toMatch(/cannot show/);
  });

  it("groups 20,000 numeric text runs on amount lines in under a second", async () => {
    // Each run on a line of its own, the shape that made grouping quadratic.
    const runs = Array.from({ length: 20_000 }, (_, i) => `BT /F1 1 Tf 20 ${40_000 - i * 2} Td (R ${i}.00) Tj ET`).join(
      "\n",
    );
    const bytes = await makeDoc({ lines: [], content: runs });
    const start = performance.now();
    const r = await analysePdf(bytes);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(r.coverage.fonts.status).not.toBe("unavailable");
  });
});
