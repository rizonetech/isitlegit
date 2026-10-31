// A protected identity's logo (D05 T01 §1; design spec 2a): the image the impersonation monitor compares lookalikes
// with (D05 T04) and the console shows its owner (§3), never inline: an SVG is rebuilt from an allowlist before it is
// stored and is only ever served as an image.
//
// Replacement never leaves the identity pointing at a missing object: the new image is written under a fresh key,
// the identity is updated conditionally on the key it had (so a concurrent upload loses cleanly) in one batch with its
// event, and only then is the previous object deleted. A failed write deletes the new object and keeps the old one.
import { ulid } from "../db/ulid";
import { IdentityRefused } from "./errors";
import { eventStatement } from "./identity";
import { sanitiseSvg } from "./svg";

export { sanitiseSvg };

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_SIDE = 4096;
export type LogoType = "image/png" | "image/svg+xml";

// --- PNG (ISO/IEC 15948, RFC 2083) -----------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (b: Uint8Array, at: number) =>
  (((b[at] as number) << 24) | ((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number)) >>>
  0;

// A PNG read chunk by chunk: the signature, IHDR first (13 bytes, a valid CRC, each side 1 to MAX_LOGO_SIDE), at least
// one IDAT, every CRC valid, and IEND last with nothing after it. Null when it is a whole image, else why not.
export function pngProblem(b: Uint8Array): string | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return "it is not a PNG image";
  let at = 8;
  let first = true;
  let idat = false;
  while (at + 12 <= b.length) {
    const length = u32(b, at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    const end = at + 8 + length;
    if (end + 4 > b.length) return "the image is cut short";
    if (crc32(b, at + 4, end) !== u32(b, end)) return "the image is damaged";
    if (first) {
      if (type !== "IHDR" || length !== 13) return "the image has no header";
      const w = u32(b, at + 8);
      const h = u32(b, at + 12);
      if (w < 1 || h < 1) return "the image has no size";
      if (w > MAX_LOGO_SIDE || h > MAX_LOGO_SIDE) return `the image is larger than ${MAX_LOGO_SIDE} pixels a side`;
      first = false;
    } else if (type === "IDAT") idat = true;
    else if (type === "IEND") {
      if (!idat) return "the image has no pixels";
      return end + 4 === b.length ? null : "the image has data after its end";
    }
    at = end + 4;
  }
  return "the image is cut short";
}

// The pixel data a PNG declares, checked by decoding it (completion review: CRCs alone passed an image whose data
// decompressed to 20 of its 2,080 bytes). IHDR's fields must be a combination the format allows (ISO/IEC 15948
// section 11.2.2), a palette image needs PLTE, and the IDAT stream must inflate to exactly the bytes the size, colour
// type, bit depth and interlacing call for, each row starting with a filter type 0 to 4. Inflation is streamed and
// nothing is kept, so a 4096 by 4096 image costs time, not memory; a stream longer than declared stops at once.
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

export async function pngPixelsProblem(b: Uint8Array): Promise<string | null> {
  const structural = pngProblem(b);
  if (structural) return structural;
  const w = u32(b, 16);
  const h = u32(b, 20);
  const depth = b[24] as number;
  const colour = b[25] as number;
  if (!DEPTHS[colour]?.includes(depth)) return "the image's colour type and depth do not go together";
  if (b[26] !== 0 || b[27] !== 0 || (b[28] !== 0 && b[28] !== 1))
    return "the image uses an unknown compression or filter";
  const interlaced = b[28] === 1;
  const bits = (CHANNELS[colour] as number) * depth;
  const rowBytes = (width: number) => Math.ceil((width * bits) / 8);
  // Each (sub)image's rows: the bytes of a row and how many rows.
  const passes = interlaced
    ? ADAM7.map(([x0, y0, dx, dy]) => ({
        cols: Math.ceil(Math.max(0, w - x0) / dx),
        rows: Math.ceil(Math.max(0, h - y0) / dy),
      }))
    : [{ cols: w, rows: h }];
  const layout = passes
    .filter((p) => p.cols > 0 && p.rows > 0)
    .map((p) => ({ row: 1 + rowBytes(p.cols), rows: p.rows }));
  const expected = layout.reduce((n, p) => n + p.row * p.rows, 0);
  // The IDAT chunks' data in order, and whether a palette was given before them.
  const parts: Uint8Array[] = [];
  let palette = false;
  for (let at = 8; at + 12 <= b.length; ) {
    const length = u32(b, at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (type === "PLTE") palette = true;
    if (type === "IDAT") parts.push(b.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  if (colour === 3 && !palette) return "the palette image has no palette";
  const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      for (const p of parts) c.enqueue(p as Uint8Array<ArrayBuffer>);
      c.close();
    },
  })
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  // Walk the decoded bytes, checking the filter byte at each row's start.
  let seen = 0;
  let pass = 0;
  let inPass = 0;
  let nextRowAt = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; ) {
        if (seen + i === nextRowAt) {
          if (pass >= layout.length) {
            await reader.cancel().catch(() => {});
            return "the image has more pixel data than its size";
          }
          if ((value[i] as number) > 4) {
            await reader.cancel().catch(() => {});
            return "the image's pixel data is damaged";
          }
          const p = layout[pass] as { row: number; rows: number };
          nextRowAt += p.row;
          if (++inPass === p.rows) {
            pass++;
            inPass = 0;
          }
        }
        // Jump to the next row start within this chunk, or past it.
        i = Math.min(value.length, nextRowAt - seen);
      }
      seen += value.length;
      if (seen > expected) {
        await reader.cancel().catch(() => {});
        return "the image has more pixel data than its size";
      }
    }
  } catch {
    return "the image's pixel data is damaged";
  }
  return seen === expected ? null : "the image's pixel data is cut short";
}

