// An evidence item's files (D07 T03 §3): `GET /a/:caseId/:key`, the key one percent-encoded path segment, under the
// report's own access rule (src/web/pages/report.tsx): a member of the case's organisation by session, or a link
// holder by the report link's signature parameters, which a signed-link report's card links carry. The signature
// covers the case, its organisation and the expiry, not the path, so it is verified as the report link it is. Files
// come from the message and are hostile: every file is an inert download, and a page asking for an image inline
// (`?inline=1`, an `<img>` of a later card) gets it inline only when it is a complete passive raster image by its
// bytes; SVG, HTML, a damaged image and anything else stay a download.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readArtefact, StoreError } from "../../intake/store";
import { verifyReportLink } from "../report-link";
import { artefactFailed, artefactGone, errorPage, HEADERS, reference } from "./errors";

export const artefactRoutes = new Hono<{ Bindings: Env }>();

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RETENTION_DAYS = 30;

// The image types a browser draws without running anything, whole: the opening bytes name the type, and the file's
// own end marker or declared size says it was not cut short, so a damaged image is never shown as a broken one.
export function passiveImage(body: Uint8Array): string | null {
  const n = body.byteLength;
  const at = (bytes: number[], from: number) => from >= 0 && bytes.every((b, i) => body[from + i] === b);
  const IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0))
    return at([0x49, 0x48, 0x44, 0x52], 12) && at(IEND, n - 12) ? "image/png" : null;
  if (at([0xff, 0xd8, 0xff], 0)) return n > 4 && at([0xff, 0xd9], n - 2) ? "image/jpeg" : null;
  if (at([0x47, 0x49, 0x46, 0x38], 0) && (body[4] === 0x37 || body[4] === 0x39) && body[5] === 0x61)
    return n > 13 && body[n - 1] === 0x3b ? "image/gif" : null;
  if (at([0x52, 0x49, 0x46, 0x46], 0) && at([0x57, 0x45, 0x42, 0x50], 8)) {
    const size = ((body[4] ?? 0) | ((body[5] ?? 0) << 8) | ((body[6] ?? 0) << 16) | ((body[7] ?? 0) << 24)) >>> 0;
    return size + 8 === n ? "image/webp" : null;
  }
  return null;
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
    const image = inline ? passiveImage(file.body) : null;
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
