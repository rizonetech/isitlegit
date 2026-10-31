// The forensics on files real software wrote (D06 T02 §1): Ghostscript's pdfwrite and Chromium's PDF output, made by
// test/fixtures/pdf-forensics/make.ts. Each detector fires on its altered file and stays silent on the genuine ones.
import { describe, expect, it } from "vitest";
import { analysePdf } from "../../src/invoice/forensics";
import { generated } from "../fixtures/pdf-forensics/load";

const EXPECTED: Record<keyof typeof generated, string[]> = {
  "gs-genuine-pop.pdf": [],
  "gs-logo.pdf": [],
  "chromium-invoice.pdf": [],
  "gs-edited-pop.pdf": ["revisions"],
  "gs-modified-pop.pdf": ["dates"],
  "gs-substituted-font.pdf": ["fonts"],
  "gs-pasted-image.pdf": ["overlay"],
  "chromium-pop.pdf": ["producer"],
};

describe("forensics on Ghostscript and Chromium files", () => {
  for (const [name, kinds] of Object.entries(EXPECTED))
    it(`${name} yields ${kinds.length ? kinds.join(", ") : "nothing"}`, async () => {
      const r = await analysePdf(generated[name as keyof typeof generated]);
      expect(r.findings.map((f) => f.kind)).toEqual(kinds);
      expect(r.unread).toEqual([]);
    });

  it("reads each Ghostscript POP's heading as a bank's and the Chromium invoice's as unknown", async () => {
    expect((await analysePdf(generated["gs-genuine-pop.pdf"])).issuer).toBe("bank");
    expect((await analysePdf(generated["chromium-pop.pdf"])).issuer).toBe("bank");
    expect((await analysePdf(generated["chromium-invoice.pdf"])).issuer).toBe("unknown");
  });
});
