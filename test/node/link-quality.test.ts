import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCorpus, parseHarness, summarize } from "../../eval/links-measure.ts";
import { loadSets } from "../../eval/load.ts";

const corpus = loadCorpus("eval/components/links");
const entry = corpus.find((e) => e.path === "message.txt");
if (!entry) throw new Error("missing fixture");
const good = {
  path: entry.path,
  sha256: entry.sha256,
  urls: entry.expected,
  more: 0,
  unread: [],
  coverage: "complete",
  error: null,
  ms: [1, 2, 3, 4, 5],
};
describe("link measurement refuses dishonest results", () => {
  it("loads the complete corpus through D08 labels", () => expect(corpus).toHaveLength(10));
  it("reports exact denominators and percentiles", () => {
    const r = summarize([entry], [good], 5);
    expect(r.totals.recall).toBe(1);
    expect(r.cases[0]?.p95Ms).toBe(5);
  });
  it("retains missing links as findings", () =>
    expect(summarize([entry], [{ ...good, urls: [] }], 5).totals.recall).toBe(0));
  it("retains invented links as findings", () =>
    expect(
      summarize([entry], [{ ...good, urls: [...good.urls, "https://invented.invalid/"] }], 5).totals.falseLinks,
    ).toBe(1));
  it("refuses omitted and duplicate cases", () => {
    expect(() => summarize([entry], [], 5)).toThrow();
    expect(() => summarize([entry], [good, good], 5)).toThrow();
  });
  it("refuses mismatched hashes and unknown identities", () => {
    expect(() => summarize([entry], [{ ...good, sha256: "0".repeat(64) }], 5)).toThrow();
    expect(() => summarize([entry], [{ ...good, path: "other" }], 5)).toThrow();
  });
  it("refuses partial work labelled complete", () =>
    expect(() => summarize([entry], [{ ...good, more: 1 }], 5)).toThrow());
  it("refuses invalid results, durations and missing repeats", () => {
    for (const patch of [{ ms: [-1] }, { ms: [NaN] }, { ms: [1] }, { urls: ["javascript:alert(1)"] }, { extra: 1 }])
      expect(() => summarize([entry], [{ ...good, ...patch }], 5)).toThrow();
  });
  it("refuses failed or ambiguous harness output", () => {
    expect(() => parseHarness(1, "LINK_RESULTS=[]")).toThrow();
    expect(() => parseHarness(0, "")).toThrow();
    expect(() => parseHarness(0, "LINK_RESULTS=[]\nLINK_RESULTS=[]")).toThrow();
  });
  it("uses null for undefined rates", () => {
    const r = summarize([{ ...entry, expected: [] }], [{ ...good, urls: [] }], 5);
    expect(r.totals.recall).toBeNull();
    expect(r.totals.falseLinkRate).toBeNull();
  });
});

it("binds every loaded path and payload to the strict manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "links-validation-"));
  try {
    const row = { ...entry };
    delete (row as Partial<typeof row>).base64;
    writeFileSync(join(dir, "message.txt"), Buffer.from(entry.base64, "base64"));
    writeFileSync(
      join(dir, "labels.json"),
      JSON.stringify([
        { path: entry.path, label: "genuine", category: "genuine-business", expected: [], source: "synthetic test" },
      ]),
    );
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([row]));
    expect(loadCorpus(dir)).toHaveLength(1);
    writeFileSync(join(dir, "message.txt"), "changed");
    expect(() => loadCorpus(dir)).toThrow(/hash mismatch/);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ ...row, path: "other.txt" }]));
    expect(() => loadCorpus(dir)).toThrow(/manifest missing/);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([row, row]));
    expect(() => loadCorpus(dir)).toThrow(/population/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("retains a parser refusal in the full denominator and as a coverage finding", () => {
  const r = summarize([entry], [{ ...good, urls: [], coverage: "refused", error: "parser-memory-limit" }], 5);
  expect(r.totals.expected).toBe(entry.expected.length);
  expect(r.totals.recall).toBe(0);
  expect(r.findings[0]?.coverageMatches).toBe(false);
  expect(() => summarize([entry], [{ ...good, coverage: "refused" }], 5)).toThrow();
});

it("keeps component inputs outside default verdict discovery", () => {
  const sets = loadSets("eval/sets");
  expect(sets.some((s) => s.name === "links")).toBe(false);
  expect(sets.flatMap((s) => s.samples).some((s) => s.file.includes("/components/links/"))).toBe(false);
  expect(
    loadCorpus("eval/components/links")
      .map((e) => e.path)
      .sort(),
  ).toEqual(corpus.map((e) => e.path).sort());
});
