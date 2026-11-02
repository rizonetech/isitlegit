// The doctored pairs generator (D06 T02 §4): 20 genuine synthetic documents, one labelled edit
// each, a model refusal replaced in code, and a restart that reuses completed pairs.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, editInstruction, ImageResponse, makePair, svgOf } from "../../scripts/fixtures/make-doctored.ts";

const OUT = join(import.meta.dirname, "../../eval/sets/payment-docs");

describe("make-doctored", () => {
  it("names 20 genuine sources with one edit each", () => {
    expect(DOCS).toHaveLength(20);
    expect(new Set(DOCS.map((d) => d.pair)).size).toBe(20);
    for (const d of DOCS) {
      expect(svgOf(d)).toContain("SYNTHETIC TEST DOCUMENT");
      expect(editInstruction(d)).toContain("SYNTHETIC");
    }
    expect(() => ImageResponse.parse({ data: [{ b64_json: "" }] })).toThrow();
    expect(ImageResponse.parse({ data: [{ b64_json: "QQ==" }] }).data).toHaveLength(1);
  });

  it("makes a pair in code when the model edit fails, and reuses it on a restart", async () => {
    const spec = DOCS[0] as (typeof DOCS)[number];
    rmSync(join(OUT, `${spec.pair}-genuine.png`), { force: true });
    rmSync(join(OUT, `${spec.pair}-doctored.png`), { force: true });
    const failing = async (): Promise<Buffer> => {
      throw new Error("content-policy");
    };
    const labels = await makePair(spec, failing);
    expect(labels.map((l) => [l.role, l.made_by])).toEqual([
      ["genuine", null],
      ["doctored", "code"],
    ]);
    expect(existsSync(join(OUT, `${spec.pair}-doctored.png`))).toBe(true);
    const before = readFileSync(join(OUT, `${spec.pair}-doctored.png`));
    const again = await makePair(spec, async () => {
      throw new Error("must not be called for a completed pair");
    });
    expect(again[1]?.made_by).toBe("code");
    expect(readFileSync(join(OUT, `${spec.pair}-doctored.png`))).toEqual(before);
  });
});
