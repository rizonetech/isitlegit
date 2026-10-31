// An evidence item's files (D07 T03 §3): `GET /a/:caseId/:key`, the key one percent-encoded path segment, under the
// report's own access rule (src/web/pages/report.tsx): a member of the case's organisation by session, or a link
// holder by the report link's signature parameters, which a signed-link report's card links carry. The signature
// covers the case, its organisation and the expiry, not the path, so it is verified as the report link it is. Files
// from the message (the raw message, its attachments) are hostile and are always an inert download, whatever their
// bytes look like: a structure check cannot prove an image decodes, so no attacker's file is ever drawn. A page asking
// for an image inline (`?inline=1`, an `<img>` of a later card, D07 T03 §14) gets one only for a file the pipeline
// rendered itself (`render`, `crop`, `page`), and only when its structure is that of a whole passive raster image.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readArtefact, StoreError } from "../../intake/store";
import { verifyReportLink } from "../report-link";
import { artefactFailed, artefactGone, errorPage, HEADERS, reference } from "./errors";

export const artefactRoutes = new Hono<{ Bindings: Env }>();

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RETENTION_DAYS = 30;
// The kinds the pipeline makes itself (src/intake/store.ts DERIVED_KINDS less `audio`): the only files drawn inline.
const RENDERED = new Set(["render", "crop", "page"]);

