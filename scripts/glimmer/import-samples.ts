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
// failure (unreadable, over 25 MB, unparsable). A change to the redaction (this file, `redact.ts`, `entities.py`, its
// table of unread scripts, `ocr_text.py`, `pins.py`, the requirements files of the entity pass and the OCR engine, the
// entity pass's model digest, switch and limits, the client names or the manifest) removes every earlier sample page before the import, and the run records its key in
// `raw/samples/REDACTION.json` only once both imports are complete, so an interrupted rebuild never stands as redacted.
//
// With the entity pass on (`ENTITY_PASS_ON`, §19) it redacts the people and places no list names, and it reads every
// page again after the render: a person or place it still finds refuses the page. The leak check runs it over every
// stored page's text, record and screenshot (as OCR reads it) too, and records its verdict in
// `raw/samples/LEAK-CHECK.json`, which the dataset build reads before it admits a sample page.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { Email } from "postal-mime";
import { type ImportResult, importSource, type SourceItem, writeImport } from "./import-source.ts";
import { readExcluded } from "./label-rules.ts";
import {
  discoveredDetail,
  EMAIL,
  ENTITY_CONFIG,
  type EntityConfig,
  type EntityPass,
  hasImages,
  LONG_NUMBER,
  namePieces,
  openConfiguredPass,
  PHONE,
  redactWithEntities,
  skeleton,
  stripImages,
  survivingEntities,
} from "./redact.ts";
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
  // A spreadsheet's UTF-8 byte-order mark is not part of the first header.
  const [header, ...rows] = parseCsv(readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
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
  // Every `.eml` (any case) at any depth under samples/, its folders followed once each: a quarantine export nests
  // folders, and a message outside the expected shape would otherwise go uncounted. Hidden names are left out.
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (folder: string, prefix: string) => {
    let real: string;
    try {
      real = realpathSync(folder);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      const isDir =
        entry.isDirectory() || (entry.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory());
      if (isDir) walk(path, `${prefix}${entry.name}/`);
      else if (/\.eml$/i.test(entry.name)) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(samples, "");
  return out;
}

const HTML_NAME = /\.(s?html?)$/i;

const bytesOf = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);

// Each part's declared charset by its file name, read from the part headers in the raw message: the parser decodes
// attachments as bytes and does not keep their `Content-Type` parameters.
export function partCharsets(raw: string): Map<string, string[]> {
  // Each name's charsets in the order its parts appear: two attachments may share a name, and the parser keeps parts
  // in that same order, so the n-th part named `invoice.html` takes the n-th charset declared for that name.
  const out = new Map<string, string[]>();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const headers = block.replace(/\r?\n[ \t]+/g, " ");
    if (!/^content-type:/im.test(headers)) continue;
    const names = partNames(headers);
    if (!names.length) continue;
    const charset = /[;\s]charset\s*=\s*"?([\w.:-]+)/i.exec(headers)?.[1] ?? "";
    for (const name of names) out.set(name, [...(out.get(name) ?? []), charset]);
  }
  return out;
}

