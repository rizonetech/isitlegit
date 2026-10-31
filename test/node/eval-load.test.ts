import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSet, loadSets, SetRefused } from "../../eval/load";

// D08 T01 §1: every evaluation set read through one label schema, a malformed set refused whole.
const FIXTURES = new URL("../fixtures/eval/", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;

function setWith(
  labels: unknown,
  files: Record<string, string> = { "a.eml": "synthetic" },
  dir = mkdtempSync(join(tmpdir(), "eval-set-")),
) {
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  if (labels !== undefined)
    writeFileSync(join(dir, "labels.json"), typeof labels === "string" ? labels : JSON.stringify(labels));
  return dir;
}
const good = {
  path: "a.eml",
  label: "attack",
  category: "credential-phishing",
  expected: ["link.credential_form"],
  source: "synthetic",
};
// What a refusal says, field by field.
function refusal(load: () => unknown) {
  try {
    load();
  } catch (error) {
    if (!(error instanceof SetRefused)) throw error;
    return { set: error.set, index: error.index, path: error.path, reason: error.reason };
  }
  throw new Error("not refused");
}

describe("loadSets", () => {
  it("loads a fixture set, each sample whole with its set-qualified id and file", () => {
    const [set] = loadSets(FIXTURES);
    expect(set?.samples).toEqual([
      {
        path: "invoice.eml",
        label: "attack",
        category: "invoice-bank-change",
        expected: ["content.ai_instructions"],
        source: "synthetic",
        id: "sample-set/invoice.eml",
        set: "sample-set",
        file: join(FIXTURES, "sample-set", "invoice.eml"),
      },
      {
        path: "newsletter.eml",
        label: "genuine",
        category: "genuine-newsletter",
        expected: [],
        source: "synthetic",
        id: "sample-set/newsletter.eml",
        set: "sample-set",
        file: join(FIXTURES, "sample-set", "newsletter.eml"),
      },
    ]);
  });

  it("keeps two sets' samples of one file name apart, each resolving its own file", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    setWith([{ ...good, path: "001.eml" }], { "001.eml": "first" }, join(root, "alpha"));
    setWith(
      [{ ...good, path: "001.eml", label: "genuine", category: "genuine-business", expected: [] }],
      { "001.eml": "second" },
      join(root, "beta"),
    );
    const samples = loadSets(root).flatMap((s) => s.samples);
    expect(samples.map((s) => [s.id, s.label, readFileSync(s.file, "utf8")])).toEqual([
      ["alpha/001.eml", "attack", "first"],
      ["beta/001.eml", "genuine", "second"],
    ]);
  });

  it("refuses an unknown category, naming the set, the label and its path", () => {
    expect(refusal(() => loadSet(setWith([{ ...good, category: "spam" }]), "s"))).toMatchObject({
      set: "s",
      index: 0,
      path: "a.eml",
    });
  });

  it("refuses each broken label, naming it", () => {
    const at = (labels: unknown[], files?: Record<string, string>) =>
      refusal(() => loadSet(setWith(labels, files), "s"));
    // Refused for leaving the set, not merely for naming no file: the file exists one level up.
    const outside = mkdtempSync(join(tmpdir(), "eval-outer-"));
    writeFileSync(join(outside, "a.eml"), "outside");
    const inner = setWith([{ ...good, path: "../a.eml" }], {}, join(outside, "set"));
    const left = refusal(() => loadSet(inner, "s"));
    expect(left).toMatchObject({ index: 0, path: "../a.eml" });
    expect(left.reason).toContain("stay inside its set");
    expect(at([{ ...good, path: "/etc/passwd" }]).reason).toContain("relative to its set");
    expect(at([{ ...good, path: "sub\\..\\..\\a.eml" }]).reason).toContain("relative to its set");
    expect(at([{ ...good, path: "b.eml" }])).toEqual({ set: "s", index: 0, path: "b.eml", reason: "no such file" });
    expect(at([good, good])).toEqual({ set: "s", index: 1, path: "a.eml", reason: "the path is labelled twice" });
    expect(at([{ ...good, expected: [] }]).reason).toContain("names the evidence");
    expect(at([{ ...good, label: "genuine", category: "genuine-business" }]).reason).toContain(
      "genuine mail raises no expected evidence",
    );
    expect(at([{ ...good, label: "genuine" }]).reason).toContain("the category agrees");
    expect(at([{ ...good, extra: 1 }]).index).toBe(0);
    expect(at([{ label: "attack" }])).toMatchObject({ index: 0, path: null });
  });

  it("refuses a set or a root that cannot be read, naming what it can and null for the rest", () => {
    expect(refusal(() => loadSet(setWith(undefined), "s"))).toEqual({
      set: "s",
      index: null,
      path: null,
      reason: "it has no labels.json",
    });
    expect(refusal(() => loadSet(setWith("{not json"), "s")).reason).toContain("cannot be read as JSON");
    expect(refusal(() => loadSet(setWith({ not: "a list" }), "s")).reason).toBe("labels.json is not a list of labels");
    expect(refusal(() => loadSet(setWith([]), "s")).reason).toBe("the set has no samples");
    expect(refusal(() => loadSets(join(tmpdir(), "no-such-sets-dir")))).toEqual({
      set: null,
      index: null,
      path: null,
      reason: "the sets directory is missing",
    });
    expect(refusal(() => loadSets(mkdtempSync(join(tmpdir(), "eval-empty-"))))).toMatchObject({
      set: null,
      reason: "the sets directory holds no set",
    });
    // One broken set refuses the load: never an incomplete population.
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    setWith([good], undefined, join(root, "fine"));
    setWith([{ ...good, path: "missing.eml" }], undefined, join(root, "broken"));
    expect(refusal(() => loadSets(root))).toMatchObject({ set: "broken", reason: "no such file" });
  });

  it("keeps DATASETS.md's six columns", () => {
    const text = readFileSync(join(ROOT, "eval", "DATASETS.md"), "utf8");
    expect(text).toContain("| Source | Licence | URL | Date | Count | Use |");
  });
});
