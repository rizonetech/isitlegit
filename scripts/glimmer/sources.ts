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
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { indexRows, readHtml } from "./import-phreshphish.ts";
import {
  fileSha256,
  type ImportOutcome as ImportItemEntry,
  type ImportResult,
  writeImport,
  writeImportItems,
} from "./import-source.ts";
import { captureProblem } from "./label-rules.ts";
import { assessCapture, majesticList, renderReceipt, saList } from "./render.ts";
import { openTextReader, type RenderedHtml } from "./source-pages.ts";
import { freezeFile, openStore, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const MAX_LABEL_ERRORS = 10;
// The sources a converter turns into rows (`rows.jsonl` beside an `EXPORT.json`): every accepted source's importer
// reads only rows bound to its converter's receipt, and its IMPORT.json accounts for every item (ScamFerret's included
// since §28).
export const RECEIPTED = [
  "phreshphish",
  "scamferret",
  "7-days-later",
  "compphish",
  "ariyadasa-2021",
  "kempf-html",
  "look-for-mallory",
  "ows",
  "phishingeval-ji",
  "phishdecloaker",
  "putra",
  "van-dooremaal-ares-2021",
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

export type ConverterItemEntry = {
  item: string;
  outcome: "exported" | "sampled-out" | "rejected";
  reason?: string;
};

export type ConverterItemsLedger = {
  header?: { inputs?: string; rows?: string };
  entries: ConverterItemEntry[];
};

export type ImportItemsLedger = {
  header?: { inputs?: string; rows?: string; export?: string; import?: string };
  entries: ImportItemEntry[];
};

export type SourceLedgerBinding = {
  manifest?: string;
  export?: ExportReceipt;
  exportSha256?: string;
  importSha256?: string;
  rows?: boolean;
  checkLineage?: boolean;
  requireInventory?: boolean;
  converterItems?: ConverterItemsLedger;
  importItems?: ImportItemsLedger;
  inventory?: string[];
  rowItems?: { item: string; input: string; lure?: boolean }[];
};

export type NewSourceCoverageFloor = {
  maxSampledOut: number;
  exported: number;
  exportedLure: number;
  exportedBenign: number;
  stored: number;
  storedLure: number;
  storedBenign: number;
};

// Measured conversion scope, sampling policy and usable stored-page coverage floors for the five Loupe 1.1 sources
// (D03 T04 §44 plan review gap 1): an unexpectedly truncated or over-sampled import fails reconciliation even when its
// receipts and ledgers internally balance.
export const NEW_SOURCE_FLOORS: Record<string, NewSourceCoverageFloor> = {
  "van-dooremaal-ares-2021": {
    maxSampledOut: 95_938,
    exported: 29_992,
    exportedLure: 14_999,
    exportedBenign: 14_993,
    stored: 17_381,
    storedLure: 5_819,
    storedBenign: 11_562,
  },
  putra: {
    maxSampledOut: 0,
    exported: 2_494,
    exportedLure: 1_994,
    exportedBenign: 500,
    stored: 1_623,
    storedLure: 1_128,
    storedBenign: 495,
  },
  ows: {
    maxSampledOut: 0,
    exported: 25_189,
    exportedLure: 25_189,
    exportedBenign: 0,
    stored: 15_499,
    storedLure: 15_499,
    storedBenign: 0,
  },
  phishdecloaker: {
    maxSampledOut: 0,
    exported: 60,
    exportedLure: 60,
    exportedBenign: 0,
    stored: 50,
    storedLure: 50,
    storedBenign: 0,
  },
  "phishingeval-ji": {
    maxSampledOut: 0,
    exported: 9_812,
    exportedLure: 7_202,
    exportedBenign: 2_610,
    stored: 8_532,
    storedLure: 6_195,
    storedBenign: 2_337,
  },
};

export function checkNewSourceCoverage(
  source: string,
  input: {
    exportReceipt?: ExportReceipt | undefined;
    rowItems?: { item: string; input: string; lure?: boolean | undefined }[] | undefined;
    stored: Pick<StoredPage, "labels">[];
  },
): string[] {
  const floor = NEW_SOURCE_FLOORS[source];
  if (!floor) return [];
  const problems: string[] = [];
  if (input.exportReceipt) {
    if (input.exportReceipt.sampled_out > floor.maxSampledOut)
      problems.push(
        `${source}: EXPORT.json sampled out ${input.exportReceipt.sampled_out} items, over the ${floor.maxSampledOut} sampling cap`,
      );
    if (input.exportReceipt.exported < floor.exported)
      problems.push(
        `${source}: EXPORT.json exported ${input.exportReceipt.exported} rows, below the ${floor.exported} floor`,
      );
  }
  if (input.rowItems) {
    let exportedLure = 0;
    let exportedBenign = 0;
    for (const r of input.rowItems) {
      if (r.lure === true) exportedLure++;
      else if (r.lure === false) exportedBenign++;
    }
    if (exportedLure < floor.exportedLure || exportedBenign < floor.exportedBenign)
      problems.push(
        `${source}: exported rows by label (${exportedLure} lure, ${exportedBenign} benign) are below the (${floor.exportedLure} lure, ${floor.exportedBenign} benign) floor`,
      );
  }
  let storedLure = 0;
  let storedBenign = 0;
  for (const page of input.stored) {
    if (page.labels.lure === true) storedLure++;
    else if (page.labels.lure === false) storedBenign++;
  }
  if (input.stored.length < floor.stored || storedLure < floor.storedLure || storedBenign < floor.storedBenign)
    problems.push(
      `${source}: stored usable pages by label (${input.stored.length} total, ${storedLure} lure, ${storedBenign} benign) are below the (${floor.stored} total, ${floor.storedLure} lure, ${floor.storedBenign} benign) floor`,
    );
  return problems;
}

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
  bindings?: Record<string, SourceLedgerBinding>;
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
      const converted = Boolean(RECEIPTED.includes(row.source) || bound.rows || record.rows || bound.export);
      if (!bound.manifest) problems.push(`${row.source}: no INPUTS.json binding its input files`);
      // Every source converted to rows owes its converter's receipt, the six §18 knew and any added since (§27): its
      // rows file on the disk, a rows digest in its import, or a receipt beside it says it was converted.
      else if (converted) {
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
      const checkLineage = Boolean(
        bound.checkLineage || bound.converterItems || bound.importItems || bound.inventory || bound.rowItems,
      );
      if (checkLineage) {
        for (const page of stored) {
          if (!page.item || !page.input)
            problems.push(`${row.source}: stored page ${page.id} has no item or input lineage`);
          if (!page.evidence) problems.push(`${row.source}: stored page ${page.id} has no capture-problem evidence`);
          else if (
            page.evidence.wall ||
            page.evidence.captcha ||
            page.evidence.consentWall ||
            page.evidence.challengeCover
          )
            problems.push(`${row.source}: stored page ${page.id} has a capture-problem wall in its evidence`);
        }
        const exportedSet = new Set<string>();
        if (converted || bound.converterItems || bound.inventory) {
          if (bound.requireInventory && !bound.inventory)
            problems.push(`${row.source}: no ITEMS.inventory.jsonl from its converter`);
          if (!bound.converterItems) problems.push(`${row.source}: no ITEMS.jsonl from its converter`);
          else {
            if (bound.manifest && bound.converterItems.header?.inputs !== bound.manifest)
              problems.push(`${row.source}: ITEMS.jsonl was made from other inputs than INPUTS.json names`);
            if (bound.export && bound.converterItems.header?.rows !== bound.export.rows_sha256)
              problems.push(`${row.source}: ITEMS.jsonl was made for other rows than EXPORT.json names`);
            const seenConverter = new Set<string>();
            const counts = { exported: 0, "sampled-out": 0, rejected: 0 };
            for (const entry of bound.converterItems.entries) {
              if (/^[^:]+:(?:sampled-out|rejected)-\d+$/.test(entry.item))
                problems.push(`${row.source}: ITEMS.jsonl contains synthetic placeholder item ${entry.item}`);
              if (seenConverter.has(entry.item))
                problems.push(`${row.source}: item ${entry.item} appears more than once in ITEMS.jsonl`);
              seenConverter.add(entry.item);
              counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
              if (entry.outcome === "exported") exportedSet.add(entry.item);
            }
            if (bound.export) {
              const rejectedTotal = Object.values(bound.export.rejected).reduce((sum, n) => sum + n, 0);
              if (
                counts.exported !== bound.export.exported ||
                counts["sampled-out"] !== bound.export.sampled_out ||
                counts.rejected !== rejectedTotal ||
                bound.converterItems.entries.length !== bound.export.met
              )
                problems.push(
                  `${row.source}: ITEMS.jsonl counts (${counts.exported} exported, ${counts["sampled-out"]} sampled out, ${counts.rejected} rejected) do not match EXPORT.json`,
                );
            }
            if (bound.inventory) {
              const invSet = new Set(bound.inventory);
              if (
                invSet.size !== bound.inventory.length ||
                invSet.size !== seenConverter.size ||
                [...invSet].some((id) => !seenConverter.has(id))
              )
                problems.push(
                  `${row.source}: ITEMS.jsonl does not match the converter's input inventory (${seenConverter.size} ledger items vs ${bound.inventory.length} inventoried)`,
                );
            }
            if (bound.rowItems) {
              const rowSet = new Set(bound.rowItems.map((r) => r.item));
              if (
                rowSet.size !== bound.rowItems.length ||
                rowSet.size !== exportedSet.size ||
                [...rowSet].some((id) => !exportedSet.has(id))
              )
                problems.push(
                  `${row.source}: rows.jsonl items (${bound.rowItems.length}) do not match the ${exportedSet.size} exported items in ITEMS.jsonl`,
                );
            }
          }
        }
        if (converted || bound.importItems || bound.rowItems) {
          if (!bound.importItems) problems.push(`${row.source}: no ITEMS.import.jsonl from its importer`);
          else {
            if (bound.manifest && bound.importItems.header?.inputs !== bound.manifest)
              problems.push(`${row.source}: ITEMS.import.jsonl is not bound to its INPUTS.json`);
            const expectedRows = record.rows ?? bound.export?.rows_sha256;
            if (expectedRows && bound.importItems.header?.rows !== expectedRows)
              problems.push(`${row.source}: ITEMS.import.jsonl was made from other rows than IMPORT.json names`);
            if (bound.exportSha256 && bound.importItems.header?.export !== bound.exportSha256)
              problems.push(`${row.source}: ITEMS.import.jsonl was made from another EXPORT.json`);
            if (bound.importSha256 && bound.importItems.header?.import !== bound.importSha256)
              problems.push(`${row.source}: ITEMS.import.jsonl is not bound to its IMPORT.json`);
            const hasInputs = Boolean(
              bound.rowItems?.length ||
                stored.some((p) => p.input) ||
                bound.importItems.entries.some((e) => Boolean(e.input)),
            );
            const seenImport = new Map<string, ImportItemEntry>();
            for (const entry of bound.importItems.entries) {
              if (hasInputs && !entry.input)
                problems.push(`${row.source}: item ${entry.item} in ITEMS.import.jsonl has no input digest`);
              if (seenImport.has(entry.item))
                problems.push(`${row.source}: item ${entry.item} appears more than once in ITEMS.import.jsonl`);
              seenImport.set(entry.item, entry);
            }
            if (bound.converterItems) {
              if (seenImport.size !== exportedSet.size || [...exportedSet].some((id) => !seenImport.has(id)))
                problems.push(
                  `${row.source}: ITEMS.import.jsonl items (${seenImport.size}) do not match the ${exportedSet.size} exported items in ITEMS.jsonl`,
                );
            }
            const rowLureByItem = new Map<string, boolean>();
            if (bound.rowItems) {
              for (const r of bound.rowItems) {
                if (r.lure !== undefined) rowLureByItem.set(r.item, r.lure);
              }
              const rowDigestByItem = new Map(bound.rowItems.map((r) => [r.item, r.input]));
              if (
                rowDigestByItem.size !== seenImport.size ||
                [...rowDigestByItem.entries()].some(([id, digest]) => seenImport.get(id)?.input !== digest)
              )
                problems.push(`${row.source}: ITEMS.import.jsonl does not match rows.jsonl items or input digests`);
            }
            const pageById = new Map(stored.map((p) => [p.id, p]));
            const itemToPageId = new Map<string, { pageId: string; input?: string | undefined }>();
            for (const page of stored) {
              const lineage = page.items?.length
                ? page.items
                : page.item && page.input
                  ? [{ id: page.item, input: page.input }]
                  : [];
              if (
                page.item &&
                page.input &&
                lineage.length > 0 &&
                (lineage[0]?.id !== page.item || lineage[0]?.input !== page.input)
              )
                problems.push(`${row.source}: stored page ${page.id} disagrees with its own first item lineage`);
              for (const li of lineage) {
                if (!li.id || !li.input)
                  problems.push(`${row.source}: stored page ${page.id} has an item without id or input digest`);
                if (
                  page.items &&
                  page.items.length > 1 &&
                  rowLureByItem.has(li.id) &&
                  li.lure !== rowLureByItem.get(li.id)
                )
                  problems.push(
                    `${row.source}: stored page ${page.id} item ${li.id} is missing or disagrees with its row lure label`,
                  );
                if (itemToPageId.has(li.id))
                  problems.push(
                    `${row.source}: item ${li.id} is claimed by both ${itemToPageId.get(li.id)?.pageId} and ${page.id}`,
                  );
                itemToPageId.set(li.id, { pageId: page.id, input: li.input });
              }
            }
            for (const [itemId, entry] of seenImport) {
              if (entry.outcome === "imported" || entry.outcome === "duplicate" || entry.outcome === "stored") {
                const claimed = itemToPageId.get(itemId);
                if (!entry.page || !pageById.has(entry.page) || !claimed || claimed.pageId !== entry.page)
                  problems.push(
                    `${row.source}: ITEMS.import.jsonl says ${itemId} is on ${entry.page ?? "no page"}, store says ${claimed?.pageId ?? "no page"}`,
                  );
                else if ((hasInputs || entry.input || claimed.input) && entry.input !== claimed.input)
                  problems.push(
                    `${row.source}: ITEMS.import.jsonl and stored page ${entry.page} disagree on the input digest of ${itemId}`,
                  );
              } else if (itemToPageId.has(itemId)) {
                problems.push(
                  `${row.source}: item ${itemId} is ${entry.outcome} in ITEMS.import.jsonl, yet stored on ${itemToPageId.get(itemId)?.pageId}`,
                );
              }
            }
            for (const [itemId, { pageId }] of itemToPageId) {
              if (!seenImport.has(itemId))
                problems.push(
                  `${row.source}: stored page ${pageId} claims item ${itemId}, which is not in ITEMS.import.jsonl`,
                );
            }
          }
        }
      }
      problems.push(
        ...checkNewSourceCoverage(row.source, {
          exportReceipt: bound.export,
          rowItems: bound.rowItems,
          stored,
        }),
      );
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

export function scanRowsLineage(rowsFile: string): { item: string; input: string; lure?: boolean }[] {
  const st = statSync(rowsFile);
  const useCache = st.size > 5 * 1024 * 1024;
  const cacheFile = join(dirname(rowsFile), ".rows-lineage.json");
  let headSha256 = "";
  const fd = openSync(rowsFile, "r");
  try {
    if (useCache) {
      const sample = Buffer.alloc(Math.min(st.size, 65_536));
      const readSample = readSync(fd, sample, 0, sample.length, 0);
      headSha256 = createHash("sha256").update(sample.subarray(0, readSample)).digest("hex");
      if (existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(readFileSync(cacheFile, "utf-8")) as {
            size?: number;
            mtimeMs?: number;
            headSha256?: string;
            rows?: { item: string; input: string; lure?: boolean }[];
          };
          if (
            cached.size === st.size &&
            cached.mtimeMs === st.mtimeMs &&
            cached.headSha256 === headSha256 &&
            Array.isArray(cached.rows)
          ) {
            return cached.rows;
          }
        } catch {
          // Recompute if cache does not read.
        }
      }
    }
    const rows: { item: string; input: string; lure?: boolean }[] = [];
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let lineLabel: "phish" | "benign" | undefined;
    let hasher = createHash("sha256");
    let lineBytes = 0;
    let lineNumber = 0;
    let position = 0;
    const feed = (part: Buffer) => {
      if (part.length === 0) return;
      hasher.update(part);
      lineBytes += part.length;
      if (head.length < 512) {
        const take = Math.min(part.length, 512 - head.length);
        head = Buffer.concat([head, part.subarray(0, take)]);
      }
      if (lineLabel === undefined) {
        const windowBuf = tail.length > 0 ? Buffer.concat([tail, part]) : part;
        const m = /"label"\s*:\s*"(phish|benign)"/.exec(windowBuf.toString("utf-8"));
        if (m) lineLabel = m[1] as "phish" | "benign";
        tail = Buffer.from(windowBuf.subarray(Math.max(0, windowBuf.length - 64)));
      }
    };
    const finish = () => {
      if (lineBytes === 0) return;
      lineNumber++;
      const prefix = head.toString("utf-8").trim();
      const input = hasher.digest("hex");
      const label = lineLabel;
      hasher = createHash("sha256");
      head = Buffer.alloc(0);
      tail = Buffer.alloc(0);
      lineLabel = undefined;
      lineBytes = 0;
      if (!prefix) return;
      const match = /"sha256"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(prefix);
      const item = match ? (JSON.parse(`"${match[1]}"`) as string) : `row-${lineNumber}`;
      const lure = label === "phish" ? true : label === "benign" ? false : undefined;
      rows.push({ item, input, ...(lure !== undefined ? { lure } : {}) });
    };
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      let from = 0;
      for (let newline = chunk.indexOf(10, from); newline !== -1 && newline < read; newline = chunk.indexOf(10, from)) {
        feed(chunk.subarray(from, newline));
        finish();
        from = newline + 1;
      }
      feed(chunk.subarray(from, read));
      position += read;
    }
    finish();
    if (useCache) {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, headSha256, rows }), "utf-8");
      renameSync(tmp, cacheFile);
    }
    return rows;
  } finally {
    closeSync(fd);
  }
}