// A part's file names as the parser decodes them: plain (`filename="a.html"`), RFC 2231 extended and continued
// (`filename*=utf-8''a%20b.html`, `filename*0*=`, `filename*1*=`) and RFC 2047 encoded words (`=?utf-8?B?...?=`).
export function partNames(headers: string): string[] {
  const names: string[] = [];
  for (const key of ["filename", "name"]) {
    const plain = new RegExp(`[;\\s]${key}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(headers);
    if (plain) names.push(encodedWords((plain[2] ?? plain[1] ?? "").replace(/^"|"$/g, "").trim()));
    const pieces = [...headers.matchAll(new RegExp(`[;\\s]${key}\\*(\\d+)?(\\*)?\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "gi"))]
      .map((m) => ({
        index: Number(m[1] ?? 0),
        encoded: Boolean(m[2]) || !m[1],
        value: (m[4] ?? m[3] ?? "").replace(/^"|"$/g, ""),
      }))
      .sort((a, b) => a.index - b.index);
    if (pieces.length) {
      const first = pieces[0]?.value ?? "";
      const declared = /^([^']*)'[^']*'(.*)$/.exec(first);
      const charset = declared?.[1] || "utf-8";
      const values = pieces.map((p, i) => (i === 0 && declared ? (declared[2] ?? "") : p.value));
      const bytes: number[] = [];
      values.forEach((value, i) => {
        const encoded = pieces[i]?.encoded;
        for (let at = 0; at < value.length; at++) {
          if (encoded && value[at] === "%" && /^[0-9a-f]{2}$/i.test(value.slice(at + 1, at + 3))) {
            bytes.push(Number.parseInt(value.slice(at + 1, at + 3), 16));
            at += 2;
          } else bytes.push(...new TextEncoder().encode(value[at] as string));
        }
      });
      try {
        names.push(new TextDecoder(charset).decode(new Uint8Array(bytes)));
      } catch {
        names.push(new TextDecoder("utf-8").decode(new Uint8Array(bytes)));
      }
    }
  }
  return [...new Set(names.filter(Boolean))];
}

function encodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, kind: string, text: string) => {
    try {
      const bytes =
        kind.toUpperCase() === "B"
          ? Uint8Array.from(Buffer.from(text, "base64"))
          : Uint8Array.from(
              Buffer.from(
                text
                  .replace(/_/g, " ")
                  .replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
                "latin1",
              ),
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
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
  const taken = new Map<string, number>();
  for (const part of email.attachments) {
    const html = part.mimeType === "text/html" || HTML_NAME.test(part.filename ?? "");
    if (html && (part.disposition === "attachment" || HTML_NAME.test(part.filename ?? ""))) {
      const name = part.filename ?? "";
      const nth = taken.get(name) ?? 0;
      taken.set(name, nth + 1);
      attachments.push(decodeHtml(bytesOf(part.content), charsets.get(name)?.[nth] || undefined));
    } else if (!(part.related || part.contentId) || !part.mimeType.startsWith("image/"))
      unsupported.push(part.mimeType);
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
// tag split out of the redactor's reach and the render joined up again, or a street address, post box, postal code,
// signed name or town the rules that stand beside the entity pass find (`discoveredDetail`, §19 gap 3), so a detail
// the model reads past is caught by something other than the model.
export function personalDetail(text: string): string | null {
  for (const [kind, rule] of [
    ["an address", EMAIL],
    ["a phone number", PHONE],
    ["a long number", LONG_NUMBER],
  ] as const) {
    if (new RegExp(rule.source).test(skeleton(text))) return kind;
  }
  return discoveredDetail(text);
}

// The entity pass a sample run uses: the one given (a test's), else, with the configuration's switch on, the pass it
// describes, started here and closed by `close`; none with the switch off.
export type EntityOptions = { pass?: EntityPass | null; config?: EntityConfig };
function entitiesFor(options: EntityOptions = {}) {
  const config = options.config ?? ENTITY_CONFIG;
  const owned = options.pass === undefined && config.on ? openConfiguredPass(config) : null;
  return { config, pass: options.pass ?? owned, close: () => owned?.close() };
}

// What a rendered page draws, checked: no client term, no address, phone or long number, and, with the entity pass on,
// no person or place the pass finds that is not a placeholder. The reason names the kind of detail, never the detail;
// a pass that cannot read the text refuses it (its reasons hold none of the text).
export async function checkShown(
  shown: string,
  terms: string[],
  entities: { pass: EntityPass | null; on: boolean },
): Promise<void> {
  if (leaks([{ id: "page", text: shown }], terms).length)
    throw new Error("refused: a client detail survived redaction");
  const kind = personalDetail(shown);
  if (kind) throw new Error(`refused: ${kind} survived redaction`);
  if (!entities.on) return;
  if (!entities.pass) throw new Error("refused: the entity pass is on but was not started");
  const left = survivingEntities(shown, await entities.pass.find(shown));
  if (left.length)
    throw new Error(`refused: a ${left[0]?.label === "person" ? "person's name" : "place"} survived redaction`);
}

// A sample's HTML with its images replaced and its details redacted (by the lists and, with the switch on, the entity
// pass), then rendered, then checked (`checkShown`), or the page is refused.
export async function renderRedacted<T extends { text: string; drawn?: string }>(
  render: (html: string) => Promise<T>,
  html: string,
  names: string[],
  terms: string[],
  domains: string[] = [],
  entities: { pass: EntityPass | null; on?: boolean } = { pass: null },
): Promise<T> {
  const on = entities.on ?? ENTITY_CONFIG.on;
  const clean = await redactWithEntities(stripImages(html), names, domains, entities.pass, on);
  if (hasImages(clean)) throw new Error("refused: an image survived the image rule");
  const page = await render(clean);
  // Everything the page draws: its text, and the form values and placeholders `innerText` leaves out.
  await checkShown(page.drawn ? `${page.text}\n${page.drawn}` : page.text, terms, { pass: entities.pass, on });
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
    // Read as the screen shows it: look-alike letters and full-width forms folded to Latin.
    const shown = skeleton(page.text);
    const text = shown.toLowerCase();
    return rules
      .filter(({ term, rule }) => (rule ? rule.test(shown) : text.includes(term)))
      .map(({ term }) => ({ id: page.id, term }));
  });
}

// The redaction's identity: the rules, the code that decodes, renders, finds entities, reads screenshots and stores,
// the requirements files the entity pass's and the OCR engine's environments are pinned to (each refuses to start in
// one that differs, `pins.py`), the entity pass's model digest, switch and limits, the lists they read and every
// message's bytes (a new message brings new recipients to guard on every page), and the brands a line signed for a
// business may name (`leadingBrand` in label-rules.ts and the South African list it reads, §19 round 3). Pages made
// under another key are made again. `scripts` stands in for this directory in tests.
export function redactionKey(
  samples: string,
  files: string[] = messageFiles(samples),
  entities: EntityConfig = ENTITY_CONFIG,
  scripts: string = import.meta.dirname,
): string {
  const hash = createHash("sha256");
  for (const file of [
    join(scripts, "redact.ts"),
    join(scripts, "import-samples.ts"),
    join(scripts, "source-pages.ts"),
    join(scripts, "import-source.ts"),
    join(scripts, "entities.py"),
    join(scripts, "unread-scripts.json"),
    join(scripts, "ocr_text.py"),
    join(scripts, "pins.py"),
    join(scripts, "requirements-entities.txt"),
    join(scripts, "requirements-ocr.txt"),
    join(scripts, "label-rules.ts"),
    join(scripts, "..", "..", "eval", "glimmer", "benign-sa-urls.txt"),
    join(samples, "client-names.txt"),
    join(samples, "manifest.csv"),
  ])
    hash.update(existsSync(file) ? readFileSync(file) : "-").update("\0");
  const { on, model, limits } = entities;
  hash
    .update(
      JSON.stringify([on, model.name, model.sha256, model.language, limits.text, limits.seconds, limits.outputBytes]),
    )
    .update("\0");
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
type RedactionState = { key: string | null; building: string | null; cleaned?: boolean; at?: string };
export function redactionState(store: ReturnType<typeof openStore>): RedactionState {
  const file = join(store.dir, "raw", "samples", "REDACTION.json");
  if (!existsSync(file)) return { key: null, building: null };
  const state = JSON.parse(readFileSync(file, "utf-8")) as Partial<RedactionState>;
  return { key: state.key ?? null, building: state.building ?? null, cleaned: state.cleaned === true };
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

// A message parsed in its own worker thread, terminated at the deadline: the parse stops, not only the wait for it.
function parseBounded(bytes: Uint8Array, ms: number): Promise<Email> {
  return new Promise((done, fail) => {
    const worker = new Worker(new URL("./parse-mail-worker.ts", import.meta.url));
    const timer = setTimeout(() => {
      void worker.terminate();
      fail(Object.assign(new Error("late"), { late: true }));
    }, ms);
    worker.once("message", (answer: { email?: Email; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (answer.email) done(answer.email);
      else fail(new Error(answer.error ?? "unparsable"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    worker.postMessage(bytes);
  });
}

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
      const email = await parseBounded(bytes, parseMs);
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
type ImportOptions = {
  samples: string;
  store: ReturnType<typeof openStore>;
  render: (html: string) => Promise<{ screenshot: Uint8Array; text: string }>;
  log?: (line: string) => void;
  maxBytes?: number;
  parseMs?: number;
  entities?: EntityOptions;
};
type ImportOutcome = { code: 0 | 1; inventory: Inventory; results: Record<string, ImportResult> };
export async function runImport(options: ImportOptions): Promise<ImportOutcome> {
  const entities = entitiesFor(options.entities);
  try {
    return await importWith(options, entities.config, entities.pass);
  } finally {
    entities.close();
  }
}

async function importWith(
  options: ImportOptions,
  config: EntityConfig,
  pass: EntityPass | null,
): Promise<ImportOutcome> {
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

  const key = redactionKey(samples, files, config);
  const keyFile = join(store.dir, "raw", "samples", "REDACTION.json");
  const state = redactionState(store);
  // The old pages are gone only once `cleaned` says so: a rebuild whose removal failed removes them again on the
  // next run, before any page under the new key is skipped as already made.
  if (state.key !== key && (state.building !== key || !state.cleaned)) {
    // The old pages stop counting before any is touched: both import records and the key say so first, so a run that
    // dies part-way through the removal leaves nothing the dataset builder accepts.
    for (const source of Object.values(SOURCES)) {
      const record = join(store.dir, "raw", source, "IMPORT.json");
      if (existsSync(record))
        writeImport(record, {
          ...(JSON.parse(readFileSync(record, "utf-8")) as ImportResult),
          status: "running",
          reason: "rebuilding under a changed redaction",
        });
    }
    writeJson(keyFile, { key: null, building: key, cleaned: false, at: new Date().toISOString() });
    const removed = Object.values(SOURCES).reduce((sum, source) => sum + store.removeSource(source), 0);
    writeJson(keyFile, { key: null, building: key, cleaned: true, at: new Date().toISOString() });
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
          const page = await renderRedacted(options.render, html, names, terms, domains, { pass, on: config.on });
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
  if (complete) writeJson(keyFile, { key, building: null, cleaned: true, at: new Date().toISOString() });
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
// An engine whose venv is not what `requirements-ocr.txt` pins refuses to start (exit 3, `pins.py`), and its reason,
// which names a package and versions only, is the error (§19, round 1 finding 2).
export const systemOcr: Ocr = async (screenshots) => {
  const python = process.env.GLIMMER_OCR_PYTHON ?? join(homedir(), ".venvs", "ocr", "bin", "python");
  if (!existsSync(python)) throw new Error("no OCR engine: install rapidocr-onnxruntime in ~/.venvs/ocr");
  const run = spawnSync(python, ["-I", join(import.meta.dirname, "ocr_text.py")], {
    input: JSON.stringify(screenshots),
    maxBuffer: 256 * 1024 * 1024,
  });
  const unpinned = run.status === 3 ? OCR_UNPINNED.exec(run.stderr.toString("utf-8").trim()) : null;
  if (unpinned) throw new Error(`the OCR engine refused: ${unpinned[0]}`);
  if (run.error || run.status !== 0)
    throw new Error(`the OCR engine failed (${run.error ? run.error.message : `exit code ${run.status}`})`);
  return JSON.parse(run.stdout.toString("utf-8")) as string[];
};
const OCR_UNPINNED =
  /^the environment does not match requirements-ocr\.txt \([A-Za-z0-9._-]+ is (?:not installed|[A-Za-z0-9.+!_-]+), pinned [A-Za-z0-9.+!_-]+\)$/;

// `raw/samples/LEAK-CHECK.json`: the last leak check's verdict, the redaction key it checked under and a digest of the
// sample pages it read (their ids and file hashes), so a page added, remade or changed since makes it stand for nothing.
export const leakCheckFile = (dir: string) => join(dir, "raw", "samples", "LEAK-CHECK.json");
export function samplePagesDigest(pages: Pick<StoredPage, "id" | "sha256">[]): string {
  const lines = pages.map((p) => `${p.id}\t${p.sha256.screenshot}\t${p.sha256.text}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// Why the store's sample pages are not covered by a clean leak check, or null when they are: the check never ran, was
// not clean, ran under another redaction than the one the pages were all made under, ran under a redaction other than
// `current` (the key `redactionKey()` gives for the code, model, configuration and samples as they are now: after a
// change to any of them the old pages and the old verdict still agree with each other, but no longer with what the
// importer would make), or read other pages than the store holds now.
export function leakCheckProblem(store: ReturnType<typeof openStore>, current: string): string | null {
  const file = leakCheckFile(store.dir);
  if (!existsSync(file)) return "the sample leak check has not run";
  let record: { clean?: unknown; key?: unknown; pages?: unknown };
  try {
    record = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return "the sample leak check's record does not read";
  }
  if (record.clean !== true) return "the sample leak check is not clean";
  const state = redactionState(store);
  if (!state.key || state.building || record.key !== state.key)
    return "the sample leak check ran under another redaction than the stored pages'";
  if (record.key !== current)
    return "the sample leak check ran under another redaction than the current one: import, then leak-check again";
  // The check's digest is over the dataset-eligible pages it read (the excluded ones are barred, above).
  const excludedNow = readExcluded(store.dir);
  const pages = store.manifest({ tolerant: true }).filter((p) => p.origin === "samples" && !excludedNow.has(p.id));
  if (record.pages !== samplePagesDigest(pages)) return "the sample pages changed after the leak check";
  return null;
}

// A record's text as the entity pass reads it: its string values, one a line and each closed as its own
// sentence (keys and hashes name no one). Values are separate fields, so no name spans two of them; joining
// them bare let the pass read fragments of neighbouring fields ("dom", "dom", "ground-truth") as one name
// (measured on the stored sample records, 2026-11-02: all 145 eligible pages flagged on the bare join, none
// on the closed join), which is the checker's artifact, not a name in any field.
export function recordText(json: string): string {
  const out: string[] = [];
  const walk = (value: unknown) => {
    // A content digest (a sha256 hex string) names no one and is not record content: the entity pass read
    // three stored hashes as a person or a place (measured 2026-11-02), the checker's artifact again.
    if (typeof value === "string") {
      if (!/^[0-9a-f]{64}$/.test(value)) out.push(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(json));
  } catch {
    return json;
  }
  return out.join("\n.\n");
}

// The proof the store's samples are whole and clean: the consent holds; the stored pages were all made under the
// current redaction and both imports are complete; every page's record reads; no page's text, record or screenshot
// (read by OCR, every screenshot read) holds a client term, an address, phone or long number, or a street address, post
// box, postal code, signed name or town (`personalDetail`), nor, with the entity
// pass on, a person or place the pass finds that is not a placeholder (a text the pass refuses fails the check too); no
// import record or the inventory holds a term or a path under samples/; and every message and part is accounted for by
// a page that exists or a reason. The verdict is recorded in `raw/samples/LEAK-CHECK.json` (`leakCheckProblem`).
//
// Each detail, entity or OCR failure is named in `failures` (and in the record) by the page's opaque id, the representation that
// failed (`text`, the page's text; `record`, its meta.json values; `OCR`, its screenshot as OCR reads it) and a reason
// that names the kind of failure, never the content; `retry` is the command to run once it is dealt with
// (`leakReport()` prints both), so a failed audit is found without reading code (§19 completion review gap 9).
export type LeakFailure = { id: string; representation: "text" | "record" | "OCR"; reason: string };
type LeakResult = {
  code: 0 | 1;
  pages: number;
  hits: number;
  unaccounted: number;
  problems: string[];
  failures: LeakFailure[];
  retry: string;
};
export const LEAK_CHECK_COMMAND = "node scripts/glimmer/import-samples.ts leak-check";
export const IMPORT_COMMAND = "node scripts/glimmer/import-samples.ts import";
export async function leakCheck(options: {
  samples: string;
  store: ReturnType<typeof openStore>;
  ocr?: Ocr;
  entities?: EntityOptions;
}): Promise<LeakResult> {
  const { samples, store } = options;
  assertConsent(samples);
  // A check under way stands for nothing: an earlier clean verdict is withdrawn before anything is read.
  writeJson(leakCheckFile(store.dir), { clean: false, key: null, pages: null, at: new Date().toISOString() });
  const entities = entitiesFor(options.entities);
  try {
    const { result, key, pages } = await checkWith(options, entities.config, entities.pass);
    writeJson(leakCheckFile(store.dir), {
      clean: result.code === 0,
      key,
      pages,
      failures: result.failures,
      at: new Date().toISOString(),
    });
    return result;
  } finally {
    entities.close();
  }
}

async function checkWith(
  options: { samples: string; store: ReturnType<typeof openStore>; ocr?: Ocr },
  config: EntityConfig,
  pass: EntityPass | null,
): Promise<{ result: LeakResult; key: string; pages: string }> {
  const { samples, store } = options;
  const clientNames = readClientNames(samples);
  const files = messageFiles(samples);
  const { terms } = termsOf(clientNames, await readMessages(samples, files, []));
  const problems: string[] = [];
  const state = redactionState(store);
  const key = redactionKey(samples, files, config);
  if (state.key !== key || state.building)
    problems.push("the stored pages were not all made under the current redaction");
  for (const source of Object.values(SOURCES)) {
    const file = join(store.dir, "raw", source, "IMPORT.json");
    const status = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as ImportResult).status : "missing";
    if (status !== "complete") problems.push(`${source}: its import is ${status}`);
  }
  // The check runs over dataset-eligible sample pages only (coordinator decision, 2026-11-02): a page the
  // label rules exclude (a flagged page among them) is barred from every dataset and is not the check's to
  // clear; the check must pass clean over everything that can enter one. Accounting below still names every
  // stored page, eligible or not.
  const excludedNow = readExcluded(store.dir);
  let allSamplePages: StoredPage[] = [];
  let pages: StoredPage[] = [];
  try {
    allSamplePages = store.manifest().filter((p) => p.origin === "samples");
    pages = allSamplePages.filter((p) => !excludedNow.has(p.id));
  } catch {
    problems.push("a page's record does not read");
  }
  // Each page's files must still be the ones its record names: a replaced screenshot reads clean by OCR and is not
  // the page that was checked.
  const damaged = Object.values(SOURCES).reduce((sum, source) => sum + store.verify(source).damaged.length, 0);
  if (damaged) problems.push(`${damaged} pages' files no longer match their records`);
  const records: { id: string; text: string }[] = [];
  // What the entity pass reads: each page's text, its record's values and its screenshot as OCR reads it, each by the
  // page's opaque id and the representation it is.
  const readable: { id: string; representation: LeakFailure["representation"]; text: string }[] = [];
  const failures: LeakFailure[] = [];
  const shots: string[] = [];
  let detail = 0;
  for (const page of pages) {
    // The text alone: a page whose screenshot is gone is still read, and named below.
    const text = readFileSync(join(store.dir, "pages", page.id, "text.txt"), "utf-8");
    const shown = personalDetail(text);
    if (shown) {
      detail++;
      failures.push({ id: page.id, representation: "text", reason: `it shows ${shown}` });
    }
    const meta = readFileSync(join(store.dir, "pages", page.id, "meta.json"), "utf-8");
    records.push({ id: page.id, text }, { id: `${page.id}/meta`, text: meta });
    readable.push(
      { id: page.id, representation: "text", text },
      { id: page.id, representation: "record", text: recordText(meta) },
    );
    shots.push(join(store.dir, "pages", page.id, "screenshot.jpg"));
  }
  // A screenshot that is not there fails the OCR run whole: named here first, by page.
  shots.forEach((shot, index) => {
    if (!existsSync(shot))
      failures.push({ id: pages[index]?.id ?? "?", representation: "OCR", reason: "the screenshot is missing" });
  });
  try {
    const read: unknown = await (options.ocr ?? systemOcr)(shots);
    // Every screenshot read, one text each: a screenshot the engine skipped is a screenshot nobody checked.
    if (!Array.isArray(read) || read.length !== shots.length || read.some((text) => typeof text !== "string")) {
      problems.push(
        `the screenshots were not all read: ${Array.isArray(read) ? read.length : 0} texts for ${shots.length}`,
      );
      // A text of the wrong kind is that page's; a count that is off cannot say which page was skipped.
      if (Array.isArray(read) && read.length === shots.length)
        read.forEach((text, index) => {
          if (typeof text !== "string")
            failures.push({
              id: pages[index]?.id ?? "?",
              representation: "OCR",
              reason: "the OCR engine gave no text",
            });
        });
    } else
      (read as string[]).forEach((text, index) => {
        records.push({ id: `${pages[index]?.id}/screenshot`, text });
        readable.push({ id: pages[index]?.id ?? "?", representation: "OCR", text });
        const shown = personalDetail(text);
        if (shown) {
          detail++;
          failures.push({ id: pages[index]?.id ?? "?", representation: "OCR", reason: `it shows ${shown}` });
        }
      });
  } catch (error) {
    problems.push(`the screenshots were not read: ${(error as Error).message.split("\n")[0]}`);
  }
  // The entity pass over all of it: a person or place left that is not a placeholder fails the check, and so does a
  // text the pass refuses (a missing or changed model, a crash, a timeout, a script it cannot read), counted by reason.
  if (config.on) {
    let named = 0;
    const refused = new Map<string, number>();
    for (const { id, representation, text } of readable) {
      try {
        if (!pass) throw new Error("refused: the entity pass is on but was not started");
        const left = survivingEntities(text, await pass.find(text));
        if (left.length) {
          named++;
          const label = left[0]?.label === "person" ? "a person's name" : "a place";
          failures.push({ id, representation, reason: `the entity pass found ${label} that is not a placeholder` });
        }
      } catch (error) {
        const why = (error as Error).message.replace(/^refused: /, "").split("\n")[0] as string;
        refused.set(why, (refused.get(why) ?? 0) + 1);
        failures.push({ id, representation, reason: `the entity pass refused it (${why})` });
      }
    }
    if (named) problems.push(`${named} pages, records or screenshots name a person or place the entity pass found`);
    for (const [why, count] of refused)
      problems.push(`the entity pass refused ${count} pages, records or screenshots (${why})`);
  }
  const imports: { id: string; text: string }[] = [];
  for (const source of [...Object.values(SOURCES), "samples"])
    for (const name of ["IMPORT.json", "INVENTORY.json", "REDACTION.json"]) {
      const file = join(store.dir, "raw", source, name);
      if (existsSync(file)) imports.push({ id: `${source}/${name}`, text: readFileSync(file, "utf-8") });
    }
  const found = [...leaks([...records, ...imports], terms), ...leaks(imports, files)];
  if (detail)
    problems.push(
      `${detail} pages or screenshots show an address, phone, long number, street address, post box, postal code, signed name or town`,
    );
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
  const storedIds = new Set(allSamplePages.map((p) => p.id));
  const parts = (inventory?.outcomes ?? []).flatMap((o) => o.parts);
  const open = parts.filter((p) => p.item && !p.page && !p.excluded && !p.filtered).length;
  const missing = parts.filter((p) => p.page && !storedIds.has(p.page)).length;
  const orphans = [...ids].filter((id) => !parts.some((p) => p.page === id)).length;
  if (open) problems.push(`${open} parts have no outcome`);
  if (missing) problems.push(`${missing} parts name a page the store does not hold`);
  if (orphans) problems.push(`${orphans} stored pages are no part's`);
  if (found.length) problems.push(`${found.length} client terms found`);
  const code = problems.length || unaccounted ? 1 : 0;
  // A page that names someone or shows a detail is made again by the import before it is checked again; any other failure (a pass or an
  // OCR engine that could not read, see docs/glimmer/importing.md for rebuilding either) needs only the check again.
  const remake = failures.some((f) => f.reason.startsWith("the entity pass found") || f.reason.startsWith("it shows"));
  const retry = remake ? `${IMPORT_COMMAND} && ${LEAK_CHECK_COMMAND}` : LEAK_CHECK_COMMAND;
  return {
    result: { code, pages: pages.length, hits: found.length, unaccounted, problems, failures, retry },
    key,
    pages: samplePagesDigest(pages),
  };
}

// The leak check's verdict as the command prints it: the problems, then each failed page and representation (the
// first 50, then a count) and the command to run again. Opaque ids and kinds of failure only, never content.
export function leakReport(result: LeakResult): string {
  if (result.code === 0)
    return `leak-check: clean (${result.pages} pages, their screenshots read; every message and part accounted for)`;
  const lines = [
    `leak-check: failed (${[...result.problems, `${result.unaccounted} messages unaccounted for`].join("; ")})`,
  ];
  for (const failure of result.failures.slice(0, 50))
    lines.push(`  ${failure.id} ${failure.representation}: ${failure.reason}`);
  if (result.failures.length > 50)
    lines.push(`  and ${result.failures.length - 50} more (raw/samples/LEAK-CHECK.json)`);
  lines.push(`retry: ${result.retry}`);
  return lines.join("\n");
}

async function main(command: string | undefined): Promise<number> {
  const samples = join(ROOT, "samples");
  const store = openStore(storeDir());
  if (command === "leak-check") {
    const result = await leakCheck({ samples, store });
    console.log(leakReport(result));
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
    const { code, inventory } = await runImport({
      samples,
      store,
      render: (html) => reader.renderHtml(html, { pictures: false }),
      log: console.log,
    });
    console.log(
      `samples: ${JSON.stringify({ messages: inventory.messages, failed: inventory.failed.length, excluded: inventory.excluded.length, items: inventory.items, unsupported: inventory.unsupported })}`,
    );
    return code;
  } finally {
    await reader.close();
  }
}

if (import.meta.filename === process.argv[1]) process.exit(await main(process.argv[2]));
