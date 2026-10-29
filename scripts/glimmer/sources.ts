// The public page datasets' record, checked against what was imported (D03 T04 §5).
//
//   node scripts/glimmer/sources.ts check   # reconcile docs/glimmer/sources.md, IMPORT.json, the store and NOTICE.md
//
// `docs/glimmer/sources.md` holds one table row per candidate source (public facts only: no content):
//
//   | Source | Dataset | Licence | Licence link | Decision | Reason | Label errors |
//
// Decision is `accepted` or `rejected`; Label errors is the spot check's percentage, or `-` before it ran. Each accepted
// source's converter writes `<store>/raw/<source>/IMPORT.json` with its counts. The check fails, both ways, when an
// accepted source has no complete import or a store count that differs from it, a rejected source has pages in the
// store, the store holds a source with no row, a source above 10 percent label errors still has a `lure` read as
// ground truth, an accepted source is missing from NOTICE.md, or no source is accepted. Nothing may come from §8's
// synthetic generator, removed by the operator on 2026-10-28: no stored page with origin synthetic, and no generator
// script, templates, test or raw folder on the disk, tracked or not. Each accepted source is bound too (§18): its inputs manifest (`INPUTS.json`), its converter's export
// receipt (`EXPORT.json`, for the sources converted to rows) reconciled and naming that manifest, and an import that
// names both; an import made from other inputs or other rows is refused.
//
//   node scripts/glimmer/sources.ts bind <source>   # record, in IMPORT.json, the rows and inputs an import came from
//   node scripts/glimmer/sources.ts freeze          # Loupe 1.0's collection freeze: raw/FROZEN.json, once reconciled
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileSha256, type ImportResult, writeImport } from "./import-source.ts";
import { majesticList, renderReceipt, saList } from "./render.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const MAX_LABEL_ERRORS = 10;
// The sources a converter turns into rows (`rows.jsonl` beside an `EXPORT.json`); ScamFerret's importer reads its archive
// itself, and its IMPORT.json accounts for every item.
export const RECEIPTED = [
  "phreshphish",
  "7-days-later",
  "compphish",
  "ariyadasa-2021",
  "kempf-html",
  "look-for-mallory",
];

export type ExportReceipt = {
  met: number;
  exported: number;
  sampled_out: number;
  rejected: Record<string, number>;
  rows_sha256: string;
  converter_sha256: string;
  inputs: string;
};

