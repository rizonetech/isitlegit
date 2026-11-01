import { env } from "cloudflare:workers";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { readArtefact, type Store } from "../../src/intake/store";
import { PdfUnreadable, rasterisePdf, recordPdfFailure } from "../../src/vision/pdf-pages";

// D03 T02 §2: PDF rasterisation through the real Browser Run bootstrap. Fixtures are synthetic PDFs written by
// this file (a text page each, a damaged file, an encrypted one); no client document is used.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
let browser: Browser | undefined;
afterEach(async () => {
  if (browser?.connected) await browser.close();
  browser = undefined;
});
const launch = async () => (browser = await puppeteer.launch(env.BROWSER));

// A minimal multi-page PDF: one Helvetica line a page, correct xref offsets.
function makePdf(texts: string[], extra = "", heights?: number[], rects?: number[]): Uint8Array {
  const objects: string[] = [];
  const kids = texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${texts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((text, i) => {
    const page = 4 + i * 2;
    const content = 5 + i * 2;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${heights?.[i] ?? 792}] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const rect = rects?.[i] ? `0 0 0 rg 0 100 ${rects[i]} 60 re f ` : "";
    const stream = `${rect}BT /F1 48 Tf 72 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects[content] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R ${extra} >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const encryptedPdf = () =>
  makePdf(
    ["Secret"],
    "/Encrypt << /Filter /Standard /V 1 /R 2 /O (00000000000000000000000000000000) /U (00000000000000000000000000000000) /P -44 >>",
  );

async function newCase() {
  const made = await createCase(env.DB, { orgId: "org-pdf", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

const barReaches = async (b: Browser, bytes: Uint8Array, xPoints: number, pagePoints: number) => {
  const page = await b.newPage();
  try {
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const evaluate = page.evaluate.bind(page) as unknown as (
      fn: (data: string, x: number, pageH: number) => Promise<boolean>,
      data: string,
      x: number,
      pageH: number,
    ) => Promise<boolean>;
    return await evaluate(
      async (data: string, x: number, pageH: number) => {
        type Img = {
          width: number;
          height: number;
          src: string;
          onload: (() => void) | null;
          onerror: (() => void) | null;
        };
        const g = globalThis as unknown as {
          Image: new () => Img;
          document: {
            createElement: (tag: string) => {
              width: number;
              height: number;
              getContext: (kind: string) => {
                drawImage: (img: Img, dx: number, dy: number) => void;
                getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
              } | null;
            };
          };
        };
        const img = new g.Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("image did not load"));
          img.src = `data:image/png;base64,${data}`;
        });
        const canvas = g.document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(
          Math.round((x * img.width) / 612),
          img.height - Math.round((130 * img.height) / pageH),
          1,
          1,
        ).data;
        return (px[3] ?? 0) > 0 && (px[0] ?? 255) < 128;
      },
      btoa(b64),
      xPoints,
      pagePoints,
    );
  } finally {
    await page.close();
  }
};

const pngSize = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const makeBigPdf = () => {
  const texts = ["Small", "Big", "After"];
  const pdf = makePdf(texts);
  return new TextEncoder().encode(
    new TextDecoder().decode(pdf).replace("[0 0 612 792] /Contents 7 0 R", "[0 0 612 7920] /Contents 7 0 R"),
  );
};

// A one-page PDF whose only content is a 5000 by 5000 grayscale image: past the decoded-image bound, so the
// page must be stated as not decoded, never stored blank as a complete render.
const makeImagePdf = async (mediaBox = "[0 0 612 792]", content = "q 500 0 0 500 56 100 cm /Im1 Do Q") => {
  const row = new Uint8Array(5000).fill(128);
  const raw = new Uint8Array(5000 * 5000);
  for (let r = 0; r < 5000; r++) raw.set(row, r * 5000);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([raw.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: Record<number, number> = {};
  let length = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    length += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
  };
  push(enc.encode("%PDF-1.4\n"));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
  obj(
    4,
    `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Contents 5 0 R /Resources << /XObject << /Im1 6 0 R >> >> >>`,
  );
  const stream = content;
  obj(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  offsets[6] = length;
  push(
    enc.encode(
      `6 0 obj\n<< /Type /XObject /Subtype /Image /Width 5000 /Height 5000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${compressed.length} >>\nstream\n`,
    ),
  );
  push(compressed);
  push(enc.encode("\nendstream\nendobj\n"));
  const xref = length;
  let tail = "xref\n0 7\n0000000000 65535 f \n";
  for (let n = 1; n <= 6; n++) tail += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(enc.encode(`${tail}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// A two-page PDF whose second page's content stream is genuinely empty (optionally Flate whitespace).
const makeBlankSecondPdf = async (flate: boolean) => {
  const enc = new TextEncoder();
  const blankRaw = flate
    ? new Uint8Array(
        await new Response(
          new Blob([enc.encode("  \n  ").buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate")),
        ).arrayBuffer(),
      )
    : enc.encode("");
  const parts: Uint8Array[] = [];
  const offsets: Record<number, number> = {};
  let length = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    length += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
  };
  push(enc.encode("%PDF-1.4\n"));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>");
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  obj(
    4,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
  );
  const stream = "BT /F1 48 Tf 72 700 Td (Invoice) Tj ET";
  obj(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  obj(6, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << >> >>");
  offsets[7] = length;
  push(enc.encode(`7 0 obj\n<< /Length ${blankRaw.length}${flate ? " /Filter /FlateDecode" : ""} >>\nstream\n`));
  push(blankRaw);
  push(enc.encode("\nendstream\nendobj\n"));
  const xref = length;
  let tail = "xref\n0 8\n0000000000 65535 f \n";
  for (let n = 1; n <= 7; n++) tail += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(enc.encode(`${tail}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("rasterisePdf", () => {
  it("reads the active revision of an incrementally updated page", async () => {
    const caseId = await newCase();
    // Base revision: page 4 is blank. Appended revision: page 4 paints only the oversized image.
    const enc = new TextEncoder();
    const row = new Uint8Array(5000).fill(128);
    const rawImg = new Uint8Array(5000 * 5000);
    for (let r = 0; r < 5000; r++) rawImg.set(row, r * 5000);
    const img = new Uint8Array(
      await new Response(
        new Blob([rawImg.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
    const parts: Uint8Array[] = [];
    let length = 0;
    const push = (b: Uint8Array) => {
      parts.push(b);
      length += b.length;
    };
    push(enc.encode("%PDF-1.4\n"));
    push(enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
    push(enc.encode("2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n"));
    push(enc.encode("4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Resources << >> >>\nendobj\n"));
    const imgAt = length;
    push(
      enc.encode(
        `6 0 obj\n<< /Type /XObject /Subtype /Image /Width 5000 /Height 5000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${img.length} >>\nstream\n`,
      ),
    );
    push(img);
    push(enc.encode("\nendstream\nendobj\n"));
    const xref1 = length;
    push(
      enc.encode(
        `xref\n0 7\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000000 65535 f \n0000000110 00000 n \n0000000000 65535 f \n${String(imgAt).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref1}\n%%EOF\n`,
      ),
    );
    const pageAt = length;
    push(
      enc.encode(
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 5 0 R /Resources << /XObject << /Im1 6 0 R >> >> >>\nendobj\n",
      ),
    );
    const contentsAt = length;
    push(enc.encode("5 0 obj\n<< /Length 7 >>\nstream\n/Im1 Do\nendstream\nendobj\n"));
    const xref2 = length;
    push(
      enc.encode(
        `xref\n4 2\n${String(pageAt).padStart(10, "0")} 00000 n \n${String(contentsAt).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 7 /Root 1 0 R /Prev ${xref1} >>\nstartxref\n${xref2}\n%%EOF`,
      ),
    );
    const pdf = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      pdf.set(part, at);
      at += part.length;
    }
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "updated.pdf",
      sha: "upda7ed1",
      bytes: pdf,
    });
    // The active page paints a refused image: stated unproven, never complete from the stale blank revision.
    expect(result.complete).toBe(false);
  });

  it("keeps genuinely blank pages complete, plain and Flate-compressed", async () => {
    for (const flate of [false, true]) {
      const caseId = await newCase();
      const result = await rasterisePdf(await launch(), store, caseId, {
        name: "blank2.pdf",
        sha: flate ? "f1a7ef1a" : "p1a1np1a",
        bytes: await makeBlankSecondPdf(flate),
      });
      expect(result.rendered).toBe(2);
      expect(result.complete).toBe(true);
    }
  });

  it("keeps a valid blank page complete, and returns stored pages when a later write fails", async () => {
    const blankCase = await newCase();
    const withBlank = await rasterisePdf(await launch(), store, blankCase, {
      name: "blank.pdf",
      sha: "b1ankb1a",
      bytes: makePdf(["Invoice", ""]),
    });
    expect(withBlank.rendered).toBe(2);
    expect(withBlank.complete).toBe(true);

    const failCase = await newCase();
    let puts = 0;
    const flaky = {
      bucket: {
        put: async () => {
          puts++;
          if (puts === 2) throw new Error("r2 down");
          return { key: "stored" };
        },
        get: async () => null,
        delete: async () => undefined,
        head: async () => null,
      },
      db: env.DB,
    } as unknown as Store;
    const partial = await rasterisePdf(await launch(), flaky, failCase, {
      name: "three.pdf",
      sha: "7hree7hr",
      bytes: makePdf(["One", "Two", "Three"]),
    });
    expect(partial.rendered).toBe(1);
    expect(partial.pages).toHaveLength(1);
    expect(partial.complete).toBe(false);
    expect(partial.reason).toContain("storing page 2 failed");
  });

  it("states a page whose only content is a refused image as unproven, not complete", async () => {
    const caseId = await newCase();
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "tiny.pdf",
      sha: "71ny71ny",
      bytes: await makeImagePdf("[0 0 1 1]", "/Im1 Do"),
    });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("within the size bounds");
  });

  it("renders a Type0 font document whose encoding needs a packed CMap", async () => {
    const caseId = await newCase();
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const offsets: Record<number, number> = {};
    let length = 0;
    const push = (b: Uint8Array) => {
      parts.push(b);
      length += b.length;
    };
    const obj = (n: number, body: string) => {
      offsets[n] = length;
      push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
    };
    push(enc.encode("%PDF-1.4\n"));
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
    obj(
      3,
      "<< /Type /Font /Subtype /Type0 /BaseFont /FakeHei /Encoding /UniJIS-UTF16-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>",
    );
    obj(
      4,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    );
    const stream = "BT /F1 48 Tf 72 700 Td <0001> Tj ET";
    obj(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    obj(
      7,
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FakeHei /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 9 0 R /DW 1000 >>",
    );
    const toUni =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfchar\n<0001> <3042>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
    obj(8, `<< /Length ${toUni.length} >>\nstream\n${toUni}\nendstream`);
    obj(
      9,
      "<< /Type /FontDescriptor /FontName /FakeHei /Flags 4 /FontBBox [0 -100 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>",
    );
    const xref = length;
    let tail = "xref\n0 10\n0000000000 65535 f \n";
    for (let n = 1; n <= 9; n++) tail += `${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`;
    push(enc.encode(`${tail}trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
    const pdf = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      pdf.set(part, at);
      at += part.length;
    }
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "cjk.pdf",
      sha: "cjk0cjk0",
      bytes: pdf,
    });
    expect(result.rendered).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("renders every page of a document that shares one image across pages", async () => {
    const caseId = await newCase();
    const enc = new TextEncoder();
    // A 2x2 grayscale Flate image, raw rows, deflated by the same stream machinery the scanner uses.
    const raw = new Uint8Array([0, 0, 255, 0, 255, 0]);
    const img = new Uint8Array(
      await new Response(
        new Blob([raw.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
    const parts: Uint8Array[] = [];
    const offsets: Record<number, number> = {};
    let length = 0;
    const push = (b: Uint8Array) => {
      parts.push(b);
      length += b.length;
    };
    const obj = (n: number, body: string) => {
      offsets[n] = length;
      push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
    };
    push(enc.encode("%PDF-1.4\n"));
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>");
    const resources = "/Resources << /XObject << /Im1 8 0 R >> >>";
    obj(4, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R ${resources} >>`);
    obj(5, `<< /Length 40 >>\nstream\nq 200 0 0 200 100 100 cm /Im1 Do Q\nendstream`);
    obj(6, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R ${resources} >>`);
    obj(7, `<< /Length 40 >>\nstream\nq 200 0 0 200 100 100 cm /Im1 Do Q\nendstream`);
    offsets[8] = length;
    push(
      enc.encode(
        `8 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${img.length} >>\nstream\n`,
      ),
    );
    push(img);
    push(enc.encode("\nendstream\nendobj\n"));
    const xref = length;
    let tail = "xref\n0 9\n0000000000 65535 f \n";
    for (let n = 1; n <= 8; n++) tail += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(enc.encode(`${tail}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
    const pdf = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      pdf.set(part, at);
      at += part.length;
    }
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "shared.pdf",
      sha: "5hared5h",
      bytes: pdf,
    });
    expect(result.rendered).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("states a corrupt embedded image as not decoded at its page", async () => {
    const caseId = await newCase();
    // A small PDF with text and a corrupt JPEG image: the text renders, the image does not.
    const enc = new TextEncoder();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);
    const parts: Uint8Array[] = [];
    const offsets: Record<number, number> = {};
    let length = 0;
    const push = (b: Uint8Array) => {
      parts.push(b);
      length += b.length;
    };
    const obj = (n: number, body: string) => {
      offsets[n] = length;
      push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
    };
    push(enc.encode("%PDF-1.4\n"));
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
    obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    obj(
      4,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 6 0 R >> >> >>",
    );
    const stream = "BT /F1 48 Tf 72 700 Td (Invoice) Tj ET Q q 400 0 0 400 100 100 cm /Im1 Do Q";
    obj(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    offsets[6] = length;
    push(
      enc.encode(
        `6 0 obj\n<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
    );
    push(jpeg);
    push(enc.encode("\nendstream\nendobj\n"));
    const xref = length;
    let tail = "xref\n0 7\n0000000000 65535 f \n";
    for (let n = 1; n <= 6; n++) tail += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(enc.encode(`${tail}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
    const pdf = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      pdf.set(part, at);
      at += part.length;
    }
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "corrupt.pdf",
      sha: "c0rrup7c",
      bytes: pdf,
    });
    expect(result.rendered).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("ImageNotDecoded");
  });

  it("states an image past the decoded-size bound as not decoded, not as a complete blank page", async () => {
    const caseId = await newCase();
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "scan.pdf",
      sha: "5can5can",
      bytes: await makeImagePdf(),
    });
    // The page renders without its oversized image: kept, but stated partial, never complete.
    expect(result.rendered).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("within the size bounds");
  });

  it("proves page order from the stored PNGs, and a timed-out render leaves the browser usable", async () => {
    const caseId = await newCase();
    const b = await launch();
    const ordered = await rasterisePdf(b, store, caseId, {
      name: "order.pdf",
      sha: "0rder0rd",
      bytes: makePdf(["Short", "Tall", "Taller"], "", [400, 800, 1200], [100, 200, 300]),
    });
    expect(ordered.rendered).toBe(3);
    const heights: number[] = [];
    for (const page of ordered.pages) {
      const read = await readArtefact(store, caseId, page.key);
      if (read && "body" in read) heights.push(pngSize(read.body).height);
    }
    // The stored pages come back in document order: each taller than the one before.
    expect(heights).toEqual([400, 800, 1200].map((h) => Math.round((1600 * h) / 612)));
    // And their decoded content is each page's own: the black bar on page n reaches 100*(n+1) points, no further.
    const bodies: Uint8Array[] = [];
    for (const page of ordered.pages) {
      const read = await readArtefact(store, caseId, page.key);
      if (read && "body" in read) bodies.push(read.body);
    }
    for (const [i, body] of bodies.entries()) {
      expect(await barReaches(b, body, 100 * (i + 1) - 20, [400, 800, 1200][i] as number)).toBe(true);
      expect(await barReaches(b, body, 100 * (i + 1) + 20, [400, 800, 1200][i] as number)).toBe(false);
    }
    await expect(
      rasterisePdf(
        b,
        store,
        caseId,
        { name: "slow.pdf", sha: "510w510w", bytes: makePdf(["A", "B"]) },
        { deadlineMs: 5 },
      ),
    ).rejects.toMatchObject({ kind: "operational" });
    const after = await rasterisePdf(b, store, caseId, {
      name: "next.pdf",
      sha: "nex7nex7",
      bytes: makePdf(["Next"]),
    });
    expect(after.rendered).toBe(1);
  });

  it("keeps the pages before one past the pixel bound", async () => {
    const caseId = await newCase();
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "big.pdf",
      sha: "b16b16b1",
      bytes: makeBigPdf(),
    });
    expect(result.rendered).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("stopped at page 2");
  });

  it("renders the first five pages at 1600 px, distinct and in order, read back from the store", async () => {
    const caseId = await newCase();
    const pdf = makePdf(["Page one", "Page two", "Page three", "Page four", "Page five", "Page six", "Page seven"]);
    const result = await rasterisePdf(await launch(), store, caseId, {
      name: "invoice.pdf",
      sha: "aaaa1111bbbb2222",
      bytes: pdf,
    });
    expect(result.totalPages).toBe(7);
    expect(result.rendered).toBe(5);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("five-page");
    const seen: string[] = [];
    for (const page of result.pages) {
      expect(page.width).toBe(1600);
      expect(page.height).toBe(Math.round((1600 * 792) / 612));
      const read = await readArtefact(store, caseId, page.key);
      expect(read && "body" in read).toBe(true);
      if (read && "body" in read) {
        expect(pngSize(read.body)).toEqual({ width: page.width, height: page.height });
        seen.push(read.body.slice(0, 64).join(","));
      }
    }
    expect(new Set(seen).size).toBe(5);
    // A retry writes the same artefacts again, no duplicates.
    const again = await rasterisePdf(browser as Browser, store, caseId, {
      name: "invoice.pdf",
      sha: "aaaa1111bbbb2222",
      bytes: pdf,
    });
    expect(again.pages.map((p) => p.key)).toEqual(result.pages.map((p) => p.key));
  });

  it("refuses damaged and encrypted PDFs as their typed kinds, and renders the good sibling after", async () => {
    const caseId = await newCase();
    const b = await launch();
    await expect(
      rasterisePdf(b, store, caseId, {
        name: "bad.pdf",
        sha: "bad0bad0",
        bytes: new TextEncoder().encode("%PDF- nope"),
      }),
    ).rejects.toMatchObject({
      name: "PdfUnreadable",
      kind: "malformed",
    });
    await expect(
      rasterisePdf(b, store, caseId, { name: "locked.pdf", sha: "10ck10ck", bytes: encryptedPdf() }),
    ).rejects.toMatchObject({
      kind: "encrypted",
    });
    await expect(
      rasterisePdf(b, store, caseId, { name: "gone.pdf", sha: "gone", bytes: new Uint8Array() }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
    const good = await rasterisePdf(b, store, caseId, { name: "ok.pdf", sha: "0k0k0k0k", bytes: makePdf(["Fine"]) });
    expect(good.rendered).toBe(1);
    await recordPdfFailure(env.DB, caseId, { name: "bad.pdf", sha: "badbadba" }, new PdfUnreadable("malformed", "x"));
    await recordPdfFailure(
      env.DB,
      caseId,
      { name: "locked.pdf", sha: "10cked10" },
      new PdfUnreadable("encrypted", "x"),
    );
    const evidence = (await readEvidence(env.DB, caseId)).filter((e) => e.check === "vision.pdf_unreadable");
    expect(evidence).toHaveLength(2);
    expect(evidence.map((e) => e.detail.kind)).toEqual(["malformed", "encrypted"]);
    // A hostile name is plain words in the summary, and recording the same refusal twice keeps one item.
    await recordPdfFailure(
      env.DB,
      caseId,
      { name: "<invoice>.pdf", sha: "b05t11e0" },
      new PdfUnreadable("malformed", "x"),
    );
    await recordPdfFailure(
      env.DB,
      caseId,
      { name: "<invoice>.pdf", sha: "b05t11e0" },
      new PdfUnreadable("malformed", "x"),
    );
    const hostile = (await readEvidence(env.DB, caseId)).filter((e) => e.detail.source === "invoice .pdf");
    expect(hostile).toHaveLength(1);
    expect(hostile[0]?.summary).not.toContain("<");
  });
});
