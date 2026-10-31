// Day-zero case capture into the private training store (D03 T04 §38).
//
// Every case Loupe's users have checked is copied, read-only from production, into `<store>/capture/1.1/` so the data
// outlives the 30-day retention. Capture is private: it never calls the page importer or training, and nothing here
// publishes. The contract is `docs/glimmer/case-capture.md`.
//
// Privacy policy (coordinator decisions, 2026-10-31): a case that is `malicious` with no `false_alarm` feedback is
// captured as phishing: the sender's signals stay and only the recipient's identifiers (name, address, and their URL
// forms) are replaced. Every other case is genuine mail and takes the full redaction. A later `false_alarm` makes the
// case genuine: its earlier revisions are redacted in place to the genuine rule (record, hashes and labels stay), so
// no less-redacted copy remains anywhere. Binary and raster artefacts are withheld (hash, type and size are kept).
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import PostalMime from "postal-mime";
import {
  decodeTextEntities,
  type EntityPass,
  namePieces,
  PLACEHOLDER,
  redact,
  redactWithEntities,
  skeleton,
} from "./redact.ts";
import { insideRepository, storeDir } from "./store.ts";

export const CAPTURE_VERSION = "1.1";
// Bumped whenever the redaction or the record layout changes, so every case is captured again under the new rule.
export const POLICY_KEY = "capture-policy-3";

export type CaseRow = {
  id: string;
  org_id: string;
  channel: "email" | "upload";
  source_kind: string | null;
  status: string;
  verdict: "safe" | "suspicious" | "malicious" | null;
  run_id: string | null;
  forwarded_by: string | null;
  uploaded_by: string | null;
  original_subject: string | null;
  original_from_name: string | null;
  original_from_address: string | null;
  upload_name: string | null;
  upload_media_type: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
};
export type ArtefactRow = { r2_key: string; kind: string; sha256: string; media_type: string; bytes: number };
export type EvidenceRow = {
  id: string;
  run_id: string;
  seq: number;
  check_name: string;
  severity: string;
  summary: string;
  detail_json: string;
  artefact_keys_json: string;
  created_at: string;
};
export type CheckRow = {
  check_name: string;
  run_id: string;
  seq: number;
  outcome: string;
  reason: string | null;
  findings: number;
};
export type FeedbackRow = {
  id: string;
  user_id: string;
  kind: "false_alarm" | "missed";
  note: string | null;
  providers_json: string;
  created_at: string;
  updated_at: string;
};
export type VerdictRow = {
  verdict: string;
  headline: string;
  confidence: number;
  reasons: string;
  actions: string;
  source: string;
  created_at: string;
};
export type Person = { name: string | null; email: string | null };
export type CaseDetail = {
  artefacts: ArtefactRow[];
  evidence: EvidenceRow[];
  checks: CheckRow[];
  feedback: FeedbackRow[];
  verdict: VerdictRow | null;
  members: Person[];
};
// Where a case comes from. Production's is `capture-source.ts`; a test gives a synthetic one.
export type CaptureSource = {
  cases(after: string | null, limit: number): Promise<CaseRow[]>;
  // The case row again, for the second metadata read that proves a snapshot was coherent; null when it is gone.
  row(id: string): Promise<CaseRow | null>;
  detail(row: CaseRow): Promise<CaseDetail>;
  // The object's bytes, or null when it cannot be read now (missing or a failed read: either way retryable).
  object(key: string): Promise<Uint8Array | null>;
};

export type Policy = "phishing" | "genuine";

export function policyFor(verdict: CaseRow["verdict"], feedback: { kind: string }[]): Policy {
  return verdict === "malicious" && !feedback.some((f) => f.kind === "false_alarm") ? "phishing" : "genuine";
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

// Sorted-key JSON, so a fingerprint does not depend on property order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------------------------------------------
// The recipient: who checked the case. Their identifiers are what every policy removes.
// ---------------------------------------------------------------------------------------------------------------
export type Recipient = {
  addresses: string[];
  names: string[];
  // The words of display names only: a name a person was given, unlike a mailbox's local part (`check`, `info`).
  displayNames: string[];
  domains: string[];
  certified: boolean;
};

const PUBLIC_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\./;
const ADDRESS_IN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function recipientOf(row: CaseRow, detail: CaseDetail, mailPeople: Person[] = []): Recipient {
  const people: Person[] = [...detail.members, ...mailPeople];
  if (row.forwarded_by) people.push({ name: null, email: row.forwarded_by });
  const addresses = new Set<string>();
  const names = new Set<string>();
  const displayNames = new Set<string>();
  for (const p of people) {
    for (const piece of namePieces(p.name ?? undefined, undefined)) displayNames.add(piece);
    if (p.email) addresses.add(p.email.trim().toLowerCase());
    for (const piece of namePieces(p.name ?? undefined, p.email ?? undefined)) names.add(piece);
  }
  const domains = [...addresses].map((a) => a.split("@")[1] ?? "").filter((d) => d && !PUBLIC_MAIL.test(d));
  // Fail closed: a case whose checker cannot be identified, or an upload whose uploader record is gone, cannot be
  // certified, so none of its payloads are kept.
  const uploaderGone = row.channel === "upload" && !!row.uploaded_by && !detail.members.length;
  const certified = addresses.size > 0 && !uploaderGone;
  return {
    addresses: [...addresses].filter(Boolean),
    names: [...names],
    displayNames: [...displayNames],
    domains: [...new Set(domains)],
    certified,
  };
}

// The recipient's address in the forms a lure link or header carries it.
function forms(recipient: Recipient): { addressForms: string[]; nameForms: string[] } {
  const out = new Set<string>();
  for (const a of recipient.addresses) {
    out.add(a);
    out.add(encodeURIComponent(a));
    out.add(Buffer.from(a).toString("base64").replace(/=+$/, ""));
    out.add(Buffer.from(a).toString("base64url"));
    out.add(Buffer.from(a).toString("hex"));
  }
  return { addressForms: [...out].filter((x) => x.length >= 4), nameForms: recipient.names };
}

// RFC 2047 encoded words (`=?UTF-8?B?QWxpY2U=?=`) read as a mail client reads them, so a name hidden in one is found.
export function decodeMimeWords(text: string): string {
  return text.replace(
    /=\?([A-Za-z0-9_-]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Buffer.from(data, "base64")
            : Buffer.from(
                data
                  .replace(/_/g, " ")
                  .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
                "latin1",
              );
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      } catch {
        return whole;
      }
    },
  );
}