export function readInventoryLedger(file: string): { header?: { inputs?: string; rows?: string }; items: string[] } {
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { items: [] };
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  const hasHeader = typeof first.inputs === "string" || typeof first.rows === "string";
  const items = (hasHeader ? lines.slice(1) : lines).map((line) => {
    const parsed = JSON.parse(line) as { item?: unknown };
    if (typeof parsed.item !== "string") throw new Error(`${file}: inventory line has no item string`);
    return parsed.item;
  });
  return {
    ...(hasHeader
      ? {
          header: {
            ...(typeof first.inputs === "string" ? { inputs: first.inputs } : {}),
            ...(typeof first.rows === "string" ? { rows: first.rows } : {}),
          },
        }
      : {}),
    items,
  };
}

export function writeInventoryLedger(file: string, header: { inputs: string; rows?: string }, items: string[]): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const written = `${[header, ...items.map((item) => ({ item }))].map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(temporary, written, "utf-8");
  renameSync(temporary, file);
  if (readFileSync(file, "utf-8") !== written)
    throw new Error(`${file}: converter inventory ledger did not read back as written`);
}

export function readConverterLedger(file: string): ConverterItemsLedger {
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { entries: [] };
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  const hasHeader = typeof first.inputs === "string" || typeof first.rows === "string";
  const entries = (hasHeader ? lines.slice(1) : lines).map((line) => JSON.parse(line) as ConverterItemEntry);
  return {
    ...(hasHeader ? { header: { inputs: first.inputs as string, rows: first.rows as string } } : {}),
    entries,
  };
}

export function readImportLedger(file: string): ImportItemsLedger {
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { entries: [] };
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  const hasHeader =
    typeof first.inputs === "string" ||
    typeof first.rows === "string" ||
    typeof first.export === "string" ||
    typeof first.import === "string";
  const entries = (hasHeader ? lines.slice(1) : lines).map((line) => JSON.parse(line) as ImportItemEntry);
  return {
    ...(hasHeader
      ? {
          header: {
            ...(typeof first.inputs === "string" ? { inputs: first.inputs } : {}),
            ...(typeof first.rows === "string" ? { rows: first.rows } : {}),
            ...(typeof first.export === "string" ? { export: first.export } : {}),
            ...(typeof first.import === "string" ? { import: first.import } : {}),
          },
        }
      : {}),
    entries,
  };
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
  const readLedger = <T>(file: string, parse: (f: string) => T): T | undefined => {
    if (!existsSync(file)) return undefined;
    try {
      return parse(file);
    } catch {
      problems.push(`${relative(dir, file)}: does not read as JSONL`);
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
  const bindings: Record<string, SourceLedgerBinding> = {};
  for (const row of parseSources(sourcesMd).rows) {
    const folder = join(dir, "raw", row.source);
    const manifest = readJson<unknown>(join(folder, "INPUTS.json"));
    const exportFile = join(folder, "EXPORT.json");
    const importFile = join(folder, "IMPORT.json");
    const rowsFile = join(folder, "rows.jsonl");
    const receipt = readJson<ExportReceipt>(exportFile);
    const converterItems = readLedger(join(folder, "ITEMS.jsonl"), readConverterLedger);
    const inventoryLedger = readLedger(join(folder, "ITEMS.inventory.jsonl"), readInventoryLedger);
    const importItems = readLedger(join(folder, "ITEMS.import.jsonl"), readImportLedger);
    const hasRows = existsSync(rowsFile);
    const manifestHash = manifest !== undefined ? manifestDigest(manifest) : undefined;
    if (inventoryLedger?.header) {
      if (manifestHash && inventoryLedger.header.inputs && inventoryLedger.header.inputs !== manifestHash)
        problems.push(`${row.source}: ITEMS.inventory.jsonl was made from other inputs than INPUTS.json names`);
      if (receipt && inventoryLedger.header.rows && inventoryLedger.header.rows !== receipt.rows_sha256)
        problems.push(`${row.source}: ITEMS.inventory.jsonl was made for other rows than EXPORT.json names`);
    }
    bindings[row.source] = {
      checkLineage: true,
      requireInventory: Boolean(hasRows || receipt),
      ...(manifestHash !== undefined ? { manifest: manifestHash } : {}),
      ...(receipt ? { export: receipt, exportSha256: fileSha256(exportFile) } : {}),
      ...(existsSync(importFile) && imports[row.source] ? { importSha256: fileSha256(importFile) } : {}),
      ...(hasRows ? { rows: true } : {}),
      ...(converterItems ? { converterItems } : {}),
      ...(inventoryLedger ? { inventory: inventoryLedger.items } : {}),
      ...(importItems ? { importItems } : {}),
      ...(hasRows && imports[row.source]?.status === "complete" ? { rowItems: scanRowsLineage(rowsFile) } : {}),
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
  for (const source of Object.keys(bindings)) {
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

export type Frozen = {
  at: string;
  sources: Record<string, { inputs: string | null; rows: string | null; stored: number; import_sha256: string }>;
  renders: Record<string, { list_sha256: string; urls: number; stored: number; excluded: number }>;
  // Benign pages in the store that neither list's receipt names as its stored capture (a URL dropped from a list, an
  // earlier capture superseded): left out of the version, never judged by it.
  left_out: number;
  pages: string[];
};

// Loupe's collection freeze (§18): refused unless the sources reconcile (rows hashed against their receipts) and both
// benign lists' renders are finished as they stand now, each receipt computed afresh from the current list, the
// journal and the store. The frozen pages are every public and sample page plus exactly the benign pages a receipt names
// as stored, each judged as `render.ts recheck` judges it, so nothing frozen went unjudged (§18 final review).
export function freezeCollection(dir: string, root = ROOT, at = new Date()): { problems: string[]; frozen?: Frozen } {
  const { problems, imports, pages, sourcesMd } = storeProblems(dir, root, { hashRows: true });
  const renders: Frozen["renders"] = {};
  const journal = join(dir, "raw", "benign", "progress.jsonl");
  const store = openStore(dir);
  const named = new Set<string>();
  for (const [name, file] of [
    ["majestic", join(dir, "raw", "majestic", "top.csv")],
    ["benign-sa", join(root, "eval", "glimmer", "benign-sa-urls.txt")],
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
    const judged = { unassessed: 0, wall: 0 };
    for (const outcome of Object.values(receipt.outcomes)) {
      if (!("stored" in outcome)) continue;
      named.add(outcome.stored);
      const read = store.readVerifiedPage(outcome.stored);
      const verdict = read ? assessCapture(read.page, read.text) : "unassessed";
      if (verdict !== "clear") judged[verdict]++;
    }
    if (judged.unassessed || judged.wall)
      problems.push(
        `${name}: ${judged.unassessed} stored pages unassessed and ${judged.wall} showing a wall: run render.ts recheck --rerender-legacy and render again`,
      );
    renders[name] = {
      list_sha256: receipt.list_sha256,
      urls: receipt.urls,
      stored: receipt.stored,
      excluded: Object.values(receipt.excluded).reduce((sum, n) => sum + n, 0),
    };
  }
  if (problems.length) return { problems };
  const accepted = new Set(
    parseSources(sourcesMd)
      .rows.filter((r) => r.decision === "accepted")
      .map((r) => r.source),
  );
  const benign = (page: StoredPage) => page.origin === "benign";
  return {
    problems,
    frozen: {
      at: at.toISOString(),
      sources: Object.fromEntries(
        Object.entries(imports)
          .filter(([source]) => accepted.has(source))
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
      left_out: pages.filter((page) => benign(page) && !named.has(page.id)).length,
      pages: pages
        .filter((page) => !benign(page) || named.has(page.id))
        .map((page) => page.id)
        .sort(),
    },
  };
}

// Writes the freeze once: the file is claimed by an exclusive link, so two freezes started together can never both
// land (the second finds it there), and it is read back whole.
export function writeFreeze(dir: string, frozen: Frozen, version = "1.0"): void {
  const file = freezeFile(dir, version);
  const written = `${JSON.stringify(frozen)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, written);
  try {
    linkSync(temporary, file); // fails when a freeze is already there
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "raw/FROZEN.json already exists: a freeze is never replaced"
        : (error as Error).message,
    );
  } finally {
    rmSync(temporary, { force: true });
  }
  if (readFileSync(file, "utf-8") !== written) throw new Error("the freeze did not read back as written");
}

