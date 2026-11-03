// The shared import run for a public dataset (D03 T04 §5): each item becomes a store page, four at a time by default
// (`--concurrency`), and the
// run's account goes to `<store>/raw/<source>/IMPORT.json` (temp-then-rename): items expected, imported (new pages),
// duplicates (pages already stored, so a rerun stores nothing twice), excluded (each with its item and reason: an item
// that failed to load or store), filtered (each with its item and reason: a page that loaded but renders almost no
// text, which no rerun changes) and stored (the source's pages in the store afterwards). More than 15 percent excluded,
// or a stop on a write failure,
// reads `incomplete`; the source is not used until a rerun completes it. The bar is 15 percent for Loupe 1.1
// (coordinator decision, 2026-11-02): the section 19 redaction tightened after the 1.0 store was built, and its
// survivor refusals exclude about 12 percent of the sample items, every one of which stays excluded from every
// dataset. Reversal cost: this one constant back to 0.05 and one re-import.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { HOST } from "../../src/vision/page-screen.ts";
import { captureProblem } from "./label-rules.ts";
import type { Labels, openStore, PageInput, StoredPage } from "./store.ts";

export const MAX_EXCLUDED_SHARE = 0.15;
export const MIN_TEXT_CHARACTERS = 20;
// An item gets this long to load, whatever its loader does: a load that never settles becomes the item's exclusion,
// so no worker waits forever (the reader's own page deadline is 30 seconds; this is the backstop around it).
export const ITEM_DEADLINE_MS = 120_000;

