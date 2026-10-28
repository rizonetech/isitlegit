import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSources, reconcile } from "../../scripts/glimmer/sources.ts";
import type { StoredPage } from "../../scripts/glimmer/store.ts";

// scripts/glimmer/sources.ts (D03 T04 §5): the record of public page datasets is reconciled both ways with what was
// imported, so neither an import nor a decision can quietly go missing.

const header = `| Source | Dataset | Licence | Licence link | Decision | Reason | Label errors |
| ------ | ------- | ------- | ------------ | -------- | ------ | ------------ |`;
const row = (source: string, decision: string, errors = "4") =>
  `| \`${source}\` | https://example.org/${source} | CC BY 4.0 | https://creativecommons.org/licenses/by/4.0/ | ${decision} | why | ${errors} |`;
const page = (source: string, lure: StoredPage["label_source"]["lure"] = "ground-truth"): StoredPage => ({
  id: `${source}-0000000000000000`,
  source,
  origin: "public",
  licence: "CC BY 4.0",
  host: null,
  template: null,
  south_africa: false,
  labels: { lure: true },
  label_source: { lure },
  sha256: { screenshot: "a".repeat(64), text: "b".repeat(64) },
  redacted: false,
});
const base = {
  sources: [header, row("set-a", "accepted"), row("set-b", "rejected")].join("\n"),
  imports: {
    "set-a": { status: "complete" as const, expected: 2, imported: 2, duplicates: 0, excluded: [], stored: 2 },
  },
  pages: [page("set-a"), page("set-a")],
  notice: "| set-a | CC BY 4.0 |",
  synthetic: "Generate at least 1,500 lures",
};

describe("parseSources", () => {
  it("reads each row and names every malformed one", () => {
    const { rows, problems } = parseSources(base.sources);
    expect(rows.map((r) => [r.source, r.decision, r.labelErrors])).toEqual([
      ["set-a", "accepted", 4],
      ["set-b", "rejected", 4],
    ]);
    expect(problems).toEqual([]);
    const bad = parseSources(
      [header, "| `x` | u | | http://plain | maybe | r | z |", "| `short` | only |"].join("\n"),
    ).problems.join("\n");
    for (const expected of ["decision is", "not an https URL", "no licence named", 'label errors "z"', "not 7"])
      expect(bad).toContain(expected);
  });
});

describe("reconcile", () => {
  it("passes when the record, the imports and the store agree", () => {
    expect(reconcile(base)).toEqual([]);
  });

  it("fails an accepted source with no import, an incomplete one, or a count that differs", () => {
    expect(reconcile({ ...base, imports: {} })).toContain("set-a: accepted, but no IMPORT.json");
    expect(
      reconcile({ ...base, imports: { "set-a": { status: "incomplete", reason: "No space left on device" } } }).join(),
    ).toContain("the import is incomplete (No space left on device)");
    expect(reconcile({ ...base, pages: [page("set-a")] }).join()).toContain(
      "IMPORT.json says 2 stored, the store holds 1",
    );
    expect(reconcile({ ...base, pages: [] }).join()).toContain("the store holds 0");
  });

  it("fails a rejected source with pages and a stored source with no row", () => {
    expect(reconcile({ ...base, pages: [...base.pages, page("set-b")] }).join()).toContain(
      "set-b: rejected, yet 1 pages are in the store",
    );
    expect(reconcile({ ...base, pages: [...base.pages, page("set-c")] }).join()).toContain(
      "set-c: in the store with no row",
    );
  });

  it("fails a source above 10 percent label errors while any of its lure labels is trusted", () => {
    const noisy = { ...base, sources: [header, row("set-a", "accepted", "12%")].join("\n") };
    expect(reconcile(noisy).join()).toContain("12% label errors, yet 2 pages trust its lure");
    expect(reconcile({ ...noisy, pages: [page("set-a", "unverified"), page("set-a", "astra+claude")] })).toEqual([]);
  });

  it("fails an accepted source missing from NOTICE.md", () => {
    expect(reconcile({ ...base, notice: "" })).toContain("set-a: accepted, but missing from NOTICE.md");
  });

  it("fails the no-source fallback until §8 asks for 3,000 lures", () => {
    const none = { ...base, sources: [header, row("set-b", "rejected")].join("\n"), imports: {}, pages: [] };
    expect(reconcile(none).join()).toContain("§8 still asks for 1,500");
    expect(reconcile({ ...none, synthetic: "Generate at least 3,000 lures ... shows 3,000 lures" })).toEqual([]);
  });
});

describe("the benign render lists (D03 T04 §6)", () => {
  it("credits the Majestic Million with its licence in NOTICE.md and docs/glimmer/sources.md", () => {
    const root = join(import.meta.dirname, "../..");
    for (const file of ["NOTICE.md", "docs/glimmer/sources.md"]) {
      const text = readFileSync(join(root, file), "utf-8");
      expect(text, file).toMatch(/Majestic Million/);
      expect(text, file).toMatch(/CC BY 3\.0/);
    }
  });
});