const isSamplePageId = (id: string): boolean => id.startsWith("samples-body-") || id.startsWith("samples-attachment-");

// Verifies an existing freeze (`raw/FROZEN.json` or `raw/FROZEN-<version>.json`) against the current store without
// replacing the immutable freeze file (D03 T04 §45). Reconciles lineage-migrated `IMPORT.json` bindings (`ITEMS.import.jsonl`)
// and post-freeze sample re-imports under the current redaction key while refusing any drifted non-sample source or page.
export function verifyExistingFreeze(
  dir: string,
  version = "1.0",
  root = ROOT,
): { problems: string[]; frozen?: Frozen; reconciledPages?: Set<string> } {
  const file = freezeFile(dir, version);
  if (!existsSync(file)) return { problems: [`${file}: does not exist`] };
  let record: Frozen;
  try {
    record = JSON.parse(readFileSync(file, "utf-8")) as Frozen;
  } catch {
    return { problems: [`${file}: does not read as JSON`] };
  }
  if (!Array.isArray(record.pages) || !record.sources || !record.renders?.majestic || !record.renders["benign-sa"])
    return { problems: [`${file}: is not a whole freeze (its pages, sources or both renders are missing)`] };

  const { problems, imports, pages, sourcesMd } = storeProblems(dir, root);
  const accepted = new Set(
    parseSources(sourcesMd)
      .rows.filter((r) => r.decision === "accepted")
      .map((r) => r.source),
  );
  for (const source of accepted) {
    if (!(source in record.sources)) problems.push(`${source}: accepted in sources.md, but absent from the freeze`);
  }
  for (const [source, frozenSource] of Object.entries(record.sources)) {
    if (!accepted.has(source)) {
      problems.push(`${source}: in the freeze, but no longer accepted in sources.md`);
      continue;
    }
    const importFile = join(dir, "raw", source, "IMPORT.json");
    if (!existsSync(importFile)) {
      problems.push(`${source}: missing IMPORT.json`);
      continue;
    }
    const currentSha = createHash("sha256").update(readFileSync(importFile)).digest("hex");
    if (currentSha !== frozenSource.import_sha256) {
      const currentImport = imports[source];
      const importLedgerFile = join(dir, "raw", source, "ITEMS.import.jsonl");
      const ledgerHeader = existsSync(importLedgerFile) ? readImportLedger(importLedgerFile).header : undefined;
      const lineageMigrated =
        currentImport?.status === "complete" &&
        (currentImport.stored ?? 0) === frozenSource.stored &&
        (currentImport.rows ?? null) === (frozenSource.rows ?? null) &&
        ledgerHeader?.import === currentSha &&
        (frozenSource.rows === null || ledgerHeader?.rows === frozenSource.rows);
      if (!lineageMigrated) problems.push(`imported again since the freeze: ${source}`);
    }
  }

  const journal = join(dir, "raw", "benign", "progress.jsonl");
  const store = openStore(dir);
  const named = new Set<string>();
  for (const [name, listPath] of [
    ["majestic", join(dir, "raw", "majestic", "top.csv")],
    ["benign-sa", join(root, "eval", "glimmer", "benign-sa-urls.txt")],
  ] as const) {
    const frozenRender = record.renders[name];
    if (!existsSync(listPath) || !existsSync(journal) || !frozenRender) {
      problems.push(`${name}: no list or no render journal to verify its frozen render`);
      continue;
    }
    const text = readFileSync(listPath, "utf-8");
    const receipt = renderReceipt(name === "majestic" ? majesticList(text) : saList(text), journal, store);
    if (receipt.unfinished.length || receipt.missing_pages.length)
      problems.push(
        `${name}: its render is not finished (${receipt.unfinished.length} unfinished, ${receipt.missing_pages.length} missing)`,
      );
    for (const outcome of Object.values(receipt.outcomes)) {
      if ("stored" in outcome) named.add(outcome.stored);
    }
    if (
      receipt.list_sha256 !== frozenRender.list_sha256 ||
      receipt.urls !== frozenRender.urls ||
      receipt.stored !== frozenRender.stored
    )
      problems.push(`${name}: render receipt drifted from the freeze`);
  }

  const storedNonSample = new Set(
    pages.filter((p) => p.origin !== "samples" && (p.origin !== "benign" || named.has(p.id))).map((p) => p.id),
  );
  const frozenNonSample = new Set(record.pages.filter((id) => !isSamplePageId(id)));
  const missingNonSample = [...frozenNonSample].filter((id) => !storedNonSample.has(id));
  const extraNonSample = [...storedNonSample].filter((id) => !frozenNonSample.has(id));
  if (missingNonSample.length || extraNonSample.length)
    problems.push(
      `non-sample pages drifted from the freeze (${missingNonSample.length} missing, ${extraNonSample.length} added)`,
    );

  const frozenSamples = record.pages.filter(isSamplePageId);
  const storedSamples = pages
    .filter((p) => p.origin === "samples")
    .map((p) => p.id)
    .sort();
  const sameSamples =
    frozenSamples.length === storedSamples.length && frozenSamples.every((id, idx) => id === storedSamples[idx]);
  if (!sameSamples && frozenSamples.length > 0) {
    const redactionFile = join(dir, "raw", "samples", "REDACTION.json");
    const redaction = existsSync(redactionFile)
      ? (JSON.parse(readFileSync(redactionFile, "utf-8")) as { key?: string | null; building?: string | null })
      : {};
    const bodyImport = existsSync(join(dir, "raw", "samples-body", "IMPORT.json"))
      ? (JSON.parse(readFileSync(join(dir, "raw", "samples-body", "IMPORT.json"), "utf-8")) as { status?: string })
      : {};
    const attImport = existsSync(join(dir, "raw", "samples-attachment", "IMPORT.json"))
      ? (JSON.parse(readFileSync(join(dir, "raw", "samples-attachment", "IMPORT.json"), "utf-8")) as {
          status?: string;
        })
      : {};
    if (
      !redaction.key ||
      redaction.building ||
      bodyImport.status !== "complete" ||
      attImport.status !== "complete" ||
      storedSamples.length === 0
    ) {
      problems.push("sample pages drifted from the freeze without a complete re-import under the current redaction");
    }
  }

  if (problems.length) return { problems };
  const reconciledPages = sameSamples ? new Set(record.pages) : new Set([...frozenNonSample, ...storedSamples].sort());
  return { problems, frozen: record, reconciledPages };
}

