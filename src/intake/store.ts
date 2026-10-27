import { isUlid } from "../db/ulid";

// The case store's R2 layout (D01 T01 §2): raw mail, its parsed form and its attachments under `raw/<caseId>/`, which
// the bucket's raw-30-days rule deletes (D00 T01 §5, POPIA), and derived artefacts under `art/<caseId>/<kind>/`. D1
// holds one `artefacts` row per object (spec 4.2).
//
// R2 and D1 cannot share a transaction, so the order is fixed and nothing is ever deleted: the object first, written
// create-only with R2 checking its SHA-256, then the row, inserted only if absent. An existing object or row is accepted
// only when its SHA-256 matches, so a retried step finds its own earlier work and answers it, two overlapping writes of
// the same content both succeed, and different content for a fixed key is refused as a conflict. A failure at either
// step is a `StoreError` naming it, and a retry completes what is missing; an object whose row never followed is swept
// with its case by the account purge (D07 T02 §9), which lists by prefix.

export type StoreErrorCode = "invalid" | "conflict" | "storage" | "database";
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "StoreError";
  }
}

export const DERIVED_KINDS = ["render", "crop", "page", "audio"] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];
type Kind = "raw" | "attachment" | DerivedKind;

export type Store = { bucket: R2Bucket; db: D1Database };
export type Stored = { key: string; caseId: string; kind: Kind; sha256: string; mediaType: string; bytes: number };

const SHA256 = /^[0-9a-f]{64}$/;
const NAME_LIMIT = 120;

function checkCase(caseId: string): void {
  if (typeof caseId !== "string" || !isUlid(caseId))
    throw new StoreError("invalid", `case id ${String(caseId)} is not a ULID`);
}
function checkHash(sha256: string): void {
  if (typeof sha256 !== "string" || !SHA256.test(sha256))
    throw new StoreError("invalid", "a SHA-256 is 64 lowercase hex characters");
}

// A name that cannot leave its folder or break a key: no path separators, control characters or leading dots, at most
// 120 characters (keeping the extension where it fits), and never empty.
export function safeName(name: string): string {
  const cleaned = String(name ?? "")
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, "_")
    .replace(/^[.\s_]+/, "")
    .trim();
  if (!cleaned) return "file";
  if (cleaned.length <= NAME_LIMIT) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, NAME_LIMIT - extension.length) + extension;
}

export function rawKey(caseId: string): string {
  checkCase(caseId);
  return `raw/${caseId}/message.eml`;
}

export function parsedKey(caseId: string): string {
  checkCase(caseId);
  return `raw/${caseId}/parsed.json`;
}

export function attachmentKey(caseId: string, sha256: string, name: string): string {
  checkCase(caseId);
  checkHash(sha256);
  return `raw/${caseId}/attachments/${sha256}-${safeName(name)}`;
}

