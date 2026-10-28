// The shared import run for a public dataset (D03 T04 §5): each item becomes a store page, four at a time by default
// (`--concurrency`), and the
// run's account goes to `<store>/raw/<source>/IMPORT.json` (temp-then-rename): items expected, imported (new pages),
// duplicates (pages already stored, so a rerun stores nothing twice), excluded (each with its item and reason: an item
// that failed to load or store), filtered (each with its item and reason: a page that loaded but renders almost no
// text, which no rerun changes) and stored (the source's pages in the store afterwards). More than 5 percent excluded,
// or a stop on a write failure,
// reads `incomplete`; the source is not used until a rerun completes it.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOST } from "../../src/vision/page-screen.ts";
import type { Labels, openStore, PageInput } from "./store.ts";

export const MAX_EXCLUDED_SHARE = 0.05;
export const MIN_TEXT_CHARACTERS = 20;

export type SourceItem = {
  id: string; // the item's name inside the dataset, for exclusions
  load: () => Promise<{ screenshot: Uint8Array; text: string; has_login_form?: boolean; has_payment_form?: boolean }>;
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
  // Items a page in the store already came from: not rendered again (a resumed run).
  skipped: number;
  reason?: string;
  started: string;
  finished?: string;
  seconds?: number;
  pages_per_minute?: number;
  concurrency: number;
};

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
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, path);
}

export async function importSource(options: {
  source: string;
  licence: string;
  items: SourceItem[];
  store: ReturnType<typeof openStore>;
  importJson?: string;
  concurrency?: number;
  log?: (line: string) => void;
  // Public datasets by default; the pilot client's redacted samples say so (§7).
  origin?: "public" | "samples";
  redacted?: boolean;
  southAfrica?: boolean;
}): Promise<ImportResult> {
  const { source, store, items } = options;
  const importJson = options.importJson ?? join(store.dir, "raw", source, "IMPORT.json");
  // Tolerant: a page whose record does not read is damaged, and this run repairs it rather than failing on it.
  const manifest = store.manifest({ tolerant: true });
  const before = new Set(manifest.map((page) => page.id));
  // An item is skipped only when its stored page is intact: a damaged one is rendered again and `putPage` replaces it.
  const damaged = new Set(store.verify(source).damaged);
  const done = new Set(
    manifest.flatMap((page) => (page.source === source && page.item && !damaged.has(page.id) ? [page.item] : [])),
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
  let imported = 0;
  let duplicates = 0;
  let stopped: string | undefined;
  const excluded: ImportResult["excluded"] = [];
  const filtered: ImportResult["filtered"] = [];
  let next = 0;
  async function worker() {
    while (!stopped && next < items.length) {
      const item = items[next++] as SourceItem;
      if (done.has(item.id)) {
        skipped++;
        continue;
      }
      let page: Awaited<ReturnType<SourceItem["load"]>>;
      try {
        page = await item.load();
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
      if (page.has_login_form !== undefined) {
        labels.has_login_form = page.has_login_form;
        label_source.has_login_form = "dom";
      }
      if (page.has_payment_form !== undefined) {
        labels.has_payment_form = page.has_payment_form;
        label_source.has_payment_form = "dom";
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
  // Tolerant: another source's unreadable record must not stop this one's accounting (verify() reports it).
  const stored = store.manifest({ tolerant: true }).filter((page) => page.source === source).length;
  const tooMany = excluded.length > items.length * MAX_EXCLUDED_SHARE;
  // A damaged page this run could not repair (its render failed, or nothing in the source names it) keeps the import
  // incomplete: the store must hold only pages that read whole before a source is used.
  const stillDamaged = stopped ? 0 : store.verify(source).damaged.length;
  const result: ImportResult = {
    status: stopped || tooMany || stillDamaged ? "incomplete" : "complete",
    expected: items.length,
    imported,
    duplicates,
    excluded,
    filtered,
    stored,
    skipped,
    ...(stopped
      ? { reason: stopped }
      : stillDamaged
        ? { reason: `${stillDamaged} damaged pages remain in the store` }
        : tooMany
          ? { reason: `${excluded.length} of ${items.length} items excluded (over 5 percent)` }
          : {}),
    started: started.toISOString(),
    finished: new Date().toISOString(),
    seconds: Math.round((Date.now() - started.getTime()) / 1000),
    pages_per_minute: Math.round(((imported + duplicates) * 60_000) / Math.max(1, Date.now() - started.getTime())),
    concurrency,
  };
  writeImport(importJson, result);
  return result;
}
