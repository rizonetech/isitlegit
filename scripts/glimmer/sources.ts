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
// ground truth, an accepted source is missing from NOTICE.md, or no source is accepted while §8 still asks for 1,500
// synthetic lures. Each accepted source is bound too (§18): its inputs manifest (`INPUTS.json`), its converter's export
// receipt (`EXPORT.json`, for the sources converted to rows) reconciled and naming that manifest, and an import that
// names both; an import made from other inputs or other rows is refused.
//
//   node scripts/glimmer/sources.ts bind <source>   # record, in IMPORT.json, the rows and inputs an import came from
//   node scripts/glimmer/sources.ts freeze          # Loupe 1.0's collection freeze: raw/FROZEN.json, once reconciled
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileSha256, type ImportResult, writeImport } from "./import-source.ts";
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
  synthetic: string;
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
  // §8 removed (operator, 2026-10-28): no page may come from the generator, whatever its source is called.
  const removed = /\*\*Removed \d{4}-\d{2}-\d{2}/.test(input.synthetic);
  if (removed) {
    const synthetic = input.pages.filter((page) => page.origin === "synthetic").length;
    if (synthetic) problems.push(`${synthetic} stored pages have origin synthetic, yet §8 was removed`);
  }
  if (rows.length && !rows.some((row) => row.decision === "accepted")) {
    // No public source: §8's synthetic target and its acceptance count both rise to 3,000; with §8 removed, Loupe would
    // have no lures but the samples'.
    if (removed) problems.push("no source was accepted, and §8's synthetic lures were removed");
    else if (/\b1,500 lures\b/.test(input.synthetic) || !/\b3,000 lures\b/.test(input.synthetic))
      problems.push("no source was accepted, yet §8 still asks for 1,500 synthetic lures");
  }
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

// §8's leftovers as check problems, while its text says it was removed.
function removalProblems(store: string): string[] {
  if (!/\*\*Removed \d{4}-\d{2}-\d{2}/.test(section8())) return [];
  return syntheticLeftovers(ROOT, store).map((path) => `${path} exists, yet §8 was removed`);
}

function section8(): string {
  const todo = readFileSync(join(ROOT, "todo/03-vision/TODO-04-glimmer.md"), "utf-8");
  const start = todo.indexOf("## 8. ");
  return todo.slice(start, todo.indexOf("## 9. ", start));
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
    const store = openStore(dir);
    const pages = store.manifest({ tolerant: true });
    const sourcesMd = readFileSync(join(ROOT, "docs/glimmer/sources.md"), "utf-8");
    const imports: Record<string, ImportRecord> = {};
    const bindings: Record<string, { manifest?: string; export?: ExportReceipt }> = {};
    for (const row of parseSources(sourcesMd).rows) {
      const folder = join(dir, "raw", row.source);
      const file = join(folder, "IMPORT.json");
      if (existsSync(file)) imports[row.source] = JSON.parse(readFileSync(file, "utf-8"));
      const inputsFile = join(folder, "INPUTS.json");
      const exportFile = join(folder, "EXPORT.json");
      bindings[row.source] = {
        ...(existsSync(inputsFile) ? { manifest: manifestDigest(JSON.parse(readFileSync(inputsFile, "utf-8"))) } : {}),
        ...(existsSync(exportFile) ? { export: JSON.parse(readFileSync(exportFile, "utf-8")) as ExportReceipt } : {}),
      };
    }
    const problems = reconcile({
      sources: sourcesMd,
      imports,
      pages,
      notice: readFileSync(join(ROOT, "NOTICE.md"), "utf-8"),
      synthetic: section8(),
      bindings,
    });
    problems.push(...removalProblems(dir));
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
            { inputs: record.inputs ?? null, rows: record.rows ?? null, stored: record.stored ?? 0 },
          ]),
      ),
      pages: pages.map((page) => page.id).sort(),
    };
    const file = join(dir, "raw", "FROZEN.json");
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(frozen)}\n`);
    renameSync(temporary, file);
    const back = JSON.parse(readFileSync(file, "utf-8")) as typeof frozen;
    if (back.pages.length !== frozen.pages.length) throw new Error("the freeze did not read back as written");
    console.log(
      `sources: frozen at ${frozen.at}: ${frozen.pages.length} pages, ${Object.keys(frozen.sources).length} sources`,
    );
    process.exit(0);
  }
  if (command !== "check") {
    console.error("usage: node scripts/glimmer/sources.ts check | status | remove <source> | bind <source> | freeze");
    process.exit(2);
  }
  const store = openStore(dir);
  const pages = store.manifest({ tolerant: true }); // an unreadable record is reported by verify() below
  const imports: Record<string, ImportRecord> = {};
  for (const source of new Set(pages.map((p) => p.source))) {
    const file = join(dir, "raw", source, "IMPORT.json");
    if (existsSync(file)) imports[source] = JSON.parse(readFileSync(file, "utf-8"));
  }
  const sourcesMd = readFileSync(join(ROOT, "docs/glimmer/sources.md"), "utf-8");
  for (const row of parseSources(sourcesMd).rows) {
    const file = join(dir, "raw", row.source, "IMPORT.json");
    if (!imports[row.source] && existsSync(file)) imports[row.source] = JSON.parse(readFileSync(file, "utf-8"));
  }
  // Damaged pages of an accepted source fail the check: a count can match while a page no longer reads whole.
  const damagedBy: Record<string, number> = {};
  for (const id of store.verify().damaged) {
    const source = /^(.+)-[0-9a-f]{16}$/.exec(id)?.[1] ?? id;
    damagedBy[source] = (damagedBy[source] ?? 0) + 1;
  }
  const bindings: Record<string, { manifest?: string; export?: ExportReceipt }> = {};
  for (const row of parseSources(sourcesMd).rows) {
    const folder = join(dir, "raw", row.source);
    const inputsFile = join(folder, "INPUTS.json");
    const exportFile = join(folder, "EXPORT.json");
    bindings[row.source] = {
      ...(existsSync(inputsFile) ? { manifest: manifestDigest(JSON.parse(readFileSync(inputsFile, "utf-8"))) } : {}),
      ...(existsSync(exportFile) ? { export: JSON.parse(readFileSync(exportFile, "utf-8")) as ExportReceipt } : {}),
    };
  }
  const problems = reconcile({
    sources: sourcesMd,
    imports,
    pages,
    notice: readFileSync(join(ROOT, "NOTICE.md"), "utf-8"),
    synthetic: section8(),
    bindings,
  });
  problems.push(...removalProblems(dir));
  for (const [source, count] of Object.entries(damagedBy))
    problems.push(`${source}: ${count} damaged pages in the store`);
  for (const problem of problems) console.log(`sources: ${problem}`);
  console.log(problems.length ? `sources: ${problems.length} problems` : "sources: reconciled");
  process.exit(problems.length ? 1 : 0);
}
