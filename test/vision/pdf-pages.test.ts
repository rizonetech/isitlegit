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
function makePdf(texts: string[], extra = "", heights?: number[]): Uint8Array {
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
    const stream = `BT /F1 48 Tf 72 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
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

describe("rasterisePdf", () => {
  it("proves page order from the stored PNGs, and a timed-out render leaves the browser usable", async () => {
    const caseId = await newCase();
    const b = await launch();
    const ordered = await rasterisePdf(b, store, caseId, {
      name: "order.pdf",
      sha: "0rder0rd",
      bytes: makePdf(["Short", "Tall", "Taller"], "", [400, 800, 1200]),
    });
    expect(ordered.rendered).toBe(3);
    const heights: number[] = [];
    for (const page of ordered.pages) {
      const read = await readArtefact(store, caseId, page.key);
      if (read && "body" in read) heights.push(pngSize(read.body).height);
    }
    // The stored pages come back in document order: each taller than the one before.
    expect(heights).toEqual([400, 800, 1200].map((h) => Math.round((1600 * h) / 612)));
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