// A token (a link's query value, say) that decodes, as base64, base64url or hex, to text holding one of the recipient's
// addresses in any letter case: the forms above only cover the spellings written in the data, not `Alice@Example.com`.
const TOKEN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
function tokenHides(token: string, addresses: string[]): boolean {
  const decodings: string[] = [
    Buffer.from(token, "base64").toString("utf8"),
    Buffer.from(token, "base64url").toString("utf8"),
  ];
  if (/^(?:[0-9a-f]{2})+$/i.test(token)) decodings.push(Buffer.from(token, "hex").toString("utf8"));
  return decodings.some((d) => addresses.some((a) => d.toLowerCase().includes(a)));
}

// Percent escapes read as a browser reads a URL (`%41lice%40Example.com`), by whole string or, failing that, escape by
// escape.
export function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Only the recipient is removed. Text written with character references (`Al&#105;ce`) is read as the browser reads it
// when that shows a recipient term, so an encoded name does not slip past.
export function scrubRecipient(text: string, recipient: Recipient): string {
  const { addressForms, nameForms } = forms(recipient);
  const addressRules = [...addressForms].sort((a, b) => b.length - a.length).map((f) => new RegExp(escapeRe(f), "gi"));
  const nameRules = [...nameForms]
    .sort((a, b) => b.length - a.length)
    .map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"));
  const hits = (s: string) =>
    [...addressRules, ...nameRules].some((r) => new RegExp(r.source, r.flags.replace("g", "")).test(s));
  // Character references and encoded words are read as a reader reads them when that shows a recipient term.
  const decoded = percentDecode(decodeMimeWords(decodeTextEntities(text)));
  let out = decoded !== text && hits(decoded) ? decoded : text;
  for (const r of addressRules) out = out.replace(r, PLACEHOLDER.email);
  for (const r of nameRules) out = out.replace(r, PLACEHOLDER.name);
  return out.replace(TOKEN, (t) => (tokenHides(t, recipient.addresses) ? PLACEHOLDER.email : t));
}

