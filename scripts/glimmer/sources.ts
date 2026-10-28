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
// synthetic lures.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ImportResult, writeImport } from "./import-source.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const MAX_LABEL_ERRORS = 10;

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
}): string[] {
  const { rows, problems } = parseSources(input.sources);
  const bySource = new Map<string, StoredPage[]>();
  for (const page of input.pages.filter((p) => p.origin === "public"))
    bySource.set(page.source, [...(bySource.get(page.source) ?? []), page]);
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
    if (row.labelErrors !== null && row.labelErrors > MAX_LABEL_ERRORS) {
      const trusted = stored.filter((page) => page.label_source.lure === "ground-truth").length;
      if (trusted)
        problems.push(`${row.source}: ${row.labelErrors}% label errors, yet ${trusted} pages trust its lure`);
    }
    if (!input.notice.includes(row.source)) problems.push(`${row.source}: accepted, but missing from NOTICE.md`);
  }
  for (const source of bySource.keys())
    if (!named.has(source)) problems.push(`${source}: in the store with no row in docs/glimmer/sources.md`);
  if (rows.length && !rows.some((row) => row.decision === "accepted")) {
    // No public source: §8's synthetic target and its acceptance count both rise to 3,000.
    if (/\b1,500 lures\b/.test(input.synthetic) || !/\b3,000 lures\b/.test(input.synthetic))
      problems.push("no source was accepted, yet §8 still asks for 1,500 synthetic lures");
  }
  return problems;
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
  if (command !== "check") {
    console.error("usage: node scripts/glimmer/sources.ts check | status | remove <source>");
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
  const problems = reconcile({
    sources: sourcesMd,
    imports,
    pages,
    notice: readFileSync(join(ROOT, "NOTICE.md"), "utf-8"),
    synthetic: section8(),
  });
  for (const [source, count] of Object.entries(damagedBy))
    problems.push(`${source}: ${count} damaged pages in the store`);
  for (const problem of problems) console.log(`sources: ${problem}`);
  console.log(problems.length ? `sources: ${problems.length} problems` : "sources: reconciled");
  process.exit(problems.length ? 1 : 0);
}