export function defaultFreeBytes(dir: string): number {
  const st = statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

function existingMetaBytes(dir: string, pageId: string): number {
  const metaPath = join(dir, "pages", pageId, "meta.json");
  try {
    return existsSync(metaPath) ? statSync(metaPath).size : 0;
  } catch {
    return 0;
  }
}

export function checkFreeSpace(
  dir: string,
  minFreeBytes: number,
  freeBytes: (dir: string) => number = defaultFreeBytes,
  neededBytes = 1,
): number {
  if (!minFreeBytes || minFreeBytes <= 0) return 0;
  const pending = Math.max(1, Math.ceil(neededBytes));
  const free = freeBytes(dir);
  if (free - pending < minFreeBytes) {
    const err = new Error(
      `only ${free} bytes free under ${dir}; writing ${pending} bytes would breach the ${minFreeBytes} byte reserve (${minFreeBytes} bytes must stay free)`,
    ) as NodeJS.ErrnoException;
    err.code = "ENOSPC";
    throw err;
  }
  return free;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the item did not load within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export type SourceItem = {
  id: string; // the item's name inside the dataset, for exclusions
  load: () => Promise<{
    screenshot: Uint8Array;
    text: string;
    has_login_form?: boolean | undefined;
    has_payment_form?: boolean | undefined;
    evidence?: PageInput["evidence"];
  }>;
  // The screenshot is the dataset's live capture while the text and form flags come from an inert copy of its HTML
  // (7 Days Later, §18): a form a script builds shows in the picture and not in the copy, so a false flag is untrusted.
  inertFlags?: boolean;
  url: string | null;
  labels: Labels;
  label_source: PageInput["label_source"];
  // The item's input digest (its row's SHA-256): a stored page rendered from another input is rendered again (§28 G4).
  input?: string;
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
  // Pages a bound import settled for items no longer in its export: removed, or narrowed to the items still listed.
  replaced?: number;
  // Items rendered again because their input changed since their page was made (§28 G4).
  rerendered?: number;
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

// The import's half of the item ledger (§28 G3): beside the converter's `ITEMS.jsonl`, each item the import was given,
// once, with its outcome and the page it is on. Its header names the rows it read; written whole (temp then rename)
// after the pages, so a run killed between the two leaves the earlier ledger, which the next run's writes over.
export const IMPORT_ITEMS = "ITEMS.import.jsonl";
export type ImportOutcome = {
  item: string;
  input?: string | undefined;
  outcome: "imported" | "duplicate" | "stored" | "excluded" | "filtered";
  page?: string;
  reason?: string;
};
export function writeImportItems(
  path: string,
  binding: { inputs: string; rows: string; export?: string | undefined; import?: string | undefined },
  outcomes: ImportOutcome[],
  options: { write?: (path: string, data: string) => void } = {},
) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const header = {
    inputs: binding.inputs,
    rows: binding.rows,
    ...(binding.export ? { export: binding.export } : {}),
    ...(binding.import ? { import: binding.import } : {}),
  };
  const lines = [JSON.stringify(header), ...outcomes.map((o) => JSON.stringify(o))];
  const written = `${lines.join("\n")}\n`;
  try {
    (options.write ?? ((p, d) => writeFileSync(p, d)))(temporary, written);
    renameSync(temporary, path);
  } catch (error) {
    try {
      if (existsSync(temporary)) writeFileSync(temporary, "");
    } catch {
      // ignore cleanup error
    }
    throw error;
  }
  if (readFileSync(path, "utf-8") !== written) throw new Error(`${path} did not read back as written`);
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
  binding?: { inputs: string; rows: string; export?: string };
  // Test hooks for interrupted or failing ledger writes (D03 T04 §28 plan review gap 5).
  afterImportWrite?: () => void;
  writeLedger?: (path: string, data: string) => void;
  // Minimum free bytes on the store filesystem during conversion and import (D03 T04 §44 plan review gap 2).
  minFreeBytes?: number;
  freeBytes?: (dir: string) => number;
  // Pre-publication coverage hook run while IMPORT.json is still `running` (D03 T04 §44 Round 1 finding 1).
  beforePublish?: (storedPages: StoredPage[]) => string | undefined;
}): Promise<ImportResult> {
  const { source, store, items } = options;
  const importJson = options.importJson ?? join(store.dir, "raw", source, "IMPORT.json");
  const publicationReserveBytes = items.length * 256 + 16_384;
  let initialFree: number | undefined;
  let committedBytes = 0;
  const effectiveFreeBytes = (dir: string): number => {
    const current = (options.freeBytes ?? defaultFreeBytes)(dir);
    if (initialFree === undefined) initialFree = current;
    return Math.min(current, initialFree - committedBytes);
  };
  if (options.minFreeBytes && options.minFreeBytes > 0) {
    checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, publicationReserveBytes);
  }
  // Tolerant: a page whose record does not read is damaged, and this run repairs it rather than failing on it.
  const manifest = store.manifest({ tolerant: true });
  const before = new Set(manifest.map((page) => page.id));
  // An item is skipped only when its stored page is intact: a damaged one is rendered again and `putPage` replaces it.
  const damaged = new Set(store.verify(source).damaged);
  // Every item a whole page stands for, its own and those it shares (§28), with the input it was rendered from.
  const intactByItem = new Map(
    manifest.flatMap((page) =>
      page.source === source && page.item && !damaged.has(page.id)
        ? (page.items?.map((entry) => entry.id) ?? [page.item]).map((id) => [id, page] as const)
        : [],
    ),
  );
  const inputOf = (page: (typeof manifest)[number], item: string) =>
    page.item === item ? page.input : page.items?.find((entry) => entry.id === item)?.input;
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
  let rerendered = 0;
  let inFlightBytes = 0;
  const outcomes = new Map<string, ImportOutcome>();
  const record = (outcome: ImportOutcome) => {
    const clean = { ...outcome };
    if (clean.input === undefined) delete clean.input;
    outcomes.set(clean.item, clean);
  };
  const itemDigest = (item: SourceItem): string | undefined => item.input;
  let imported = 0;
  let duplicates = 0;
  let stopped: string | undefined;
  const excluded: ImportResult["excluded"] = [];
  const filtered: ImportResult["filtered"] = [];
  let next = 0;
  async function worker() {
    while (!stopped && next < items.length) {
      if (options.minFreeBytes && options.minFreeBytes > 0) {
        try {
          checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, inFlightBytes + publicationReserveBytes);
        } catch (error) {
          stopped = (error as Error).message.split("\n")[0] ?? "low disk space";
          break;
        }
      }
      const item = items[next++] as SourceItem;
      let stored = intactByItem.get(item.id);
      // An item whose input changed since its page was rendered (§28 G4): it leaves that page (the page is removed when
      // no other item names it, narrowed when shared) and is rendered again; a render that fails then leaves it on no
      // page, never on its old content. A page from before inputs were kept has none, and is taken as unchanged.
      const was = stored ? inputOf(stored, item.id) : undefined;
      if (stored && item.input && was && was !== item.input) {
        const others = (stored.items?.map((entry) => entry.id) ?? [stored.item as string]).filter(
          (id) => id !== item.id,
        );
        if (others.length) {
          const keepBytes = existingMetaBytes(store.dir, stored.id) + 512;
          inFlightBytes += keepBytes;
          try {
            if (options.minFreeBytes && options.minFreeBytes > 0) {
              checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, inFlightBytes + publicationReserveBytes);
            }
            const updated = store.keepItems(stored.id, others);
            for (const otherId of others) intactByItem.set(otherId, updated);
          } catch (error) {
            stopped = (error as Error).message.split("\n")[0] ?? "store failed";
            break;
          } finally {
            inFlightBytes = Math.max(0, inFlightBytes - keepBytes);
          }
        } else {
          store.removePage(stored.id);
        }
        intactByItem.delete(item.id);
        rerendered++;
        stored = undefined;
      }
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
          const relabelBytes =
            existingMetaBytes(store.dir, stored.id) +
            Buffer.byteLength(JSON.stringify({ labels, label_source, licence: options.licence }, null, 2), "utf-8") +
            512;
          inFlightBytes += relabelBytes;
          try {
            if (options.minFreeBytes && options.minFreeBytes > 0) {
              checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, inFlightBytes + publicationReserveBytes);
            }
            store.setLabels(stored.id, labels, label_source, options.licence);
            relabelled++;
          } catch (error) {
            stopped = (error as Error).message.split("\n")[0] ?? "store failed";
            break;
          } finally {
            inFlightBytes = Math.max(0, inFlightBytes - relabelBytes);
          }
        }
        skipped++;
        record({ item: item.id, input: itemDigest(item), outcome: "stored", page: stored.id });
        continue;
      }
      let page: Awaited<ReturnType<SourceItem["load"]>>;
      try {
        page = await withDeadline(item.load(), options.itemMs ?? ITEM_DEADLINE_MS);
      } catch (error) {
        const reason = (error as Error).message.split("\n")[0] ?? "load failed";
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
          stopped = reason;
          break;
        }
        excluded.push({ item: item.id, reason });
        record({
          item: item.id,
          input: itemDigest(item),
          outcome: "excluded",
          reason: excluded.at(-1)?.reason as string,
        });
        continue;
      }
      // Why a capture cannot carry its publisher's label (§28 G6 and plan review gap 6): an empty page with no text or
      // form, a parked or error page, or a textual or structural wall is filtered out with its reason; a sparse lure
      // with a logo and form fields is admitted. Redacted client samples still filter script-only shells under 20 chars.
      const problem =
        options.origin === "samples" && page.text.trim().length < MIN_TEXT_CHARACTERS
          ? `renders under ${MIN_TEXT_CHARACTERS} characters of text`
          : captureProblem(page.text, page.evidence, page);
      if (problem) {
        filtered.push({ item: item.id, reason: problem });
        record({ item: item.id, input: itemDigest(item), outcome: "filtered", reason: problem });
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
      const digest = itemDigest(item);
      const pageInput: PageInput = {
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
        ...(digest ? { input: digest } : {}),
        ...(page.evidence ? { evidence: page.evidence } : {}),
      };
      const { screenshot: _screenshot, text: _text, ...metaFields } = pageInput;
      const serializedMetaBytes = Buffer.byteLength(
        `${JSON.stringify(
          {
            ...metaFields,
            source,
            sha256: { screenshot: "0".repeat(64), text: "0".repeat(64) },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const contentDigest = createHash("sha256").update(page.screenshot).update("\0").update(page.text).digest("hex");
      const candidateId = `${source}-${contentDigest.slice(0, 16)}`;
      const duplicateItemBytes = Buffer.byteLength(
        JSON.stringify({ id: item.id, input: digest, lure: labels.lure, lure_type: labels.lure_type }, null, 2),
        "utf-8",
      );
      const duplicateMetaBytes = before.has(candidateId)
        ? existingMetaBytes(store.dir, candidateId) + duplicateItemBytes + 256
        : 0;
      const newPageBytes = page.screenshot.byteLength + Buffer.byteLength(page.text, "utf-8") + serializedMetaBytes;
      const pageBytes = Math.max(duplicateMetaBytes, newPageBytes) + 256;
      inFlightBytes += pageBytes;
      try {
        if (options.minFreeBytes && options.minFreeBytes > 0) {
          checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, inFlightBytes + publicationReserveBytes);
        }
        const id = await store.putPage(source, pageInput);
        if (before.has(id)) {
          duplicates++;
          // Another item with this content: kept on the page with its own lure label, never dropped (§28, G3).
          store.addItem(id, { id: item.id, input: digest, lure: labels.lure, lure_type: labels.lure_type });
          committedBytes += duplicateItemBytes;
          record({ item: item.id, input: digest, outcome: "duplicate", page: id });
        } else {
          before.add(id);
          imported++;
          committedBytes += newPageBytes;
          record({ item: item.id, input: digest, outcome: "imported", page: id });
        }
      } catch (error) {
        const reason = (error as Error).message.split("\n")[0] ?? "store failed";
        // A write that fails on the store's side (a full disk, a permission) stops the run; a bad item is excluded.
        if ((error as NodeJS.ErrnoException).code) stopped = reason;
        else {
          excluded.push({ item: item.id, reason });
          record({ item: item.id, input: digest, outcome: "excluded", reason });
        }
      } finally {
        inFlightBytes = Math.max(0, inFlightBytes - pageBytes);
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
  // A bound import (§28 G4) holds the converter's whole export: an item ids its row by content (its SHA-256), so an item
  // whose input changed arrives under a new id and is rendered as new, and the page it left is settled here. A page none
  // of whose items the export lists is removed; a page shared with listed items keeps only those. An item whose new
  // render failed or was excluded is then on no page, never on its old content. An unbound import only reports them.
  let replaced = 0;
  if (options.binding && !stopped)
    for (const page of store.manifest({ tolerant: true, source }).filter((p) => p.source === source && p.item)) {
      const ids = page.items?.map((entry) => entry.id) ?? [page.item as string];
      const live = ids.filter((id) => listed.has(id));
      if (live.length === ids.length) continue;
      if (live.length) {
        if (options.minFreeBytes && options.minFreeBytes > 0) {
          try {
            checkFreeSpace(
              store.dir,
              options.minFreeBytes,
              effectiveFreeBytes,
              existingMetaBytes(store.dir, page.id) + publicationReserveBytes + 512,
            );
          } catch (error) {
            stopped = (error as Error).message.split("\n")[0] ?? "low disk space";
            break;
          }
        }
        store.keepItems(page.id, live);
      } else store.removePage(page.id);
      replaced++;
    }
  const sourcePages = store.manifest({ tolerant: true, source }).filter((page) => page.source === source);
  const stored = sourcePages.length;
  const stale = stopped ? 0 : sourcePages.filter((page) => page.item && !listed.has(page.item)).length;
  const legacy = sourcePages.filter((page) => !page.item).length;
  let coverageFailure: string | undefined;
  if (!stopped && !tooMany && !stillDamaged && !stale && options.beforePublish) {
    try {
      coverageFailure = options.beforePublish(sourcePages);
    } catch (error) {
      coverageFailure = (error as Error).message.split("\n")[0] ?? "coverage check failed";
    }
  }
  const result: ImportResult = {
    ...(options.binding ? { inputs: options.binding.inputs, rows: options.binding.rows } : {}),
    status: stopped || tooMany || stillDamaged || stale || coverageFailure ? "incomplete" : "complete",
    expected: items.length,
    imported,
    duplicates,
    excluded,
    filtered,
    stored,
    skipped,
    relabelled,
    rerendered,
    replaced,
    legacy,
    ...(stopped
      ? { reason: stopped }
      : stillDamaged
        ? { reason: `${stillDamaged} damaged pages remain in the store` }
        : stale
          ? { reason: `${stale} stored pages are not in the dataset any more; remove them` }
          : tooMany
            ? { reason: `${excluded.length} of ${items.length} items excluded (over 15 percent)` }
            : coverageFailure
              ? { reason: coverageFailure }
              : {}),
    started: started.toISOString(),
    finished: new Date().toISOString(),
    seconds: Math.round((Date.now() - started.getTime()) / 1000),
    pages_per_minute: Math.round(((imported + duplicates) * 60_000) / Math.max(1, Date.now() - started.getTime())),
    concurrency,
  };
  const plannedImport = options.publish === false ? { ...result, status: "running" as const } : result;
  try {
    options.afterImportWrite?.();
    // The import ledger is bound to the inputs, export and import digests it belongs to, written temp-then-replace and
    // read back before IMPORT.json publishes `complete` (§28 plan review gap 5 and completion review G9). A failure or
    // stop here marks IMPORT.json incomplete, and a hard kill before writeImport leaves IMPORT.json as `running`.
    const importText = `${JSON.stringify(plannedImport, null, 2)}\n`;
    if ((options.binding || options.writeLedger) && !stopped) {
      const binding = options.binding ?? { inputs: "", rows: "" };
      const where = new Map<string, string>();
      for (const page of sourcePages)
        for (const id of page.items?.map((entry) => entry.id) ?? (page.item ? [page.item] : [])) where.set(id, page.id);
      const settled = items.map((item): ImportOutcome => {
        const digest = itemDigest(item);
        const had = outcomes.get(item.id) ?? { item: item.id, outcome: "excluded", reason: "not reached" };
        if (had.page && !where.has(item.id))
          return {
            item: item.id,
            ...(digest ? { input: digest } : {}),
            outcome: "excluded",
            reason: "its page was settled away",
          };
        return had.page
          ? { ...had, ...(digest ? { input: digest } : {}), page: where.get(item.id) as string }
          : { ...had, ...(digest ? { input: digest } : {}) };
      });
      const exportFile = join(dirname(importJson), "EXPORT.json");
      const exportDigest = binding.export ?? (existsSync(exportFile) ? fileSha256(exportFile) : undefined);
      const importDigest = createHash("sha256").update(importText, "utf-8").digest("hex");
      const itemsOnlyBytes = settled.reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf-8") + 1,
        256,
      );
      const ledgerBytes = Buffer.byteLength(importText, "utf-8") + itemsOnlyBytes;
      if (options.minFreeBytes && options.minFreeBytes > 0) {
        checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, ledgerBytes);
      }
      writeImportItems(
        join(dirname(importJson), IMPORT_ITEMS),
        { ...binding, export: exportDigest, import: importDigest },
        settled,
        options.writeLedger ? { write: options.writeLedger } : {},
      );
      committedBytes += itemsOnlyBytes;
    }
    if (options.minFreeBytes && options.minFreeBytes > 0) {
      checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, Buffer.byteLength(importText, "utf-8"));
    }
    writeImport(importJson, plannedImport);
  } catch (error) {
    result.status = "incomplete";
    if (!result.reason) result.reason = (error as Error).message;
    try {
      if (options.minFreeBytes && options.minFreeBytes > 0) {
        const failureBytes = Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, "utf-8");
        checkFreeSpace(store.dir, options.minFreeBytes, effectiveFreeBytes, failureBytes);
      }
      writeImport(importJson, result);
    } catch {
      // Insufficient free space to publish the failure receipt: preserve the already-published `running` receipt.
    }
  }
  return result;
}
