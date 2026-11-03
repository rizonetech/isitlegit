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
  // Counted in characters (code points), so a cut never splits one in half.
  const characters = Array.from(cleaned);
  if (characters.length <= NAME_LIMIT) return cleaned;
  const dot = characters.lastIndexOf(".");
  const extension = dot > 0 && characters.length - dot <= 10 ? characters.slice(dot) : [];
  return [...characters.slice(0, NAME_LIMIT - extension.length), ...extension].join("");
}

export function rawKey(caseId: string): string {
  checkCase(caseId);
  return `raw/${caseId}/message.eml`;
}

export function parsedKey(caseId: string): string {
  checkCase(caseId);
  return `raw/${caseId}/parsed.json`;
}

// The message's visible text, hidden text taken out (D02 T05 §1): what a model reads. Kept beside the message it was read
// from, as the parsed summary is, so the bucket's 30-day rule deletes it with them.
export function visibleKey(caseId: string): string {
  checkCase(caseId);
  return `raw/${caseId}/visible.txt`;
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

async function write(store: Store, wanted: Stored, body: Uint8Array, fenceAt?: number): Promise<Stored> {
  let item = wanted;
  // Before anything is written, one read checks that the case exists (an object for no case could never be swept by
  // the purge, which lists the prefixes of cases that exist) and finds any row for this key: a row outlives its object
  // under raw/ (the 30-day rule), so other content recorded for the key is a conflict even when its object has gone,
  // and the same content takes the recorded media type, so a restored object matches its row.
  let found: (Partial<Row> & { known: string }) | null;
  try {
    found = await store.db
      .prepare("SELECT c.id AS known, a.* FROM cases c LEFT JOIN artefacts a ON a.r2_key = ? WHERE c.id = ?")
      .bind(item.key, item.caseId)
      .first<Partial<Row> & { known: string }>();
  } catch (error) {
    throw new StoreError("database", `reading the row for ${item.key}: ${(error as Error).message}`);
  }
  if (!found) throw new StoreError("invalid", `there is no case ${item.caseId}`);
  if (found.r2_key) {
    if (found.sha256 !== item.sha256 || found.case_id !== item.caseId)
      throw new StoreError("conflict", `${item.key} is recorded with other content`);
    item = { ...item, mediaType: found.media_type as string };
  }
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
    // Gone between the two calls (the lifecycle rule or the purge): nothing is wrong with the content, so a retry can
    // complete it.
    if (!existing) throw new StoreError("storage", `${item.key} disappeared while being written; try again`);
    // Objects this store wrote carry the SHA-256 it supplied; one written without it is checked by its bytes.
    let stored = hex(existing.checksums.sha256);
    if (stored === null) {
      try {
        const object = await store.bucket.get(item.key);
        stored = object ? await sha256Hex(new Uint8Array(await object.arrayBuffer())) : null;
      } catch (error) {
        throw new StoreError("storage", `reading ${item.key}: ${(error as Error).message}`);
      }
      if (stored === null) throw new StoreError("storage", `${item.key} disappeared while being written; try again`);
    }
    if (stored !== item.sha256) throw new StoreError("conflict", `${item.key} already holds other content`);
    // The stored object's media type wins: the same bytes declared differently by a later writer are recorded as the
    // object already holds them, so R2, D1 and the answer agree.
    item = { ...item, mediaType: existing.httpMetadata?.contentType ?? item.mediaType };
  }
  // A write across its case's removal is fenced (D01 T01 §24): the insert below joins the case, so a case
  // gone at insert time records no row; an object this call just created is removed again, while an
  // earlier attempt's object is recorded work the removal flow's prefix sweep owns, never deleted here.
  const caseStillThere = async (): Promise<boolean> => {
    try {
      return (await store.db.prepare("SELECT id FROM cases WHERE id = ?").bind(item.caseId).first()) !== null;
    } catch {
      return true;
    }
  };
  const fencedByRemoval = async (): Promise<StoreError> => {
    if (created !== null) {
      try {
        await store.bucket.delete(item.key);
      } catch {
        return new StoreError(
          "storage",
          `${item.key} was fenced: its case is gone, and its object could not be removed; the removal sweep owns it`,
        );
      }
    }
    return new StoreError("storage", `${item.key} was fenced: its case is gone`);
  };
  // A caller deadline (fenceAt) is enforced twice: in the Worker before the insert, and inside the
  // insert's own SQL as it executes, so a write delayed past it (a stalled lookup, a slow object
  // write) records no row and is never listed, whatever lands in the bucket meanwhile.
  if (fenceAt !== undefined && Date.now() > fenceAt) {
    if (!(await caseStillThere())) throw await fencedByRemoval();
    throw new StoreError("storage", `${item.key} was fenced after its deadline`);
  }
  let row: Row | null;
  try {
    await store.db
      .prepare(
        fenceAt === undefined
          ? "INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cases WHERE id = ?) ON CONFLICT (r2_key) DO NOTHING"
          : "INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) SELECT ?, ?, ?, ?, ?, ? WHERE CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) < ? AND EXISTS (SELECT 1 FROM cases WHERE id = ?) ON CONFLICT (r2_key) DO NOTHING",
      )
      .bind(
        ...(fenceAt === undefined
          ? [item.key, item.caseId, item.kind, item.sha256, item.mediaType, item.bytes, item.caseId]
          : [item.key, item.caseId, item.kind, item.sha256, item.mediaType, item.bytes, fenceAt, item.caseId]),
      )
      .run();
    row = await store.db.prepare("SELECT * FROM artefacts WHERE r2_key = ?").bind(item.key).first<Row>();
  } catch (error) {
    throw new StoreError("database", `recording ${item.key}: ${(error as Error).message}`);
  }
  if (!row) {
    if (!(await caseStillThere())) throw await fencedByRemoval();
    if (fenceAt !== undefined && Date.now() > fenceAt)
      throw new StoreError("storage", `${item.key} was fenced after its deadline`);
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
  fenceAt?: number,
) {
  checkCase(caseId);
  if (typeof mediaType !== "string" || !mediaType) throw new StoreError("invalid", "a media type is required");
  if (!(body instanceof Uint8Array)) throw new StoreError("invalid", "the content must be bytes");
  let sha256: string;
  try {
    sha256 = await sha256Hex(body);
  } catch (error) {
    throw new StoreError("storage", `hashing the content: ${(error as Error).message}`);
  }
  return write(store, { key: key(sha256), caseId, kind, sha256, mediaType, bytes: body.byteLength }, body, fenceAt);
}

export const putRaw = (store: Store, caseId: string, body: Uint8Array, mediaType = "message/rfc822") =>
  put(store, caseId, "raw", () => rawKey(caseId), body, mediaType);

// The summary must be a JSON object: anything JSON cannot hold (a cycle, a BigInt) or that is not an object is refused.
export async function putParsed(store: Store, caseId: string, summary: Record<string, unknown>): Promise<Stored> {
  let text: string | undefined;
  try {
    text = JSON.stringify(summary);
  } catch (error) {
    throw new StoreError("invalid", `the summary cannot be written as JSON: ${(error as Error).message}`);
  }
  if (typeof summary !== "object" || summary === null || Array.isArray(summary) || text === undefined)
    throw new StoreError("invalid", "the summary must be a JSON object");
  return put(store, caseId, "raw", () => parsedKey(caseId), new TextEncoder().encode(text), "application/json");
}

export const putAttachment = (store: Store, caseId: string, name: string, body: Uint8Array, mediaType: string) =>
  put(store, caseId, "attachment", (sha) => attachmentKey(caseId, sha, name), body, mediaType);

export async function putArtefact(
  store: Store,
  caseId: string,
  kind: DerivedKind,
  name: string,
  body: Uint8Array,
  mediaType: string,
  fenceAt?: number,
): Promise<Stored> {
  checkCase(caseId);
  if (!(DERIVED_KINDS as readonly string[]).includes(kind))
    throw new StoreError("invalid", `${String(kind)} is not a derived artefact kind (${DERIVED_KINDS.join(", ")})`);
  return put(store, caseId, kind, (sha) => artefactKey(caseId, kind, sha, name), body, mediaType, fenceAt);
}

// The row and the bytes, or the row and `missing` when the object is gone (a raw object past 30 days, or one deleted
// outside this store); a key the case does not own, or a write that never reached its row, is not found.
export const putVisible = (store: Store, caseId: string, text: string) =>
  put(store, caseId, "raw", () => visibleKey(caseId), new TextEncoder().encode(text), "text/plain; charset=utf-8");

// The visible text, or null when none was written (not yet scanned, or gone with the message): unavailable, which is not
// the same as an empty body.
export async function readVisible(store: Store, caseId: string): Promise<string | null> {
  const read = await readArtefact(store, caseId, visibleKey(caseId));
  return read && "body" in read ? new TextDecoder().decode(read.body) : null;
}

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
  // The body is read inside the same boundary: a transfer cut off after the headers is a storage failure too.
  try {
    object = await store.bucket.get(key);
    return object ? { stored, body: new Uint8Array(await object.arrayBuffer()) } : { stored, missing: true };
  } catch (error) {
    throw new StoreError("storage", `reading ${key}: ${(error as Error).message}`);
  }
}