// The check after cleaning: whether a recipient identifier is still in `text` once look-alike letters are folded, as a
// reader would see it. A case where one survives is failed, never published (fail closed).
export function survivingIdentifier(text: string, recipient: Recipient): boolean {
  const { addressForms } = forms(recipient);
  const names = recipient.displayNames.map(
    (n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(skeleton(n).toLowerCase())}(?![\\p{L}\\p{N}])`, "u"),
  );
  // Every way a reader can come to read the text: as written, with character references, encoded words and percent
  // escapes read, and with its tags dropped (so a name split by markup joins up).
  const entities = decodeTextEntities(text);
  const chain = percentDecode(decodeMimeWords(entities));
  const views = new Set([text, entities, chain, visibleText(text), visibleText(chain)]);
  for (const view of views) {
    const seen = skeleton(view).toLowerCase();
    if (addressForms.some((f) => seen.includes(skeleton(f).toLowerCase()))) return true;
    if ((seen.match(TOKEN) ?? []).some((t) => tokenHides(t, recipient.addresses))) return true;
    if (names.some((re) => re.test(seen))) return true;
  }
  return false;
}

// Structure, not content: a field the capture itself names or the pipeline sets is not text a person wrote.
const STRUCTURAL = new Set([
  "key",
  "check",
  "check_name",
  "id",
  "run_id",
  "severity",
  "outcome",
  "kind",
  "status",
  "channel",
  "policy",
  "source",
  "source_kind",
  "media_type",
  "user",
  "name",
]);

// The check over a JSON document: only its string values, never its keys or its structural fields.
export function survivingInJson(value: unknown, recipient: Recipient, key = ""): boolean {
  if (typeof value === "string") return !STRUCTURAL.has(key) && survivingIdentifier(value, recipient);
  if (Array.isArray(value)) return value.some((v) => survivingInJson(v, recipient, key));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([k, v]) => (!STRUCTURAL.has(k) && survivingIdentifier(k, recipient)) || survivingInJson(v, recipient, k),
    );
  return false;
}

// Embedded binary (a `data:` URI) cannot be cleared of a recipient's identifiers, so it is withheld in place.
const EMBEDDED = /data:[a-z0-9.+/-]*(?:;[a-z0-9=.+-]+)*[;,][^\s"'()<>]*/gi;
export const WITHHELD_EMBEDDED = "data:withheld";
export const WITHHELD_FIELD = "[withheld: recipient identifier survived cleaning]";

// What a reader sees of markup: tags dropped (so `Al<span>ice</span>` reads `Alice`) and character references read.
export function visibleText(markup: string): string {
  return decodeTextEntities(markup.replace(/<[^>]*>/g, ""));
}

export type Cleaner = {
  // Whether a recipient identifier is still in `value`, read as markup is read.
  survives(value: string): boolean;
  text(value: string): Promise<string>;
  // A header, link, filename or key: only the recipient goes, under both policies, so the sender's signals stay.
  signal(value: string): string;
  // Free text a person wrote: always the full rule.
  prose(value: string): Promise<string>;
};

export function cleanerFor(policy: Policy, recipient: Recipient, pass: EntityPass | null): Cleaner {
  const names = recipient.names;
  const full = async (v: string) =>
    pass ? redactWithEntities(v, names, recipient.domains, pass, true) : redact(v, names, recipient.domains);
  const inert = (v: string) => v.replace(EMBEDDED, WITHHELD_EMBEDDED);
  // The scrub is best effort; this is the guarantee. A string that still shows the recipient in any way a reader can
  // read it is not kept: the field is withheld, whatever form the identifier took.
  const guard = (v: string) => (survivingIdentifier(v, recipient) ? WITHHELD_FIELD : v);
  return {
    survives: (v) => survivingIdentifier(v, recipient),
    signal: (v) => guard(scrubRecipient(v, recipient)),
    text: async (v) =>
      guard(
        policy === "phishing" ? scrubRecipient(inert(v), recipient) : scrubRecipient(await full(inert(v)), recipient),
      ),
    prose: async (v) => guard(scrubRecipient(await full(v), recipient)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// One case's payloads.
// ---------------------------------------------------------------------------------------------------------------
export type Payload =
  | {
      key: string;
      kind: string;
      status: "kept";
      media_type: string;
      source_sha256: string;
      bytes: number;
      file: string;
      sha256: string;
    }
  | {
      key: string;
      kind: string;
      status: "withheld";
      reason: string;
      media_type: string;
      source_sha256: string;
      bytes: number;
    };

const TEXT_TYPES = /^(text\/|application\/json|message\/rfc822|application\/(?:xml|xhtml\+xml))/i;
const MAX_TEXT = 8 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });
const hexOnly = /^[0-9a-f]{32,}$/i;
const SIGNAL_KEYS = /^(sha256|digest|md5|sha1|spf|dkim|dmarc|arc|hash)$/i;

// JSON is walked, never run through the prose redactor whole. A hash or an authentication value is not rewritten as
// prose, but the recipient's identifiers (an address in an `spf` value, or a hex form of one) still go.
export async function cleanJson(value: unknown, cleaner: Cleaner, key = ""): Promise<unknown> {
  if (typeof value === "string") {
    if (hexOnly.test(value) || SIGNAL_KEYS.test(key)) return cleaner.signal(value);
    return cleaner.text(value);
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => cleanJson(v, cleaner, key)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // A property name is text too: an address can be a key.
    for (const [k, v] of Object.entries(value)) out[cleaner.signal(k)] = await cleanJson(v, cleaner, k);
    return out;
  }
  return value;
}

type Mail = Awaited<ReturnType<typeof PostalMime.parse>>;
const AUTH_HEADER = /^(authentication-results|received-spf|arc-authentication-results)$/i;
const MAX_NESTED = 2;

function peopleFromText(text: string): Person[] {
  const out: Person[] = [];
  for (const m of text.matchAll(/^[ \t>]*(?:to|cc|bcc|delivered-to|x-original-to)[ \t]*:[ \t]*(.+)$/gim)) {
    for (const a of (m[1] ?? "").matchAll(ADDRESS_IN)) out.push({ name: null, email: a[0] });
    const named = (m[1] ?? "").match(/^"?([^"<@]{2,80}?)"?\s*</);
    if (named?.[1]) out.push({ name: named[1].trim(), email: null });
  }
  return out;
}

const asBytes = (content: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

// Everyone a message names as a recipient, or as the person who forwarded it: its outer headers, the forwarder in the
// outer `From`, every nested message, and the recipient lines of a forward written into the body.
export async function discoverPeople(bytes: Uint8Array, depth = 0, forwarded = true): Promise<Person[]> {
  const mail: Mail = await PostalMime.parse(bytes);
  const listed = [...(mail.to ?? []), ...(mail.cc ?? []), ...(mail.bcc ?? [])].flatMap((a) =>
    "group" in a && a.group ? a.group : [a],
  ) as { name?: string; address?: string }[];
  const delivered = (mail.headers ?? [])
    .filter((h) => /^(delivered-to|x-original-to)$/i.test(h.key))
    .map((h) => ({ name: "", address: h.value.replace(/^.*?<?([^\s<>]+@[^\s<>]+)>?.*$/, "$1") }));
  const out: Person[] = [...listed, ...delivered].map((p) => ({ name: p.name || null, email: p.address || null }));
  // Only the outermost message's `From` is the forwarder; an inner `From` is the sender being checked.
  if (forwarded && depth === 0 && mail.from?.address)
    out.push({ name: mail.from.name || null, email: mail.from.address });
  out.push(...peopleFromText(mail.text ?? ""));
  out.push(...peopleFromText((mail.html ?? "").replace(/<[^>]+>/g, "\n")));
  if (depth < MAX_NESTED)
    for (const a of mail.attachments)
      if (/^message\/rfc822$/i.test(a.mimeType))
        out.push(...(await discoverPeople(asBytes(a.content), depth + 1, forwarded)));
  return out;
}

// A raw message, parsed structurally and cleaned part by part. Typed signals are lifted out of the parse: the sender's
// domain, the authentication results, the link hosts and the attachments' hashes (never their bytes). A nested message
// is captured the same way, inside its parent.
export async function captureMail(bytes: Uint8Array, cleaner: Cleaner, policy: Policy, depth = 0): Promise<unknown> {
  const mail: Mail = await PostalMime.parse(bytes);
  const headers = mail.headers.map((h) => ({ key: h.key, value: cleaner.signal(h.value) }));
  const html = mail.html ?? null;
  const links = [...new Set([...(html ?? mail.text ?? "").matchAll(/https?:\/\/[^\s"'<>)]+/gi)].map((m) => m[0]))];
  const linkHosts = [
    ...new Set(
      links
        .map((l) => {
          try {
            return new URL(l).hostname.toLowerCase();
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ];
  const sender = mail.from?.address?.toLowerCase() ?? "";
  const nested: unknown[] = [];
  const attachments: unknown[] = [];
  for (const a of mail.attachments) {
    const content = asBytes(a.content);
    attachments.push({
      filename: a.filename ? cleaner.signal(a.filename) : null,
      media_type: a.mimeType,
      bytes: content.byteLength,
      sha256: sha256(content),
    });
    if (/^message\/rfc822$/i.test(a.mimeType) && depth < MAX_NESTED)
      nested.push(await captureMail(content, cleaner, policy, depth + 1));
  }
  const cleanedHtmlAll = html ? await cleaner.text(html) : null;
  // Markup that still shows the recipient once read as a browser reads it is not kept (fail closed).
  const cleanedHtml = cleanedHtmlAll === WITHHELD_FIELD ? null : cleanedHtmlAll;
  return {
    policy,
    signals: {
      sender_domain: sender.split("@")[1] ?? null,
      authentication: mail.headers
        .filter((h) => AUTH_HEADER.test(h.key))
        .map((h) => ({ key: h.key, value: cleaner.signal(h.value) })),
      link_hosts: linkHosts,
      links: links.map((l) => cleaner.signal(l)),
      attachments,
    },
    headers,
    subject: mail.subject ? await cleaner.text(mail.subject) : null,
    text: mail.text ? await cleaner.text(mail.text) : null,
    html: cleanedHtml,
    html_withheld: html !== null && cleanedHtml === null ? "recipient identifier split across markup" : null,
    nested,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The revision: one immutable folder per distinct state of a case.
// ---------------------------------------------------------------------------------------------------------------
// What decides a case's state, taken from the source alone: the same fingerprint is reached without reading any object,
// so an unchanged case costs no download. The recipient is a function of this state (the members, the forwarding
// address and the raw message, whose hash is among the artefacts), so it need not be part of it.
export function fingerprint(row: CaseRow, detail: CaseDetail): string {
  return sha256(
    canonical({
      row,
      detail: {
        ...detail,
        // Feedback notes are personal text: the fingerprint holds their hash, not the note.
        feedback: detail.feedback.map((f) => ({ ...f, note: f.note === null ? null : sha256(f.note) })),
      },
      policy: POLICY_KEY,
    }),
  );
}

export type Manifest = {
  version: string;
  case_id: string;
  channel: string;
  fingerprint: string;
  policy: Policy;
  // The rules the revision was cleaned under: an older one is re-cleaned in place when the rules change.
  policy_key?: string;
  certified: boolean;
  verdict: string | null;
  captured_at: string;
  recipient_digest: string;
  payloads: Payload[];
  record: string;
  redacted_in_place?: { at: string; reason: "false_alarm" | "policy_update"; from_policy: Policy };
};

export type Layout = {
  root: string;
  cases: string;
  scratch: string;
  stats: string;
  statsMd: string;
  status: string;
  progress: string;
  lock: string;
};

export function layoutOf(dir: string): Layout {
  const root = join(dir, "capture", CAPTURE_VERSION);
  return {
    root,
    cases: join(root, "cases"),
    scratch: join(root, ".scratch"),
    stats: join(root, "stats.json"),
    statsMd: join(root, "STATS.md"),
    status: join(root, "last-run.json"),
    progress: join(root, "progress.json"),
    lock: join(root, ".lock"),
  };
}

function flush(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Written to a temporary name, flushed, renamed over the target, and the folder flushed too, so a power cut leaves the
// old file or the whole new one.
export function writeAtomic(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    flush(tmp);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  flush(dirname(path));
}

// The external root, resolved before any write: never in a git work tree, and never reached through a symlink that
// leaves the folder it names. With `create` false it only checks, and writes nothing.
export function resolveRoot(dir: string = storeDir(), create = true): string {
  const full = resolve(dir);
  if (insideRepository(full)) throw new Error("capture: the store lies in a git work tree");
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (insideRepository(real)) throw new Error("capture: the store resolves into a git work tree");
  }
  if (!create) return full;
  mkdirSync(full, { recursive: true, mode: 0o700 });
  return realpathSync(full);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// One writer at a time. A lock whose process is gone is taken over; a live one refuses.
export function takeLock(layout: Layout): () => void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(layout.lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(layout.lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(layout.lock, "utf-8"), 10);
      if (Number.isInteger(holder) && processAlive(holder)) throw new Error("capture: another capture holds the lock");
      rmSync(layout.lock, { force: true });
    }
  }
  throw new Error("capture: the lock could not be taken");
}

// Recovery at the start of a run, when this process holds the lock and so nothing else is writing: a temporary
// revision folder left by a writer that is gone was never published, and an R2 download left in the scratch folder is
// unredacted mail that must not stay.
export function sweepInterrupted(layout: Layout): number {
  let removed = 0;
  const drop = (path: string) => {
    rmSync(path, { recursive: true, force: true });
    removed++;
  };
  if (existsSync(layout.scratch)) for (const name of readdirSync(layout.scratch)) drop(join(layout.scratch, name));
  // The lock is held, so nothing else is writing: every temporary name below is the debris of a run that ended
  // early, a half-written revision folder or a half-written file (a marker's holds the recipient's identifiers).
  const stale = /\.tmp-\d+-[0-9a-f]+$|^\.tmp-\d+-/;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (stale.test(entry.name)) drop(path);
      else if (entry.isDirectory() && entry.name !== ".scratch") walk(path);
    }
  };
  if (existsSync(layout.root)) walk(layout.root);
  return removed;
}

export type Outcome =
  | { case_id: string; result: "added"; fingerprint: string; policy: Policy; withheld: number; kept: number }
  | { case_id: string; result: "unchanged" }
  | { case_id: string; result: "retry"; reason: string; missing?: number }
  | { case_id: string; result: "failed"; reason: string };

// `step` is called at each boundary of a publication, so a test can interrupt exactly there.
export type CaptureOptions = { pass?: EntityPass | null; now?: () => Date; step?: (name: string) => void };

function readLatest(layout: Layout, id: string): { fingerprint: string } | null {
  const file = join(layout.cases, id, "LATEST.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as { fingerprint: string };
  } catch {
    return null;
  }
}

const sha256File = (path: string) => sha256(readFileSync(path));

// Whether a stored revision still holds what its manifest says, file by file; the reason when it does not.
export function verifyRevision(dir: string): string | null {
  const manifestFile = join(dir, "manifest.json");
  if (!existsSync(manifestFile)) return "no manifest";
  try {
    const m = JSON.parse(readFileSync(manifestFile, "utf-8")) as Manifest;
    if (!existsSync(join(dir, "record.json")) || sha256File(join(dir, "record.json")) !== m.record) return "record";
    for (const p of m.payloads)
      if (p.status === "kept" && (!existsSync(join(dir, p.file)) || sha256File(join(dir, p.file)) !== p.sha256))
        return "payload";
    return null;
  } catch {
    return "manifest";
  }
}

type Built = { manifest: Manifest; files: Map<string, string | Uint8Array> };

async function build(
  source: CaptureSource,
  row: CaseRow,
  detail: CaseDetail,
  policy: Policy,
  recipient: Recipient,
  fp: string,
  options: CaptureOptions,
): Promise<Built | { retry: string; missing: number } | { failed: string }> {
  const cleaner = cleanerFor(policy, recipient, options.pass ?? null);
  const files = new Map<string, string | Uint8Array>();
  const payloads: Payload[] = [];
  let index = 0;
  let missing = 0;
  let failure: string | null = null;
  for (const a of detail.artefacts) {
    const base = {
      key: cleaner.signal(a.r2_key),
      kind: a.kind,
      media_type: a.media_type,
      source_sha256: a.sha256,
      bytes: a.bytes,
    };
    const textual = TEXT_TYPES.test(a.media_type) && a.bytes <= MAX_TEXT;
    if (!textual || !recipient.certified) {
      payloads.push({
        ...base,
        status: "withheld",
        reason: !recipient.certified ? "recipient identity unknown" : "binary or raster data cannot be cleared",
      });
      continue;
    }
    const bytes = await source.object(a.r2_key);
    if (!bytes) {
      missing++;
      continue;
    }
    if (sha256(bytes) !== a.sha256) {
      failure = "an artefact's digest does not match its record";
      continue;
    }
    const file = `p${index++}.json`;
    const isMail = a.kind === "raw" && /rfc822/i.test(a.media_type);
    let content: unknown;
    if (isMail) content = await captureMail(bytes, cleaner, policy);
    else if (/json/i.test(a.media_type)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(bytes));
      } catch {
        parsed = undefined;
      }
      // JSON is processed structurally; text that is not valid JSON is cleaned as text.
      content =
        parsed === undefined
          ? { policy, text: await cleaner.text(decoder.decode(bytes)) }
          : { policy, json: await cleanJson(parsed, cleaner) };
    } else {
      const cleaned = await cleaner.text(decoder.decode(bytes));
      content =
        cleaned === WITHHELD_FIELD
          ? { policy, text: null, text_withheld: "recipient identifier split across markup" }
          : { policy, text: cleaned };
    }
    const body = JSON.stringify(content);
    if (survivingInJson(content, recipient)) {
      failure = `a recipient identifier survived cleaning (${a.kind} ${a.media_type.split(";")[0]})`;
      continue;
    }
    files.set(file, body);
    payloads.push({ ...base, status: "kept", file, sha256: sha256(body) });
  }
  if (failure) return { failed: failure };
  if (missing) return { retry: "an artefact could not be read", missing };
  const evidence = await Promise.all(
    detail.evidence.map(async (e) => ({
      id: e.id,
      run_id: e.run_id,
      check: e.check_name,
      severity: e.severity,
      summary: await cleaner.text(e.summary),
      detail: await cleanJson(safeParse(e.detail_json), cleaner),
      artefact_keys: (safeParse(e.artefact_keys_json) as string[] | null)?.map((k) => cleaner.signal(String(k))) ?? [],
      created_at: e.created_at,
    })),
  );
  const feedback = await Promise.all(
    detail.feedback.map(async (f) => ({
      kind: f.kind,
      user: sha256(f.user_id).slice(0, 16),
      note: f.note === null ? null : await cleaner.prose(f.note),
      providers: safeParse(f.providers_json),
      created_at: f.created_at,
      updated_at: f.updated_at,
    })),
  );
  const record = {
    case: {
      id: row.id,
      channel: row.channel,
      source_kind: row.source_kind,
      status: row.status,
      verdict: row.verdict,
      run_id: row.run_id ?? row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // Null unless a validated source field supplies them; never inferred from free text.
      category: null,
      lure_type: null,
      original_subject: row.original_subject ? await cleaner.text(row.original_subject) : null,
      original_from_address: row.original_from_address ? cleaner.signal(row.original_from_address) : null,
      upload_media_type: row.upload_media_type,
    },
    verdict: detail.verdict
      ? {
          verdict: detail.verdict.verdict,
          headline: await cleaner.text(detail.verdict.headline),
          confidence: detail.verdict.confidence,
          reasons: await cleanJson(safeParse(detail.verdict.reasons), cleaner),
          actions: await cleanJson(safeParse(detail.verdict.actions), cleaner),
          source: detail.verdict.source,
          created_at: detail.verdict.created_at,
        }
      : null,
    evidence,
    checks: detail.checks,
    feedback,
  };
  const recordBody = JSON.stringify(record);
  if (survivingInJson(record, recipient)) return { failed: "a recipient identifier survived cleaning (record)" };
  files.set("record.json", recordBody);
  const manifest: Manifest = {
    version: CAPTURE_VERSION,
    case_id: row.id,
    channel: row.channel,
    fingerprint: fp,
    policy,
    policy_key: POLICY_KEY,
    certified: recipient.certified,
    verdict: row.verdict,
    captured_at: (options.now?.() ?? new Date()).toISOString(),
    recipient_digest: sha256(canonical([recipient.addresses, recipient.names, recipient.domains])),
    payloads,
    record: sha256(recordBody),
  };
  return { manifest, files };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function redactNested(node: unknown, cleaner: Cleaner, target: Policy): Promise<unknown> {
  const stored = node as Record<string, unknown>;
  const next: Record<string, unknown> = { ...stored, policy: target };
  for (const field of ["subject", "text", "html"] as const)
    if (typeof stored[field] === "string") next[field] = await cleaner.text(stored[field] as string);
  if (Array.isArray(stored.nested))
    next.nested = await Promise.all(stored.nested.map((n) => redactNested(n, cleaner, target)));
  return next;
}

// The one permitted change to a stored revision. After a `false_alarm`, a phishing revision is redacted to the genuine
// rule where it stands: each stored file is read, its own text is cleaned, and it is written back atomically. The
// revision keeps its own record, labels, feedback, evidence and hashes; nothing from a newer revision replaces them.
async function redactStored(
  dir: string,
  cleanerFor_: (policy: Policy) => Cleaner,
  now: Date,
  current: Policy,
): Promise<boolean> {
  const manifestFile = join(dir, "manifest.json");
  const old = JSON.parse(readFileSync(manifestFile, "utf-8")) as Manifest;
  // A revision never gets a weaker rule than its own: only a false alarm turns phishing into genuine.
  const falseAlarm = old.policy === "phishing" && current === "genuine";
  const target: Policy = falseAlarm ? "genuine" : old.policy;
  const cleaner = cleanerFor_(target);
  if (!falseAlarm && old.policy_key === POLICY_KEY) return false;
  const payloads: Payload[] = [];
  for (const p of old.payloads) {
    if (p.status !== "kept") {
      payloads.push(p);
      continue;
    }
    const stored = JSON.parse(readFileSync(join(dir, p.file), "utf-8")) as Record<string, unknown>;
    const next = (await redactNested(stored, cleaner, target)) as Record<string, unknown>;
    if ("json" in stored) next.json = await cleanJson(stored.json, cleaner);
    const body = JSON.stringify(next);
    writeAtomic(join(dir, p.file), body);
    payloads.push({ ...p, sha256: sha256(body) });
  }
  const stored = JSON.parse(readFileSync(join(dir, "record.json"), "utf-8"));
  const recordBody = JSON.stringify(await cleanJson(stored, cleaner));
  writeAtomic(join(dir, "record.json"), recordBody);
  writeAtomic(
    manifestFile,
    JSON.stringify({
      ...old,
      policy: target,
      policy_key: POLICY_KEY,
      payloads,
      record: sha256(recordBody),
      redacted_in_place: {
        at: now.toISOString(),
        reason: falseAlarm ? "false_alarm" : "policy_update",
        from_policy: old.policy,
      },
    } satisfies Manifest),
  );
  return true;
}

const pendingFile = (caseDir: string) => join(caseDir, "PENDING-REDACTION.json");

// Earlier revisions of a case that need redacting in place: a phishing one once the case is genuine (a false alarm),
// and any one cleaned under older rules.
function staleRevisions(caseDir: string, keep: string, current: Policy): string[] {
  return readdirSync(caseDir).filter((name) => {
    if (name === keep || name.startsWith(".") || !existsSync(join(caseDir, name, "manifest.json"))) return false;
    try {
      const m = JSON.parse(readFileSync(join(caseDir, name, "manifest.json"), "utf-8")) as Manifest;
      return m.policy_key !== POLICY_KEY || (m.policy === "phishing" && current === "genuine");
    } catch {
      return false;
    }
  });
}

export async function captureCase(
  upstream: CaptureSource,
  layout: Layout,
  start: CaseRow,
  options: CaptureOptions = {},
): Promise<Outcome> {
  // An object is read once per case, however many steps want it.
  const seen = new Map<string, Uint8Array | null>();
  const source: CaptureSource = {
    ...upstream,
    object: async (key) => {
      if (!seen.has(key)) seen.set(key, await upstream.object(key));
      return seen.get(key) ?? null;
    },
  };
  let row = start;
  const caseDir = join(layout.cases, row.id);
  const step = (name: string) => options.step?.(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = await source.detail(row);
    const policy = policyFor(row.verdict, detail.feedback);
    const fp = fingerprint(row, detail);
    const revision = join(caseDir, fp);
    const latest = readLatest(layout, row.id);
    const pending = existsSync(pendingFile(caseDir));
    const intact = existsSync(revision) && verifyRevision(revision) === null;
    // Unchanged means no download at all: the same state, a verified revision and no privacy work waiting.
    if (latest?.fingerprint === fp && intact && !pending) return { case_id: row.id, result: "unchanged" };
    // The recipient may also be named in the raw message's own headers, nested messages and forwarded lines.
    const people: Person[] = [];
    for (const raw of detail.artefacts.filter((a) => a.kind === "raw" && /rfc822/i.test(a.media_type))) {
      if (raw.bytes > MAX_TEXT) continue;
      const bytes = await source.object(raw.r2_key);
      if (!bytes) return { case_id: row.id, result: "retry", reason: "the raw message could not be read", missing: 1 };
      try {
        // An uploaded original message is the lure itself: its outer sender is the attacker, not a forwarder.
        people.push(...(await discoverPeople(bytes, 0, row.channel === "email")));
      } catch {
        /* a message that does not parse names no recipient here; the case is uncertified without any identity */
      }
    }
    const recipient = recipientOf(row, detail, people);
    const built = intact ? null : await build(source, row, detail, policy, recipient, fp, options);
    if (built && "retry" in built)
      return { case_id: row.id, result: "retry", reason: built.retry, missing: built.missing };
    if (built && "failed" in built) return { case_id: row.id, result: "failed", reason: built.failed };
    // The second read of the source: a case that changed while its objects were downloaded is read again.
    const again = await upstream.row(row.id);
    if (!again) return { case_id: row.id, result: "retry", reason: "the case disappeared during collection" };
    if (fingerprint(again, await upstream.detail(again)) !== fp) {
      if (attempt === 0) {
        row = again;
        continue;
      }
      return { case_id: row.id, result: "retry", reason: "the case kept changing during collection" };
    }
    mkdirSync(caseDir, { recursive: true, mode: 0o700 });
    // Privacy work is recorded before the pointer moves, so an interruption leaves a marker the next run finishes.
    if (staleRevisions(caseDir, fp, policy).length) {
      // The marker carries what the redaction needs, so it can finish without production: it is removed with the work.
      writeAtomic(pendingFile(caseDir), JSON.stringify({ fingerprint: fp, recipient, policy }));
      step("pending-written");
    }
    if (built && "manifest" in built) {
      const tmp = join(caseDir, `.tmp-${process.pid}-${fp.slice(0, 12)}`);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { mode: 0o700 });
      for (const [name, data] of built.files) {
        writeFileSync(join(tmp, name), data, { mode: 0o600 });
        flush(join(tmp, name));
      }
      writeFileSync(join(tmp, "manifest.json"), JSON.stringify(built.manifest), { mode: 0o600 });
      flush(join(tmp, "manifest.json"));
      flush(tmp);
      step("revision-built");
      // A revision found damaged is replaced by the one just built from the source.
      rmSync(revision, { recursive: true, force: true });
      renameSync(tmp, revision);
      flush(caseDir);
    }
    step("revision-published");
    writeAtomic(join(caseDir, "LATEST.json"), JSON.stringify({ fingerprint: fp }));
    step("pointer-moved");
    if (existsSync(pendingFile(caseDir))) {
      for (const name of staleRevisions(caseDir, fp, policy)) {
        await redactStored(
          join(caseDir, name),
          (p) => cleanerFor(p, recipient, options.pass ?? null),
          options.now?.() ?? new Date(),
          policy,
        );
        step("revision-redacted");
      }
      rmSync(pendingFile(caseDir), { force: true });
      flush(caseDir);
    }
    const manifest = JSON.parse(readFileSync(join(revision, "manifest.json"), "utf-8")) as Manifest;
    return {
      case_id: row.id,
      result: "added",
      fingerprint: fp,
      policy,
      withheld: manifest.payloads.filter((p) => p.status === "withheld").length,
      kept: manifest.payloads.filter((p) => p.status === "kept").length,
    };
  }
  return { case_id: row.id, result: "retry", reason: "the case kept changing during collection" };
}

// ---------------------------------------------------------------------------------------------------------------
// A whole run and its stats.
// ---------------------------------------------------------------------------------------------------------------
export type Stats = {
  generated_at: string;
  // This scan's production population, counted apart from what the store holds.
  production: { seen: number; captured_now: number; waiting_to_retry: number; failed: number };
  // The store: every case ever captured, whether or not production still holds it.
  store: { cases: number; historical_only: number; uncertified: number; integrity_failures: number };
  by_channel: Record<string, number>;
  by_verdict: Record<string, number>;
  by_category: Record<string, number>;
  by_lure_type: Record<string, number>;
  payloads: { kept: number; withheld: number; missing_in_scan: number };
  payloads_by_channel_verdict: Record<string, { kept: number; withheld: number }>;
  artefacts_by_kind: Record<string, number>;
  withheld_reasons: Record<string, number>;
};

function bump(map: Record<string, number>, key: string | null | undefined, by = 1) {
  const k = key ?? "unknown";
  map[k] = (map[k] ?? 0) + by;
}

export type ScanFacts = {
  seen: string[];
  // The cases whose latest revision matches production as read in this scan.
  current: string[];
  retry: number;
  failed: number;
  missing: number;
  integrity: number;
};

// Built from each case's latest committed revision only, so a case counts once however many revisions it holds.
export function buildStats(layout: Layout, scan: ScanFacts, now: Date): Stats {
  const seen = new Set(scan.seen);
  const current = new Set(scan.current);
  const stats: Stats = {
    generated_at: now.toISOString(),
    production: { seen: seen.size, captured_now: 0, waiting_to_retry: scan.retry, failed: scan.failed },
    store: { cases: 0, historical_only: 0, uncertified: 0, integrity_failures: scan.integrity },
    by_channel: {},
    by_verdict: {},
    by_category: {},
    by_lure_type: {},
    payloads: { kept: 0, withheld: 0, missing_in_scan: scan.missing },
    payloads_by_channel_verdict: {},
    artefacts_by_kind: {},
    withheld_reasons: {},
  };
  if (!existsSync(layout.cases)) return stats;
  for (const id of readdirSync(layout.cases).sort()) {
    const latest = readLatest(layout, id);
    if (!latest) continue;
    const file = join(layout.cases, id, latest.fingerprint, "manifest.json");
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf-8")) as Manifest;
    stats.store.cases++;
    if (current.has(id)) stats.production.captured_now++;
    if (!seen.has(id)) stats.store.historical_only++;
    bump(stats.by_channel, m.channel);
    bump(stats.by_verdict, m.verdict);
    bump(stats.by_category, null);
    bump(stats.by_lure_type, null);
    if (!m.certified) stats.store.uncertified++;
    const cell = `${m.channel}/${m.verdict ?? "unknown"}`;
    const entry = stats.payloads_by_channel_verdict[cell] ?? { kept: 0, withheld: 0 };
    // A damaged revision holds nothing countable: it is an integrity failure, not kept payloads.
    const sound = verifyRevision(join(layout.cases, id, latest.fingerprint)) === null;
    for (const p of sound ? m.payloads : []) {
      stats.payloads[p.status]++;
      entry[p.status]++;
      bump(stats.artefacts_by_kind, p.kind);
      if (p.status === "withheld") bump(stats.withheld_reasons, p.reason);
    }
    stats.payloads_by_channel_verdict[cell] = entry;
  }
  return stats;
}

export function statsMarkdown(s: Stats): string {
  const table = (title: string, m: Record<string, number>) =>
    `## ${title}\n\n${
      Object.entries(m)
        .sort()
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n") || "- none"
    }\n`;
  const cells = Object.entries(s.payloads_by_channel_verdict)
    .sort()
    .map(([k, v]) => `- ${k}: kept ${v.kept}, withheld ${v.withheld}`)
    .join("\n");
  return [
    "# Day-zero case capture",
    "",
    `Generated ${s.generated_at}. Private: counts only, no case content.`,
    "",
    `Production this scan: seen ${s.production.seen}, captured ${s.production.captured_now}, waiting to retry ${s.production.waiting_to_retry}, failed ${s.production.failed}.`,
    "",
    `Store: ${s.store.cases} cases (${s.store.historical_only} no longer in production), not certified ${s.store.uncertified}, integrity failures ${s.store.integrity_failures}.`,
    "",
    `Payloads kept: ${s.payloads.kept}. Withheld: ${s.payloads.withheld}. Unreadable this scan: ${s.payloads.missing_in_scan}.`,
    "",
    table("By channel", s.by_channel),
    table("By verdict", s.by_verdict),
    table("By category", s.by_category),
    table("By lure type", s.by_lure_type),
    table("Artefacts by kind", s.artefacts_by_kind),
    table("Withheld reasons", s.withheld_reasons),
    `## Payloads by channel and verdict\n\n${cells || "- none"}\n`,
  ].join("\n");
}