export function artefactKey(caseId: string, kind: DerivedKind, sha256: string, name: string): string {
  checkCase(caseId);
  if (!(DERIVED_KINDS as readonly string[]).includes(kind))
    throw new StoreError("invalid", `${String(kind)} is not a derived artefact kind (${DERIVED_KINDS.join(", ")})`);
  checkHash(sha256);
  return `art/${caseId}/${kind}/${sha256}-${safeName(name)}`;
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const hex = (buffer: ArrayBuffer | undefined) =>
  buffer ? Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("") : null;

type Row = { r2_key: string; case_id: string; kind: Kind; sha256: string; media_type: string; bytes: number };

async function write(store: Store, item: Stored, body: Uint8Array): Promise<Stored> {
  let created: R2Object | null;
  try {
    created = await store.bucket.put(item.key, body, {
      sha256: item.sha256,
      httpMetadata: { contentType: item.mediaType },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch (error) {
    throw new StoreError("storage", `writing ${item.key}: ${(error as Error).message}`);
  }
  if (created === null) {
    // Already there: an earlier attempt's, or another writer's. Only the same content is the same object.
    let existing: R2Object | null;
    try {
      existing = await store.bucket.head(item.key);
    } catch (error) {
      throw new StoreError("storage", `reading ${item.key}: ${(error as Error).message}`);
    }
    if (hex(existing?.checksums.sha256) !== item.sha256)
      throw new StoreError("conflict", `${item.key} already holds other content`);
  }
  let row: Row | null;
  try {
    await store.db
      .prepare(
        "INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (r2_key) DO NOTHING",
      )
      .bind(item.key, item.caseId, item.kind, item.sha256, item.mediaType, item.bytes)
      .run();
    row = await store.db.prepare("SELECT * FROM artefacts WHERE r2_key = ?").bind(item.key).first<Row>();
  } catch (error) {
    throw new StoreError("database", `recording ${item.key}: ${(error as Error).message}`);
  }
  if (!row || row.sha256 !== item.sha256 || row.case_id !== item.caseId)
    throw new StoreError("conflict", `${item.key} is recorded with other content`);
  return { ...item, mediaType: row.media_type, bytes: row.bytes };
}

async function put(
  store: Store,
  caseId: string,
  kind: Kind,
  key: (sha: string) => string,
  body: Uint8Array,
  mediaType: string,
) {
  checkCase(caseId);
  if (typeof mediaType !== "string" || !mediaType) throw new StoreError("invalid", "a media type is required");
  const sha256 = await sha256Hex(body);
  return write(store, { key: key(sha256), caseId, kind, sha256, mediaType, bytes: body.byteLength }, body);
}

export const putRaw = (store: Store, caseId: string, body: Uint8Array, mediaType = "message/rfc822") =>
  put(store, caseId, "raw", () => rawKey(caseId), body, mediaType);

export const putParsed = (store: Store, caseId: string, summary: unknown) =>
  put(
    store,
    caseId,
    "raw",
    () => parsedKey(caseId),
    new TextEncoder().encode(JSON.stringify(summary)),
    "application/json",
  );

export const putAttachment = (store: Store, caseId: string, name: string, body: Uint8Array, mediaType: string) =>
  put(store, caseId, "attachment", (sha) => attachmentKey(caseId, sha, name), body, mediaType);

export async function putArtefact(
  store: Store,
  caseId: string,
  kind: DerivedKind,
  name: string,
  body: Uint8Array,
  mediaType: string,
): Promise<Stored> {
  checkCase(caseId);
  if (!(DERIVED_KINDS as readonly string[]).includes(kind))
    throw new StoreError("invalid", `${String(kind)} is not a derived artefact kind (${DERIVED_KINDS.join(", ")})`);
  return put(store, caseId, kind, (sha) => artefactKey(caseId, kind, sha, name), body, mediaType);
}

// The row and the bytes, or the row and `missing` when the object is gone (a raw object past 30 days, or a write that
// never completed); a key the case does not own is not found.
export async function readArtefact(
  store: Store,
  caseId: string,
  key: string,
): Promise<{ stored: Stored; body: Uint8Array } | { stored: Stored; missing: true } | null> {
  checkCase(caseId);
  let row: Row | null;
  let object: R2ObjectBody | null;
  try {
    row = await store.db
      .prepare("SELECT * FROM artefacts WHERE r2_key = ? AND case_id = ?")
      .bind(key, caseId)
      .first<Row>();
  } catch (error) {
    throw new StoreError("database", `reading the row for ${key}: ${(error as Error).message}`);
  }
  if (!row) return null;
  const stored: Stored = {
    key: row.r2_key,
    caseId: row.case_id,
    kind: row.kind,
    sha256: row.sha256,
    mediaType: row.media_type,
    bytes: row.bytes,
  };
  try {
    object = await store.bucket.get(key);
  } catch (error) {
    throw new StoreError("storage", `reading ${key}: ${(error as Error).message}`);
  }
  return object ? { stored, body: new Uint8Array(await object.arrayBuffer()) } : { stored, missing: true };
}
