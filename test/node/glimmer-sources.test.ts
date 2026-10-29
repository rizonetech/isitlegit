import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  manifestDigest,
  parseSources,
  reconcile,
  storeProblems,
  syntheticLeftovers,
} from "../../scripts/glimmer/sources.ts";
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
  notice: "| `set-a`: Set A (https://example.org) | CC BY 4.0 | credit |",
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
    // The name in prose, or inside a longer name, is not its attribution row.
    expect(reconcile({ ...base, notice: "We thank set-a.\n| `set-ab`: Other | CC0 | x |" })).toContain(
      "set-a: accepted, but missing from NOTICE.md",
    );
  });

  it("fails any synthetic page, and each generator file or raw folder, whatever the TODO text says", () => {
    const page = { ...base.pages[0], origin: "synthetic" } as (typeof base.pages)[number];
    expect(reconcile(base)).toEqual([]);
    expect(reconcile({ ...base, pages: [...base.pages, page] })).toContain(
      "1 stored pages have origin synthetic, yet §8 was removed",
    );
    const root = mkdtempSync(join(tmpdir(), "glimmer-s8-"));
    try {
      const store = join(root, "store");
      expect(syntheticLeftovers(root, store)).toEqual([]);
      // Each path on its own, untracked: the check reads the disk, not git.
      const leftovers: [string, () => void][] = [
        ["scripts/glimmer/synth.ts", () => writeFileSync(join(root, "scripts/glimmer/synth.ts"), "")],
        ["scripts/glimmer/templates", () => mkdirSync(join(root, "scripts/glimmer/templates"))],
        ["test/node/glimmer-synth.test.ts", () => writeFileSync(join(root, "test/node/glimmer-synth.test.ts"), "")],
        ["raw/synthetic", () => mkdirSync(join(store, "raw", "synthetic"), { recursive: true })],
      ];
      mkdirSync(join(root, "scripts/glimmer"), { recursive: true });
      mkdirSync(join(root, "test/node"), { recursive: true });
      for (const [path, make] of leftovers) {
        make();
        expect(syntheticLeftovers(root, store)).toContain(path);
      }
      expect(syntheticLeftovers(root, store)).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds none of the generator's files in this repository", () => {
    expect(syntheticLeftovers(join(import.meta.dirname, "../.."), join(tmpdir(), "glimmer-no-store"))).toEqual([]);
  });

  it("refuses a leftover through the problems check and freeze both read", () => {
    const store = mkdtempSync(join(tmpdir(), "glimmer-s8-store-"));
    try {
      const root = join(import.meta.dirname, "../..");
      expect(storeProblems(store, root).problems).not.toContain("raw/synthetic exists, yet §8 was removed");
      mkdirSync(join(store, "raw", "synthetic"), { recursive: true });
      expect(storeProblems(store, root).problems).toContain("raw/synthetic exists, yet §8 was removed");
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("fails when no source is accepted", () => {
    const none = { ...base, sources: [header, row("set-b", "rejected")].join("\n"), imports: {}, pages: [] };
    expect(reconcile(none)).toContain("no source was accepted");
  });
});

describe("import accounting (D03 T04 §5)", () => {
  it("fails a complete import that stored nothing or does not account for every item", () => {
    const sources = [
      "| Source | Dataset | Licence | Licence link | Decision | Reason | Label errors |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| `set` | https://example.org/set | CC0 | https://example.org/licence | accepted | test | - |",
    ].join("\n");
    const page = { id: "set-1", source: "set", origin: "public", label_source: {} } as unknown as StoredPage;
    const check = (record: Record<string, unknown>, pages: StoredPage[]) =>
      reconcile({
        sources,
        imports: { set: record as never },
        pages,
        notice: "| `set`: Set | CC0 | x |",
      });
    expect(check({ status: "complete", expected: 0, imported: 0, stored: 0 }, [])).toContain(
      "set: accepted, but the import stored no page",
    );
    expect(check({ status: "complete", expected: 100, imported: 1, duplicates: 0, stored: 1 }, [page])).toContain(
      "set: IMPORT.json accounts for 1 of 100 items",
    );
    expect(check({ status: "running", expected: 3, stored: 1 }, [page])).toContain("set: the import is running");
    expect(
      check({ status: "complete", expected: 3, imported: 1, skipped: 1, filtered: [{}], excluded: [], stored: 1 }, [
        page,
      ]),
    ).toEqual([]);
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

describe("binding each import to its inputs and rows (D03 T04 §18)", () => {
  it("digests a manifest exactly as scripts/glimmer/inputs.py does, past ASCII too", () => {
    const manifest = {
      files: [
        { name: "a.zip", sha256: "ab", bytes: 5, published: null, pinned: "kaggle: owner/set, version 2" },
        { name: "b.tar.gz", sha256: "cd", bytes: 5, published: { kind: "md5", value: "ef" }, pinned: null },
      ],
      licence: "CC BY 4.0 \u2014 Z\u00fcrich",
    };
    // inputs.digest_of on the same value, in Python.
    expect(manifestDigest(manifest)).toBe("12e9362bc402fec37e7749613d6bf4a42d0a8998e6a82a183a6588d573ae1fce");
  });

  it("refuses an import not bound to its manifest, or made from other rows than the export wrote", () => {
    const receipt = {
      met: 3,
      exported: 2,
      sampled_out: 0,
      rejected: { "not a page": 1 },
      rows_sha256: "r1",
      converter_sha256: "c1",
      inputs: "m1",
    };
    const bound = {
      ...base,
      sources: [header, row("phreshphish", "accepted")].join("\n"),
      pages: [page("phreshphish"), page("phreshphish")],
    };
    const record = { status: "complete" as const, expected: 2, imported: 2, duplicates: 0, excluded: [], stored: 2 };
    const notice = "| `phreshphish`: PhreshPhish | CC BY 4.0 | credit |";
    const check = (imports: Record<string, unknown>, bindings: Record<string, unknown>) =>
      reconcile({ ...bound, notice, imports: imports as never, bindings: bindings as never });
    expect(
      check(
        { phreshphish: { ...record, inputs: "m1", rows: "r1" } },
        { phreshphish: { manifest: "m1", export: receipt } },
      ),
    ).toEqual([]);
    expect(check({ phreshphish: record }, { phreshphish: {} }).join()).toMatch(/no INPUTS.json/);
    expect(
      check({ phreshphish: { ...record, inputs: "m1", rows: "r1" } }, { phreshphish: { manifest: "m1" } }).join(),
    ).toMatch(/no EXPORT.json/);
    expect(
      check(
        { phreshphish: { ...record, inputs: "m1", rows: "r2" } },
        { phreshphish: { manifest: "m1", export: receipt } },
      ).join(),
    ).toMatch(/other rows/);
    expect(
      check(
        { phreshphish: { ...record, inputs: "m0", rows: "r1" } },
        { phreshphish: { manifest: "m1", export: receipt } },
      ).join(),
    ).toMatch(/not bound to its INPUTS/);
    expect(
      check(
        { phreshphish: { ...record, inputs: "m1", rows: "r1" } },
        { phreshphish: { manifest: "m1", export: { ...receipt, met: 4 } } },
      ).join(),
    ).toMatch(/accounts for 3 of 4/);
  });
});