export type RunSummary = {
  seen: number;
  added: number;
  unchanged: number;
  retry: number;
  failed: number;
  integrity: number;
  failures: { case_id: string; reason: string }[];
};

// Every case's latest revision, checked file by file against its manifest.
export function verifyStore(layout: Layout): string[] {
  const bad: string[] = [];
  if (!existsSync(layout.cases)) return bad;
  for (const id of readdirSync(layout.cases)) {
    const caseDir = join(layout.cases, id);
    // Every stored revision, not only the latest: an older one holds data too.
    const revisions = readdirSync(caseDir).filter(
      (name) => !name.startsWith(".") && existsSync(join(caseDir, name, "manifest.json")),
    );
    if (revisions.some((name) => verifyRevision(join(caseDir, name)) !== null)) bad.push(id);
  }
  return bad;
}

// Privacy work left by an interrupted run is finished first, from the marker alone: production may no longer hold the
// case, or its raw mail, by now.
export async function resumePending(layout: Layout, options: CaptureOptions = {}): Promise<number> {
  let done = 0;
  if (!existsSync(layout.cases)) return done;
  for (const id of readdirSync(layout.cases)) {
    const caseDir = join(layout.cases, id);
    const marker = pendingFile(caseDir);
    if (!existsSync(marker)) continue;
    const {
      fingerprint: keep,
      recipient,
      policy = "genuine",
    } = JSON.parse(readFileSync(marker, "utf-8")) as { fingerprint: string; recipient: Recipient; policy?: Policy };
    for (const name of staleRevisions(caseDir, keep, policy)) {
      await redactStored(
        join(caseDir, name),
        (p) => cleanerFor(p, recipient, options.pass ?? null),
        options.now?.() ?? new Date(),
        policy,
      );
      options.step?.("resumed-redaction");
    }
    rmSync(marker, { force: true });
    flush(caseDir);
    done++;
  }
  return done;
}

