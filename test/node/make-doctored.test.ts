// The doctored pairs generator (D06 T02 §4): 20 genuine synthetic documents, one labelled edit
// each, a model refusal replaced in code, and a restart that reuses completed pairs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, editInstruction, ImageResponse, makePair, runAll, svgOf } from "../../scripts/fixtures/make-doctored.ts";

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
    const tmp = join(import.meta.dirname, "../../eval/sets/payment-docs-tmp");
    rmSync(tmp, { recursive: true, force: true });
    const failing = async (): Promise<Buffer> => {
      throw Object.assign(new Error("refused"), { kind: "content-policy" });
    };
    const labels = await makePair(spec, failing, tmp);
    expect(labels.map((l) => [l.role, l.made_by])).toEqual([
      ["genuine", null],
      ["doctored", "code"],
    ]);
    expect(existsSync(join(tmp, `${spec.pair}-doctored.png`))).toBe(true);
    const before = readFileSync(join(tmp, `${spec.pair}-doctored.png`));
    const again = await makePair(
      spec,
      async () => {
        throw new Error("must not be called for a completed pair");
      },
      tmp,
    );
    expect(again[1]?.made_by).toBe("code");
    expect(readFileSync(join(tmp, `${spec.pair}-doctored.png`))).toEqual(before);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("makes an unchanged model output in code, never as a model edit", async () => {
    const spec = DOCS[1] as (typeof DOCS)[number];
    const tmp = join(import.meta.dirname, "../../eval/sets/payment-docs-tmp2");
    rmSync(tmp, { recursive: true, force: true });
    const labels = await makePair(spec, async (_s, genuine) => genuine, tmp);
    expect(labels[1]?.made_by).toBe("code");
    expect(labels[1]?.note).toContain("unchanged");
    rmSync(tmp, { recursive: true, force: true });
  });
});

it("recovers provenance from sidecars on a restart without a manifest", async () => {
  const tmp = join(import.meta.dirname, "../../eval/sets/payment-docs-tmp3");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const spec = DOCS[0] as (typeof DOCS)[number];
  await makePair(
    spec,
    async () => {
      throw Object.assign(new Error("refused"), { kind: "content-policy" });
    },
    tmp,
  );
  rmSync(join(tmp, "labels.json"), { force: true });
  writeFileSync(join(tmp, `${spec.pair}.json`), JSON.stringify({ pair: spec.pair, made_by: "model", note: "kept" }));
  const labels = await runAll(null, tmp);
  const doctored = labels.find((l) => l.pair === spec.pair && l.role === "doctored");
  expect(doctored?.made_by).toBe("model");
  expect(doctored?.note).toBe("kept");
  rmSync(tmp, { recursive: true, force: true });
});
