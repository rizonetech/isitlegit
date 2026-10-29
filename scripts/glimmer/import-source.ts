// The shared import run for a public dataset (D03 T04 §5): each item becomes a store page, four at a time by default
// (`--concurrency`), and the
// run's account goes to `<store>/raw/<source>/IMPORT.json` (temp-then-rename): items expected, imported (new pages),
// duplicates (pages already stored, so a rerun stores nothing twice), excluded (each with its item and reason: an item
// that failed to load or store), filtered (each with its item and reason: a page that loaded but renders almost no
// text, which no rerun changes) and stored (the source's pages in the store afterwards). More than 5 percent excluded,
// or a stop on a write failure,
// reads `incomplete`; the source is not used until a rerun completes it.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOST } from "../../src/vision/page-screen.ts";
import type { Labels, openStore, PageInput } from "./store.ts";

export const MAX_EXCLUDED_SHARE = 0.05;
export const MIN_TEXT_CHARACTERS = 20;
// An item gets this long to load, whatever its loader does: a load that never settles becomes the item's exclusion,
// so no worker waits forever (the reader's own page deadline is 30 seconds; this is the backstop around it).
export const ITEM_DEADLINE_MS = 120_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the item did not load within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export type SourceItem = {
  id: string; // the item's name inside the dataset, for exclusions
  load: () => Promise<{ screenshot: Uint8Array; text: string; has_login_form?: boolean; has_payment_form?: boolean }>;
  // The screenshot is the dataset's live capture while the text and form flags come from an inert copy of its HTML
  // (7 Days Later, §18): a form a script builds shows in the picture and not in the copy, so a false flag is untrusted.
  inertFlags?: boolean;
  url: string | null;
  labels: Labels;
  label_source: PageInput["label_source"];
};

export type ImportResult = {
  // `running` is written before any work, so a run that is killed, or that cannot write its end for a full disk,
  // never leaves an earlier `complete` standing.
  status: "running" | "complete" | "incomplete";
  expected: number;
  imported: number;
  duplicates: number;
  excluded: { item: string; reason: string }[];
  filtered: { item: string; reason: string }[];
  stored: number;
  // Items a page in the store already came from: not rendered again (a resumed run); of those, the ones whose stored
  // labels or licence took a changed mapping.
  skipped: number;
  relabelled?: number;
  // The source's pages stored before pages named their item: they cannot be checked against the dataset's list.
  legacy?: number;
  reason?: string;
  started: string;
  finished?: string;
  seconds?: number;
  pages_per_minute?: number;
  concurrency: number;
  // The inputs and rows the import was made from (§18): the manifest's digest and the rows file's SHA-256, as the
  // converter's export receipt names them, so `sources.ts check` refuses an import made from anything else.
  inputs?: string;
  rows?: string;
};

// A file's SHA-256, read in blocks: rows files pass the 2 GiB a single read can hold (PhreshPhish's is 26 GB).
export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const block = Buffer.alloc(4 << 20);
    for (let read = readSync(fd, block); read > 0; read = readSync(fd, block)) hash.update(block.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// A converter's export receipt beside its rows: the binding an import records, once the rows file is the one it names.
// Refuses rows without a receipt, or rows that changed since it was written.
export function exportBinding(rowsFile: string): { inputs: string; rows: string } {
  const receiptFile = join(dirname(rowsFile), "EXPORT.json");
  if (!existsSync(receiptFile)) throw new Error(`${receiptFile} is missing: run the converter, which writes it`);
  const receipt = JSON.parse(readFileSync(receiptFile, "utf-8")) as { inputs?: string; rows_sha256?: string };
  if (!receipt.inputs || !receipt.rows_sha256) throw new Error(`${receiptFile} does not name its inputs and rows`);
  const rows = fileSha256(rowsFile);
  if (rows !== receipt.rows_sha256) throw new Error(`${rowsFile} changed since its export receipt was written`);
  return { inputs: receipt.inputs, rows };
}

// The host the request states, or null when the URL has none a DNS name can express (an IP, a malformed URL).
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return HOST.test(host) ? host : null;
  } catch {
    return null; // not a URL: the page is kept with no host rather than a wrong one
  }
}

