// The pilot client's sample mail as Loupe training pages (D03 T04 §7).
//
//   node scripts/glimmer/import-samples.ts inventory    # counts only: no names, subjects, addresses or file names
//   node scripts/glimmer/import-samples.ts import       # redact, render inertly and store every attachment and body
//   node scripts/glimmer/import-samples.ts leak-check   # scan every stored sample page and record for client details
//
// Reads `samples/` (git-ignored; linked into this worktree from the main checkout). Runs only while
// `samples/pilot-consent.md` holds the "Extension: Fireworks training (2026-10-28 15:16 SAST)" section and
// `samples/client-names.txt` exists. Each HTML attachment, HTML body and plain-text body is redacted (`redact.ts`), its
// images replaced by blank boxes, then rendered inertly and checked: a page whose rendered text still holds a client
// name, address, domain, phone or long number is refused, never stored. Pages are stored with `origin: samples`,
// `redacted: true`, under opaque item ids (`m-<hash of the path>`), so no record names a client folder or file.
//
// Labels: an operator-labelled message (`manifest.csv`, `attack` or `genuine`) is ground truth; a quarantined message's
// Microsoft verdict in its file name is a lure, ground truth when `HighConfPhish` and `unverified` when `Phish`
// (trained on, never evaluated). `Spam`, `Bulk`, another verdict and no label are counted exclusions: neither a lure
// nor a benign page by any ground truth. Identical pages from several messages take the strongest label they agree on;
// pages whose messages disagree keep no `lure` label.
//
// Every message is accounted for in `raw/samples/INVENTORY.json`: each part a page item, an unsupported part, or a
// failure (unreadable, over 25 MB, unparsable). A change to the redaction (this file, `redact.ts`, the client names or
// the manifest) removes every earlier sample page before the import, and the run records its key in
// `raw/samples/REDACTION.json` only once both imports are complete, so an interrupted rebuild never stands as redacted.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import PostalMime, { type Email } from "postal-mime";
import { type ImportResult, importSource, type SourceItem } from "./import-source.ts";
import { EMAIL, hasImages, LONG_NUMBER, namePieces, PHONE, redact, stripImages } from "./redact.ts";
import { decodeHtml, openTextReader } from "./source-pages.ts";
import { openStore, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const CONSENT_HEADING = "Extension: Fireworks training (2026-10-28 15:16 SAST)";
export const LICENCE = "pilot client consent, 2026-10-28";
export const SOURCES = { attachment: "samples-attachment", body: "samples-body" } as const;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const PARSE_DEADLINE_MS = 30_000;

export function assertConsent(samples: string): void {
  const file = join(samples, "pilot-consent.md");
  if (!existsSync(file) || !readFileSync(file, "utf-8").includes(CONSENT_HEADING))
    throw new Error(`refused: pilot-consent.md has no "${CONSENT_HEADING}" section; no sample is read without it`);
}

// The client's names, required: without them a client's name in a lure body would pass every check.
export function readClientNames(samples: string): string[] {
  const file = join(samples, "client-names.txt");
  if (!existsSync(file))
    throw new Error("refused: samples/client-names.txt is missing; no sample is redacted without it");
  const names = readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!names.length) throw new Error("refused: samples/client-names.txt names no one");
  return names;
}

// A message's name in every record: a hash of its path, so no record names the client's folder or a file.
export function opaqueId(file: string): string {
  return `m-${createHash("sha256").update(file).digest("hex").slice(0, 16)}`;
}

// A label a page may carry, ranked so identical pages take the strongest; or why the message is not a training page.
export type Label = { lure: boolean; source: "ground-truth" | "unverified"; rank: number } | { excluded: string };