// The image types a browser draws without running anything, whole. There is no image decoder in a Worker, so each
// format's own structure is walked: a PNG's chunks with their CRCs from IHDR to IEND with image data between, a JPEG's
// segments to a frame and a scan ending in its end marker, a GIF's blocks to an image and its trailer, a WebP's RIFF
// size and its one image chunk's header. A file that is cut short, padded or merely starts like an image fails, and
// stays a download, never a broken image.
export function passiveImage(body: Uint8Array): string | null {
  if (png(body)) return "image/png";
  if (jpeg(body)) return "image/jpeg";
  if (gif(body)) return "image/gif";
  if (webp(body)) return "image/webp";
  return null;
}
const be32 = (b: Uint8Array, at: number) =>
  (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;
const le32 = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
const be16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const has = (b: Uint8Array, bytes: number[], at: number) => at >= 0 && bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(b: Uint8Array): boolean {
  if (!has(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)) return false;
  let at = 8;
  let first = true;
  let data = false;
  while (at + 12 <= b.byteLength) {
    const length = be32(b, at);
    const end = at + 12 + length;
    if (end > b.byteLength) return false;
    const type = ascii(b, at + 4, 4);
    if (crc32(b.subarray(at + 4, at + 8 + length)) !== be32(b, at + 8 + length)) return false;
    if (first && (type !== "IHDR" || length !== 13 || be32(b, at + 8) === 0 || be32(b, at + 12) === 0)) return false;
    first = false;
    if (type === "IDAT" && length > 0) data = true;
    if (type === "IEND") return data && end === b.byteLength;
    at = end;
  }
  return false;
}
function jpeg(b: Uint8Array): boolean {
  if (!has(b, [0xff, 0xd8], 0)) return false;
  let at = 2;
  let frame = false;
  while (at + 4 <= b.byteLength) {
    if (b[at] !== 0xff) return false;
    const marker = b[at + 1] as number;
    if (marker === 0xff) {
      at++;
      continue;
    }
    const length = be16(b, at + 2);
    // A length under 2 lands on a length byte, never 0xFF, so the next step refuses it.
    if (at + 2 + length > b.byteLength) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || be16(b, at + 5) === 0 || be16(b, at + 7) === 0) return false;
      frame = true;
    }
    if (marker === 0xda) {
      const scan = at + 2 + length;
      return frame && b.byteLength - scan > 2 && has(b, [0xff, 0xd9], b.byteLength - 2);
    }
    at += 2 + length;
  }
  return false;
}
function gif(b: Uint8Array): boolean {
  if (!(ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return false;
  if (b.byteLength < 14 || le16(b, 6) === 0 || le16(b, 8) === 0) return false;
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  let at = 13 + table(b[10] as number);
  let image = false;
  const blocks = () => {
    while (at < b.byteLength) {
      const size = b[at] as number;
      at += 1 + size;
      if (size === 0) return at <= b.byteLength;
    }
    return false;
  };
  while (at < b.byteLength) {
    const kind = b[at];
    if (kind === 0x3b) return image && at === b.byteLength - 1;
    if (kind === 0x21) {
      at += 2;
      if (!blocks()) return false;
    } else if (kind === 0x2c) {
      if (at + 10 > b.byteLength || le16(b, at + 5) === 0 || le16(b, at + 7) === 0) return false;
      at += 10 + table(b[at + 9] as number);
      const min = b[at];
      if (min === undefined || min < 2 || min > 8) return false;
      at++;
      if (!blocks()) return false;
      image = true;
    } else return false;
  }
  return false;
}
function webp(b: Uint8Array): boolean {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP" || le32(b, 4) + 8 !== b.byteLength) return false;
  let at = 12;
  while (at + 8 <= b.byteLength) {
    const kind = ascii(b, at, 4);
    const size = le32(b, at + 4);
    const data = at + 8;
    if (data + size > b.byteLength) return false;
    if (kind === "VP8 ")
      return (
        size >= 10 &&
        has(b, [0x9d, 0x01, 0x2a], data + 3) &&
        (le16(b, data + 6) & 0x3fff) > 0 &&
        (le16(b, data + 8) & 0x3fff) > 0
      );
    if (kind === "VP8L") return size >= 5 && b[data] === 0x2f;
    at = data + size + (size & 1);
  }
  return false;
}

const filename = (key: string) => (key.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);

artefactRoutes.get("/a/:caseId/:key", async (c) => {
  const id = c.req.param("caseId");
  const key = c.req.param("key");
  if (!CASE_ID.test(id) || !key) return errorPage(404, id);
  const url = new URL(c.req.url);
  const inline = url.searchParams.get("inline") === "1";
  // The link holder's own parameters, without the page's `inline` ask, are the report link's (verified as one).
  const params = new URLSearchParams(url.search);
  params.delete("inline");
  const search = params.size > 0 ? `?${params}` : "";
  const hasLink = ["o", "e", "s"].some((name) => params.has(name));
  let renewed: string[] = [];
  const answer = (res: Response) => {
    for (const cookie of renewed) res.headers.append("set-cookie", cookie);
    return res;
  };
  const back = `/r/${id}${hasLink ? search : ""}`;
  try {
    let orgId: string | null = null;
    const read = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    renewed = read.headers.getSetCookie();
    const user = read.response?.user;
    if (user) {
      const member = await c.env.DB.prepare(
        `SELECT c.org_id AS orgId FROM cases c JOIN "member" m ON m."organizationId" = c.org_id WHERE c.id = ? AND m."userId" = ?`,
      )
        .bind(id, user.id)
        .first<{ orgId: string }>();
      orgId = member?.orgId ?? null;
    }
    if (!orgId && hasLink) {
      const link = await verifyReportLink(c.env.REPORT_LINK_SECRET, `/r/${id}${search}`);
      if (!link.ok) return answer(errorPage(link.reason === "expired" ? 410 : 404, id));
      if (link.caseId === id) orgId = link.orgId;
    }
    // Nobody yet: sign in, then back to the report (as the report answers); anyone else is refused as not found.
    if (!orgId && !user && !hasLink)
      return answer(
        new Response(null, {
          status: 303,
          headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent(`/r/${id}`)}` },
        }),
      );
    if (!orgId) return answer(errorPage(404, id));
    const owned = await c.env.DB.prepare("SELECT created_at AS createdAt FROM cases WHERE id = ? AND org_id = ?")
      .bind(id, orgId)
      .first<{ createdAt: string }>();
    if (!owned) return answer(errorPage(404, id));
    const file = await readArtefact({ bucket: c.env.ARTEFACTS, db: c.env.DB }, id, key);
    if (!file) return answer(errorPage(404, id));
    if ("missing" in file) {
      const age = Date.now() - Date.parse(owned.createdAt);
      return answer(artefactGone(back, age > RETENTION_DAYS * 24 * 60 * 60 * 1000));
    }
    const image = inline && RENDERED.has(file.stored.kind) ? passiveImage(file.body) : null;
    const headers: Record<string, string> = {
      ...HEADERS,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    };
    if (image) {
      headers["content-type"] = image;
      headers["content-disposition"] = "inline";
    } else {
      headers["content-type"] = "application/octet-stream";
      headers["content-disposition"] = `attachment; filename="${filename(key)}"`;
    }
    return answer(new Response(file.body, { headers }));
  } catch (error) {
    const ref = reference(500);
    const cause = error instanceof StoreError ? error.code : (error as Error).name;
    console.log(JSON.stringify({ event: "artefact", outcome: "unavailable", reference: ref, error: cause }));
    return answer(artefactFailed(`${url.pathname}${url.search}`, back, { ref }));
  }
});
