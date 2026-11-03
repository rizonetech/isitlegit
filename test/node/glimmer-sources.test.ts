import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readFreeze } from "../../scripts/glimmer/build-dataset.ts";
import { captureProblem } from "../../scripts/glimmer/label-rules.ts";
import { recoverHtmlEvidence } from "../../scripts/glimmer/source-pages.ts";
import {
  type Frozen,
  freezeCollection,
  manifestDigest,
  migrateLineage,
  parseSources,
  RECEIPTED,
  reconcile,
  removeSourceFromStore,
  storeProblems,
  syntheticLeftovers,
  writeFreeze,
} from "../../scripts/glimmer/sources.ts";
import { openStore, type StoredPage } from "../../scripts/glimmer/store.ts";

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

  it("names an unreadable record, a set-aside synthetic copy and a leftover under the root it is given", () => {
    const repo = join(import.meta.dirname, "../..");
    const root = mkdtempSync(join(tmpdir(), "glimmer-s8-root-"));
    const store = mkdtempSync(join(tmpdir(), "glimmer-s8-store-"));
    try {
      mkdirSync(join(root, "docs/glimmer"), { recursive: true });
      writeFileSync(join(root, "docs/glimmer/sources.md"), readFileSync(join(repo, "docs/glimmer/sources.md")));
      writeFileSync(join(root, "NOTICE.md"), readFileSync(join(repo, "NOTICE.md")));
      mkdirSync(join(root, "scripts/glimmer"), { recursive: true });
      writeFileSync(join(root, "scripts/glimmer/synth.ts"), "");
      mkdirSync(join(store, "raw", "phreshphish"), { recursive: true });
      writeFileSync(join(store, "raw", "phreshphish", "IMPORT.json"), "{ torn");
      const aside = join(store, "pages", ".damaged-made-0123456789abcdef-1");
      mkdirSync(aside, { recursive: true });
      writeFileSync(join(aside, "meta.json"), JSON.stringify({ origin: "synthetic" }));
      const { problems } = storeProblems(store, root);
      expect(problems).toContain("scripts/glimmer/synth.ts exists, yet §8 was removed");
      expect(problems).toContain("raw/phreshphish/IMPORT.json: does not read as JSON");
      expect(problems).toContain(
        "pages/.damaged-made-0123456789abcdef-1 is a set-aside synthetic page, yet §8 was removed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("names rows written after their receipt, and on freeze rows that are not the ones it names", () => {
    const store = mkdtempSync(join(tmpdir(), "glimmer-g12-"));
    try {
      const repo = join(import.meta.dirname, "../..");
      const folder = join(store, "raw", "phreshphish");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "rows.jsonl"), "{}\n");
      writeFileSync(
        join(folder, "EXPORT.json"),
        JSON.stringify({
          met: 1,
          exported: 1,
          sampled_out: 0,
          rejected: {},
          rows_sha256: "0".repeat(64),
          converter_sha256: "",
          inputs: "",
        }),
      );
      const old = new Date("2026-10-29T10:00:00Z");
      utimesSync(join(folder, "EXPORT.json"), old, old);
      expect(storeProblems(store, repo).problems).toContain(
        "phreshphish: rows.jsonl was written after its EXPORT.json, which does not name it",
      );
      utimesSync(join(folder, "rows.jsonl"), old, old);
      expect(storeProblems(store, repo).problems.join()).not.toContain("phreshphish: rows.jsonl");
      expect(storeProblems(store, repo, { hashRows: true }).problems).toContain(
        "phreshphish: rows.jsonl is not the rows its EXPORT.json names",
      );
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses to freeze twice or before the benign renders finish, and the build refuses a changed import", async () => {
    const store = mkdtempSync(join(tmpdir(), "glimmer-g13-"));
    const env = { ...process.env, GLIMMER_DATA_DIR: store };
    const script = (name: string) => join(import.meta.dirname, "../../scripts/glimmer", name);
    try {
      const fresh = spawnSync(process.execPath, [script("sources.ts"), "freeze"], { env, encoding: "utf-8" });
      expect(fresh.status).toBe(1);
      expect(fresh.stdout).toContain("majestic: no list or no render journal");
      // A list rendered in part, as it stands now: an old receipt file claiming it finished is not read at all.
      mkdirSync(join(store, "raw", "majestic"), { recursive: true });
      writeFileSync(join(store, "raw", "majestic", "top.csv"), "GlobalRank,Domain\n1,example.com\n2,example.org\n");
      writeFileSync(
        join(store, "raw", "majestic", "RENDER.json"),
        JSON.stringify({ unfinished: [], missing_pages: [] }),
      );
      mkdirSync(join(store, "raw", "benign"), { recursive: true });
      writeFileSync(
        join(store, "raw", "benign", "progress.jsonl"),
        `${JSON.stringify({ url: "https://example.com/", event: "excluded", reason: "HTTP 404", at: "2026-10-29T08:00:00.000Z" })}\n`,
      );
      const partial = spawnSync(process.execPath, [script("sources.ts"), "freeze"], { env, encoding: "utf-8" });
      expect(partial.status).toBe(1);
      expect(partial.stdout).toContain("majestic: its render is not finished (1 unfinished, 0 missing)");
      // Every URL with an outcome, but one stored page a legacy capture recheck cannot clear: still not frozen.
      const legacy = await openStore(store).putPage("benign-majestic", {
        screenshot: new Uint8Array(
          await sharp({ create: { width: 16, height: 16, channels: 3, background: "#fff" } })
            .jpeg()
            .toBuffer(),
        ),
        text: "Example Domain. This domain is for use in illustrative examples.",
        origin: "benign",
        licence: "CC BY 3.0",
        host: "example.org",
        template: null,
        south_africa: false,
        labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
        label_source: {
          lure: "construction",
          lure_type: "construction",
          has_login_form: "dom",
          has_payment_form: "dom",
        },
        redacted: false,
        url: "https://example.org/",
      } as Parameters<ReturnType<typeof openStore>["putPage"]>[1]);
      writeFileSync(
        join(store, "raw", "benign", "progress.jsonl"),
        [
          { url: "https://example.com/", event: "excluded", reason: "HTTP 404", at: "2026-10-29T08:00:00.000Z" },
          { url: "https://example.org/", event: "stored", id: legacy, at: "2026-10-29T08:00:05.000Z" },
        ]
          .map((event) => `${JSON.stringify(event)}\n`)
          .join(""),
      );
      const unassessed = spawnSync(process.execPath, [script("sources.ts"), "freeze"], { env, encoding: "utf-8" });
      expect(unassessed.status).toBe(1);
      expect(unassessed.stdout).toContain("majestic: 1 stored pages unassessed and 0 showing a wall");
      mkdirSync(join(store, "raw", "set"), { recursive: true });
      writeFileSync(join(store, "raw", "set", "IMPORT.json"), "{}");
      writeFileSync(
        join(store, "raw", "FROZEN.json"),
        JSON.stringify({
          pages: [],
          sources: { set: { import_sha256: "0".repeat(64) } },
          renders: { majestic: {}, "benign-sa": {} },
        }),
      );
      const again = spawnSync(process.execPath, [script("sources.ts"), "freeze"], { env, encoding: "utf-8" });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("a freeze is never replaced");
      const build = spawnSync(process.execPath, [script("build-dataset.ts"), "1.0"], { env, encoding: "utf-8" });
      expect(build.status).toBe(2);
      expect(build.stderr).toContain("imported again since the freeze: set");
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("freezes a reconciled store end to end, leaving out benign pages no list names, and the build reads it", async () => {
    const root = mkdtempSync(join(tmpdir(), "glimmer-fz-root-"));
    const store = mkdtempSync(join(tmpdir(), "glimmer-fz-store-"));
    try {
      mkdirSync(join(root, "docs", "glimmer"), { recursive: true });
      mkdirSync(join(root, "eval", "glimmer"), { recursive: true });
      writeFileSync(join(root, "docs", "glimmer", "sources.md"), [header, row("set-a", "accepted")].join("\n"));
      writeFileSync(join(root, "NOTICE.md"), base.notice);
      writeFileSync(join(root, "eval", "glimmer", "benign-sa-urls.txt"), "home\thttps://bank.example/\tBank\n");
      const shot = async (colour: string) =>
        new Uint8Array(
          await sharp({ create: { width: 16, height: 16, channels: 3, background: colour } })
            .jpeg()
            .toBuffer(),
        );
      const pages = openStore(store);
      const evidence = {
        title: "Home",
        overlays: "",
        captcha: false,
        consentWall: false,
        challengeCover: false,
        wall: false,
      };
      const benign = (host: string, colour: string) => async () =>
        pages.putPage(host === "bank.example" ? "benign-sa" : "benign-majestic", {
          screenshot: await shot(colour),
          text: `Welcome to ${host}`,
          origin: "benign",
          licence: "CC BY 3.0",
          host,
          template: null,
          south_africa: host === "bank.example",
          labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
          label_source: {
            lure: "construction",
            lure_type: "construction",
            has_login_form: "dom",
            has_payment_form: "dom",
          },
          redacted: false,
          url: `https://${host}/`,
          evidence,
        } as Parameters<typeof pages.putPage>[1]);
      const listed = await benign("example.org", "#eee")();
      const sa = await benign("bank.example", "#ddd")();
      const outside = await benign("dropped.example", "#ccc")(); // a URL no list names any more
      const lure = await pages.putPage("set-a", {
        screenshot: await shot("#c33"),
        text: "Sign in to your bank",
        origin: "public",
        licence: "CC BY 4.0",
        host: null,
        template: null,
        south_africa: false,
        labels: { lure: true },
        label_source: { lure: "ground-truth" },
        redacted: false,
        item: "set-a-1",
        input: "c".repeat(64),
        evidence,
      } as Parameters<typeof pages.putPage>[1]);
      const manifest = { files: [{ name: "set-a.zip" }] };
      mkdirSync(join(store, "raw", "set-a"), { recursive: true });
      writeFileSync(join(store, "raw", "set-a", "INPUTS.json"), JSON.stringify(manifest));
      writeFileSync(
        join(store, "raw", "set-a", "IMPORT.json"),
        JSON.stringify({
          status: "complete",
          expected: 1,
          imported: 1,
          duplicates: 0,
          excluded: [],
          stored: 1,
          inputs: manifestDigest(manifest),
        }),
      );
      mkdirSync(join(store, "raw", "majestic"), { recursive: true });
      writeFileSync(join(store, "raw", "majestic", "top.csv"), "GlobalRank,Domain\n1,example.org\n");
      mkdirSync(join(store, "raw", "benign"), { recursive: true });
      writeFileSync(
        join(store, "raw", "benign", "progress.jsonl"),
        [
          { url: "https://example.org/", event: "stored", id: listed, at: "2026-10-29T08:00:00.000Z" },
          { url: "https://bank.example/", event: "stored", id: sa, at: "2026-10-29T08:00:01.000Z" },
          { url: "https://dropped.example/", event: "stored", id: outside, at: "2026-10-29T08:00:02.000Z" },
        ]
          .map((event) => `${JSON.stringify(event)}\n`)
          .join(""),
      );
      const { problems, frozen } = freezeCollection(store, root, new Date("2026-10-31T00:00:00Z"));
      expect(problems).toEqual([]);
      expect(frozen?.pages).toEqual([listed, sa, lure].sort());
      expect(frozen?.left_out).toBe(1);
      writeFreeze(store, frozen as Frozen);
      // Once only: a second freeze finds it there.
      expect(() => writeFreeze(store, frozen as Frozen)).toThrow(/never replaced/);
      // A later version freezes into its own file; 1.0's freeze stays byte for byte as it was (§27).
      const first = readFileSync(join(store, "raw", "FROZEN.json"), "utf-8");
      const added = "set-a-00000000000000ff"; // a page stored after 1.0 froze, eligible for 1.1
      const later = {
        ...(frozen as Frozen),
        at: "2026-11-02T00:00:00.000Z",
        pages: [...(frozen as Frozen).pages, added].sort(),
      };
      writeFreeze(store, later, "1.1");
      expect(readFileSync(join(store, "raw", "FROZEN.json"), "utf-8")).toBe(first);
      expect(readFreeze(store, "1.1").has(added)).toBe(true);
      expect(readFreeze(store).has(added)).toBe(false);
      expect(() => readFreeze(store, "1.2")).toThrow(/freeze the collection for 1.2 first/);
      // The build reads exactly the frozen pages, and refuses once an import changed.
      expect([...readFreeze(store)].sort()).toEqual([listed, sa, lure].sort());
      writeFileSync(join(store, "raw", "set-a", "IMPORT.json"), "{}");
      expect(() => readFreeze(store)).toThrow(/imported again since the freeze: set-a/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("fails when no source is accepted, an empty table included", () => {
    const none = { ...base, sources: [header, row("set-b", "rejected")].join("\n"), imports: {}, pages: [] };
    expect(reconcile(none)).toContain("no source was accepted");
    expect(reconcile({ sources: "", imports: {}, pages: [], notice: "" })).toContain("no source was accepted");
    expect(reconcile({ ...none, sources: header })).toContain("no source was accepted");
  });

  it("exits 1 from check and freeze on a leftover, and freeze writes nothing", () => {
    const store = mkdtempSync(join(tmpdir(), "glimmer-s8-cli-"));
    try {
      mkdirSync(join(store, "raw", "synthetic"), { recursive: true });
      const run = (command: string) =>
        spawnSync(process.execPath, [join(import.meta.dirname, "../../scripts/glimmer/sources.ts"), command], {
          env: { ...process.env, GLIMMER_DATA_DIR: store },
          encoding: "utf-8",
        });
      for (const command of ["check", "freeze"]) {
        const result = run(command);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("raw/synthetic exists, yet §8 was removed");
      }
      expect(existsSync(join(store, "raw", "FROZEN.json"))).toBe(false);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
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

  it("asks a receipt of any source converted to rows, not only the six §18 knew (§27)", () => {
    const receipt = {
      met: 2,
      exported: 2,
      sampled_out: 0,
      rejected: {},
      rows_sha256: "r1",
      converter_sha256: "c1",
      inputs: "m1",
    };
    const fresh = {
      ...base,
      sources: [header, row("new-lures", "accepted")].join("\n"),
      pages: [page("new-lures"), page("new-lures")],
      notice: "| `new-lures`: New lures | CC BY 4.0 | credit |",
    };
    const record = { status: "complete" as const, expected: 2, imported: 2, duplicates: 0, excluded: [], stored: 2 };
    const check = (imports: Record<string, unknown>, bindings: Record<string, unknown>) =>
      reconcile({ ...fresh, imports: imports as never, bindings: bindings as never });
    const good = { ...record, inputs: "m1", rows: "r1" };
    expect(check({ "new-lures": good }, { "new-lures": { manifest: "m1", export: receipt, rows: true } })).toEqual([]);
    // Its rows on the disk with no receipt beside them.
    expect(
      check({ "new-lures": { ...record, inputs: "m1" } }, { "new-lures": { manifest: "m1", rows: true } }).join(),
    ).toMatch(/new-lures: no EXPORT.json/);
    // Rows the receipt does not name, and a receipt made from other inputs.
    expect(
      check(
        { "new-lures": { ...good, rows: "r2" } },
        { "new-lures": { manifest: "m1", export: receipt, rows: true } },
      ).join(),
    ).toMatch(/other rows than EXPORT.json names/);
    expect(
      check(
        { "new-lures": good },
        { "new-lures": { manifest: "m1", export: { ...receipt, inputs: "m2" }, rows: true } },
      ).join(),
    ).toMatch(/other inputs than INPUTS.json names/);
  });

  it("asks ScamFerret for its converter's receipt, and reconciles it once bound (D03 T04 §28)", () => {
    expect(RECEIPTED).toContain("scamferret");
    const receipt = {
      met: 3,
      exported: 2,
      sampled_out: 0,
      rejected: { "not a gzip page of at most 20971520 bytes": 1 },
      rows_sha256: "r1",
      converter_sha256: "c1",
      inputs: "m1",
    };
    const bound = {
      ...base,
      sources: [header, row("scamferret", "accepted")].join("\n"),
      pages: [page("scamferret"), page("scamferret")],
      notice: "| `scamferret`: ScamFerret | GPL-3.0 | credit |",
    };
    const record = { status: "complete" as const, expected: 2, imported: 2, duplicates: 0, excluded: [], stored: 2 };
    const check = (imports: Record<string, unknown>, bindings: Record<string, unknown>) =>
      reconcile({ ...bound, imports: imports as never, bindings: bindings as never });
    expect(
      check(
        { scamferret: { ...record, inputs: "m1", rows: "r1" } },
        { scamferret: { manifest: "m1", export: receipt } },
      ),
    ).toEqual([]);
    // An import made before the converter step (no rows digest, no receipt) no longer reconciles.
    expect(check({ scamferret: { ...record, inputs: "m1" } }, { scamferret: { manifest: "m1" } }).join()).toMatch(
      /scamferret: no EXPORT.json from its converter/,
    );
    expect(
      check(
        { scamferret: { ...record, inputs: "m1", rows: "r2" } },
        { scamferret: { manifest: "m1", export: receipt } },
      ).join(),
    ).toMatch(/other rows than EXPORT.json names/);
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

  it("reconciles item ledgers, input inventory and stored-page lineage, and refuses disagreements (D03 T04 §28)", () => {
    const receipt = {
      met: 3,
      exported: 2,
      sampled_out: 0,
      rejected: { "not a page": 1 },
      rows_sha256: "r1",
      converter_sha256: "c1",
      inputs: "m1",
    };
    const evidence = {
      title: "Login",
      overlays: "",
      captcha: false,
      consentWall: false,
      challengeCover: false,
      wall: false,
    };
    const storedPage: StoredPage = {
      ...page("phreshphish"),
      id: "phreshphish-0000000000000001",
      item: "item-1",
      input: "in-1",
      items: [
        { id: "item-1", input: "in-1" },
        { id: "item-2", input: "in-2" },
      ],
      evidence,
    };
    const record = {
      status: "complete" as const,
      expected: 2,
      imported: 1,
      duplicates: 1,
      excluded: [],
      stored: 1,
      inputs: "m1",
      rows: "r1",
    };
    const converterItems = {
      header: { inputs: "m1", rows: "r1" },
      entries: [
        { item: "item-1", outcome: "exported" as const },
        { item: "item-2", outcome: "exported" as const },
        { item: "item-3", outcome: "rejected" as const, reason: "not a page" },
      ],
    };
    const importItems = {
      header: { inputs: "m1", rows: "r1", export: "ex1", import: "im1" },
      entries: [
        { item: "item-1", input: "in-1", outcome: "imported" as const, page: storedPage.id },
        { item: "item-2", input: "in-2", outcome: "duplicate" as const, page: storedPage.id },
      ],
    };
    const notice = "| `phreshphish`: PhreshPhish | CC BY 4.0 | credit |";
    const sources = [header, row("phreshphish", "accepted")].join("\n");
    const runCheck = (overrideBinding: Record<string, unknown>, pages = [storedPage]) =>
      reconcile({
        sources,
        notice,
        imports: { phreshphish: record },
        pages,
        bindings: {
          phreshphish: {
            checkLineage: true,
            manifest: "m1",
            export: receipt,
            exportSha256: "ex1",
            importSha256: "im1",
            converterItems,
            importItems,
            inventory: ["item-1", "item-2", "item-3"],
            rowItems: [
              { item: "item-1", input: "in-1" },
              { item: "item-2", input: "in-2" },
            ],
            ...overrideBinding,
          },
        },
      });
    expect(runCheck({})).toEqual([]);
    // Input omitted from converter ledger and store, caught by independent inventory.
    expect(runCheck({ inventory: ["item-1", "item-2", "item-3", "item-4"] }).join()).toMatch(
      /does not match the converter's input inventory/,
    );
    // Exported row omitted from import ledger, caught by rowItems / converterItems comparison.
    expect(
      runCheck({
        rowItems: [
          { item: "item-1", input: "in-1" },
          { item: "item-2", input: "in-2" },
          { item: "item-extra", input: "in-x" },
        ],
      }).join(),
    ).toMatch(/rows\.jsonl items/);
    // Item appearing twice in ITEMS.jsonl or ITEMS.import.jsonl.
    expect(
      runCheck({
        converterItems: {
          ...converterItems,
          entries: [...converterItems.entries, { item: "item-1", outcome: "rejected", reason: "dup" }],
        },
      }).join(),
    ).toMatch(/item item-1 appears more than once in ITEMS\.jsonl/);
    expect(
      runCheck({
        importItems: {
          ...importItems,
          entries: [...importItems.entries, { item: "item-1", outcome: "excluded", reason: "dup" }],
        },
      }).join(),
    ).toMatch(/item item-1 appears more than once in ITEMS\.import\.jsonl/);
    // Stored page and ITEMS.import.jsonl disagree on which items made the page or on the input digest.
    expect(
      runCheck({}, [
        {
          ...storedPage,
          items: [{ id: "item-1", input: "in-1" }],
        },
      ]).join(),
    ).toMatch(/ITEMS\.import\.jsonl says item-2 is on phreshphish-0000000000000001, store says no page/);
    expect(
      runCheck({}, [
        {
          ...storedPage,
          items: [
            { id: "item-1", input: "in-1" },
            { id: "item-2", input: "wrong-digest" },
          ],
        },
      ]).join(),
    ).toMatch(/disagree on the input digest of item-2/);
    // Stored page lacking capture-problem evidence.
    const { evidence: _dropped, ...withoutEvidence } = storedPage;
    expect(runCheck({}, [withoutEvidence]).join()).toMatch(/has no capture-problem evidence/);
    // Completion review G2, G3, G8: synthetic placeholder IDs, missing ITEMS.inventory.jsonl, missing input digests,
    // wall evidence on a stored page, or missing/conflicting per-item lure on multi-item pages are refused.
    expect(runCheck({ requireInventory: true, inventory: undefined }).join()).toMatch(
      /no ITEMS\.inventory\.jsonl from its converter/,
    );
    expect(
      runCheck({
        converterItems: {
          ...converterItems,
          entries: [
            { item: "item-1", outcome: "exported" },
            { item: "item-2", outcome: "exported" },
            { item: "phreshphish:rejected-1", outcome: "rejected", reason: "not a page" },
          ],
        },
        inventory: ["item-1", "item-2", "phreshphish:rejected-1"],
      }).join(),
    ).toMatch(/contains synthetic placeholder item phreshphish:rejected-1/);
    expect(
      runCheck({
        importItems: {
          ...importItems,
          entries: [
            { item: "item-1", outcome: "imported", page: storedPage.id },
            { item: "item-2", input: "in-2", outcome: "duplicate", page: storedPage.id },
          ],
        },
      }).join(),
    ).toMatch(/item item-1 in ITEMS\.import\.jsonl has no input digest/);
    expect(
      runCheck({}, [
        {
          ...storedPage,
          evidence: { ...evidence, wall: true },
        },
      ]).join(),
    ).toMatch(/has a capture-problem wall in its evidence/);
    expect(
      runCheck(
        {
          rowItems: [
            { item: "item-1", input: "in-1", lure: true },
            { item: "item-2", input: "in-2", lure: false },
          ],
        },
        [
          {
            ...storedPage,
            items: [
              { id: "item-1", input: "in-1", lure: true },
              { id: "item-2", input: "in-2" },
            ],
          },
        ],
      ).join(),
    ).toMatch(/item item-2 is missing or disagrees with its row lure label/);
  });

  it("removes ITEMS.import.jsonl when removing a source, and migrateLineage upgrades a pre-change store end to end while refusing synthetic IDs, unmatched items or changed generations (D03 T04 §28)", async () => {
    const root = mkdtempSync(join(tmpdir(), "glimmer-mig-root-"));
    const store = mkdtempSync(join(tmpdir(), "glimmer-mig-store-"));
    try {
      mkdirSync(join(root, "docs", "glimmer"), { recursive: true });
      writeFileSync(join(root, "docs", "glimmer", "sources.md"), [header, row("compphish", "accepted")].join("\n"));
      writeFileSync(join(root, "NOTICE.md"), "| `compphish`: CompPhish | CC BY 4.0 | credit |\n");
      const shot = new Uint8Array(
        await sharp({ create: { width: 16, height: 16, channels: 3, background: "#a22" } })
          .jpeg()
          .toBuffer(),
      );
      const pages = openStore(store);
      await pages.putPage("compphish", {
        screenshot: shot,
        text: "Sign in to your account",
        origin: "public",
        licence: "CC BY 4.0",
        host: null,
        template: null,
        south_africa: false,
        labels: { lure: true },
        label_source: { lure: "ground-truth" },
        redacted: false,
      });
      const folder = join(store, "raw", "compphish");
      mkdirSync(folder, { recursive: true });
      const manifest = { files: [{ name: "All_HTML.zip" }] };
      const inputsDigest = manifestDigest(manifest);
      writeFileSync(join(folder, "INPUTS.json"), JSON.stringify(manifest));
      const row1 = JSON.stringify({
        sha256: "compphish-1",
        url: "https://example.test/login",
        html: "<!doctype html><html><head><title>Account Login</title></head><body><p>Sign in to your account</p></body></html>",
        label: "phish",
        target: null,
      });
      const row2 = JSON.stringify({
        sha256: "compphish-2",
        url: "https://example.test/empty",
        html: "<!doctype html><html><body></body></html>",
        label: "phish",
        target: null,
      });
      const rowsText = `${row1}\n${row2}\n`;
      writeFileSync(join(folder, "rows.jsonl"), rowsText);
      const { fileSha256 } = await import("../../scripts/glimmer/import-source.ts");
      const rowsSha = fileSha256(join(folder, "rows.jsonl"));
      writeFileSync(
        join(folder, "EXPORT.json"),
        JSON.stringify({
          met: 3,
          exported: 2,
          sampled_out: 0,
          rejected: { "no label": 1 },
          rows_sha256: rowsSha,
          converter_sha256: "c1",
          inputs: inputsDigest,
        }),
      );
      writeFileSync(
        join(folder, "IMPORT.json"),
        JSON.stringify({
          status: "complete",
          expected: 2,
          imported: 1,
          duplicates: 0,
          skipped: 0,
          filtered: [{ item: "compphish-2", reason: "an empty page" }],
          excluded: [],
          stored: 1,
          inputs: inputsDigest,
          rows: rowsSha,
        }),
      );
      // Pre-migration store fails storeProblems because ITEMS.inventory.jsonl, ITEMS.jsonl, ITEMS.import.jsonl, item/input and evidence are missing.
      const beforeProblems = storeProblems(store, root).problems.join("\n");
      expect(beforeProblems).toContain("no item or input lineage");
      expect(beforeProblems).toContain("no capture-problem evidence");
      expect(beforeProblems).toContain("no ITEMS.inventory.jsonl");
      expect(beforeProblems).toContain("no ITEMS.jsonl");
      expect(beforeProblems).toContain("no ITEMS.import.jsonl");

      // Completion review G2: migrateLineage refuses when non-exported items lack real converter inventory.
      await expect(migrateLineage(store, root)).rejects.toThrow(
        /cannot migrate ITEMS\.jsonl without real converter inventory/,
      );

      // Provide the converter's real inventory (including rejected item compphish-3).
      writeFileSync(
        join(folder, "ITEMS.inventory.jsonl"),
        `${[
          { inputs: inputsDigest, rows: rowsSha },
          { item: "compphish-1" },
          { item: "compphish-2" },
          { item: "compphish-3" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );

      // Completion review G6: migrateLineage refuses when a rendered row does not match any stored page by content.
      const otherShot = new Uint8Array(
        await sharp({ create: { width: 16, height: 16, channels: 3, background: "#119" } })
          .jpeg()
          .toBuffer(),
      );
      await expect(
        migrateLineage(store, root, {
          renderHtml: async () => ({
            screenshot: otherShot,
            text: "Completely unrelated text",
            has_login_form: false,
            has_payment_form: false,
            evidence: {
              title: "Other",
              overlays: "",
              captcha: false,
              consentWall: false,
              challengeCover: false,
              wall: false,
            },
          }),
        }),
      ).rejects.toThrow(/did not match any stored page by content/);

      await migrateLineage(store, root, {
        renderHtml: async () => ({
          screenshot: shot,
          text: "Sign in to your account",
          has_login_form: true,
          has_payment_form: false,
          evidence: {
            title: "Account Login",
            overlays: "",
            captcha: false,
            consentWall: false,
            challengeCover: false,
            wall: false,
          },
        }),
      });
      expect(storeProblems(store, root, { hashRows: true }).problems).toEqual([]);
      const [migratedPage] = openStore(store).manifest({ source: "compphish" });
      expect(migratedPage?.item).toBe("compphish-1");
      expect(migratedPage?.evidence?.title).toBe("Account Login");
      expect(existsSync(join(folder, "ITEMS.jsonl"))).toBe(true);
      expect(existsSync(join(folder, "ITEMS.inventory.jsonl"))).toBe(true);
      expect(existsSync(join(folder, "ITEMS.import.jsonl"))).toBe(true);

      // Completion review G7: migrateLineage refuses when INPUTS.json changes instead of overwriting EXPORT.json / IMPORT.json.
      writeFileSync(join(folder, "INPUTS.json"), JSON.stringify({ files: [{ name: "New_HTML.zip" }] }));
      await expect(migrateLineage(store, root)).rejects.toThrow(/other inputs than INPUTS\.json names/);
      writeFileSync(join(folder, "INPUTS.json"), JSON.stringify(manifest));

      // Round 1 finding 2: migrateLineage preserves Python's {"inputs": ...}-only ITEMS.inventory.jsonl and refuses
      // when ITEMS.jsonl names rejected item C while ITEMS.inventory.jsonl names rejected item B, without overwriting it.
      const invWithB = `${[
        { inputs: inputsDigest },
        { item: "compphish-1" },
        { item: "compphish-2" },
        { item: "compphish-rejected-B" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`;
      const ledgerWithC = `${[
        { inputs: inputsDigest, rows: rowsSha },
        { item: "compphish-1", outcome: "exported" },
        { item: "compphish-2", outcome: "exported" },
        { item: "compphish-rejected-C", outcome: "rejected", reason: "no html" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`;
      writeFileSync(join(folder, "ITEMS.inventory.jsonl"), invWithB);
      writeFileSync(join(folder, "ITEMS.jsonl"), ledgerWithC);
      await expect(migrateLineage(store, root)).rejects.toThrow(/does not match ITEMS\.inventory\.jsonl/);
      expect(readFileSync(join(folder, "ITEMS.inventory.jsonl"), "utf-8")).toBe(invWithB);

      // Round 1 finding 3: recoverHtmlEvidence detects stylesheet-defined (<style>) full-screen image covers with
      // challenge-vendor scripts, and migrateLineage refuses when a re-rendered page has a capture-problem wall.
      const cssCoverHtml =
        '<html><head><style>.cover { position: fixed; inset: 0; width: 100vw; height: 100vh; background-image: url("/bg.png"); }</style><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="cover"></div></body></html>';
      const cssEvidence = recoverHtmlEvidence(cssCoverHtml, "");
      expect(cssEvidence.challengeCover).toBe(true);
      expect(captureProblem("Sign in", cssEvidence, { has_login_form: true, has_payment_form: false })).toBe(
        "a bot challenge drawn over the page",
      );

      writeFileSync(
        join(folder, "ITEMS.inventory.jsonl"),
        `${[{ inputs: inputsDigest }, { item: "compphish-1" }, { item: "compphish-2" }, { item: "compphish-3" }]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      writeFileSync(
        join(folder, "ITEMS.jsonl"),
        `${[
          { inputs: inputsDigest, rows: rowsSha },
          { item: "compphish-1", outcome: "exported" },
          { item: "compphish-2", outcome: "exported" },
          { item: "compphish-3", outcome: "rejected", reason: "no html" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      removeSourceFromStore(store, "compphish");
      await openStore(store).putPage("compphish", {
        screenshot: shot,
        text: "Sign in to your account",
        origin: "public",
        licence: "CC BY 4.0",
        host: null,
        template: null,
        south_africa: false,
        labels: { lure: true },
        label_source: { lure: "ground-truth" },
        redacted: false,
      });
      writeFileSync(
        join(folder, "IMPORT.json"),
        JSON.stringify({
          status: "complete",
          expected: 2,
          imported: 1,
          duplicates: 0,
          skipped: 0,
          filtered: [{ item: "compphish-2", reason: "an empty page" }],
          excluded: [],
          stored: 1,
          inputs: inputsDigest,
          rows: rowsSha,
        }),
      );
      await expect(
        migrateLineage(store, root, {
          renderHtml: async () => ({
            screenshot: shot,
            text: "Sign in to your account",
            has_login_form: false,
            has_payment_form: false,
            evidence: {
              title: "Verify you are human",
              overlays: "",
              captcha: false,
              consentWall: false,
              challengeCover: true,
              wall: true,
            },
          }),
        }),
      ).rejects.toThrow(/capture-problem wall/);

      // Removing a source cleans ITEMS.import.jsonl alongside marking IMPORT.json incomplete.
      expect(removeSourceFromStore(store, "compphish")).toBe(1);
      expect(existsSync(join(folder, "ITEMS.import.jsonl"))).toBe(false);
      expect(JSON.parse(readFileSync(join(folder, "IMPORT.json"), "utf-8")).status).toBe("incomplete");

      // Round 5 finding 1: when rows.jsonl has duplicate HTML rows and no existing ITEMS.import.jsonl,
      // migrateLineage matches duplicates by SHA-256 digest (htmlHashByItem) and reads HTML on demand only for
      // the single row rendered, without retaining raw HTML strings across all rows.
      const dupHtml =
        "<html><head><title>Account Login</title></head><body><form><input type='password'/>Sign in to your account</form></body></html>";
      const dupRowsContent = `${[
        {
          sha256: "compphish-dup-1",
          url: "https://login.example.com/a",
          html: dupHtml,
          label: "phish",
          target: "Example",
        },
        {
          sha256: "compphish-dup-2",
          url: "https://login.example.com/a",
          html: dupHtml,
          label: "phish",
          target: "Example",
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`;
      writeFileSync(join(folder, "rows.jsonl"), dupRowsContent);
      const dupRowsSha = fileSha256(join(folder, "rows.jsonl"));
      writeFileSync(
        join(folder, "EXPORT.json"),
        JSON.stringify({
          met: 2,
          exported: 2,
          sampled_out: 0,
          rejected: {},
          rows_sha256: dupRowsSha,
          converter_sha256: "c1",
          inputs: inputsDigest,
        }),
      );
      writeFileSync(
        join(folder, "IMPORT.json"),
        JSON.stringify({
          status: "complete",
          expected: 2,
          imported: 1,
          duplicates: 1,
          skipped: 0,
          filtered: [],
          excluded: [],
          stored: 1,
          inputs: inputsDigest,
          rows: dupRowsSha,
        }),
      );
      writeFileSync(
        join(folder, "ITEMS.inventory.jsonl"),
        `${[{ inputs: inputsDigest }, { item: "compphish-dup-1" }, { item: "compphish-dup-2" }]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      writeFileSync(
        join(folder, "ITEMS.jsonl"),
        `${[
          { inputs: inputsDigest, rows: dupRowsSha },
          { item: "compphish-dup-1", outcome: "exported" },
          { item: "compphish-dup-2", outcome: "exported" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      const s2 = openStore(store);
      const dupPageId = await s2.putPage("compphish", {
        screenshot: shot,
        text: "Sign in to your account",
        origin: "public",
        licence: "CC BY 4.0",
        host: null,
        template: null,
        south_africa: false,
        labels: { lure: true },
        label_source: { lure: "ground-truth" },
        redacted: false,
      });
      await migrateLineage(store, root, {
        renderHtml: async () => ({
          screenshot: shot,
          text: "Sign in to your account",
          has_login_form: true,
          has_payment_form: false,
          evidence: {
            title: "Account Login",
            overlays: "",
            captcha: false,
            consentWall: false,
            challengeCover: false,
            wall: false,
          },
        }),
      });
      const dupImportLines = readFileSync(join(folder, "ITEMS.import.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(dupImportLines.slice(1)).toEqual([
        { item: "compphish-dup-1", outcome: "imported", page: dupPageId, input: expect.any(String) },
        { item: "compphish-dup-2", outcome: "duplicate", page: dupPageId, input: expect.any(String) },
      ]);

      // Round 6 finding 1: when a stored page already has item/evidence and a second row with different HTML
      // goes through the fallback renderer during needLedgerBuild, migrateLineage checks captureProblem and
      // refuses if the fallback-rendered row has a wall, rather than matching it by text hash as a duplicate.
      rmSync(join(folder, "ITEMS.import.jsonl"), { force: true });
      openStore(store).setLineage(dupPageId, {
        item: "compphish-dup-1",
        input: dupImportLines[1].input,
        items: [{ id: "compphish-dup-1", input: dupImportLines[1].input, lure: true }],
        evidence: {
          title: "Account Login",
          overlays: "",
          captcha: false,
          consentWall: false,
          challengeCover: false,
          wall: false,
        },
      });
      const diffRowsContent = `${[
        {
          sha256: "compphish-dup-1",
          url: "https://login.example.com/a",
          html: dupHtml,
          label: "phish",
          target: "Example",
        },
        {
          sha256: "compphish-dup-2",
          url: "https://login.example.com/a",
          html: `${dupHtml}<!-- different html bytes -->`,
          label: "phish",
          target: "Example",
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`;
      writeFileSync(join(folder, "rows.jsonl"), diffRowsContent);
      const diffRowsSha = fileSha256(join(folder, "rows.jsonl"));
      writeFileSync(
        join(folder, "EXPORT.json"),
        JSON.stringify({
          met: 2,
          exported: 2,
          sampled_out: 0,
          rejected: {},
          rows_sha256: diffRowsSha,
          converter_sha256: "c1",
          inputs: inputsDigest,
        }),
      );
      writeFileSync(
        join(folder, "IMPORT.json"),
        JSON.stringify({
          status: "complete",
          expected: 2,
          imported: 1,
          duplicates: 1,
          skipped: 0,
          filtered: [],
          excluded: [],
          stored: 1,
          inputs: inputsDigest,
          rows: diffRowsSha,
        }),
      );
      writeFileSync(
        join(folder, "ITEMS.jsonl"),
        `${[
          { inputs: inputsDigest, rows: diffRowsSha },
          { item: "compphish-dup-1", outcome: "exported" },
          { item: "compphish-dup-2", outcome: "exported" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      await expect(
        migrateLineage(store, root, {
          renderHtml: async () => ({
            screenshot: shot,
            text: "Sign in to your account",
            has_login_form: true,
            has_payment_form: false,
            evidence: {
              title: "Account Login",
              overlays: "",
              captcha: true,
              consentWall: false,
              challengeCover: false,
              wall: true,
            },
          }),
        }),
      ).rejects.toThrow(/compphish-dup-2 rendered with a capture-problem wall/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("documents captureProblem() and ledger reconciliation in docs/glimmer/importing.md (D03 T04 §28)", () => {
    const doc = readFileSync(join(import.meta.dirname, "../../docs/glimmer/importing.md"), "utf-8");
    expect(doc).not.toContain("renders under 20 characters of text");
    expect(doc).toContain("captureProblem()");
    expect(doc).toContain("15 percent");
    expect(doc).toContain("new_rows.py");
    expect(doc).toContain("import-new.ts");
    expect(doc).toContain("ITEMS.inventory.jsonl");
    expect(doc).toContain("ITEMS.import.jsonl");
    expect(doc).toContain("migrate-lineage");
  });
});