// A message's label: the manifest's (listed by its path under samples/, like `gmail/x.eml`), else the Microsoft
// verdict in a quarantine file name.
export function labelOf(file: string, manifest: Map<string, string>): Label {
  const listed = manifest.get(file);
  if (listed === "attack") return { lure: true, source: "ground-truth", rank: 2 };
  if (listed === "genuine") return { lure: false, source: "ground-truth", rank: 2 };
  const verdict = /_([A-Za-z]+)\.eml$/.exec(file)?.[1];
  // Microsoft's high-confidence phishing verdict counts as ground truth (operator, 2026-10-28 21:41 SAST), which gives
  // the evaluation its South African lures; a plain `Phish` verdict stays unverified: trained on, never evaluated.
  if (verdict === "HighConfPhish") return { lure: true, source: "ground-truth", rank: 2 };
  if (verdict === "Phish") return { lure: true, source: "unverified", rank: 1 };
  if (verdict === "Spam" || verdict === "Bulk") return { excluded: `a ${verdict} verdict: neither a lure nor benign` };
  if (verdict) return { excluded: "an unknown verdict" };
  return { excluded: "no label" };
}

// `manifest.csv`, checked: a `file` and a `label` column, every label `attack` or `genuine`, every file a message.
export function readManifest(samples: string, files: string[]): Map<string, string> {
  const file = join(samples, "manifest.csv");
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  const [header, ...rows] = readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  const columns = (header ?? "").split(",").map((c) => c.trim());
  const at = (name: string) => columns.indexOf(name);
  if (at("file") < 0 || at("label") < 0) throw new Error("refused: manifest.csv needs file and label columns");
  const known = new Set(files);
  rows.forEach((row, index) => {
    const cells = row.split(",").map((c) => c.trim());
    const [name, label] = [cells[at("file")] ?? "", cells[at("label")] ?? ""];
    if (label !== "attack" && label !== "genuine")
      throw new Error(`refused: manifest.csv row ${index + 2} has label "${label}", not attack or genuine`);
    if (!known.has(name)) throw new Error(`refused: manifest.csv row ${index + 2} names no message under samples/`);
    out.set(name, label);
  });
  return out;
}

// Every message in every folder under samples/ (a client set's folder is named after the client, so the code names
// none of them), as its path under samples/.
export function messageFiles(samples: string): string[] {
  return readdirSync(samples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((folder) => !folder.startsWith(".") && statSync(join(samples, folder)).isDirectory())
    .sort()
    .flatMap((folder) =>
      readdirSync(join(samples, folder))
        .filter((name) => name.endsWith(".eml"))
        .sort()
        .map((name) => `${folder}/${name}`),
    );
}

const HTML_NAME = /\.(s?html?)$/i;

const bytesOf = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);

// A message's parts: each HTML attachment (decoded by its own charset), its body (the HTML one, else the plain text
// laid out as a page), and every other part by its type, for the inventory. Inline images are not parts: the body's
// images are replaced by blank boxes before it is rendered.
export function messageParts(email: Email): {
  attachments: string[];
  body: string | null;
  unsupported: string[];
} {
  const attachments: string[] = [];
  const unsupported: string[] = [];
  for (const part of email.attachments) {
    const html = part.mimeType === "text/html" || HTML_NAME.test(part.filename ?? "");
    if (html && (part.disposition === "attachment" || HTML_NAME.test(part.filename ?? "")))
      attachments.push(decodeHtml(bytesOf(part.content)));
    else if (!(part.related || part.contentId) || !part.mimeType.startsWith("image/")) unsupported.push(part.mimeType);
  }
  const body = email.html
    ? email.html
    : email.text
      ? `<pre style="white-space:pre-wrap;font:16px sans-serif">${email.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`
      : null;
  return { attachments, body, unsupported };
}

type Person = { name?: string; address?: string };
function people(email: Email, raw: string): Person[] {
  const listed = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])].flatMap((a) =>
    "group" in a && a.group ? a.group : [a as Person],
  );
  const delivered: Person[] = [...raw.matchAll(/^(?:Delivered-To|X-Original-To):\s*<?(\S+@[^\s>]+)/gim)].map((m) => ({
    name: "",
    address: m[1] ?? "",
  }));
  return [...listed, ...delivered];
}

// The names to redact in one message: every recipient's name pieces and the client names file.
export function recipientNames(email: Email, raw: string, clientNames: string[]): string[] {
  return [...clientNames, ...people(email, raw).flatMap((p) => namePieces(p.name, p.address))];
}