// The row, and whether the object is still there, without reading its body (an `R2` head): what a reader needs to know an
// artefact is the case's and present when it will read some other, smaller artefact instead (D07 T03 §19). Null for a key
// the case does not own; a failure is a `database` or `storage` refusal like `readArtefact`'s.
export async function peekArtefact(
  store: Store,
  caseId: string,
  key: string,
): Promise<{ stored: Stored; present: true } | { stored: Stored; missing: true } | null> {
  checkCase(caseId);
  let row: Row | null;
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
    return (await store.bucket.head(key)) ? { stored, present: true } : { stored, missing: true };
  } catch (error) {
    throw new StoreError("storage", `checking ${key}: ${(error as Error).message}`);
  }
}

// A case's recorded artefacts of one kind, oldest key first (the rows only, no bodies): how a step finds what came with
// an upload (D01 T03 §1). A failure is a `database` refusal like the other reads.
export async function artefactsOf(store: Store, caseId: string, kind: Kind): Promise<Stored[]> {
  checkCase(caseId);
  try {
    const rows = await store.db
      .prepare("SELECT * FROM artefacts WHERE case_id = ? AND kind = ? ORDER BY r2_key")
      .bind(caseId, kind)
      .all<Row>();
    return rows.results.map((row) => ({
      key: row.r2_key,
      caseId: row.case_id,
      kind: row.kind,
      sha256: row.sha256,
      mediaType: row.media_type,
      bytes: row.bytes,
    }));
  } catch (error) {
    throw new StoreError("database", `listing the ${kind} artefacts of ${caseId}: ${(error as Error).message}`);
  }
}
