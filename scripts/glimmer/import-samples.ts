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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import PostalMime, { type Email } from "postal-mime";
import { type ImportResult, importSource, type SourceItem, writeImport } from "./import-source.ts";
import { EMAIL, hasImages, LONG_NUMBER, namePieces, PHONE, redact, stripImages } from "./redact.ts";
import { decodeHtml, openTextReader } from "./source-pages.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

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

// RFC 4180 rows: commas inside double quotes are part of a field, and a doubled quote is a quote.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

// `manifest.csv`, checked: a `file` and a `label` column, every label `attack` or `genuine`, every file a message,
// and no message listed twice with different labels.
export function readManifest(samples: string, files: string[]): Map<string, string> {
  const file = join(samples, "manifest.csv");
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  const [header, ...rows] = parseCsv(readFileSync(file, "utf-8"));
  const columns = (header ?? []).map((c) => c.trim());
  const at = (name: string) => columns.indexOf(name);
  if (at("file") < 0 || at("label") < 0) throw new Error("refused: manifest.csv needs file and label columns");
  const known = new Set(files);
  rows.forEach((cells, index) => {
    const [name, label] = [(cells[at("file")] ?? "").trim(), (cells[at("label")] ?? "").trim()];
    if (label !== "attack" && label !== "genuine")
      throw new Error(`refused: manifest.csv row ${index + 2} has label "${label}", not attack or genuine`);
    if (!known.has(name)) throw new Error(`refused: manifest.csv row ${index + 2} names no message under samples/`);
    if (out.has(name) && out.get(name) !== label)
      throw new Error(`refused: manifest.csv row ${index + 2} labels a message already labelled ${out.get(name)}`);
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

// Each part's declared charset by its file name, read from the part headers in the raw message: the parser decodes
// attachments as bytes and does not keep their `Content-Type` parameters.
export function partCharsets(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const headers = block.replace(/\r?\n[ \t]+/g, " ");
    if (!/^content-type:/im.test(headers)) continue;
    const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(headers)?.[1];
    const name = /(?:file)?name\*?\s*=\s*"?([^";\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (charset && name) out.set(name, charset);
  }
  return out;
}

// A message's parts: each HTML attachment (decoded by its own charset), its body (the HTML one, else the plain text
// laid out as a page), and every other part by its type, for the inventory. Inline images are not parts: the body's
// images are replaced by blank boxes before it is rendered.
export function messageParts(
  email: Email,
  raw = "",
): {
  attachments: string[];
  body: string | null;
  unsupported: string[];
} {
  const attachments: string[] = [];
  const unsupported: string[] = [];
  const charsets = partCharsets(raw);
  for (const part of email.attachments) {
    const html = part.mimeType === "text/html" || HTML_NAME.test(part.filename ?? "");
    if (html && (part.disposition === "attachment" || HTML_NAME.test(part.filename ?? "")))
      attachments.push(decodeHtml(bytesOf(part.content), charsets.get(part.filename ?? "")));
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

// The redaction's identity: the rules, the code that decodes, renders and stores, the lists they read and every
// message's bytes (a new message brings new recipients to guard on every page). Pages made under another key are made
// again.
export function redactionKey(samples: string, files: string[] = messageFiles(samples)): string {
  const hash = createHash("sha256");
  for (const file of [
    join(import.meta.dirname, "redact.ts"),
    import.meta.filename,
    join(import.meta.dirname, "source-pages.ts"),
    join(import.meta.dirname, "import-source.ts"),
    join(samples, "client-names.txt"),
    join(samples, "manifest.csv"),
  ])
    hash.update(existsSync(file) ? readFileSync(file) : "-").update("\0");
  for (const file of files) {
    hash.update(file).update("\0");
    try {
      hash.update(readFileSync(join(samples, file)));
    } catch {
      hash.update("unreadable");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

// `raw/samples/REDACTION.json`: `key`, the redaction the stored pages were all made under (null while none is whole),
// and `building`, the one a rebuild under way is making them under. An interrupted rebuild keeps its finished pages.
type RedactionState = { key: string | null; building: string | null; at?: string };
export function redactionState(store: ReturnType<typeof openStore>): RedactionState {
  const file = join(store.dir, "raw", "samples", "REDACTION.json");
  if (!existsSync(file)) return { key: null, building: null };
  const state = JSON.parse(readFileSync(file, "utf-8")) as Partial<RedactionState>;
  return { key: state.key ?? null, building: state.building ?? null };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(temporary, file);
}

type Parsed = { id: string; file: string; raw: string; email: Email };
export type Part = {
  item?: string;
  page?: string;
  excluded?: string;
  filtered?: string;
  unsupported?: string;
  none?: true;
};
type Outcome = { id: string; label: string; parts: Part[] };
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
async function readMessages(
  samples: string,
  files: string[],
  failed: Inventory["failed"],
  limits: { maxBytes?: number; parseMs?: number } = {},
): Promise<Parsed[]> {
  const maxBytes = limits.maxBytes ?? MAX_MESSAGE_BYTES;
  const parseMs = limits.parseMs ?? PARSE_DEADLINE_MS;
  const parsed: Parsed[] = [];
  for (const file of files) {
    const id = opaqueId(file);
    try {
      const path = join(samples, file);
      if (statSync(path).size > maxBytes) {
        failed.push({ id, reason: `over ${Math.round((maxBytes / 1024 / 1024) * 100) / 100} MB` });
        continue;
      }
      const bytes = readFileSync(path);
      let timer: NodeJS.Timeout | undefined;
      const email = await Promise.race([
        PostalMime.parse(bytes),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("late"), { late: true })), parseMs);
        }),
      ]).finally(() => clearTimeout(timer));
      parsed.push({ id, file, raw: bytes.toString("latin1"), email });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const late = (error as { late?: boolean }).late;
      failed.push({
        id,
        reason: late ? `not parsed within ${parseMs / 1000} seconds` : code ? `unreadable (${code})` : "unparsable",
      });
    }
  }
  return parsed;
}

// The import, end to end: the consent and lists checked; every message read, bounded, and accounted for; earlier
// pages made under another redaction removed (a rebuild under way keeps its finished pages); both kinds imported but
// not yet published; identical pages' labels reconciled across both kinds; every part's outcome written to the
// inventory; and only then each import published `complete` and the redaction key recorded. Exit 0 when complete.
export async function runImport(options: {
  samples: string;
  store: ReturnType<typeof openStore>;
  render: (html: string) => Promise<{ screenshot: Uint8Array; text: string }>;
  log?: (line: string) => void;
  maxBytes?: number;
  parseMs?: number;
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
  const parsed = await readMessages(samples, files, inventory.failed, options);

  const key = redactionKey(samples, files);
  const keyFile = join(store.dir, "raw", "samples", "REDACTION.json");
  const state = redactionState(store);
  if (state.key !== key && state.building !== key) {
    const removed = Object.values(SOURCES).reduce((sum, source) => sum + store.removeSource(source), 0);
    writeJson(keyFile, { key: null, building: key, at: new Date().toISOString() });
    if (removed) log(`samples: the redaction changed; ${removed} earlier pages removed before the import`);
  } else if (state.key !== key) log("samples: resuming the rebuild under the current redaction");

  const { terms, domains, pieces } = termsOf(clientNames, parsed);
  type Item = SourceItem & { rank: number; label: { lure: boolean; source: string }; kind: keyof typeof SOURCES };
  const itemsBy: Record<keyof typeof SOURCES, Item[]> = { attachment: [], body: [] };
  // The page each loaded item became, to reconcile identical pages' labels and record each part's outcome.
  const pageOf = new Map<string, string>();
  const partsOf = new Map<string, Part[]>();
  for (const { id, file, raw, email } of parsed) {
    const label = labelOf(file, manifest);
    const parts = messageParts(email, raw);
    const outcome: Outcome = {
      id,
      label: "excluded" in label ? "excluded" : label.lure ? "lure" : "benign",
      parts: [],
    };
    inventory.outcomes.push(outcome);
    inventory.unsupported += parts.unsupported.length;
    outcome.parts.push(...parts.unsupported.map((type) => ({ unsupported: type })));
    partsOf.set(id, outcome.parts);
    if ("excluded" in label) {
      inventory.excluded.push({ id, reason: label.excluded });
      continue;
    }
    if (!parts.body && !parts.attachments.length) outcome.parts.push({ none: true });
    const names = [...recipientNames(email, raw, clientNames), ...pieces];
    const add = (kind: keyof typeof SOURCES, html: string, index: number) => {
      const itemId = `${id}#${kind}${index}`;
      itemsBy[kind].push({
        id: itemId,
        kind,
        url: null,
        rank: label.rank,
        label,
        labels: { lure: label.lure },
        label_source: { lure: label.source === "ground-truth" ? "ground-truth" : "unverified" },
        load: async () => {
          const page = await renderRedacted(options.render, html, names, terms, domains);
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
    results[kind] = await importSource({
      source: SOURCES[kind],
      licence: LICENCE,
      items,
      store,
      origin: "samples",
      redacted: true,
      southAfrica: true,
      concurrency: 1,
      publish: false,
      log,
    });
  }
  const allItems = [...itemsBy.attachment, ...itemsBy.body];
  const stored = new Map(
    store
      .manifest({ tolerant: true })
      .flatMap((p) => ((Object.values(SOURCES) as string[]).includes(p.source) ? [[p.id, p] as const] : [])),
  );
  const storedFrom = new Map([...stored.values()].flatMap((p) => (p.item ? [[p.item, p.id] as const] : [])));
  const pageFor = (item: string) => {
    const page = pageOf.get(item) ?? storedFrom.get(item);
    return page && stored.has(page) ? page : undefined;
  };
  reconcile(store, stored, allItems, pageFor);
  // Each part's outcome: the page it is (stored from it, or the same as another's), or why it is not one.
  const why = new Map<string, Part>();
  for (const result of Object.values(results)) {
    for (const e of result.excluded) why.set(e.item, { item: e.item, excluded: e.reason });
    for (const f of result.filtered) why.set(f.item, { item: f.item, filtered: f.reason });
  }
  for (const item of allItems) {
    const page = pageFor(item.id);
    partsOf
      .get(item.id.split("#")[0] as string)
      ?.push(page ? { item: item.id, page } : (why.get(item.id) ?? { item: item.id }));
  }
  writeJson(join(store.dir, "raw", "samples", "INVENTORY.json"), inventory);
  const complete = inventory.failed.length === 0 && Object.values(results).every((r) => r.status === "complete");
  // Published last, and `complete` only when the whole sample run is: the dataset builder reads an import once its
  // record says so, and a sample set with a message missing is not one to train on.
  for (const kind of ["attachment", "body"] as const) {
    const result = results[kind] as ImportResult;
    const whole = complete
      ? result
      : {
          ...result,
          status: "incomplete" as const,
          reason: result.reason ?? `the sample run is incomplete: ${inventory.failed.length} messages failed`,
        };
    writeImport(join(store.dir, "raw", SOURCES[kind], "IMPORT.json"), whole);
  }
  if (complete) writeJson(keyFile, { key, building: null, at: new Date().toISOString() });
  return { code: complete ? 0 : 1, inventory, results };
}

// Identical pages from several messages, across attachments and bodies alike (the same content is the same page by
// its screenshot and text): each keeps the strongest label its messages agree on (ground truth over unverified), and
// no `lure` label when they disagree, whatever order they were stored in.
function reconcile(
  store: ReturnType<typeof openStore>,
  stored: Map<string, StoredPage>,
  items: { id: string; label: { lure: boolean; source: string } }[],
  pageFor: (item: string) => string | undefined,
): void {
  const contentOf = (page: StoredPage) => `${page.sha256.screenshot}:${page.sha256.text}`;
  const labels = new Map<string, { lure: boolean; source: string }[]>();
  const pages = new Map<string, Set<string>>();
  for (const item of items) {
    const id = pageFor(item.id);
    const page = id ? stored.get(id) : undefined;
    if (!page) continue;
    const content = contentOf(page);
    labels.set(content, [...(labels.get(content) ?? []), item.label]);
    pages.set(content, (pages.get(content) ?? new Set()).add(page.id));
  }
  for (const [content, found] of labels) {
    const agreed = new Set(found.map((l) => l.lure)).size === 1;
    const lure = found[0]?.lure as boolean;
    const strongest = found.some((l) => l.source === "ground-truth") ? "ground-truth" : "unverified";
    for (const id of pages.get(content) ?? []) {
      const page = stored.get(id) as StoredPage;
      const { lure: _lure, ...rest } = page.labels;
      const { lure: _source, ...restSource } = page.label_source;
      if (!agreed) {
        if (page.labels.lure !== undefined) store.setLabels(id, rest, restSource);
      } else if (page.labels.lure !== lure || page.label_source.lure !== strongest)
        store.setLabels(id, { ...rest, lure }, { ...restSource, lure: strongest });
    }
  }
}

// The terms nothing from the samples may hold, derived as the import derives them: client names, every recipient's
// name pieces and address, and the client's domains.
function termsOf(clientNames: string[], parsed: Parsed[]): { terms: string[]; domains: string[]; pieces: string[] } {
  const everyAddress = parsed.flatMap(({ email, raw }) => addresses(email, raw));
  // Every recipient's name pieces, of any length, are redacted and guarded on every page: a name from one message can
  // stand in another's quoted or forwarded text. (Guarding them everywhere while redacting each page by its own
  // recipients alone refused 134 of 540 real bodies, 2026-10-29; redacting them everywhere removes those hits.)
  const pieces = [
    ...new Set(parsed.flatMap(({ email, raw }) => people(email, raw).flatMap((p) => namePieces(p.name, p.address)))),
  ];
  return { terms: protectedTerms(clientNames, everyAddress, pieces), domains: clientDomains(everyAddress), pieces };
}

export type Ocr = (screenshots: string[]) => Promise<string[]>;

// The text an OCR engine reads off each stored screenshot (`scripts/glimmer/ocr_text.py`, RapidOCR in its own venv,
// `GLIMMER_OCR_PYTHON` or `~/.venvs/ocr/bin/python`): what a viewer of the picture reads, checked as the page text is.
export const systemOcr: Ocr = async (screenshots) => {
  const python = process.env.GLIMMER_OCR_PYTHON ?? join(homedir(), ".venvs", "ocr", "bin", "python");
  if (!existsSync(python)) throw new Error("no OCR engine: install rapidocr-onnxruntime in ~/.venvs/ocr");
  const out = execFileSync(python, ["-I", join(import.meta.dirname, "ocr_text.py")], {
    input: JSON.stringify(screenshots),
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out.toString("utf-8")) as string[];
};

// The proof the store's samples are whole and clean: the consent holds; the stored pages were all made under the
// current redaction and both imports are complete; every page's record reads; no page's text, record or screenshot
// (read by OCR) holds a client term or an address, phone or long number; no import record or the inventory holds a
// term or a path under samples/; and every message and part is accounted for by a page that exists or a reason.
export async function leakCheck(options: {
  samples: string;
  store: ReturnType<typeof openStore>;
  ocr?: Ocr;
}): Promise<{ code: 0 | 1; pages: number; hits: number; unaccounted: number; problems: string[] }> {
  const { samples, store } = options;
  assertConsent(samples);
  const clientNames = readClientNames(samples);
  const files = messageFiles(samples);
  const { terms } = termsOf(clientNames, await readMessages(samples, files, []));
  const problems: string[] = [];
  const state = redactionState(store);
  if (state.key !== redactionKey(samples, files) || state.building)
    problems.push("the stored pages were not all made under the current redaction");
  for (const source of Object.values(SOURCES)) {
    const file = join(store.dir, "raw", source, "IMPORT.json");
    const status = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as ImportResult).status : "missing";
    if (status !== "complete") problems.push(`${source}: its import is ${status}`);
  }
  let pages: StoredPage[] = [];
  try {
    pages = store.manifest().filter((p) => p.origin === "samples");
  } catch {
    problems.push("a page's record does not read");
  }
  const records: { id: string; text: string }[] = [];
  const shots: string[] = [];
  let detail = 0;
  for (const page of pages) {
    const text = store.readPage(page.id).text;
    if (personalDetail(text)) detail++;
    records.push(
      { id: page.id, text },
      { id: `${page.id}/meta`, text: readFileSync(join(store.dir, "pages", page.id, "meta.json"), "utf-8") },
    );
    shots.push(join(store.dir, "pages", page.id, "screenshot.jpg"));
  }
  try {
    const read = await (options.ocr ?? systemOcr)(shots);
    read.forEach((text, index) => {
      records.push({ id: `${pages[index]?.id}/screenshot`, text });
      if (personalDetail(text)) detail++;
    });
  } catch (error) {
    problems.push(`the screenshots were not read: ${(error as Error).message.split("\n")[0]}`);
  }
  const imports: { id: string; text: string }[] = [];
  for (const source of [...Object.values(SOURCES), "samples"])
    for (const name of ["IMPORT.json", "INVENTORY.json", "REDACTION.json"]) {
      const file = join(store.dir, "raw", source, name);
      if (existsSync(file)) imports.push({ id: `${source}/${name}`, text: readFileSync(file, "utf-8") });
    }
  const found = [...leaks([...records, ...imports], terms), ...leaks(imports, files)];
  if (detail) problems.push(`${detail} pages or screenshots show an address, phone or long number`);
  // Every message and every part accounted for, every part's page in the store, every stored page some part's.
  const inventoryFile = join(store.dir, "raw", "samples", "INVENTORY.json");
  const inventory = existsSync(inventoryFile) ? (JSON.parse(readFileSync(inventoryFile, "utf-8")) as Inventory) : null;
  if (!inventory) problems.push("no inventory");
  const accounted = new Set([
    ...(inventory?.outcomes ?? []).map((o) => o.id),
    ...(inventory?.failed ?? []).map((f) => f.id),
  ]);
  const unaccounted = files.filter((file) => !accounted.has(opaqueId(file))).length;
  const ids = new Set(pages.map((p) => p.id));
  const parts = (inventory?.outcomes ?? []).flatMap((o) => o.parts);
  const open = parts.filter((p) => p.item && !p.page && !p.excluded && !p.filtered).length;
  const missing = parts.filter((p) => p.page && !ids.has(p.page)).length;
  const orphans = [...ids].filter((id) => !parts.some((p) => p.page === id)).length;
  if (open) problems.push(`${open} parts have no outcome`);
  if (missing) problems.push(`${missing} parts name a page the store does not hold`);
  if (orphans) problems.push(`${orphans} stored pages are no part's`);
  if (found.length) problems.push(`${found.length} client terms found`);
  const code = problems.length || unaccounted ? 1 : 0;
  return { code, pages: pages.length, hits: found.length, unaccounted, problems };
}

async function main(command: string | undefined): Promise<number> {
  const samples = join(ROOT, "samples");
  const store = openStore(storeDir());
  if (command === "leak-check") {
    const result = await leakCheck({ samples, store });
    console.log(
      result.code === 0
        ? `leak-check: clean (${result.pages} pages, their screenshots read; every message and part accounted for)`
        : `leak-check: failed (${[...result.problems, `${result.unaccounted} messages unaccounted for`].join("; ")})`,
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
    for (const { file, raw, email } of parsed) {
      const parts = messageParts(email, raw);
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
