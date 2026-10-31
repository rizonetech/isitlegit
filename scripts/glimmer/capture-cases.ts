// Day-zero case capture into the private training store (D03 T04 §34).
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
import { type EntityPass, namePieces, PLACEHOLDER, redact, redactWithEntities } from "./redact.ts";
import { insideRepository, storeDir } from "./store.ts";

export const CAPTURE_VERSION = "1.1";
// Bumped whenever the redaction or the record layout changes, so every case is captured again under the new rule.
export const POLICY_KEY = "capture-policy-1";

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
export type Recipient = { addresses: string[]; names: string[]; domains: string[]; certified: boolean };

const PUBLIC_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\./;

export function recipientOf(row: CaseRow, detail: CaseDetail, mailPeople: Person[] = []): Recipient {
  const people: Person[] = [...detail.members, ...mailPeople];
  if (row.forwarded_by) people.push({ name: null, email: row.forwarded_by });
  const addresses = new Set<string>();
  const names = new Set<string>();
  for (const p of people) {
    if (p.email) addresses.add(p.email.trim().toLowerCase());
    for (const piece of namePieces(p.name ?? undefined, p.email ?? undefined)) names.add(piece);
  }
  const domains = [...addresses].map((a) => a.split("@")[1] ?? "").filter((d) => d && !PUBLIC_MAIL.test(d));
  // An upload by a user whose record is gone has no identity to remove: such a case cannot be certified.
  const certified = !(row.channel === "upload" && row.uploaded_by && !detail.members.length);
  return { addresses: [...addresses].filter(Boolean), names: [...names], domains: [...new Set(domains)], certified };
}

// The recipient's address and name in the forms a lure link or header carries them.
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Phishing policy: only the recipient is removed. Everything the sender wrote stays, link hosts and sender addresses
// included.
export function scrubRecipient(text: string, recipient: Recipient): string {
  const { addressForms, nameForms } = forms(recipient);
  let out = text;
  for (const f of addressForms.sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(escapeRe(f), "gi"), PLACEHOLDER.email);
  for (const n of nameForms.sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"), PLACEHOLDER.name);
  return out;
}

export type Cleaner = {
  text(value: string): Promise<string>;
  // A header or a link: only the recipient goes, under both policies, so the sender's domains and headers stay.
  signal(value: string): string;
  // Free text a person wrote: always the full rule.
  prose(value: string): Promise<string>;
};

export function cleanerFor(policy: Policy, recipient: Recipient, pass: EntityPass | null): Cleaner {
  const names = recipient.names;
  const full = async (v: string) =>
    pass ? redactWithEntities(v, names, recipient.domains, pass, true) : redact(v, names, recipient.domains);
  return {
    signal: (v) => scrubRecipient(v, recipient),
    text: async (v) =>
      policy === "phishing" ? scrubRecipient(v, recipient) : scrubRecipient(await full(v), recipient),
    prose: async (v) => scrubRecipient(await full(v), recipient),
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
      transformed: boolean;
    }
  | {
      key: string;
      kind: string;
      status: "withheld";
      reason: string;
      media_type: string;
      source_sha256: string;
      bytes: number;
    }
  | { key: string; kind: string; status: "missing"; media_type: string; source_sha256: string; bytes: number };

const TEXT_TYPES = /^(text\/|application\/json|message\/rfc822|application\/(?:xml|xhtml\+xml))/i;
const MAX_TEXT = 8 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });
const hexOnly = /^[0-9a-f]{32,}$/i;
const SIGNAL_KEYS = /^(sha256|digest|md5|sha1|spf|dkim|dmarc|arc|hash)$/i;

// JSON is walked, never run through the prose redactor whole: hashes and authentication results stay byte for byte.
export async function cleanJson(value: unknown, cleaner: Cleaner, key = ""): Promise<unknown> {
  if (typeof value === "string") {
    if (hexOnly.test(value) || SIGNAL_KEYS.test(key)) return value;
    return cleaner.text(value);
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => cleanJson(v, cleaner, key)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await cleanJson(v, cleaner, k);
    return out;
  }
  return value;
}

type Mail = Awaited<ReturnType<typeof PostalMime.parse>>;
const HEADER_AUTH =
  /^(authentication-results|received-spf|arc-authentication-results|dkim-signature|arc-seal|arc-message-signature)$/i;