export function removeSourceFromStore(dir: string, name: string): number {
  const removed = openStore(dir).removeSource(name);
  const folder = join(dir, "raw", name);
  rmSync(join(folder, "ITEMS.import.jsonl"), { force: true });
  const file = join(folder, "IMPORT.json");
  if (existsSync(file))
    writeImport(file, {
      ...(JSON.parse(readFileSync(file, "utf-8")) as ImportResult),
      status: "incomplete",
      stored: 0,
      reason: "removed from the store",
    });
  return removed;
}

export function writeConverterLedger(
  file: string,
  header: { inputs: string; rows: string },
  entries: ConverterItemEntry[],
): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const written = `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(temporary, written, "utf-8");
  renameSync(temporary, file);
  if (readFileSync(file, "utf-8") !== written)
    throw new Error(`${file}: converter item ledger did not read back as written`);
}

// Populates converter/import item ledgers and stored-page lineage (`item`, `input`, `items`, `evidence`) for existing
// imports so `storeProblems()` reconciles them (§28). Refuses mismatched generations, synthetic converter IDs, or
// unmatched items/pages instead of fabricating bindings, IDs, pairings, or empty evidence.
export async function migrateLineage(
  dir: string,
  root = ROOT,
  options: { renderHtml?: (html: string) => Promise<RenderedHtml>; log?: (line: string) => void } = {},
): Promise<{ migrated: string[] }> {
  const migrated: string[] = [];
  const store = openStore(dir, { sync: () => undefined, write: (p, d) => writeFileSync(p, d) });
  const allPages = store.manifest({ tolerant: true });
  const bySource = new Map<string, StoredPage[]>();
  for (const p of allPages) {
    const group = bySource.get(p.source);
    if (group) group.push(p);
    else bySource.set(p.source, [p]);
  }
  const sourcesMd = readFileSync(join(root, "docs/glimmer/sources.md"), "utf-8");
  let sharedReader: Awaited<ReturnType<typeof openTextReader>> | null = null;
  const getRenderHtml = async () => {
    if (options.renderHtml) return options.renderHtml;
    const reader = sharedReader ?? (await openTextReader());
    sharedReader = reader;
    return (html: string) => reader.renderHtml(html);
  };
  try {
    for (const row of parseSources(sourcesMd).rows) {
      if (row.decision !== "accepted") continue;
      const source = row.source;
      const folder = join(dir, "raw", source);
      const importFile = join(folder, "IMPORT.json");
      if (!existsSync(importFile)) continue;
      const importRecord = JSON.parse(readFileSync(importFile, "utf-8")) as ImportResult & {
        inputs?: string;
        rows?: string;
      };
      if (importRecord.status !== "complete") continue;
      const inputsFile = join(folder, "INPUTS.json");
      const exportFile = join(folder, "EXPORT.json");
      const rowsFile = join(folder, "rows.jsonl");
      const converterLedgerFile = join(folder, "ITEMS.jsonl");
      const inventoryLedgerFile = join(folder, "ITEMS.inventory.jsonl");
      const importLedgerFile = join(folder, "ITEMS.import.jsonl");
      const manifestHash = existsSync(inputsFile)
        ? manifestDigest(JSON.parse(readFileSync(inputsFile, "utf-8")))
        : importRecord.inputs;
      const receipt = existsSync(exportFile)
        ? (JSON.parse(readFileSync(exportFile, "utf-8")) as ExportReceipt)
        : undefined;
      if (receipt && manifestHash && receipt.inputs !== manifestHash) {
        throw new Error(`${source}: EXPORT.json was made from other inputs than INPUTS.json names; re-run converter`);
      }
      if (receipt && existsSync(rowsFile) && fileSha256(rowsFile) !== receipt.rows_sha256) {
        throw new Error(`${source}: rows.jsonl is not the rows EXPORT.json names; re-run converter`);
      }
      if (manifestHash && importRecord.inputs && importRecord.inputs !== manifestHash) {
        throw new Error(`${source}: IMPORT.json is bound to other inputs than INPUTS.json names; re-import`);
      }
      if (receipt && importRecord.rows && importRecord.rows !== receipt.rows_sha256) {
        throw new Error(`${source}: IMPORT.json was made from other rows than EXPORT.json names; re-import`);
      }
      if ((!importRecord.inputs && manifestHash) || (receipt && !importRecord.rows)) {
        if (!importRecord.inputs && manifestHash) importRecord.inputs = manifestHash;
        if (receipt && !importRecord.rows) importRecord.rows = receipt.rows_sha256;
        writeImport(importFile, importRecord);
      }
      const pages = bySource.get(source) ?? [];
      if (!existsSync(rowsFile) || !receipt) {
        for (const page of pages) {
          if (!page.item || !page.input || !page.evidence) {
            throw new Error(
              `${source}: stored page ${page.id} lacks lineage or capture evidence and has no rows.jsonl`,
            );
          }
        }
        migrated.push(source);
        continue;
      }

      options.log?.(`migrate-lineage: scanning ${source}...`);
      const existingImportLedger = existsSync(importLedgerFile) ? readImportLedger(importLedgerFile) : undefined;
      const existingConverterLedger = existsSync(converterLedgerFile)
        ? readConverterLedger(converterLedgerFile)
        : undefined;
      const existingInventoryLedger = existsSync(inventoryLedgerFile)
        ? readInventoryLedger(inventoryLedgerFile)
        : undefined;
      const rowItems = scanRowsLineage(rowsFile);
      const rowInputByItem = new Map(rowItems.map((r) => [r.item, r.input]));
      const rowLureByItem = new Map<string, boolean>();
      for (const r of rowItems) {
        if (r.lure !== undefined) rowLureByItem.set(r.item, r.lure);
      }

      if (
        existingConverterLedger?.entries.some((e) => /^[^:]+:(?:sampled-out|rejected)-\d+$/.test(e.item)) ||
        existingInventoryLedger?.items.some((id) => /^[^:]+:(?:sampled-out|rejected)-\d+$/.test(id))
      ) {
        throw new Error(`${source}: converter ledger contains synthetic placeholder IDs; re-run converter`);
      }

      if (existingInventoryLedger?.header) {
        if (existingInventoryLedger.header.inputs && existingInventoryLedger.header.inputs !== receipt.inputs) {
          throw new Error(`${source}: ITEMS.inventory.jsonl was made from other inputs than INPUTS.json names`);
        }
        if (existingInventoryLedger.header.rows && existingInventoryLedger.header.rows !== receipt.rows_sha256) {
          throw new Error(`${source}: ITEMS.inventory.jsonl was made for other rows than EXPORT.json names`);
        }
      }

      const rejectedReasons = Object.entries(receipt.rejected).filter(([, c]) => c > 0);
      const rejectedTotal = rejectedReasons.reduce((sum, [, c]) => sum + c, 0);
      let converterEntries = existingConverterLedger?.entries;
      if (
        !existingConverterLedger ||
        existingConverterLedger.header?.inputs !== receipt.inputs ||
        existingConverterLedger.header?.rows !== receipt.rows_sha256 ||
        existingConverterLedger.entries.length !== receipt.met
      ) {
        const entries: ConverterItemEntry[] = rowItems.map((r) => ({ item: r.item, outcome: "exported" }));
        if (receipt.sampled_out === 0 && rejectedTotal === 0 && entries.length === receipt.met) {
          converterEntries = entries;
        } else if (
          existingInventoryLedger &&
          existingInventoryLedger.items.length === receipt.met &&
          ((receipt.sampled_out > 0 && rejectedTotal === 0) ||
            (receipt.sampled_out === 0 && rejectedReasons.length === 1))
        ) {
          const nonExported = existingInventoryLedger.items.filter((id) => !rowInputByItem.has(id));
          if (nonExported.length !== receipt.met - entries.length) {
            throw new Error(`${source}: ITEMS.inventory.jsonl does not match exported rows in rows.jsonl`);
          }
          if (receipt.sampled_out > 0) {
            for (const id of nonExported) entries.push({ item: id, outcome: "sampled-out" });
          } else {
            const reason = rejectedReasons[0]?.[0] as string;
            for (const id of nonExported) entries.push({ item: id, outcome: "rejected", reason });
          }
          converterEntries = entries;
        } else {
          throw new Error(
            `${source}: cannot migrate ITEMS.jsonl without real converter inventory for non-exported items; re-run converter`,
          );
        }
        writeConverterLedger(
          converterLedgerFile,
          { inputs: receipt.inputs, rows: receipt.rows_sha256 },
          converterEntries,
        );
      }

      if (existingInventoryLedger) {
        const invSet = new Set(existingInventoryLedger.items);
        const convSet = new Set((converterEntries ?? []).map((e) => e.item));
        if (
          invSet.size !== existingInventoryLedger.items.length ||
          invSet.size !== convSet.size ||
          [...invSet].some((id) => !convSet.has(id))
        ) {
          throw new Error(
            `${source}: ITEMS.jsonl (${convSet.size} items) does not match ITEMS.inventory.jsonl (${existingInventoryLedger.items.length} items); re-run converter`,
          );
        }
      } else if (receipt.sampled_out === 0 && rejectedTotal === 0 && rowItems.length === receipt.met) {
        writeInventoryLedger(
          inventoryLedgerFile,
          { inputs: receipt.inputs },
          rowItems.map((r) => r.item),
        );
      } else {
        throw new Error(
          `${source}: missing ITEMS.inventory.jsonl for source with non-exported items; re-run converter`,
        );
      }

      const exportSha256 = fileSha256(exportFile);
      const importSha256 = fileSha256(importFile);
      const header = {
        inputs: importRecord.inputs ?? receipt.inputs,
        rows: importRecord.rows ?? receipt.rows_sha256,
        export: exportSha256,
        import: importSha256,
      };

      const smallEnoughToRender =
        pages.some((p) => !p.evidence || !p.item) &&
        (Boolean(options.renderHtml) ||
          (rowItems.length > 0 && rowItems.length <= 200 && statSync(rowsFile).size <= 50 * 1024 * 1024));

      if (smallEnoughToRender) {
        const renderHtml = await getRenderHtml();
        const indexed = await indexRows(rowsFile);
        const excludedById = new Map((importRecord.excluded ?? []).map((e) => [e.item, e.reason]));
        const filteredById = new Map((importRecord.filtered ?? []).map((e) => [e.item, e.reason]));
        const pageByItem = new Map<string, StoredPage>();
        const pagesByPair = new Map<string, StoredPage[]>();
        const pagesByText = new Map<string, StoredPage[]>();
        for (const p of pages) {
          if (p.item) pageByItem.set(p.item, p);
          const pairKey = `${p.sha256.screenshot}:${p.sha256.text}`;
          pagesByPair.set(pairKey, [...(pagesByPair.get(pairKey) ?? []), p]);
          pagesByText.set(p.sha256.text, [...(pagesByText.get(p.sha256.text) ?? []), p]);
        }
        const assignedByPage = new Map<
          string,
          {
            items: NonNullable<StoredPage["items"]>;
            evidence: NonNullable<StoredPage["evidence"]>;
          }
        >();
        const ledgerEntries: ImportItemEntry[] = [];
        for (const entry of indexed) {
          const item = entry.sha256;
          const input = entry.input ?? rowInputByItem.get(item);
          if (!input) throw new Error(`${source}: item ${item} has no input digest`);
          const excludedReason = excludedById.get(item);
          if (excludedReason !== undefined) {
            ledgerEntries.push({ item, input, outcome: "excluded", reason: excludedReason });
            continue;
          }
          const filteredReason = filteredById.get(item);
          if (filteredReason !== undefined) {
            ledgerEntries.push({ item, input, outcome: "filtered", reason: filteredReason });
            continue;
          }
          const rendered = await renderHtml(readHtml(rowsFile, entry));
          const wallProblem = captureProblem(rendered.text, rendered.evidence, {
            has_login_form: rendered.has_login_form,
            has_payment_form: rendered.has_payment_form,
          });
          if (
            wallProblem !== null ||
            rendered.evidence.wall ||
            rendered.evidence.captcha ||
            rendered.evidence.consentWall ||
            rendered.evidence.challengeCover
          ) {
            throw new Error(`${source}: item ${item} rendered with a capture-problem wall; re-import ${source}`);
          }
          const shotHash = createHash("sha256").update(rendered.screenshot).digest("hex");
          const textHash = createHash("sha256").update(rendered.text, "utf-8").digest("hex");
          const matched =
            pageByItem.get(item) ?? pagesByPair.get(`${shotHash}:${textHash}`)?.[0] ?? pagesByText.get(textHash)?.[0];
          if (!matched) {
            throw new Error(`${source}: item ${item} did not match any stored page by content; re-import ${source}`);
          }
          const current = assignedByPage.get(matched.id);
          const outcome: ImportItemEntry["outcome"] = current ? "duplicate" : "imported";
          const lure = entry.label === "phish" ? true : entry.label === "benign" ? false : rowLureByItem.get(item);
          const nextItem = {
            id: item,
            input,
            ...(lure !== undefined ? { lure } : {}),
            ...(lure === false ? { lure_type: "none" as const } : {}),
          };
          const nextItems = [...(current?.items ?? []), nextItem];
          assignedByPage.set(matched.id, { items: nextItems, evidence: rendered.evidence });
          ledgerEntries.push({ item, input, outcome, page: matched.id });
        }
        for (const page of pages) {
          const assigned = assignedByPage.get(page.id);
          const firstItem = assigned?.items[0];
          if (!assigned || !firstItem) {
            throw new Error(`${source}: stored page ${page.id} was not matched by any exported row; re-import`);
          }
          store.setLineage(page.id, {
            item: firstItem.id,
            input: firstItem.input,
            items: assigned.items,
            evidence: assigned.evidence,
          });
        }
        writeImportItems(importLedgerFile, header, ledgerEntries);
        migrated.push(source);
        continue;
      }

      // Recover HTML evidence by rendering any page lacking evidence, and index HTML SHA-256 hashes (never retaining
      // raw HTML documents) when duplicate items need matching.
      const excludedById = new Map((importRecord.excluded ?? []).map((e) => [e.item, e.reason]));
      const filteredById = new Map((importRecord.filtered ?? []).map((e) => [e.item, e.reason]));
      const pagesMissingEvidence = new Set(pages.filter((p) => !p.evidence).map((p) => p.id));
      const needLedgerBuild = !existingImportLedger || existingImportLedger.entries.length !== receipt.exported;
      const recoveredEvidenceByPage = new Map<string, NonNullable<StoredPage["evidence"]>>();
      const htmlHashByItem = new Map<string, string>();
      const indexedByItem = new Map<string, Awaited<ReturnType<typeof indexRows>>[number]>();
      if (pagesMissingEvidence.size > 0 || needLedgerBuild) {
        const renderHtml = pagesMissingEvidence.size > 0 ? await getRenderHtml() : undefined;
        const indexed = await indexRows(rowsFile);
        const wantedPrimaryItems = new Map<string, StoredPage>();
        for (const p of pages) {
          if (p.item && (pagesMissingEvidence.has(p.id) || needLedgerBuild)) wantedPrimaryItems.set(p.item, p);
        }
        for (const entry of indexed) {
          if (excludedById.has(entry.sha256) || filteredById.has(entry.sha256)) continue;
          if (needLedgerBuild) indexedByItem.set(entry.sha256, entry);
          if (wantedPrimaryItems.has(entry.sha256) || needLedgerBuild) {
            const html = readHtml(rowsFile, entry);
            if (needLedgerBuild) {
              htmlHashByItem.set(entry.sha256, createHash("sha256").update(html, "utf-8").digest("hex"));
            }
            const primaryPage = wantedPrimaryItems.get(entry.sha256);
            if (primaryPage && pagesMissingEvidence.has(primaryPage.id) && renderHtml) {
              const rendered = await renderHtml(html);
              const wallProblem = captureProblem(rendered.text, rendered.evidence, {
                has_login_form: rendered.has_login_form,
                has_payment_form: rendered.has_payment_form,
              });
              if (
                wallProblem !== null ||
                rendered.evidence.wall ||
                rendered.evidence.captcha ||
                rendered.evidence.consentWall ||
                rendered.evidence.challengeCover
              ) {
                throw new Error(
                  `${source}: stored page ${primaryPage.id} rendered with a capture-problem wall; re-import ${source}`,
                );
              }
              recoveredEvidenceByPage.set(primaryPage.id, rendered.evidence);
            }
          }
        }
      }

      const enrichItem = (
        id: string,
        input: string,
        existing?: NonNullable<StoredPage["items"]>[number],
      ): NonNullable<StoredPage["items"]>[number] => {
        const lure = existing?.lure ?? rowLureByItem.get(id);
        const lure_type = existing?.lure_type ?? (lure === false ? "none" : undefined);
        return {
          id,
          input,
          ...(lure !== undefined ? { lure } : {}),
          ...(lure_type !== undefined ? { lure_type } : {}),
        };
      };

      if (!needLedgerBuild && existingImportLedger) {
        const pageById = new Map(pages.map((p) => [p.id, p]));
        const updatedEntries: ImportItemEntry[] = existingImportLedger.entries.map((entry) => {
          const input = entry.input ?? rowInputByItem.get(entry.item);
          if (!input) throw new Error(`${source}: item ${entry.item} in ITEMS.import.jsonl has no input digest`);
          return { ...entry, input };
        });
        const byPage = new Map<string, NonNullable<StoredPage["items"]>>();
        for (const entry of updatedEntries) {
          if (entry.outcome === "imported" || entry.outcome === "duplicate" || entry.outcome === "stored") {
            if (!entry.page || !pageById.has(entry.page) || !entry.input) {
              throw new Error(
                `${source}: ITEMS.import.jsonl maps ${entry.item} to missing page ${entry.page ?? "none"}`,
              );
            }
            const targetPage = pageById.get(entry.page) as StoredPage;
            const existingItem = targetPage.items?.find((li) => li.id === entry.item);
            const rich = enrichItem(entry.item, entry.input, existingItem);
            const list = byPage.get(entry.page);
            if (list) list.push(rich);
            else byPage.set(entry.page, [rich]);
          }
        }
        for (const page of pages) {
          const items = byPage.get(page.id);
          const primary = items?.[0];
          if (!items || !primary) {
            throw new Error(`${source}: stored page ${page.id} has no items in ITEMS.import.jsonl`);
          }
          const evidence = page.evidence ?? recoveredEvidenceByPage.get(page.id);
          if (!evidence) {
            throw new Error(`${source}: stored page ${page.id} has no capture evidence`);
          }
          const needUpdate =
            page.item !== primary.id ||
            page.input !== primary.input ||
            !page.evidence ||
            (page.items?.length ?? 1) !== items.length ||
            (page.items
              ? page.items.some(
                  (li, idx) =>
                    li.id !== items[idx]?.id || li.input !== items[idx]?.input || li.lure !== items[idx]?.lure,
                )
              : items.length > 1);
          if (needUpdate) {
            store.setLineage(page.id, {
              item: primary.id,
              input: primary.input,
              items,
              evidence,
            });
          }
        }
        writeImportItems(importLedgerFile, header, updatedEntries);
        migrated.push(source);
        continue;
      }

      // Build ITEMS.import.jsonl and stored-page lineage from verified content matches only.
      const pageByItem = new Map<string, StoredPage>();
      const pagesByHtmlHash = new Map<string, StoredPage>();
      const pagesByPair = new Map<string, StoredPage[]>();
      const pagesByText = new Map<string, StoredPage[]>();
      for (const page of pages) {
        if (!page.item) {
          throw new Error(`${source}: stored page ${page.id} has no item id; re-import ${source}`);
        }
        pageByItem.set(page.item, page);
        for (const li of page.items ?? []) pageByItem.set(li.id, page);
        const primaryHash = htmlHashByItem.get(page.item);
        if (primaryHash !== undefined && !pagesByHtmlHash.has(primaryHash)) {
          pagesByHtmlHash.set(primaryHash, page);
        }
        const pairKey = `${page.sha256.screenshot}:${page.sha256.text}`;
        pagesByPair.set(pairKey, [...(pagesByPair.get(pairKey) ?? []), page]);
        pagesByText.set(page.sha256.text, [...(pagesByText.get(page.sha256.text) ?? []), page]);
      }

      const pageItems = new Map<string, NonNullable<StoredPage["items"]>>();
      const itemOutcome = new Map<string, { outcome: "imported" | "duplicate" | "stored"; page: string }>();
      const surviving = rowItems.filter((r) => !excludedById.has(r.item) && !filteredById.has(r.item));

      for (const r of surviving) {
        let matched = pageByItem.get(r.item);
        if (!matched) {
          const h = htmlHashByItem.get(r.item);
          if (h !== undefined) matched = pagesByHtmlHash.get(h);
        }
        if (!matched) {
          const entry = indexedByItem.get(r.item);
          if (entry !== undefined) {
            const renderHtml = await getRenderHtml();
            const rendered = await renderHtml(readHtml(rowsFile, entry));
            const wallProblem = captureProblem(rendered.text, rendered.evidence, {
              has_login_form: rendered.has_login_form,
              has_payment_form: rendered.has_payment_form,
            });
            if (
              wallProblem !== null ||
              rendered.evidence.wall ||
              rendered.evidence.captcha ||
              rendered.evidence.consentWall ||
              rendered.evidence.challengeCover
            ) {
              throw new Error(`${source}: item ${r.item} rendered with a capture-problem wall; re-import ${source}`);
            }
            const shotHash = createHash("sha256").update(rendered.screenshot).digest("hex");
            const textHash = createHash("sha256").update(rendered.text, "utf-8").digest("hex");
            matched = pagesByPair.get(`${shotHash}:${textHash}`)?.[0] ?? pagesByText.get(textHash)?.[0];
          }
        }
        if (!matched) {
          throw new Error(`${source}: item ${r.item} did not match any stored page by content; re-import ${source}`);
        }
        const existingList = pageItems.get(matched.id);
        const existingItem = matched.items?.find((li) => li.id === r.item);
        const rich = enrichItem(r.item, r.input, existingItem);
        if (existingList) {
          existingList.push(rich);
          itemOutcome.set(r.item, { outcome: "duplicate", page: matched.id });
        } else {
          pageItems.set(matched.id, [rich]);
          itemOutcome.set(r.item, { outcome: "imported", page: matched.id });
        }
      }

      const ledgerEntries: ImportItemEntry[] = rowItems.map((r) => {
        const excludedReason = excludedById.get(r.item);
        if (excludedReason !== undefined)
          return { item: r.item, input: r.input, outcome: "excluded", reason: excludedReason };
        const filteredReason = filteredById.get(r.item);
        if (filteredReason !== undefined)
          return { item: r.item, input: r.input, outcome: "filtered", reason: filteredReason };
        const assigned = itemOutcome.get(r.item);
        if (!assigned) throw new Error(`${source}: item ${r.item} was not assigned an import outcome`);
        return { item: r.item, input: r.input, outcome: assigned.outcome, page: assigned.page };
      });

      for (const page of pages) {
        const items = pageItems.get(page.id);
        const primary = items?.[0];
        if (!items || !primary) {
          throw new Error(`${source}: stored page ${page.id} was not matched by any exported row; re-import`);
        }
        const evidence = page.evidence ?? recoveredEvidenceByPage.get(page.id);
        if (!evidence) {
          throw new Error(`${source}: stored page ${page.id} has no capture evidence`);
        }
        store.setLineage(page.id, {
          item: primary.id,
          input: primary.input,
          items,
          evidence,
        });
      }
      writeImportItems(importLedgerFile, header, ledgerEntries);
      migrated.push(source);
    }
  } finally {
    if (sharedReader) await sharedReader.close();
  }
  return { migrated };
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
    // The reverse of an import: the source's pages leave the store, and its record and import ledger say so.
    const removed = removeSourceFromStore(dir, name);
    console.log(`sources: removed ${removed} pages of ${name}`);
    process.exit(0);
  }
  if (command === "migrate-lineage") {
    const { migrated } = await migrateLineage(dir, ROOT, { log: (line) => console.log(line) });
    console.log(`sources: migrated lineage for ${migrated.length} sources (${migrated.join(", ")})`);
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
    // The collection as it stands, once a version (§18, §27): see freezeCollection() and writeFreeze().
    // `freeze --version 1.1` writes 1.1's own freeze; with no version, 1.0's.
    const at = process.argv.indexOf("--version");
    const version = at >= 0 ? (process.argv[at + 1] ?? "") : "1.0";
    const target = freezeFile(dir, version);
    if (existsSync(target)) {
      const verified = verifyExistingFreeze(dir, version);
      if (verified.problems.length === 0 && verified.frozen) {
        console.log(
          `sources: existing freeze at ${target} verified (${verified.reconciledPages?.size ?? verified.frozen.pages.length} pages, ${Object.keys(verified.frozen.sources).length} sources); a freeze is never replaced`,
        );
        process.exit(0);
      }
      for (const problem of verified.problems) console.error(`sources: ${problem}`);
      console.error(`sources: ${target} already exists: a freeze is never replaced (move it aside by hand to redo)`);
      process.exit(1);
    }
    const { problems, frozen } = freezeCollection(dir);
    if (!frozen) {
      for (const problem of problems) console.log(`sources: ${problem}`);
      console.error(`sources: not frozen: ${problems.length} problems`);
      process.exit(1);
    }
    try {
      writeFreeze(dir, frozen, version);
    } catch (error) {
      console.error(`sources: ${(error as Error).message}`);
      process.exit(1);
    }
    console.log(
      `sources: frozen at ${frozen.at}: ${frozen.pages.length} pages, ${Object.keys(frozen.sources).length} sources, ${frozen.left_out} benign pages outside both lists left out`,
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