export async function captureAll(
  source: CaptureSource,
  dir: string,
  options: CaptureOptions & { pageSize?: number; limit?: number } = {},
): Promise<RunSummary> {
  const layout = layoutOf(resolveRoot(dir));
  const release = takeLock(layout);
  const summary: RunSummary = { seen: 0, added: 0, unchanged: 0, retry: 0, failed: 0, integrity: 0, failures: [] };
  const seenIds: string[] = [];
  const currentIds: string[] = [];
  let missing = 0;
  const started = Date.now();
  // Content-free progress, so a long run can be told from a stalled one: counts, elapsed time and nothing else.
  const progress = (state: string) =>
    writeAtomic(
      layout.progress,
      `${JSON.stringify({ state, elapsed_seconds: Math.round((Date.now() - started) / 1000), ...summary, failures: summary.failures.length })}\n`,
    );
  try {
    sweepInterrupted(layout);
    await resumePending(layout, options);
    progress("running");
    let after: string | null = null;
    let lastWrite = Date.now();
    for (;;) {
      const page: CaseRow[] = await source.cases(after, options.pageSize ?? 50);
      if (!page.length) break;
      for (const row of page) {
        if (options.limit !== undefined && summary.seen >= options.limit) break;
        summary.seen++;
        seenIds.push(row.id);
        let outcome: Outcome;
        try {
          outcome = await captureCase(source, layout, row, options);
        } catch (error) {
          // The message names a failure, never a payload.
          outcome = { case_id: row.id, result: "retry", reason: (error as Error).message.slice(0, 200) };
        }
        if (outcome.result === "added") {
          summary.added++;
          currentIds.push(row.id);
        } else if (outcome.result === "unchanged") {
          summary.unchanged++;
          currentIds.push(row.id);
        } else {
          if (outcome.result === "retry") {
            summary.retry++;
            missing += outcome.missing ?? 0;
          } else summary.failed++;
          summary.failures.push({ case_id: outcome.case_id, reason: outcome.reason });
        }
        if (Date.now() - lastWrite >= 1000) {
          progress("running");
          lastWrite = Date.now();
        }
      }
      after = page[page.length - 1]?.id ?? null;
      if (page.length < (options.pageSize ?? 50) || (options.limit !== undefined && summary.seen >= options.limit))
        break;
    }
    // Whatever stored revision is still damaged after this scan could not be repaired from production.
    summary.integrity = verifyStore(layout).length;
    const now = options.now?.() ?? new Date();
    const stats = buildStats(
      layout,
      {
        seen: seenIds,
        current: currentIds,
        retry: summary.retry,
        failed: summary.failed,
        missing,
        integrity: summary.integrity,
      },
      now,
    );
    writeAtomic(layout.stats, `${JSON.stringify(stats, null, 2)}\n`);
    writeAtomic(layout.statsMd, `${statsMarkdown(stats)}\n`);
    // The last-run status holds counts and case ids only, never content.
    writeAtomic(layout.status, `${JSON.stringify({ at: now.toISOString(), ...summary }, null, 2)}\n`);
    progress("finished");
    return summary;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Command line:
//   node scripts/glimmer/capture-cases.ts [--limit N]   run once
//   node scripts/glimmer/capture-cases.ts --print-root  validate the destination without writing, and print it
//   node scripts/glimmer/capture-cases.ts --status      the running or last run's content-free progress
// ---------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const args = process.argv.slice(2);
  const known = new Set(["--limit", "--print-root", "--status"]);
  const bad = args.find((a, i) => a.startsWith("--") && !known.has(a) && args[i - 1] !== "--limit");
  const limitAt = args.indexOf("--limit");
  const limitText = limitAt >= 0 ? args[limitAt + 1] : undefined;
  if (bad || (limitAt >= 0 && !/^[1-9]\d{0,6}$/.test(limitText ?? ""))) {
    console.error("usage: capture-cases.ts [--limit <positive integer>] | --print-root | --status");
    process.exit(2);
  }
  if (args.includes("--print-root")) {
    console.log(resolveRoot(storeDir(), false));
  } else if (args.includes("--status")) {
    const layout = layoutOf(resolveRoot(storeDir(), false));
    console.log(existsSync(layout.progress) ? readFileSync(layout.progress, "utf-8").trim() : '{"state":"never run"}');
  } else {
    const { openWranglerSource } = await import("./capture-source.ts");
    const limit = limitText === undefined ? undefined : Number(limitText);
    const dir = resolveRoot();
    const source = openWranglerSource(layoutOf(dir).scratch);
    const { openConfiguredPass } = await import("./redact.ts");
    const pass = openConfiguredPass();
    try {
      const summary = await captureAll(source, dir, limit === undefined ? { pass } : { pass, limit });
      console.log(JSON.stringify({ ...summary, failures: summary.failures.length }));
      process.exitCode = summary.failed || summary.retry || summary.integrity ? 3 : 0;
    } finally {
      pass.close();
    }
  }
}
