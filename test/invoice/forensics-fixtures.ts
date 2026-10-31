// The synthetic documents the forensics tests read (D06 T02 §1): a fictional bank's proof of payment and a fictional
// supplier's invoice, each built genuine and then altered one way, with the controls that must stay silent.
import { appendUpdate, buildPdf, contentOf, type Objects, type TextLine, toBytes, type XrefStyle } from "./pdf-writer";

export const HELVETICA = "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>";
export const HELVETICA_BOLD = "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>";
export const TIMES = "<</Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding>>";
export const COURIER = "<</Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding>>";

export const POP_LINES: TextLine[] = [
  { font: "F1", size: 18, x: 72, y: 760, text: "Proof of Payment" },
  { font: "F1", size: 10, x: 72, y: 740, text: "Kestrel Bank Limited (fictional) - SYNTHETIC TEST DOCUMENT" },
  { font: "F1", size: 11, x: 72, y: 700, text: "Date paid: 2026-10-20" },
  { font: "F1", size: 11, x: 72, y: 680, text: "Beneficiary: Hadeda Couriers (Pty) Ltd" },
  { font: "F1", size: 11, x: 72, y: 660, text: "Account number: 62004417731" },
  { font: "F1", size: 11, x: 72, y: 640, text: "Branch code: 250655" },
  { font: "F1", size: 11, x: 72, y: 620, text: "Amount: R 12 450.00" },
  { font: "F1", size: 11, x: 72, y: 600, text: "Reference: INV-2026-0412" },
];

export const INVOICE_LINES: TextLine[] = [
  { font: "F1", size: 18, x: 72, y: 760, text: "Tax Invoice" },
  { font: "F1", size: 10, x: 72, y: 740, text: "Hadeda Couriers (Pty) Ltd (fictional) - SYNTHETIC TEST DOCUMENT" },
  { font: "F1", size: 11, x: 72, y: 700, text: "Invoice date: 2026-10-12" },
  { font: "F1", size: 11, x: 72, y: 680, text: "Courier services, October: R 4 100.00" },
  { font: "F1", size: 11, x: 72, y: 660, text: "Banking details: Kestrel Bank, account 62004417731, branch 250655" },
  { font: "F1", size: 11, x: 72, y: 640, text: "Please send proof of payment to accounts@hadeda.example" },
  { font: "F1", size: 11, x: 72, y: 620, text: "Total due: R 4 100.00" },
];

export type Info = { producer?: string; creator?: string; created?: string; modified?: string };
export type Doc = {
  lines: TextLine[];
  fonts?: Record<string, string>;
  extra?: string;
  xobjects?: Record<string, number>;
  objects?: Objects;
  info?: Info;
  xref?: XrefStyle;
  linearized?: boolean;
  compress?: boolean;
  content?: string | string[];
};

// Object numbers: 2 the catalog, 3 the page tree, 4 the page, 5 the content, 6 the information dictionary, 7 to 9 the
// fonts, 11 and up the document's own extras (1 is left for a linearization dictionary).
export const infoDict = (i: Info) =>
  `<<${i.producer ? ` /Producer (${i.producer})` : ""}${i.creator ? ` /Creator (${i.creator})` : ""}${i.created ? ` /CreationDate (D:${i.created})` : ""}${i.modified ? ` /ModDate (D:${i.modified})` : ""}>>`;

