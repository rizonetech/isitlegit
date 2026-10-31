// D02 T05 §4's completion review: a document's text read in bounded time, on the wall clock (workerd's stands still
// while code runs): a 200-page PDF, every page a compressed stream of text, read in well under the checks step's time.
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfText } from "../../src/checks/pdf-text.ts";

describe("pdfText on a 200-page document", () => {
  it("reads every page in under two seconds", async () => {
    const pages = 200;
    const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
    const obj = (n: number, body: Buffer | string) =>
      parts.push(
        Buffer.from(`${n} 0 obj\n`),
        Buffer.isBuffer(body) ? body : Buffer.from(body),
        Buffer.from("\nendobj\n"),
      );
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const kids = Array.from({ length: pages }, (_, i) => `${10 + i * 2} 0 R`).join(" ");
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
    obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    for (let i = 0; i < pages; i++) {
      const line = `BT /F1 10 Tf 72 720 Td ${"(Invoice line for the month of October, item and amount.) Tj 0 -12 Td ".repeat(50)}ET`;
      const data = deflateSync(Buffer.from(line));
      obj(
        10 + i * 2,
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents ${11 + i * 2} 0 R >>`,
      );
      obj(
        11 + i * 2,
        Buffer.concat([
          Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`),
          data,
          Buffer.from("\nendstream"),
        ]),
      );
    }
    parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n"));
    const bytes = new Uint8Array(Buffer.concat(parts));
    const start = performance.now();
    const read = await pdfText(bytes);
    const ms = performance.now() - start;
    console.log(`pdfText: ${pages} pages, ${bytes.length} bytes, ${read.text.length} characters, ${ms.toFixed(0)} ms`);
    expect(read.unread).toEqual([]);
    expect(ms).toBeLessThan(2_000);
  });
});
