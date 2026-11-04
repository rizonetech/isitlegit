// The forensics on files real software wrote (D06 T02 §1): Ghostscript's pdfwrite and Chromium's PDF output, made by
// test/node/make-pdf-forensics.ts. Each intended edit yields its signal; the genuine Chromium POP also has a producer
// finding. A finding alone does not establish tampering or reach verdict-level severity.
import { describe, expect, it } from "vitest";
import { analysePdf, FORENSIC_KINDS, forensicsEvidence } from "../../src/invoice/forensics";
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

// D06 T02 §8: diagnose the exact native-PDF limits without changing their verdict semantics.
const PINNED_HASHES = {
  "chromium-invoice.pdf": "2c47f6db63c5491003ff09312a18a7ac510a4e67cb91bed15b7eb474c1977b33",
  "chromium-pop.pdf": "12dea7e9e203bf7038e2bc67a1dc6397b4e99152cfd26116e714ebe95fe1b245",
  "gs-edited-pop.pdf": "8471cb6d535098aa6c37188da1c9b287584693041d503ccd180e8e03c742490a",
  "gs-genuine-pop.pdf": "0d7118a5165a7be8b6e56e2e0814dc0065328c06465a4aa783f10648771932a2",
  "gs-logo.pdf": "a999f86a3a1be600053d9012bd13c1267e3648832e8228ce11d97fe79604f522",
  "gs-modified-pop.pdf": "acdf3a753c77d9ce0a4d35a59e8082d9cba5ebd50e5e6f1c0e8e377ba25faa56",
  "gs-pasted-image.pdf": "85e7bb146452e9db60526c898caf15dd45700916994ae6b12c02bb405b31d2b6",
  "gs-substituted-font.pdf": "709748665276c58553171ba9e979c33561f03e5370402c6d0e6c203fcc3c0383",
} as const;

describe("native PDF diagnostic invariants", () => {
  it("retains every pinned generated fixture", () => {
    expect(Object.keys(generated).sort()).toEqual(Object.keys(PINNED_HASHES).sort());
  });
  for (const name of Object.keys(PINNED_HASHES) as (keyof typeof generated)[])
    it(`${name} retains its bytes, evidence strength and honest coverage`, async () => {
      const bytes = generated[name];
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(hash).toBe(PINNED_HASHES[name]);
      const report = await analysePdf(bytes);
      const evidence = forensicsEvidence(report, { key: `art/case/${name}`, filename: name });
      expect(evidence.map((item) => [item.check, item.severity])).toEqual(
        EXPECTED[name].map((kind) => [`document.forensics.${kind}`, "medium"]),
      );
      expect(evidence.some((item) => item.severity === "high" || item.severity === "critical")).toBe(false);
      for (const item of evidence) expect(item.detail.limits).toEqual(expect.any(String));
      expect(Object.keys(report.coverage).sort()).toEqual([...FORENSIC_KINDS].sort());
      for (const kind of FORENSIC_KINDS) {
        expect(report.coverage[kind]).toEqual(
          name === "chromium-invoice.pdf" && kind === "dates"
            ? { status: "unavailable", reason: "the document states no payment date" }
            : { status: "ran", reason: null },
        );
      }
      expect(report.unread).toEqual([]);
    });
});
