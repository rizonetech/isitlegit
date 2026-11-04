import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAMILIES, generate, SEED, writeCorpus } from "../../scripts/fixtures/make-lookalikes.ts";
import { measure, referenceSkeleton, techniques } from "../../scripts/measure-lookalikes.ts";
import { skeleton } from "../../src/checks/lookalike.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lookalike corpus and measurement", () => {
  it("freezes seeded independently labelled populations with every mutation family for every target", () => {
    const corpus = writeCorpus(undefined, true);
    expect(corpus).toEqual(generate(SEED));
    expect(generate(SEED + 1).positives).not.toEqual(corpus.positives);
    expect(corpus.targets.length).toBeGreaterThanOrEqual(20);
    expect(corpus.benign.length).toBe(60);
    expect(new Set(corpus.benign).size).toBe(60);
    for (const target of corpus.targets) {
      const positives = corpus.positives.filter((p) => p.target === target);
      expect(positives.map((p) => p.family)).toEqual(FAMILIES);
      for (const p of positives) expect(p.label).not.toBe(target);
      for (let i = 1; i <= 3; i++) {
        const accented = positives.find((p) => p.family === `accent-${i}`)?.label as string;
        expect([...accented.normalize("NFD").matchAll(/\p{M}/gu)]).toHaveLength(i);
      }
    }
  });

  it("refuses missing and stale fixtures without repairing them in check mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "lookalike-fixtures-"));
    directories.push(dir);
    expect(() => writeCorpus(dir, true)).toThrow();
    writeCorpus(dir);
    const original = readFileSync(join(dir, "positive.json"), "utf8");
    writeFileSync(join(dir, "benign.json"), "{}\n");
    expect(() => writeCorpus(dir, true)).toThrow(/Stale/);
    expect(readFileSync(join(dir, "benign.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(dir, "positive.json"), "utf8")).toBe(original);
  });

  it("pins the raw reference table and compares one-to-many, normalization and ignorable mappings", () => {
    expect(() => referenceSkeleton("tampered source")).toThrow(/digest mismatch/);
    const reference = referenceSkeleton();
    expect(reference("modern")).toBe("rnodern");
    expect(reference("Ì")).toBe("l̀");
    expect(reference("pa\u200dypal")).toBe("paypal");
    const corpus = generate();
    for (const label of [...corpus.targets, ...corpus.positives.map((p) => p.label), ...corpus.benign])
      expect(reference(label), label).toBe(skeleton(label));
  });

  it("counts all targets, preserves a deliberately flagged benign control, and counts a candidate once", () => {
    const corpus = {
      seed: 1,
      sources: {},
      targets: ["fynbosfreight", "fýnbosfreight"],
      positives: [{ label: "fýnbósfreíght", target: "fynbosfreight", family: "accent-3" }],
      benign: ["fýnbósfreíght", "velúriaweaving"],
    };
    const results = measure(corpus, 1);
    const folded = results.find((r) => r.name === "Accent-fold equality");
    expect(folded).toMatchObject({ detected: 1, intended: 1, falseFlags: 1, families: { "accent-3": 1 } });
    expect(folded?.micros).toBeGreaterThan(0);
    // The first target is unrelated; the second still counts.
    const later = measure({ ...corpus, targets: ["unrelatedbusiness", "fynbosfreight"] }, 1);
    expect(later.find((r) => r.name === "Accent-fold equality")?.detected).toBe(1);
    expect(() => measure(corpus, 0)).toThrow();
    expect(techniques()["Accent-fold equality"]?.("fýnbósfreíght", "fynbosfreight")).toBe(true);
  });
});