// `--concurrency <n>` from an importer's command line: pages rendered at once, 1 to 16, 4 by default.
export function concurrencyArg(argv: string[] = process.argv): number {
  const at = argv.indexOf("--concurrency");
  if (at < 0) return 4;
  const n = Number(argv[at + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--concurrency takes a whole number from 1 to 16");
  return n;
}

export function writeImport(path: string, result: ImportResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const written = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(temporary, written);
  renameSync(temporary, path);
  // Read back whole (completion review G11): the record the sources check and the freeze trust is what is on the disk.
  if (readFileSync(path, "utf-8") !== written) throw new Error(`${path} did not read back as written`);
}

export async function importSource(options: {
  source: string;
  licence: string;
  items: SourceItem[];
  store: ReturnType<typeof openStore>;
  importJson?: string;
  concurrency?: number;
  // The per-item load deadline (ITEM_DEADLINE_MS), shorter in tests.
  itemMs?: number;
  log?: (line: string) => void;
  // Public datasets by default; the pilot client's redacted samples say so (§7).
  origin?: "public" | "samples";
  // False: the record stays `running` when the run ends, and the caller publishes the result itself once its own
  // steps after the import have succeeded (the samples reconcile labels and write their inventory first, §7).
  publish?: boolean;
  redacted?: boolean;
  southAfrica?: boolean;
  // The converter's binding for the rows imported (`exportBinding`), recorded in IMPORT.json.
  binding?: { inputs: string; rows: string };
}): Promise<ImportResult> {
  const { source, store, items } = options;
  const importJson = options.importJson ?? join(store.dir, "raw", source, "IMPORT.json");
  // Tolerant: a page whose record does not read is damaged, and this run repairs it rather than failing on it.
  const manifest = store.manifest({ tolerant: true });
  const before = new Set(manifest.map((page) => page.id));
  // An item is skipped only when its stored page is intact: a damaged one is rendered again and `putPage` replaces it.
  const damaged = new Set(store.verify(source).damaged);
  const intactByItem = new Map(
    manifest.flatMap((page) =>
      page.source === source && page.item && !damaged.has(page.id) ? [[page.item, page] as const] : [],
    ),
  );
  const concurrency = options.concurrency ?? 4;
  const started = new Date();
  // The record says `running` before any page is touched; a store that cannot take even that is not imported into.
  writeImport(importJson, {
    status: "running",
    expected: items.length,
    imported: 0,
    duplicates: 0,
    excluded: [],
    filtered: [],
    stored: 0,
    skipped: 0,
    started: started.toISOString(),
    concurrency,
  });
  let skipped = 0;
  let relabelled = 0;
  let imported = 0;
  let duplicates = 0;
  let stopped: string | undefined;
  const excluded: ImportResult["excluded"] = [];
  const filtered: ImportResult["filtered"] = [];
  let next = 0;
  async function worker() {
    while (!stopped && next < items.length) {
      const item = items[next++] as SourceItem;
      const stored = intactByItem.get(item.id);
      if (stored) {
        // Already stored and whole: not rendered again. When the converter now maps its labels or licence differently,
        // the stored record takes the new mapping (the DOM's form flags stay as they were read).
        const labels = { ...stored.labels, ...item.labels };
        const label_source = { ...stored.label_source, ...item.label_source };
        // A field the mapping set and now no longer gives (a brand withdrawn, a category that settles no type) is
        // withdrawn with it; what the DOM, the rules or the teacher set stays (§18 final review).
        for (const field of ["brand", "lure_type"] as const)
          if (item.labels[field] === undefined && stored.label_source[field] === "ground-truth") {
            delete labels[field];
            delete label_source[field];
          }
        // A false flag read off an inert copy beside the dataset's live capture is untrusted, found as on a first import.
        if (item.inertFlags)
          for (const field of ["has_login_form", "has_payment_form"] as const)
            if (labels[field] === false && label_source[field] === "dom") label_source[field] = "unverified";
        const changed =
          stored.licence !== options.licence ||
          JSON.stringify(labels) !== JSON.stringify(stored.labels) ||
          JSON.stringify(label_source) !== JSON.stringify(stored.label_source);
        if (changed) {
          store.setLabels(stored.id, labels, label_source, options.licence);
          relabelled++;
        }
        skipped++;
        continue;
      }
      let page: Awaited<ReturnType<SourceItem["load"]>>;
      try {
        page = await withDeadline(item.load(), options.itemMs ?? ITEM_DEADLINE_MS);
      } catch (error) {
        excluded.push({ item: item.id, reason: (error as Error).message.split("\n")[0] ?? "load failed" });
        continue;
      }
      // A page that renders to almost no text (a script-only shell, a blank frame) teaches nothing: it is filtered out,
      // and counted apart from failures, because it is what the dataset holds rather than an import that went wrong.
      if (page.text.trim().length < MIN_TEXT_CHARACTERS) {
        filtered.push({ item: item.id, reason: `renders under ${MIN_TEXT_CHARACTERS} characters of text` });
        continue;
      }
      const labels: Labels = { ...item.labels };
      const label_source = { ...item.label_source };
      // A flag read off an inert copy beside a live screenshot is trusted only when it found the form.
      const flagSource = (found: boolean) => (item.inertFlags && !found ? "unverified" : "dom");
      if (page.has_login_form !== undefined) {
        labels.has_login_form = page.has_login_form;
        label_source.has_login_form = flagSource(page.has_login_form);
      }
      if (page.has_payment_form !== undefined) {
        labels.has_payment_form = page.has_payment_form;
        label_source.has_payment_form = flagSource(page.has_payment_form);
      }
      const host = hostOf(item.url);
      try {
        const id = await store.putPage(source, {
          screenshot: page.screenshot,
          text: page.text,
          origin: options.origin ?? "public",
          licence: options.licence,
          host,
          template: null,
          south_africa: options.southAfrica || (host?.endsWith(".za") ?? false),
          labels,
          label_source,
          redacted: options.redacted ?? false,
          item: item.id,
        });
        if (before.has(id)) duplicates++;
        else {
          before.add(id);
          imported++;
        }
      } catch (error) {
        const reason = (error as Error).message.split("\n")[0] ?? "store failed";
        // A write that fails on the store's side (a full disk, a permission) stops the run; a bad item is excluded.
        if ((error as NodeJS.ErrnoException).code) stopped = reason;
        else excluded.push({ item: item.id, reason });
      }
      const handled = imported + duplicates + skipped + excluded.length + filtered.length;
      if (handled % 250 === 0) options.log?.(`${source}: ${handled} of ${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const tooMany = excluded.length > items.length * MAX_EXCLUDED_SHARE;
  // A damaged page this run could not repair (its render failed, or nothing in the source names it) keeps the import
  // incomplete: the store must hold only pages that read whole before a source is used.
  const stillDamaged = stopped ? 0 : store.verify(source).damaged.length;
  // A page of this source whose item the dataset no longer lists (an earlier revision, a dropped row) must not be
  // certified as part of it: it keeps the import incomplete until it is removed. Pages from before item ids are counted.
  const listed = new Set(items.map((item) => item.id));
  const sourcePages = store.manifest({ tolerant: true }).filter((page) => page.source === source);
  const stored = sourcePages.length;
  const stale = stopped ? 0 : sourcePages.filter((page) => page.item && !listed.has(page.item)).length;
  const legacy = sourcePages.filter((page) => !page.item).length;
  const result: ImportResult = {
    ...(options.binding ?? {}),
    status: stopped || tooMany || stillDamaged || stale ? "incomplete" : "complete",
    expected: items.length,
    imported,
    duplicates,
    excluded,
    filtered,
    stored,
    skipped,
    relabelled,
    legacy,
    ...(stopped
      ? { reason: stopped }
      : stillDamaged
        ? { reason: `${stillDamaged} damaged pages remain in the store` }
        : stale
          ? { reason: `${stale} stored pages are not in the dataset any more; remove them` }
          : tooMany
            ? { reason: `${excluded.length} of ${items.length} items excluded (over 5 percent)` }
            : {}),
    started: started.toISOString(),
    finished: new Date().toISOString(),
    seconds: Math.round((Date.now() - started.getTime()) / 1000),
    pages_per_minute: Math.round(((imported + duplicates) * 60_000) / Math.max(1, Date.now() - started.getTime())),
    concurrency,
  };
  writeImport(importJson, options.publish === false ? { ...result, status: "running" } : result);
  return result;
}
