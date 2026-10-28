// The shared import run for a public dataset (D03 T04 §5): each item becomes a store page, four at a time, and the
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
  status: "complete" | "incomplete";
  expected: number;
  imported: number;
  duplicates: number;
  excluded: { item: string; reason: string }[];
  filtered: { item: string; reason: string }[];
  stored: number;
  reason?: string;
  finished: string;
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
  const before = new Set(store.manifest().map((page) => page.id));
  let imported = 0;
  let duplicates = 0;
  let stopped: string | undefined;
  const excluded: ImportResult["excluded"] = [];
  const filtered: ImportResult["filtered"] = [];
  let next = 0;
  async function worker() {
    while (!stopped && next < items.length) {
      const item = items[next++] as SourceItem;
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
      const handled = imported + duplicates + excluded.length + filtered.length;
      if (handled % 250 === 0) options.log?.(`${source}: ${handled} of ${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
  const stored = store.manifest().filter((page) => page.source === source).length;
  const tooMany = excluded.length > items.length * MAX_EXCLUDED_SHARE;
  const result: ImportResult = {
    status: stopped || tooMany ? "incomplete" : "complete",
    expected: items.length,
    imported,
    duplicates,
    excluded,
    filtered,
    stored,
    ...(stopped
      ? { reason: stopped }
      : tooMany
        ? { reason: `${excluded.length} of ${items.length} items excluded (over 5 percent)` }
        : {}),
    finished: new Date().toISOString(),
  };
  writeImport(importJson, result);
  return result;
}