export function docObjects(d: Doc): { objects: Objects; size: number } {
  const fonts = d.fonts ?? { F1: HELVETICA };
  const fontNums: Record<string, number> = {};
  const objects: Objects = {};
  let n = 7;
  for (const [name, dict] of Object.entries(fonts)) {
    fontNums[name] = n;
    objects[n++] = dict;
  }
  const fontRes = Object.entries(fontNums)
    .map(([k, v]) => `/${k} ${v} 0 R`)
    .join(" ");
  const xo = d.xobjects
    ? ` /XObject <<${Object.entries(d.xobjects)
        .map(([k, v]) => `/${k} ${v} 0 R`)
        .join(" ")}>>`
    : "";
  objects[2] = "<</Type /Catalog /Pages 3 0 R>>";
  objects[3] = "<</Type /Pages /Kids [4 0 R] /Count 1>>";
  const contents = Array.isArray(d.content) ? d.content : [d.content ?? contentOf(d.lines, d.extra ?? "")];
  const contentRefs: number[] = [];
  contents.forEach((c, i) => {
    const num = i === 0 ? 5 : 30 + i;
    contentRefs.push(num);
    objects[num] = { dict: "<<>>", stream: c, compress: d.compress ?? true };
  });
  objects[4] = `<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <<${fontRes}>>${xo}>> /Contents ${contentRefs.length === 1 ? "5 0 R" : `[${contentRefs.map((r) => `${r} 0 R`).join(" ")}]`}>>`;
  objects[6] = infoDict(
    d.info ?? {
      producer: "KestrelStatements 4.2",
      created: "20261020101500+02'00'",
      modified: "20261020101500+02'00'",
    },
  );
  Object.assign(objects, d.objects ?? {});
  const size = Math.max(...Object.keys(objects).map(Number)) + 1;
  return { objects, size };
}

export async function makeDoc(d: Doc): Promise<Uint8Array> {
  const { objects, size } = docObjects(d);
  return buildPdf({ objects, root: 2, info: 6, size, xref: d.xref, linearized: d.linearized });
}

export const BANK_INFO: Info = {
  producer: "KestrelStatements 4.2",
  created: "20261020101500+02'00'",
  modified: "20261020101500+02'00'",
};

// A 1 by 1 grey image.
export const IMAGE = {
  dict: "<</Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8>>",
  stream: "\x80",
};

export const genuinePop = () => makeDoc({ lines: POP_LINES, info: BANK_INFO });

// The amount changed by a later save that replaces the page's content stream.
export async function editedPop(base?: Uint8Array): Promise<Uint8Array> {
  const original = base ?? (await genuinePop());
  const lines = POP_LINES.map((l) => (l.text.startsWith("Amount") ? { ...l, text: "Amount: R 112 450.00" } : l));
  return appendUpdate(original, {
    objects: { 5: { dict: "<<>>", stream: contentOf(lines), compress: true } },
    root: 2,
    info: 6,
    size: 12,
  });
}

// The metadata alone rewritten by a later save.
export const metadataOnly = async () =>
  appendUpdate(await genuinePop(), {
    objects: {
      6: `<< /Producer (KestrelStatements 4.2) /Title (Payment 0412) /CreationDate (D:20261020101500+02'00') /ModDate (D:20261020101500+02'00')>>`,
    },
    root: 2,
    info: 6,
    size: 12,
  });

// Signed by a later save: a signature field, its widget, the catalog's form and the page's annotation list.
export async function signedPop(): Promise<Uint8Array> {
  const page4 =
    "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 7 0 R>>>> /Contents 5 0 R /Annots [21 0 R]>>";
  return appendUpdate(await genuinePop(), {
    objects: {
      2: "<</Type /Catalog /Pages 3 0 R /AcroForm 22 0 R>>",
      4: page4,
      20: `<</Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <${"00".repeat(64)}>>>`,
      21: "<</Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /V 20 0 R /Rect [0 0 0 0] /P 4 0 R>>",
      22: "<</Fields [21 0 R] /SigFlags 3>>",
    },
    root: 2,
    info: 6,
    size: 23,
  });
}

export const signedThenEdited = async () => {
  const signed = await signedPop();
  const lines = POP_LINES.map((l) => (l.text.startsWith("Amount") ? { ...l, text: "Amount: R 112 450.00" } : l));
  return appendUpdate(signed, {
    objects: { 5: { dict: "<<>>", stream: contentOf(lines), compress: true } },
    root: 2,
    info: 6,
    size: 23,
  });
};

export const stringBytes = toBytes;
