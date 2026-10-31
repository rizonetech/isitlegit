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
      const line = `BT /F1 10 Tf 72 720 Td (Page marker ${i}.) Tj 0 -12 Td ${"(Invoice line for the month of October, item and amount.) Tj 0 -12 Td ".repeat(50)}ET`;
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
    // Every page read: each one's marker, and every line (round 5: the time alone would pass a first page only).
    for (let i = 0; i < pages; i++) expect(read.text).toContain(`Page marker ${i}.`);
    expect(read.text.split("Invoice line for the month of October").length - 1).toBe(pages * 50);
    expect(ms).toBeLessThan(2_000);
  });

  it("indexes a megabyte of digits in linear time (round 3: the object pattern was quadratic on them)", async () => {
    const bytes = new TextEncoder().encode(`%PDF-1.7\n%${"7".repeat(1024 * 1024)}\n`);
    const start = performance.now();
    const read = await pdfText(bytes);
    const ms = performance.now() - start;
    console.log(`pdfText: a megabyte of digits, ${ms.toFixed(0)} ms`);
    expect(read.unread).toContain("its pages could not be found");
    expect(ms).toBeLessThan(1_000);
  });

  it("reads a CMap of a range repeated many times, or of unclosed blocks, in bounded time (round 4)", async () => {
    const page = (cmap: string) => {
      const content = "BT /F1 12 Tf <0001> Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>",
        `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
      ];
      return new TextEncoder().encode(
        `%PDF-1.7\n${objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("")}trailer\n<< /Root 1 0 R >>\n`,
      );
    };
    for (const cmap of [
      "1 begincodespacerange <0000> <ffff> endcodespacerange " +
        "1 beginbfrange <0000> <9c3f> <0041> endbfrange ".repeat(1000),
      "beginbfchar ".repeat(200_000),
      "1 beginbfrange " + "<0000> <0001> [".repeat(50_000),
    ]) {
      const start = performance.now();
      await pdfText(page(cmap));
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});