// A raw message, parsed structurally and cleaned part by part. Typed signals are lifted out of the parse: the sender's
// domain, the authentication results, the link hosts and the attachments' hashes (never their bytes).
export async function captureMail(bytes: Uint8Array, cleaner: Cleaner, policy: Policy) {
  const mail: Mail = await PostalMime.parse(bytes);
  const headers: { key: string; value: string }[] = [];
  for (const h of mail.headers)
    headers.push({ key: h.key, value: HEADER_AUTH.test(h.key) ? h.value : cleaner.signal(h.value) });
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
  return {
    policy,
    signals: {
      sender_domain: sender.split("@")[1] ?? null,
      authentication: mail.headers
        .filter((h) => HEADER_AUTH.test(h.key) && !/signature|seal/i.test(h.key))
        .map((h) => ({ key: h.key, value: h.value })),
      link_hosts: linkHosts,
      links: links.map((l) => cleaner.signal(l)),
      attachments: mail.attachments.map((a) => ({
        filename: a.filename ?? null,
        media_type: a.mimeType,
        bytes: a.content instanceof ArrayBuffer ? a.content.byteLength : String(a.content).length,
        sha256: sha256(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : String(a.content)),
      })),
    },
    headers,
    subject: mail.subject ? await cleaner.text(mail.subject) : null,
    text: mail.text ? await cleaner.text(mail.text) : null,
    html: html ? await cleaner.text(html) : null,
  };
}

export function mailPeople(mail: Mail): Person[] {
  const flat = [...(mail.to ?? []), ...(mail.cc ?? []), ...(mail.bcc ?? [])].flatMap((a) =>
    "group" in a && a.group ? a.group : [a],
  ) as { name?: string; address?: string }[];
  const delivered = (mail.headers ?? [])
    .filter((h) => /^(delivered-to|x-original-to)$/i.test(h.key))
    .map((h) => ({ name: "", address: h.value.replace(/^.*?<?([^\s<>]+@[^\s<>]+)>?.*$/, "$1") }));
  return [...flat, ...delivered].map((p) => ({ name: p.name || null, email: p.address || null }));
}