// --- Storing -----------------------------------------------------------------------------------------------------

function sniffType(bytes: Uint8Array): LogoType | null {
  if (PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return "image/png";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  return /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) ? "image/svg+xml" : null;
}

export type StoredLogo = { key: string; mediaType: LogoType };

// Validates, sanitises and stores an organisation's logo, then deletes the one it replaces. The identity must exist.
export async function storeLogo(
  bucket: R2Bucket,
  db: D1Database,
  orgId: string,
  actor: string,
  bytes: Uint8Array,
  claimedType: string,
  now = new Date(),
): Promise<StoredLogo> {
  if (bytes.length > MAX_LOGO_BYTES) throw new IdentityRefused("the logo is larger than 2 MiB");
  const type = sniffType(bytes);
  if (!type) throw new IdentityRefused("the logo must be a PNG or SVG image");
  if (type !== claimedType.toLowerCase()) throw new IdentityRefused("the file is not the type it says it is");
  let body: Uint8Array;
  if (type === "image/png") {
    const problem = await pngPixelsProblem(bytes);
    if (problem) throw new IdentityRefused(problem);
    body = bytes;
  } else {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new IdentityRefused("the SVG is not UTF-8 text");
    }
    body = new TextEncoder().encode(sanitiseSvg(text));
  }
  const before = await db
    .prepare("SELECT logo_r2_key FROM identities WHERE org_id = ?")
    .bind(orgId)
    .first<{ logo_r2_key: string | null }>();
  if (!before) throw new IdentityRefused("set the identity before its logo");
  const key = `ident/${orgId}/logo-${ulid(now.getTime())}.${type === "image/png" ? "png" : "svg"}`;
  await bucket.put(key, body, { httpMetadata: { contentType: type } });
  const at = now.toISOString();
  const eventId = ulid(now.getTime());
  const event = eventStatement(
    db,
    orgId,
    actor,
    "identity.logo_stored",
    { replaced: before.logo_r2_key },
    at,
    true,
    eventId,
  );
  let changes = 0;
  try {
    const [update] = await db.batch([
      db
        .prepare(
          `UPDATE identities SET logo_r2_key = ?, logo_media_type = ?, updated_at = ?, updated_by = ?
           WHERE org_id = ? AND logo_r2_key IS ?`,
        )
        .bind(key, type, at, actor, orgId, before.logo_r2_key),
      event,
    ]);
    changes = update?.meta.changes ?? 0;
  } catch (error) {
    await discard(bucket, db, key, orgId, actor, at);
    throw error;
  }
  if (changes !== 1) {
    await discard(bucket, db, key, orgId, actor, at);
    throw new IdentityRefused("the logo was changed meanwhile; try again");
  }
  if (before.logo_r2_key) await deleteOrRecord(bucket, db, before.logo_r2_key, eventId);
  return { key, mediaType: type };
}

// Clears the reference and records it in one batch, then deletes the object.
export async function removeLogo(
  bucket: R2Bucket,
  db: D1Database,
  orgId: string,
  actor: string,
  now = new Date(),
): Promise<void> {
  const row = await db
    .prepare("SELECT logo_r2_key FROM identities WHERE org_id = ?")
    .bind(orgId)
    .first<{ logo_r2_key: string | null }>();
  if (!row?.logo_r2_key) return;
  const at = now.toISOString();
  const eventId = ulid(now.getTime());
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE identities SET logo_r2_key = NULL, logo_media_type = NULL, updated_at = ?, updated_by = ?
         WHERE org_id = ? AND logo_r2_key = ?`,
      )
      .bind(at, actor, orgId, row.logo_r2_key),
    eventStatement(db, orgId, actor, "identity.logo_removed", { removed: row.logo_r2_key }, at, true, eventId),
  ]);
  if ((update?.meta.changes ?? 0) !== 1) throw new IdentityRefused("the logo was changed meanwhile; try again");
  await deleteOrRecord(bucket, db, row.logo_r2_key, eventId);
}

// Deletes a replaced or removed object; a failure is recorded on that operation's own event, naming the orphan.
async function deleteOrRecord(bucket: R2Bucket, db: D1Database, key: string, eventId: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch {
    await db
      .prepare("UPDATE trust_events SET detail_json = json_set(detail_json, '$.orphan', ?) WHERE id = ?")
      .bind(key, eventId)
      .run();
  }
}

// Removes a new object whose reference never committed. If even that fails, the orphan gets an event of its own so a
// cleanup can find it; if the database is the failure too, the key goes to the Worker's log (no secret is in a key).
async function discard(bucket: R2Bucket, db: D1Database, key: string, orgId: string, actor: string, at: string) {
  try {
    await bucket.delete(key);
    return;
  } catch {
    // Recorded below.
  }
  try {
    await eventStatement(db, orgId, actor, "identity.logo_orphaned", { orphan: key }, at).run();
  } catch {
    console.error(JSON.stringify({ event: "identity.logo_orphaned", orphan: key }));
  }
}
