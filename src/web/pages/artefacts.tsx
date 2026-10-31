// An evidence item's files (D07 T03 §3): `GET /a/:caseId/:key`, the key one percent-encoded path segment, under the
// report's own access rule (src/web/pages/report.tsx): a member of the case's organisation by session, or a link
// holder by the report link's signature parameters, which a signed-link report's card links carry. The signature
// covers the case, its organisation and the expiry, not the path, so it is verified as the report link it is. Files
// come from the message and are hostile: only a passive raster image recognised by its bytes is shown inline, and
// everything else, SVG and HTML included, is an inert download.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readArtefact, StoreError } from "../../intake/store";
import { verifyReportLink } from "../report-link";
import { artefactGone, errorPage, HEADERS, reference } from "./errors";

export const artefactRoutes = new Hono<{ Bindings: Env }>();

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RETENTION_DAYS = 30;

// The image types a browser draws without running anything, by their opening bytes.
export function passiveImage(body: Uint8Array): string | null {
  const starts = (bytes: number[], at = 0) => bytes.every((b, i) => body[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38]) && (body[4] === 0x37 || body[4] === 0x39) && body[5] === 0x61)
    return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

const filename = (key: string) => (key.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);

artefactRoutes.get("/a/:caseId/:key", async (c) => {
  const id = c.req.param("caseId");
  const key = c.req.param("key");
  if (!CASE_ID.test(id) || !key) return errorPage(404, id);
  const url = new URL(c.req.url);
  const hasLink = ["o", "e", "s"].some((name) => url.searchParams.has(name));
  let renewed: string[] = [];
  const answer = (res: Response) => {
    for (const cookie of renewed) res.headers.append("set-cookie", cookie);
    return res;
  };
  const back = `/r/${id}${hasLink ? url.search : ""}`;
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
      const link = await verifyReportLink(c.env.REPORT_LINK_SECRET, `/r/${id}${url.search}`);
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
    const image = passiveImage(file.body);
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
    return answer(errorPage(500, id, { ref, retry: `${url.pathname}${url.search}` }));
  }
});