// A manifest's identity as scripts/glimmer/inputs.py computes it: the SHA-256 of its JSON with keys sorted, no spaces
// and every character past ASCII escaped, as Python's json.dumps writes it.
export function manifestDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object")
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${canonical(k)}:${canonical((v as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export type SourceRow = {
  source: string;
  dataset: string;
  licence: string;
  licenceLink: string;
  decision: "accepted" | "rejected";
  reason: string;
  labelErrors: number | null;
};

export type ImportRecord = {
  status: "running" | "complete" | "incomplete";
  expected?: number;
  imported?: number;
  duplicates?: number;
  skipped?: number;
  filtered?: { item: string; reason: string }[];
  excluded?: { item: string; reason: string }[];
  stored?: number;
  reason?: string;
  inputs?: string;
  rows?: string;
};

// The table's rows; a row that does not parse is itself a problem, never skipped.
export function parseSources(markdown: string): { rows: SourceRow[]; problems: string[] } {
  const rows: SourceRow[] = [];
  const problems: string[] = [];
  const lines = markdown.split("\n").filter((line) => line.trim().startsWith("|"));
  for (const line of lines.slice(2)) {
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    const [source = "", dataset = "", licence = "", licenceLink = "", decision = "", reason = "", errors = ""] = cells;
    const name = source.replace(/`/g, "");
    if (cells.length !== 7) {
      problems.push(`row "${line.trim().slice(0, 60)}" has ${cells.length} cells, not 7`);
      continue;
    }
    if (decision !== "accepted" && decision !== "rejected")
      problems.push(`${name}: decision is "${decision}", not accepted or rejected`);
    if (!/^https:\/\/\S+$/.test(licenceLink.replace(/[<>]/g, "")))
      problems.push(`${name}: the licence link is not an https URL`);
    if (!licence) problems.push(`${name}: no licence named`);
    const labelErrors = errors === "-" || errors === "" ? null : Number(errors.replace(/%$/, ""));
    if (labelErrors !== null && !Number.isFinite(labelErrors)) problems.push(`${name}: label errors "${errors}"`);
    rows.push({
      source: name,
      dataset,
      licence,
      licenceLink,
      decision: decision as SourceRow["decision"],
      reason,
      labelErrors: labelErrors !== null && Number.isFinite(labelErrors) ? labelErrors : null,
    });
  }
  return { rows, problems };
}

export function reconcile(input: {
  sources: string;
  imports: Record<string, ImportRecord | undefined>;
  pages: StoredPage[];
  notice: string;
  // Each source's manifest digest and export receipt, as read beside its import (§18); left out, the binding is not
  // checked (a caller with no store).
  bindings?: Record<string, { manifest?: string; export?: ExportReceipt }>;
}): string[] {
  const { rows, problems } = parseSources(input.sources);
  const bySource = new Map<string, StoredPage[]>();
  // Appended in place: copying a source's list for every page made the check quadratic (seconds at 40,000 pages).
  for (const page of input.pages.filter((p) => p.origin === "public")) {
    const group = bySource.get(page.source);
    if (group) group.push(page);
    else bySource.set(page.source, [page]);
  }
  const named = new Set(rows.map((row) => row.source));
  for (const row of rows) {
    const stored = bySource.get(row.source) ?? [];
    if (row.decision === "rejected") {
      if (stored.length) problems.push(`${row.source}: rejected, yet ${stored.length} pages are in the store`);
      continue;
    }
    const record = input.imports[row.source];
    if (!record) problems.push(`${row.source}: accepted, but no IMPORT.json`);
    else if (record.status !== "complete")
      problems.push(`${row.source}: the import is ${record.status}${record.reason ? ` (${record.reason})` : ""}`);
    else if (record.stored !== stored.length)
      problems.push(`${row.source}: IMPORT.json says ${record.stored} stored, the store holds ${stored.length}`);
    else if (!stored.length) problems.push(`${row.source}: accepted, but the import stored no page`);
    else {
      // Every item expected is accounted for exactly once: imported, a duplicate, skipped as already stored, filtered
      // or excluded.
      const counted =
        (record.imported ?? 0) +
        (record.duplicates ?? 0) +
        (record.skipped ?? 0) +
        (record.filtered?.length ?? 0) +
        (record.excluded?.length ?? 0);
      if (counted !== record.expected)
        problems.push(`${row.source}: IMPORT.json accounts for ${counted} of ${record.expected} items`);
    }
    if (input.bindings && record?.status === "complete") {
      const bound = input.bindings[row.source] ?? {};
      if (!bound.manifest) problems.push(`${row.source}: no INPUTS.json binding its input files`);
      else if (RECEIPTED.includes(row.source)) {
        const receipt = bound.export;
        if (!receipt) problems.push(`${row.source}: no EXPORT.json from its converter`);
        else {
          const rejected = Object.values(receipt.rejected).reduce((sum, n) => sum + n, 0);
          if (receipt.exported + receipt.sampled_out + rejected !== receipt.met)
            problems.push(
              `${row.source}: EXPORT.json accounts for ${receipt.exported + receipt.sampled_out + rejected} of ${receipt.met} items`,
            );
          if (receipt.inputs !== bound.manifest)
            problems.push(`${row.source}: EXPORT.json was made from other inputs than INPUTS.json names`);
          if (record.rows !== receipt.rows_sha256)
            problems.push(`${row.source}: the import was made from other rows than EXPORT.json names`);
          if (record.expected !== receipt.exported)
            problems.push(
              `${row.source}: the import expected ${record.expected} rows, the export wrote ${receipt.exported}`,
            );
        }
      }
      if (bound.manifest && record.inputs !== bound.manifest)
        problems.push(`${row.source}: the import is not bound to its INPUTS.json`);
    }
    if (row.labelErrors !== null && row.labelErrors > MAX_LABEL_ERRORS) {
      const trusted = stored.filter((page) => page.label_source.lure === "ground-truth").length;
      if (trusted)
        problems.push(`${row.source}: ${row.labelErrors}% label errors, yet ${trusted} pages trust its lure`);
    }
    // Its own row in NOTICE.md's table, which starts with the source's name in code: the name in prose, or inside a
    // longer name, is not its attribution.
    const noticed = input.notice.split("\n").some((line) => line.startsWith(`| \`${row.source}\``));
    if (!noticed) problems.push(`${row.source}: accepted, but missing from NOTICE.md`);
  }
  for (const source of bySource.keys())
    if (!named.has(source)) problems.push(`${source}: in the store with no row in docs/glimmer/sources.md`);
  // §8 was removed (operator, 2026-10-28): no page may come from the generator, whatever its source is called.
  const synthetic = input.pages.filter((page) => page.origin === "synthetic").length;
  if (synthetic) problems.push(`${synthetic} stored pages have origin synthetic, yet §8 was removed`);
  // No public source leaves Loupe no lures but the samples'.
  if (!rows.some((row) => row.decision === "accepted")) problems.push("no source was accepted");
  return problems;
}

// What §8's generator would have left, tracked or not: its script, templates and test in the repository, and its raw
// folder in the store. Empty while the removal holds (§8's checkpoint).
export const SYNTHETIC_PATHS = [
  "scripts/glimmer/synth.ts",
  "scripts/glimmer/templates",
  "test/node/glimmer-synth.test.ts",
];
export function syntheticLeftovers(root: string, store: string): string[] {
  return [
    ...SYNTHETIC_PATHS.filter((path) => existsSync(join(root, path))),
    ...(existsSync(join(store, "raw", "synthetic")) ? ["raw/synthetic"] : []),
  ];
}

// Every problem the store and its record hold, for `check` and for `freeze` alike: the record reconciled with the
// imports, bindings and pages, damaged pages, and §8's leftovers on the disk.
// `hashRows` (the freeze) hashes each converted source's rows in full against its receipt; without it (the check) the
// rows only must be no newer than their receipt, since a converter writes its rows first and its receipt last.
export function storeProblems(
  dir: string,
  root = ROOT,
  options: { hashRows?: boolean } = {},
): { problems: string[]; imports: Record<string, ImportRecord>; pages: StoredPage[]; sourcesMd: string } {
  const problems: string[] = [];
  // A record that does not read (a disk fault, a torn write) is a named problem, never a thrown stack trace.
  const readJson = <T>(file: string): T | undefined => {
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as T;
    } catch {
      problems.push(`${relative(dir, file)}: does not read as JSON`);
      return undefined;
    }
  };
  const store = openStore(dir);
  const pages = store.manifest({ tolerant: true }); // an unreadable record is reported by verify() below
  const sourcesMd = readFileSync(join(root, "docs/glimmer/sources.md"), "utf-8");
  const imports: Record<string, ImportRecord> = {};
  for (const source of new Set([...pages.map((p) => p.source), ...parseSources(sourcesMd).rows.map((r) => r.source)])) {
    const record = readJson<ImportRecord>(join(dir, "raw", source, "IMPORT.json"));
    if (record) imports[source] = record;
  }
  // Damaged pages of an accepted source fail the check: a count can match while a page no longer reads whole.
  const damagedBy: Record<string, number> = {};
  const { damaged, setAside } = store.verify();
  for (const id of damaged) {
    const source = /^(.+)-[0-9a-f]{16}$/.exec(id)?.[1] ?? id;
    damagedBy[source] = (damagedBy[source] ?? 0) + 1;
  }
  const bindings: Record<string, { manifest?: string; export?: ExportReceipt }> = {};
  for (const row of parseSources(sourcesMd).rows) {
    const folder = join(dir, "raw", row.source);
    const manifest = readJson<unknown>(join(folder, "INPUTS.json"));
    const receipt = readJson<ExportReceipt>(join(folder, "EXPORT.json"));
    bindings[row.source] = {
      ...(manifest !== undefined ? { manifest: manifestDigest(manifest) } : {}),
      ...(receipt ? { export: receipt } : {}),
    };
  }
  problems.push(
    ...reconcile({
      sources: sourcesMd,
      imports,
      pages,
      notice: readFileSync(join(root, "NOTICE.md"), "utf-8"),
      bindings,
    }),
  );
  // The rows beside each receipt are the ones it names (completion review G12): a converter stopped between its rows
  // and its receipt leaves new rows beside the old receipt.
  for (const source of RECEIPTED) {
    const rows = join(dir, "raw", source, "rows.jsonl");
    const receipt = bindings[source]?.export;
    if (!receipt || !existsSync(rows)) continue;
    const written = statSync(join(dir, "raw", source, "EXPORT.json")).mtimeMs;
    if (statSync(rows).mtimeMs > written + 1000)
      problems.push(`${source}: rows.jsonl was written after its EXPORT.json, which does not name it`);
    else if (options.hashRows && fileSha256(rows) !== receipt.rows_sha256)
      problems.push(`${source}: rows.jsonl is not the rows its EXPORT.json names`);
  }
  for (const path of syntheticLeftovers(root, dir)) problems.push(`${path} exists, yet §8 was removed`);
  // A damaged copy a repair set aside still holds its page: one from the generator is a leftover too.
  for (const name of setAside) {
    let origin: unknown;
    try {
      origin = (JSON.parse(readFileSync(join(dir, "pages", name, "meta.json"), "utf-8")) as { origin?: unknown })
        .origin;
    } catch {
      origin = undefined; // a copy whose record does not read is counted by verify(), not read here
    }
    if (origin === "synthetic") problems.push(`pages/${name} is a set-aside synthetic page, yet §8 was removed`);
  }
  for (const [source, count] of Object.entries(damagedBy))
    problems.push(`${source}: ${count} damaged pages in the store`);
  return { problems, imports, pages, sourcesMd };
}

if (import.meta.filename === process.argv[1]) {
  const [command, name] = process.argv.slice(2);
  const dir = storeDir();
  if (command === "status") {
    // Each source in the store: pages, and its import's status, counts, time and rate.
    const counts = openStore(dir).counts().bySource;
    for (const source of Object.keys(counts).sort()) {
      const file = join(dir, "raw", source, "IMPORT.json");
      const record = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf-8")) as ImportRecord & Record<string, unknown>)
        : null;
      console.log(
        `${source}: ${counts[source]} pages; ${record ? `${record.status}, ${record.expected} expected, ${record.imported} imported, ${record.skipped ?? 0} skipped, ${record.duplicates} duplicates, ${record.filtered?.length ?? 0} filtered, ${record.excluded?.length ?? 0} excluded${record.pages_per_minute ? `, ${record.pages_per_minute} pages a minute` : ""}` : "no import record"}`,
      );
    }
    // Damaged copies a repair set aside: kept for inspection, listed so they never pile up unseen.
    const pagesDir = join(dir, "pages");
    const setAside = existsSync(pagesDir) ? readdirSync(pagesDir).filter((n) => n.startsWith(".damaged-")).length : 0;
    if (setAside)
      console.log(`set aside: ${setAside} damaged copies in ${pagesDir} (remove a source to clear its own)`);
    process.exit(0);
  }
  if (command === "remove" && name) {
    // The reverse of an import: the source's pages leave the store, and its record says so.
    const removed = openStore(dir).removeSource(name);
    const file = join(dir, "raw", name, "IMPORT.json");
    if (existsSync(file))
      writeImport(file, {
        ...(JSON.parse(readFileSync(file, "utf-8")) as ImportResult),
        status: "incomplete",
        stored: 0,
        reason: "removed from the store",
      });
    console.log(`sources: removed ${removed} pages of ${name}`);
    process.exit(0);
  }
  if (command === "bind" && name) {
    // An existing import's binding (§18). First the rows it read: the rows file, when it is older than the import's
    // start, is the one it read. Then, once the converter has written its receipt for byte-identical rows, the inputs.
    const folder = join(dir, "raw", name);
    const importFile = join(folder, "IMPORT.json");
    if (!existsSync(importFile)) {
      console.error(`sources: ${name} has no IMPORT.json`);
      process.exit(1);
    }
    const record = JSON.parse(readFileSync(importFile, "utf-8")) as ImportResult & { inputs?: string; rows?: string };
    const rowsFile = join(folder, "rows.jsonl");
    if (RECEIPTED.includes(name) && !record.rows) {
      if (!existsSync(rowsFile) || statSync(rowsFile).mtimeMs > Date.parse(record.started)) {
        console.error(`sources: ${name}'s rows file is not the one its import read (it is newer than the import)`);
        process.exit(1);
      }
      record.rows = fileSha256(rowsFile);
      writeImport(importFile, record);
      console.log(`sources: ${name}: the rows its import read are recorded`);
    }
    const inputsFile = join(folder, "INPUTS.json");
    const exportFile = join(folder, "EXPORT.json");
    if (!existsSync(inputsFile)) {
      console.log(`sources: ${name}: no INPUTS.json yet`);
      process.exit(0);
    }
    const manifest = manifestDigest(JSON.parse(readFileSync(inputsFile, "utf-8")));
    if (RECEIPTED.includes(name)) {
      if (!existsSync(exportFile)) {
        console.log(`sources: ${name}: no EXPORT.json yet; run its converter`);
        process.exit(0);
      }
      const receipt = JSON.parse(readFileSync(exportFile, "utf-8")) as ExportReceipt;
      if (receipt.rows_sha256 !== record.rows || receipt.inputs !== manifest) {
        console.error(`sources: ${name}: the converter wrote other rows than the import read; import again`);
        process.exit(1);
      }
    }
    writeImport(importFile, { ...record, inputs: manifest });
    console.log(`sources: ${name}: the import is bound to its inputs`);
    process.exit(0);
  }
  if (command === "freeze") {
    // The collection as it stands (§18): every source's binding and every page in the store, written whole. The
    // builder reads only pages it names, so nothing stored later can enter this version. Refused unless the sources
    // reconcile, so a freeze never holds an unbound or incomplete import.
    // Once only (completion review G13): a freeze is the version's input, never replaced by a later run.
    const file = join(dir, "raw", "FROZEN.json");
    if (existsSync(file)) {
      console.error(
        "sources: raw/FROZEN.json already exists: a freeze is never replaced (move it aside by hand to redo)",
      );
      process.exit(1);
    }
    const { problems, imports, pages, sourcesMd } = storeProblems(dir, ROOT, { hashRows: true });
    // The benign lists' renders finished whole, as they stand now (§18 round 1): each receipt computed afresh from the
    // current list, the journal and the store, never trusted from a file an earlier run wrote. Every URL has its
    // outcome and every stored page verifies.
    const renders: Record<string, { list_sha256: string; urls: number; stored: number; excluded: number }> = {};
    const journal = join(dir, "raw", "benign", "progress.jsonl");
    const store = openStore(dir);
    for (const [name, file] of [
      ["majestic", join(dir, "raw", "majestic", "top.csv")],
      ["benign-sa", join(ROOT, "eval", "glimmer", "benign-sa-urls.txt")],
    ] as const) {
      if (!existsSync(file) || !existsSync(journal)) {
        problems.push(`${name}: no list or no render journal to freeze its render from`);
        continue;
      }
      const text = readFileSync(file, "utf-8");
      const receipt = renderReceipt(name === "majestic" ? majesticList(text) : saList(text), journal, store);
      if (receipt.unfinished.length || receipt.missing_pages.length)
        problems.push(
          `${name}: its render is not finished (${receipt.unfinished.length} unfinished, ${receipt.missing_pages.length} missing)`,
        );
      renders[name] = {
        list_sha256: receipt.list_sha256,
        urls: receipt.urls,
        stored: receipt.stored,
        excluded: Object.values(receipt.excluded).reduce((sum, n) => sum + n, 0),
      };
    }
    if (problems.length) {
      for (const problem of problems) console.log(`sources: ${problem}`);
      console.error(`sources: not frozen: ${problems.length} problems`);
      process.exit(1);
    }
    const frozen = {
      at: new Date().toISOString(),
      sources: Object.fromEntries(
        Object.entries(imports)
          .filter(([source]) =>
            parseSources(sourcesMd).rows.some((r) => r.source === source && r.decision === "accepted"),
          )
          .map(([source, record]) => [
            source,
            {
              inputs: record.inputs ?? null,
              rows: record.rows ?? null,
              stored: record.stored ?? 0,
              // The import record as it stood, which the build checks is still the one there.
              import_sha256: createHash("sha256")
                .update(readFileSync(join(dir, "raw", source, "IMPORT.json")))
                .digest("hex"),
            },
          ]),
      ),
      renders,
      pages: pages.map((page) => page.id).sort(),
    };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(frozen)}\n`);
    renameSync(temporary, file);
    // Read back whole: another writer's freeze of the same size between the rename and this read is caught too.
    if (readFileSync(file, "utf-8") !== `${JSON.stringify(frozen)}\n`) {
      console.error("sources: the freeze did not read back as written");
      process.exit(1);
    }
    console.log(
      `sources: frozen at ${frozen.at}: ${frozen.pages.length} pages, ${Object.keys(frozen.sources).length} sources`,
    );
    process.exit(0);
  }
  if (command !== "check") {
    console.error("usage: node scripts/glimmer/sources.ts check | status | remove <source> | bind <source> | freeze");
    process.exit(2);
  }
  const { problems } = storeProblems(dir);
  for (const problem of problems) console.log(`sources: ${problem}`);
  console.log(problems.length ? `sources: ${problems.length} problems` : "sources: reconciled");
  process.exit(problems.length ? 1 : 0);
}