export function addresses(email: Email, raw: string): string[] {
  return people(email, raw)
    .map((p) => p.address ?? "")
    .filter(Boolean)
    .map((a) => a.toLowerCase());
}

// The client's own domains: every recipient address's domain that is not a public mail provider.
export function clientDomains(recipientAddresses: string[]): string[] {
  const publicMail = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\./;
  return [...new Set(recipientAddresses.map((a) => a.split("@")[1] ?? ""))].filter((d) => d && !publicMail.test(d));
}

// What must never reach a stored sample page or record: client names, every recipient's name pieces and address, and
// the client's domains.
export function protectedTerms(clientNames: string[], recipientAddresses: string[], recipientPieces: string[] = []) {
  return [...clientNames, ...recipientPieces, ...recipientAddresses, ...clientDomains(recipientAddresses)];
}

// Which kind of personal detail a rendered text still shows, by pattern: an address, a phone or a long number that a
// tag split out of the redactor's reach and the render joined up again.
export function personalDetail(text: string): string | null {
  for (const [kind, rule] of [
    ["an address", EMAIL],
    ["a phone number", PHONE],
    ["a long number", LONG_NUMBER],
  ] as const) {
    rule.lastIndex = 0;
    if (new RegExp(rule.source).test(text)) return kind;
  }
  return null;
}

// A sample's HTML with its images replaced and its details redacted, then rendered, then checked: what the render
// shows must hold no client term and no address, phone or long number, or the page is refused. The reason names the
// kind of detail, never the detail.
export async function renderRedacted<T extends { text: string }>(
  render: (html: string) => Promise<T>,
  html: string,
  names: string[],
  terms: string[],
  domains: string[] = [],
): Promise<T> {
  const clean = redact(stripImages(html), names, domains);
  if (hasImages(clean)) throw new Error("refused: an image survived the image rule");
  const page = await render(clean);
  if (leaks([{ id: "page", text: page.text }], terms).length)
    throw new Error("refused: a client detail survived redaction");
  const kind = personalDetail(page.text);
  if (kind) throw new Error(`refused: ${kind} survived redaction`);
  return page;
}

// Every record whose text holds a client term: a name as a whole word, an address or domain anywhere.
export function leaks(pages: { id: string; text: string }[], terms: string[]): { id: string; term: string }[] {
  const wanted = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
  const rules = wanted.map((term) => ({
    term,
    rule: /[@.]/.test(term)
      ? null
      : new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu"),
  }));
  return pages.flatMap((page) => {
    const text = page.text.toLowerCase();
    return rules
      .filter(({ term, rule }) => (rule ? rule.test(page.text) : text.includes(term)))
      .map(({ term }) => ({ id: page.id, term }));
  });
}

// The redaction's identity: the rules and the lists they read. Pages made under another key are made again.
export function redactionKey(samples: string): string {
  const hash = createHash("sha256");
  for (const file of [
    join(import.meta.dirname, "redact.ts"),
    import.meta.filename,
    join(samples, "client-names.txt"),
    join(samples, "manifest.csv"),
  ])
    hash.update(existsSync(file) ? readFileSync(file) : "-").update("\0");
  return hash.digest("hex");
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(temporary, file);
}

type Parsed = { id: string; file: string; raw: string; email: Email };
type Outcome = { id: string; label: string; parts: string[] };
export type Inventory = {
  messages: number;
  failed: { id: string; reason: string }[];
  excluded: { id: string; reason: string }[];
  items: number;
  unsupported: number;
  outcomes: Outcome[];
};

