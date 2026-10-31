// Makes the forensics fixtures from two generators independent of the test writer (D06 T02 §1): Ghostscript's
// `pdfwrite` and Chromium's PDF output, so the analyser is proven on files real software writes, not only on our own
// dialect. Run from the repository root: `node test/node/make-pdf-forensics.ts`. Needs `gs` on PATH and the
// Chromium the browser tests use. Every document is synthetic, of fictional companies and banks, and says so.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteString, dictOf, isStream, readPdf, resolve, streamData } from "../../src/invoice/pdf.ts";
import { appendUpdate } from "../invoice/pdf-writer.ts";
import { launch } from "./browser.ts";

const OUT = join(import.meta.dirname, "../fixtures/pdf-forensics");
const work = mkdtempSync(join(tmpdir(), "pdf-forensics-"));

// Atomic: a temporary file in the destination folder, then a rename.
function save(name: string, bytes: Uint8Array) {
  const tmp = join(OUT, `.${name}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(OUT, name));
}

const ps = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
type Line = { font?: string; size?: number; y: number; text: string };
const POP: Line[] = [
  { size: 18, y: 760, text: "Proof of Payment" },
  { size: 10, y: 740, text: "Kestrel Bank Limited (fictional) - SYNTHETIC TEST DOCUMENT" },
  { y: 700, text: "Date paid: 2026-10-20" },
  { y: 680, text: "Beneficiary: Hadeda Couriers (Pty) Ltd" },
  { y: 660, text: "Account number: 62004417731" },
  { y: 640, text: "Branch code: 250655" },
  { y: 620, text: "Amount: R 12 450.00" },
  { y: 600, text: "Reference: INV-2026-0412" },
  { y: 580, text: "Fee: R 5.00" },
];
const DOCINFO = (mod = "20261020101500+02'00'") =>
  `[ /Title (Payment INV-2026-0412) /Creator (KestrelStatements 4.2) /CreationDate (D:20261020101500+02'00') /ModDate (D:${mod}) /DOCINFO pdfmark`;

function ghostscript(name: string, lines: Line[], extra = "", mod?: string): Uint8Array {
  const body = lines
    .map(
      (l) => `/${l.font ?? "Helvetica"} findfont ${l.size ?? 11} scalefont setfont 72 ${l.y} moveto ${ps(l.text)} show`,
    )
    .join("\n");
  const src = join(work, `${name}.ps`);
  const out = join(work, `${name}.pdf`);
  writeFileSync(src, `%!PS\n${DOCINFO(mod)}\n${body}\n${extra}\nshowpage\n`);
  execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", `-sOutputFile=${out}`, src]);
  return new Uint8Array(readFileSync(out));
}

// An update that redraws the page's content with one more run of text over the amount, as an editor's save does.
async function edited(base: Uint8Array): Promise<Uint8Array> {
  const file = await readPdf(base);
  const root = file.trailer?.entries.get("Root");
  const info = file.trailer?.entries.get("Info");
  const size = file.trailer?.entries.get("Size");
  const pages = dictOf(file, dictOf(file, root)?.entries.get("Pages"));
  const kids = resolve(file, pages?.entries.get("Kids"));
  const page = Array.isArray(kids) ? dictOf(file, kids[0]) : null;
  const contentsRef = page?.entries.get("Contents");
  const contents = resolve(file, contentsRef);
  const fonts = dictOf(file, dictOf(file, page?.entries.get("Resources"))?.entries.get("Font"));
  const fontName = fonts ? [...fonts.entries.keys()][0] : undefined;
  if (!isStream(contents) || !fontName || typeof size !== "number" || !contentsRef || typeof contentsRef !== "object")
    throw new Error("unexpected Ghostscript output");
  const data = await streamData(file, contents);
  if (!data) throw new Error("unreadable Ghostscript content");
  const num = (contentsRef as { num: number }).num;
  const rootNum = (root as { num: number }).num;
  const infoNum = info && typeof info === "object" ? (info as { num: number }).num : undefined;
  return appendUpdate(base, {
    objects: {
      [num]: {
        dict: "<<>>",
        stream: `${byteString(data)}\nq 1 0 0 1 0 0 cm BT /${fontName} 11 Tf 120 620 Td (112 450.00) Tj ET Q`,
        compress: true,
      },
    },
    root: rootNum,
    info: infoNum,
    size,
  });
}

const html = (heading: string, lines: string[]) =>
  `<!doctype html><meta charset="utf-8"><body style="font: 11pt Arial, sans-serif; margin: 2cm"><h1 style="font-size: 18pt">${heading}</h1>${lines.map((l) => `<p>${l}</p>`).join("")}</body>`;

async function chromiumFiles(): Promise<Record<string, Uint8Array>> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const pdf = async (doc: string) => {
      await page.setContent(doc);
      return new Uint8Array(await page.pdf({ format: "A4" }));
    };
    return {
      "chromium-pop.pdf": await pdf(
        html(
          "Proof of Payment",
          POP.slice(1).map((l) => l.text),
        ),
      ),
      "chromium-invoice.pdf": await pdf(
        html("Tax Invoice", [
          "Hadeda Couriers (Pty) Ltd (fictional) - SYNTHETIC TEST DOCUMENT",
          "Invoice date: 2026-10-12",
          "Courier services, October: R 4 100.00",
          "Banking details: Kestrel Bank, account 62004417731, branch 250655",
          "Please send proof of payment to accounts@hadeda.example",
          "Total due: R 4 100.00",
        ]),
      ),
    };
  } finally {
    await browser.close();
  }
}

try {
  const genuine = ghostscript("gs-genuine-pop", POP);
  save("gs-genuine-pop.pdf", genuine);
  save("gs-edited-pop.pdf", await edited(genuine));
  save("gs-modified-pop.pdf", ghostscript("gs-modified-pop", POP, "", "20261028142200+02'00'"));
  save(
    "gs-substituted-font.pdf",
    ghostscript(
      "gs-substituted-font",
      POP.map((l) => (l.text.startsWith("Amount") ? { ...l, font: "Times-Roman" } : l)),
    ),
  );
  save(
    "gs-pasted-image.pdf",
    ghostscript(
      "gs-pasted-image",
      POP,
      "gsave 70 616 translate 130 14 scale 1 1 8 [1 0 0 1 0 0] {<c0>} image grestore",
    ),
  );
  save(
    "gs-logo.pdf",
    ghostscript("gs-logo", POP, "gsave 450 760 translate 80 40 scale 1 1 8 [1 0 0 1 0 0] {<c0>} image grestore"),
  );
  for (const [name, bytes] of Object.entries(await chromiumFiles())) save(name, bytes);
} finally {
  rmSync(work, { recursive: true, force: true });
}