// ---------------------------------------------------------------------------------------------------------------
// The revision: one immutable folder per distinct state of a case.
// ---------------------------------------------------------------------------------------------------------------
export function fingerprint(row: CaseRow, detail: CaseDetail, recipient: Recipient): string {
  return sha256(
    canonical({
      row,
      detail: {
        ...detail,
        // Feedback notes are personal text: the fingerprint holds their hash, not the note.
        feedback: detail.feedback.map((f) => ({ ...f, note: f.note === null ? null : sha256(f.note) })),
      },
      recipient: sha256(canonical([recipient.addresses, recipient.names, recipient.domains, recipient.certified])),
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
  certified: boolean;
  verdict: string | null;
  captured_at: string;
  recipient_digest: string;
  payloads: Payload[];
  record: string;
  redacted_in_place?: { at: string; reason: "false_alarm"; from_policy: "phishing" };
};

export type Layout = {
  root: string;
  cases: string;
  stats: string;
  statsMd: string;
  status: string;
  lock: string;
};

export function layoutOf(dir: string): Layout {
  const root = join(dir, "capture", CAPTURE_VERSION);
  return {
    root,
    cases: join(root, "cases"),
    stats: join(root, "stats.json"),
    statsMd: join(root, "STATS.md"),
    status: join(root, "last-run.json"),
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

// Written to a temporary name, flushed, then renamed over the target: a reader sees the old file or the whole new one.
export function writeAtomic(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  flush(tmp);
  renameSync(tmp, path);
}

// The external root, resolved before any write: never in a git work tree, and never reached through a symlink that
// leaves the folder it names.
export function resolveRoot(dir: string = storeDir()): string {
  const full = resolve(dir);
  if (insideRepository(full)) throw new Error("capture: the store lies in a git work tree");
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (insideRepository(real)) throw new Error("capture: the store resolves into a git work tree");
  }
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

// A revision folder is built under a temporary name and published by one rename. A temporary folder left by a writer
// that is gone is an interrupted revision: it was never published, so it is removed.
export function sweepInterrupted(layout: Layout): number {
  let removed = 0;
  if (!existsSync(layout.cases)) return 0;
  for (const id of readdirSync(layout.cases)) {
    const caseDir = join(layout.cases, id);
    for (const name of readdirSync(caseDir)) {
      const match = /^\.tmp-(\d+)-/.exec(name);
      if (match && !processAlive(Number(match[1]))) {
        rmSync(join(caseDir, name), { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

export type Outcome =
  | { case_id: string; result: "added"; fingerprint: string; policy: Policy; withheld: number; kept: number }
  | { case_id: string; result: "unchanged" }
  | { case_id: string; result: "retry"; reason: string }
  | { case_id: string; result: "failed"; reason: string };

export type CaptureOptions = { pass?: EntityPass | null; now?: () => Date };

function readLatest(layout: Layout, id: string): { fingerprint: string } | null {
  const file = join(layout.cases, id, "LATEST.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as { fingerprint: string };
  } catch {
    return null;
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
): Promise<Built | { retry: string } | { failed: string }> {
  const cleaner = cleanerFor(policy, recipient, options.pass ?? null);
  const files = new Map<string, string | Uint8Array>();
  const payloads: Payload[] = [];
  let index = 0;
  for (const a of detail.artefacts) {
    const base = { key: a.r2_key, kind: a.kind, media_type: a.media_type, source_sha256: a.sha256, bytes: a.bytes };
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
    if (!bytes) return { retry: "an artefact could not be read" };
    if (sha256(bytes) !== a.sha256) return { failed: "an artefact's digest does not match its record" };
    const file = `p${index++}.json`;
    const isMail = a.kind === "raw" && /rfc822/i.test(a.media_type);
    const content = isMail
      ? await captureMail(bytes, cleaner, policy)
      : { policy, text: await cleaner.text(decoder.decode(bytes)) };
    const body = JSON.stringify(content);
    files.set(file, body);
    payloads.push({ ...base, status: "kept", file, sha256: sha256(body), transformed: true });
  }
  const evidence = await Promise.all(
    detail.evidence.map(async (e) => ({
      id: e.id,
      run_id: e.run_id,
      check: e.check_name,
      severity: e.severity,
      summary: await cleaner.text(e.summary),
      detail: await cleanJson(safeParse(e.detail_json), cleaner),
      artefact_keys: safeParse(e.artefact_keys_json),
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
      original_from_address: row.original_from_address,
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
  files.set("record.json", recordBody);
  const manifest: Manifest = {
    version: CAPTURE_VERSION,
    case_id: row.id,
    channel: row.channel,
    fingerprint: fp,
    policy,
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

// The one permitted change to a stored revision: after a `false_alarm`, a phishing revision is rewritten, file by
// file and atomically, to the genuine rule. Its record, hashes and labels stay; the less-redacted text is replaced.
function redactInPlace(layout: Layout, id: string, keep: string, built: Built, now: Date): number {
  let done = 0;
  const caseDir = join(layout.cases, id);
  for (const name of readdirSync(caseDir)) {
    if (name === keep || name.startsWith(".") || name === "LATEST.json") continue;
    const dir = join(caseDir, name);
    const manifestFile = join(dir, "manifest.json");
    if (!existsSync(manifestFile)) continue;
    const old = JSON.parse(readFileSync(manifestFile, "utf-8")) as Manifest;
    if (old.policy === "genuine") continue;
    const payloads: Payload[] = old.payloads.map((p) => {
      if (p.status !== "kept") return p;
      const fresh = built.manifest.payloads.find((q) => q.key === p.key && q.status === "kept");
      const body =
        fresh && fresh.status === "kept"
          ? (built.files.get(fresh.file) as string)
          : JSON.stringify({ policy: "genuine", text: null });
      writeAtomic(join(dir, p.file), body);
      return { ...p, sha256: sha256(body) };
    });
    const recordBody = built.files.get("record.json") as string;
    // The old record carries the old feedback state; it is replaced by the genuine record of the same case, which
    // holds the same fields with the genuine rule applied.
    writeAtomic(join(dir, "record.json"), recordBody);
    writeAtomic(
      manifestFile,
      JSON.stringify({
        ...old,
        policy: "genuine",
        payloads,
        record: sha256(recordBody),
        redacted_in_place: { at: now.toISOString(), reason: "false_alarm", from_policy: "phishing" },
      } satisfies Manifest),
    );
    done++;
  }
  return done;
}

export async function captureCase(
  upstream: CaptureSource,
  layout: Layout,
  row: CaseRow,
  options: CaptureOptions = {},
): Promise<Outcome> {
  // An object is read once per case: the recipient headers and the payload both want the raw message.
  const seen = new Map<string, Uint8Array | null>();
  const source: CaptureSource = {
    ...upstream,
    object: async (key) => {
      if (!seen.has(key)) seen.set(key, await upstream.object(key));
      return seen.get(key) ?? null;
    },
  };
  const detail = await source.detail(row);
  // The recipient may also be named in the raw message's own headers: read them before anything is cleaned.
  const extra: Person[] = [];
  const raw = detail.artefacts.find((a) => a.kind === "raw" && /rfc822/i.test(a.media_type));
  if (raw && raw.bytes <= MAX_TEXT) {
    const bytes = await source.object(raw.r2_key);
    if (!bytes) return { case_id: row.id, result: "retry", reason: "the raw message could not be read" };
    try {
      extra.push(...mailPeople(await PostalMime.parse(bytes)));
    } catch {
      /* an unparseable message has no readable recipient headers; the verdict-level identity still applies */
    }
  }
  const recipient = recipientOf(row, detail, extra);
  const policy = policyFor(row.verdict, detail.feedback);
  const fp = fingerprint(row, detail, recipient);
  const latest = readLatest(layout, row.id);
  const caseDir = join(layout.cases, row.id);
  if (latest?.fingerprint === fp && existsSync(join(caseDir, fp, "manifest.json")))
    return { case_id: row.id, result: "unchanged" };
  const built = await build(source, row, detail, policy, recipient, fp, options);
  if ("retry" in built) return { case_id: row.id, result: "retry", reason: built.retry };
  if ("failed" in built) return { case_id: row.id, result: "failed", reason: built.failed };
  mkdirSync(caseDir, { recursive: true, mode: 0o700 });
  const tmp = join(caseDir, `.tmp-${process.pid}-${fp.slice(0, 12)}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  for (const [name, data] of built.files) {
    writeFileSync(join(tmp, name), data, { mode: 0o600 });
    flush(join(tmp, name));
  }
  writeFileSync(join(tmp, "manifest.json"), JSON.stringify(built.manifest), { mode: 0o600 });
  flush(join(tmp, "manifest.json"));
  if (!existsSync(join(caseDir, fp))) renameSync(tmp, join(caseDir, fp));
  else rmSync(tmp, { recursive: true, force: true });
  writeAtomic(join(caseDir, "LATEST.json"), JSON.stringify({ fingerprint: fp }));
  if (policy === "genuine") redactInPlace(layout, row.id, fp, built, options.now?.() ?? new Date());
  return {
    case_id: row.id,
    result: "added",
    fingerprint: fp,
    policy,
    withheld: built.manifest.payloads.filter((p) => p.status === "withheld").length,
    kept: built.manifest.payloads.filter((p) => p.status === "kept").length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A whole run and its stats.
// ---------------------------------------------------------------------------------------------------------------
export type Stats = {
  generated_at: string;
  cases_seen: number;
  cases_captured: number;
  cases_failed: number;
  cases_retry: number;
  by_channel: Record<string, number>;
  by_verdict: Record<string, number>;
  by_category: Record<string, number>;
  by_lure_type: Record<string, number>;
  payloads: { kept: number; withheld: number; missing: number };
  artefacts_by_kind: Record<string, number>;
  withheld_reasons: Record<string, number>;
  uncertified: number;
};

function bump(map: Record<string, number>, key: string | null | undefined, by = 1) {
  const k = key ?? "unknown";
  map[k] = (map[k] ?? 0) + by;
}

// Built from each case's latest committed revision only, so a case counts once however many revisions it holds.
export function buildStats(layout: Layout, seen: number, failed: number, retry: number, now: Date): Stats {
  const stats: Stats = {
    generated_at: now.toISOString(),
    cases_seen: seen,
    cases_captured: 0,
    cases_failed: failed,
    cases_retry: retry,
    by_channel: {},
    by_verdict: {},
    by_category: {},
    by_lure_type: {},
    payloads: { kept: 0, withheld: 0, missing: 0 },
    artefacts_by_kind: {},
    withheld_reasons: {},
    uncertified: 0,
  };
  if (!existsSync(layout.cases)) return stats;
  for (const id of readdirSync(layout.cases).sort()) {
    const latest = readLatest(layout, id);
    if (!latest) continue;
    const file = join(layout.cases, id, latest.fingerprint, "manifest.json");
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf-8")) as Manifest;
    stats.cases_captured++;
    bump(stats.by_channel, m.channel);
    bump(stats.by_verdict, m.verdict);
    bump(stats.by_category, null);
    bump(stats.by_lure_type, null);
    if (!m.certified) stats.uncertified++;
    for (const p of m.payloads) {
      stats.payloads[p.status]++;
      bump(stats.artefacts_by_kind, p.kind);
      if (p.status === "withheld") bump(stats.withheld_reasons, p.reason);
    }
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
  return [
    "# Day-zero case capture",
    "",
    `Generated ${s.generated_at}. Private: counts only, no case content.`,
    "",
    `Cases seen: ${s.cases_seen}. Captured: ${s.cases_captured}. Failed: ${s.cases_failed}. Waiting to retry: ${s.cases_retry}. Not certified: ${s.uncertified}.`,
    "",
    `Payloads kept: ${s.payloads.kept}. Withheld: ${s.payloads.withheld}. Missing: ${s.payloads.missing}.`,
    "",
    table("By channel", s.by_channel),
    table("By verdict", s.by_verdict),
    table("By category", s.by_category),
    table("By lure type", s.by_lure_type),
    table("Artefacts by kind", s.artefacts_by_kind),
    table("Withheld reasons", s.withheld_reasons),
  ].join("\n");
}

export type RunSummary = {
  seen: number;
  added: number;
  unchanged: number;
  retry: number;
  failed: number;
  failures: { case_id: string; reason: string }[];
};

export async function captureAll(
  source: CaptureSource,
  dir: string,
  options: CaptureOptions & { pageSize?: number; limit?: number } = {},
): Promise<RunSummary> {
  const layout = layoutOf(resolveRoot(dir));
  const release = takeLock(layout);
  const summary: RunSummary = { seen: 0, added: 0, unchanged: 0, retry: 0, failed: 0, failures: [] };
  try {
    sweepInterrupted(layout);
    let after: string | null = null;
    for (;;) {
      const page: CaseRow[] = await source.cases(after, options.pageSize ?? 50);
      if (!page.length) break;
      for (const row of page) {
        if (options.limit !== undefined && summary.seen >= options.limit) break;
        summary.seen++;
        let outcome: Outcome;
        try {
          outcome = await captureCase(source, layout, row, options);
        } catch (error) {
          // The message names a failure, never a payload.
          outcome = { case_id: row.id, result: "retry", reason: (error as Error).message.slice(0, 200) };
        }
        if (outcome.result === "added") summary.added++;
        else if (outcome.result === "unchanged") summary.unchanged++;
        else {
          if (outcome.result === "retry") summary.retry++;
          else summary.failed++;
          summary.failures.push({ case_id: outcome.case_id, reason: outcome.reason });
        }
      }
      after = page[page.length - 1]?.id ?? null;
      if (page.length < (options.pageSize ?? 50) || (options.limit !== undefined && summary.seen >= options.limit))
        break;
    }
    const now = options.now?.() ?? new Date();
    const stats = buildStats(layout, summary.seen, summary.failed, summary.retry, now);
    writeAtomic(layout.stats, `${JSON.stringify(stats, null, 2)}\n`);
    writeAtomic(layout.statsMd, `${statsMarkdown(stats)}\n`);
    // The last-run status holds counts and case ids only, never content.
    writeAtomic(layout.status, `${JSON.stringify({ at: now.toISOString(), ...summary }, null, 2)}\n`);
    return summary;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Command line: node scripts/glimmer/capture-cases.ts [--limit N]
// ---------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const { openWranglerSource } = await import("./capture-source.ts");
  const limitAt = process.argv.indexOf("--limit");
  const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : undefined;
  const dir = resolveRoot();
  const source = openWranglerSource(join(layoutOf(dir).root, ".scratch"));
  const { openConfiguredPass } = await import("./redact.ts");
  const pass = openConfiguredPass();
  try {
    const summary = await captureAll(source, dir, limit === undefined ? { pass } : { pass, limit });
    console.log(JSON.stringify({ ...summary, failures: summary.failures.length }));
    process.exitCode = summary.failed || summary.retry ? 3 : 0;
  } finally {
    pass.close();
  }
}