// Each message read whole, bounded: a file over 25 MB, one that does not read, or one that does not parse within 30
// seconds is a failure recorded by its opaque id, never an abort.
async function readMessages(samples: string, files: string[], failed: Inventory["failed"]): Promise<Parsed[]> {
  const parsed: Parsed[] = [];
  for (const file of files) {
    const id = opaqueId(file);
    try {
      const path = join(samples, file);
      if (statSync(path).size > MAX_MESSAGE_BYTES) {
        failed.push({ id, reason: `over ${MAX_MESSAGE_BYTES / 1024 / 1024} MB` });
        continue;
      }
      const bytes = readFileSync(path);
      let timer: NodeJS.Timeout | undefined;
      const email = await Promise.race([
        PostalMime.parse(bytes),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("did not parse in time")), PARSE_DEADLINE_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      parsed.push({ id, file, raw: bytes.toString("latin1"), email });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      failed.push({ id, reason: code ? `unreadable (${code})` : "unparsable" });
    }
  }
  return parsed;
}

// The import, end to end: the consent and lists checked, every message read and accounted for, earlier pages made
// under another redaction removed, both kinds imported, identical pages' labels reconciled, the inventory written,
// and the redaction key recorded only when every message is accounted for and both imports are complete. Exit 0 when
// complete, 1 when not.
export async function runImport(options: {
  samples: string;
  store: ReturnType<typeof openStore>;
  render: (html: string) => Promise<{ screenshot: Uint8Array; text: string }>;
  log?: (line: string) => void;
}): Promise<{ code: 0 | 1; inventory: Inventory; results: Record<string, ImportResult> }> {
  const { samples, store } = options;
  const log = options.log ?? (() => undefined);
  assertConsent(samples);
  const clientNames = readClientNames(samples);
  const files = messageFiles(samples);
  const manifest = readManifest(samples, files);
  const inventory: Inventory = {
    messages: files.length,
    failed: [],
    excluded: [],
    items: 0,
    unsupported: 0,
    outcomes: [],
  };
  const parsed = await readMessages(samples, files, inventory.failed);

  const key = redactionKey(samples);
  const keyFile = join(store.dir, "raw", "samples", "REDACTION.json");
  const recorded = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf-8")) as { key?: string }).key : null;
  if (recorded !== key) {
    const removed = Object.values(SOURCES).reduce((sum, source) => sum + store.removeSource(source), 0);
    if (removed) log(`samples: the redaction changed; ${removed} earlier pages removed before the import`);
  }

  const { terms, domains, distinct, own } = termsOf(clientNames, parsed);
  const itemsBy: Record<
    keyof typeof SOURCES,
    (SourceItem & { rank: number; label: { lure: boolean; source: string } })[]
  > = { attachment: [], body: [] };
  // The page each loaded item became, to reconcile identical pages' labels after the import.
  const pageOf = new Map<string, string>();
  for (const { id, file, raw, email } of parsed) {
    const label = labelOf(file, manifest);
    const parts = messageParts(email);
    const outcome: Outcome = {
      id,
      label: "excluded" in label ? "excluded" : `${label.lure ? "lure" : "benign"}`,
      parts: [],
    };
    inventory.outcomes.push(outcome);
    inventory.unsupported += parts.unsupported.length;
    outcome.parts.push(...parts.unsupported.map((type) => `unsupported ${type}`));
    if ("excluded" in label) {
      inventory.excluded.push({ id, reason: label.excluded });
      continue;
    }
    if (!parts.body && !parts.attachments.length) outcome.parts.push("no body");
    // This message's own recipients in full, everyone's distinctive pieces too.
    const names = [...recipientNames(email, raw, clientNames), ...distinct];
    const pageTerms = [...terms, ...(own.get(id) ?? [])];
    const add = (kind: keyof typeof SOURCES, html: string, index: number) => {
      const itemId = `${id}#${kind}${index}`;
      outcome.parts.push(itemId);
      itemsBy[kind].push({
        id: itemId,
        url: null,
        rank: label.rank,
        label,
        labels: { lure: label.lure },
        label_source: { lure: label.source === "ground-truth" ? "ground-truth" : "unverified" },
        load: async () => {
          const page = await renderRedacted(options.render, html, names, pageTerms, domains);
          const digest = createHash("sha256").update(page.screenshot).update("\0").update(page.text).digest("hex");
          pageOf.set(itemId, `${SOURCES[kind]}-${digest.slice(0, 16)}`);
          return page;
        },
      });
    };
    for (const [index, html] of parts.attachments.entries()) add("attachment", html, index);
    if (parts.body) add("body", parts.body, 0);
  }

  const results: Record<string, ImportResult> = {};
  for (const kind of ["attachment", "body"] as const) {
    // Strongest label first, then by id: whichever message an identical page is first stored from, the order is fixed.
    const items = itemsBy[kind].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
    inventory.items += items.length;
    const result = await importSource({
      source: SOURCES[kind],
      licence: LICENCE,
      items,
      store,
      origin: "samples",
      redacted: true,
      southAfrica: true,
      concurrency: 1,
      log,
    });
    results[kind] = result;
    reconcile(store, SOURCES[kind], items, pageOf);
    log(
      `samples ${kind}: ${JSON.stringify({ ...result, excluded: result.excluded.length, filtered: result.filtered.length })}`,
    );
  }
  writeJson(join(store.dir, "raw", "samples", "INVENTORY.json"), inventory);
  const complete = inventory.failed.length === 0 && Object.values(results).every((r) => r.status === "complete");
  if (complete) writeJson(keyFile, { key, at: new Date().toISOString() });
  return { code: complete ? 0 : 1, inventory, results };
}

// Identical pages from several messages: the page keeps the strongest label its messages agree on (ground truth over
// unverified), and keeps no `lure` label when they disagree, whatever order they were stored in.
function reconcile(
  store: ReturnType<typeof openStore>,
  source: string,
  items: { id: string; label: { lure: boolean; source: string } }[],
  pageOf: Map<string, string>,
): void {
  const stored = new Map(
    store.manifest({ tolerant: true }).flatMap((p) => (p.source === source ? [[p.id, p] as const] : [])),
  );
  const storedFrom = new Map([...stored.values()].flatMap((p) => (p.item ? [[p.item, p.id] as const] : [])));
  // Each item's page: the one it rendered to in this run, or the one stored from it before (a resumed run skips it).
  const groups = new Map<string, { lure: boolean; source: string }[]>();
  for (const item of items) {
    const page = pageOf.get(item.id) ?? storedFrom.get(item.id);
    if (!page || !stored.has(page)) continue;
    groups.set(page, [...(groups.get(page) ?? []), item.label]);
  }
  for (const [id, labels] of groups) {
    const page = stored.get(id);
    if (!page || labels.length < 2) continue;
    const { lure: _lure, ...rest } = page.labels;
    const { lure: _source, ...restSource } = page.label_source;
    if (new Set(labels.map((l) => l.lure)).size > 1) {
      if (page.labels.lure !== undefined) store.setLabels(id, rest, restSource);
      continue;
    }
    const lure = labels[0]?.lure as boolean;
    const strongest = labels.some((l) => l.source === "ground-truth") ? "ground-truth" : "unverified";
    if (page.labels.lure !== lure || page.label_source.lure !== strongest)
      store.setLabels(id, { ...rest, lure }, { ...restSource, lure: strongest });
  }
}

// The terms nothing from the samples may hold, derived as the import derives them: client names, every recipient's
// name pieces and address, and the client's domains.
function termsOf(
  clientNames: string[],
  parsed: Parsed[],
): { terms: string[]; domains: string[]; distinct: string[]; own: Map<string, string[]> } {
  const everyAddress = parsed.flatMap(({ email, raw }) => addresses(email, raw));
  // A recipient's name pieces of four letters or more are guarded on every page; shorter ones (`Jo`, `Sam`) only on
  // their own message's pages, where they name the reader. Guarded everywhere, a short name that is also a common word
  // refused nearly every page (measured 2026-10-29: one such piece in 125 of 199 bodies).
  const own = new Map(
    parsed.map(({ id, email, raw }) => [id, people(email, raw).flatMap((p) => namePieces(p.name, p.address))]),
  );
  const distinct = [...new Set([...own.values()].flat().filter((piece) => piece.length >= 4))];
  return {
    terms: protectedTerms(clientNames, everyAddress, distinct),
    domains: clientDomains(everyAddress),
    distinct,
    own,
  };
}

// Every stored sample page's text and record, and every record the import wrote, scanned for client terms and for
// paths under samples/; and the inventory checked to account for every message. Exit 0 when clean and whole.
export async function leakCheck(options: { samples: string; store: ReturnType<typeof openStore> }): Promise<{
  code: 0 | 1;
  pages: number;
  hits: number;
  unaccounted: number;
}> {
  const { samples, store } = options;
  const clientNames = readClientNames(samples);
  const files = messageFiles(samples);
  const { terms, own } = termsOf(clientNames, await readMessages(samples, files, []));
  const records: { id: string; text: string }[] = [];
  const found: { id: string; term: string }[] = [];
  const pages = store.manifest({ tolerant: true }).filter((p) => p.origin === "samples");
  for (const page of pages) {
    // A page is checked against every guarded term and its own message's recipients (its item names the message).
    const message = page.item?.split("#")[0] ?? "";
    const pageRecords = [
      { id: page.id, text: store.readPage(page.id).text },
      { id: `${page.id}/meta`, text: readFileSync(join(store.dir, "pages", page.id, "meta.json"), "utf-8") },
    ];
    found.push(...leaks(pageRecords, own.get(message) ?? []));
    records.push(...pageRecords);
  }
  for (const source of [...Object.values(SOURCES), "samples"])
    for (const name of ["IMPORT.json", "INVENTORY.json"]) {
      const file = join(store.dir, "raw", source, name);
      if (existsSync(file)) records.push({ id: `${source}/${name}`, text: readFileSync(file, "utf-8") });
    }
  found.push(...leaks(records, terms), ...leaks(records, files));
  const inventoryFile = join(store.dir, "raw", "samples", "INVENTORY.json");
  const inventory = existsSync(inventoryFile) ? (JSON.parse(readFileSync(inventoryFile, "utf-8")) as Inventory) : null;
  const accounted = new Set([
    ...(inventory?.outcomes ?? []).map((o) => o.id),
    ...(inventory?.failed ?? []).map((f) => f.id),
  ]);
  const unaccounted = files.filter((file) => !accounted.has(opaqueId(file))).length;
  return { code: found.length || unaccounted ? 1 : 0, pages: pages.length, hits: found.length, unaccounted };
}

async function main(command: string | undefined): Promise<number> {
  const samples = join(ROOT, "samples");
  const store = openStore(storeDir());
  if (command === "leak-check") {
    const result = await leakCheck({ samples, store });
    console.log(
      result.code === 0
        ? `leak-check: clean (${result.pages} pages, every message accounted for)`
        : `leak-check: ${result.hits} hits, ${result.unaccounted} messages unaccounted for`,
    );
    return result.code;
  }
  if (command === "inventory") {
    assertConsent(samples);
    readClientNames(samples);
    const files = messageFiles(samples);
    const manifest = readManifest(samples, files);
    const failed: Inventory["failed"] = [];
    const parsed = await readMessages(samples, files, failed);
    const counts = {
      messages: files.length,
      failed: failed.length,
      attachments: 0,
      bodies: 0,
      textBodies: 0,
      unsupported: 0,
    };
    const labels: Record<string, number> = {};
    for (const { file, email } of parsed) {
      const parts = messageParts(email);
      counts.attachments += parts.attachments.length;
      if (email.html) counts.bodies++;
      else if (parts.body) counts.textBodies++;
      counts.unsupported += parts.unsupported.length;
      const label = labelOf(file, manifest);
      const name = "excluded" in label ? label.excluded : `${label.lure ? "lure" : "benign"} ${label.source}`;
      labels[name] = (labels[name] ?? 0) + 1;
    }
    console.log(JSON.stringify({ ...counts, labels }));
    return 0;
  }
  if (command !== "import") {
    console.error("usage: node scripts/glimmer/import-samples.ts inventory | import | leak-check");
    return 2;
  }
  const reader = await openTextReader();
  try {
    const { code, inventory } = await runImport({ samples, store, render: reader.renderHtml, log: console.log });
    console.log(
      `samples: ${JSON.stringify({ messages: inventory.messages, failed: inventory.failed.length, excluded: inventory.excluded.length, items: inventory.items, unsupported: inventory.unsupported })}`,
    );
    return code;
  } finally {
    await reader.close();
  }
}

if (import.meta.filename === process.argv[1]) process.exit(await main(process.argv[2]));
