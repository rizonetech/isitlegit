import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putArtefact } from "../../src/intake/store";
import { passiveImage } from "../../src/web/pages/artefacts";
import { signReportLink } from "../../src/web/report-link";
import { call, signIn } from "../auth/helpers";

// The artefact route (D07 T03 §3): a drawn card's file link opens for a member by session and for a link holder by the
// report link's signature, with the exact bytes; only a passive raster image recognised by its bytes is shown inline,
// everything else is an inert download; refusals reveal nothing; a gone file and a failed read are said as such.
const db = (env as unknown as Env).DB;
const bucket = (env as unknown as Env).ARTEFACTS;
const SECRET = (env as unknown as Env).REPORT_LINK_SECRET;
afterEach(() => vi.restoreAllMocks());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const enc = (text: string) => new TextEncoder().encode(text);

async function org() {
  const id = `org-art-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, "Artefact Co", id, new Date().toISOString())
    .run();
  return id;
}
async function member(orgId: string) {
  const email = `art-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
    .run();
  return cookie;
}
// A finished case with one evidence item resting on a stored file; the report draws the file's link.
async function caseWith(orgId: string, body: Uint8Array, mediaType: string, name: string) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  const stored = await putArtefact({ bucket, db }, id, "page", name, body, mediaType);
  await saveEvidence(db, id, [
    {
      check: "intake.upload",
      severity: "info",
      summary: "The uploaded file",
      detail: { kind: "document", mediaType, bytes: body.byteLength },
      artefacts: [stored.key],
    },
  ]);
  await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
  return { id, key: stored.key };
}
const html = async (res: Response) => res.text();
const fileLink = (page: string) => {
  const href = /href="(\/a\/[^"]+)"/.exec(page)?.[1];
  expect(href, "a file link on the report").toBeTruthy();
  return (href as string).replaceAll("&amp;", "&");
};
const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("the artefact route", () => {
  it("recognises passive raster images by their bytes only", () => {
    expect(passiveImage(PNG)).toBe("image/png");
    expect(passiveImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(passiveImage(enc("GIF89a...."))).toBe("image/gif");
    expect(passiveImage(enc("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    for (const text of [
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "<html><script>1</script>",
      "GIF89",
      "RIFF\0\0\0\0AVI ",
    ])
      expect(passiveImage(enc(text)), text).toBeNull();
  });

  it("opens a drawn card's file for a member, with its exact bytes, inline when it is an image", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const { id } = await caseWith(orgId, PNG, "image/png", "logo.png");
    const report = await html(await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } }));
    const res = await call(fileLink(report), { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await bytes(res)).toEqual(PNG);
  });

  it("opens a drawn card's file for a signed-link holder by the link's own signature", async () => {
    const orgId = await org();
    const { id } = await caseWith(orgId, enc("%PDF-1.7 statement"), "application/pdf", "statement.pdf");
    const link = await signReportLink(SECRET, id, orgId);
    const report = await html(await call(link, { headers: { accept: "text/html" } }));
    const href = fileLink(report);
    expect(href).toContain("&s=");
    const res = await call(href);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="[^"]+"$/);
    expect(await bytes(res)).toEqual(enc("%PDF-1.7 statement"));
  });

  it("serves HTML, SVG and an HTML file declared as an image as inert downloads", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    for (const [body, type, name] of [
      ["<html><script>alert(1)</script></html>", "text/html", "page.html"],
      ["<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/svg+xml", "logo.svg"],
      ["<html><script>alert(1)</script></html>", "image/png", "fake.png"],
    ] as const) {
      const { id, key } = await caseWith(orgId, enc(body), type, name);
      const res = await call(`/a/${id}/${encodeURIComponent(key)}`, { headers: { cookie } });
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition"), name).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), name).toContain("sandbox");
    }
  });

  it("refuses a tampered or expired signature, another organisation and another case's key, and serves a member whose link expired", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const { id, key } = await caseWith(orgId, PNG, "image/png", "logo.png");
    const path = `/a/${id}/${encodeURIComponent(key)}`;
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost");
    const tampered = new URLSearchParams(link.search);
    // The first character changes the signature's bytes; the last carries two padding bits that can decode the same.
    const sig = tampered.get("s") ?? "";
    tampered.set("s", `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`);
    expect((await call(`${path}?${tampered}`)).status).toBe(404);
    const old = new URL(await signReportLink(SECRET, id, orgId, Date.now() - 8 * 24 * 3600 * 1000), "http://localhost");
    expect((await call(`${path}${old.search}`)).status).toBe(410);
    expect((await call(`${path}${old.search}`, { headers: { cookie } })).status).toBe(200);
    const stranger = await member(await org());
    expect((await call(path, { headers: { cookie: stranger } })).status).toBe(404);
    const other = await caseWith(orgId, PNG, "image/png", "other.png");
    expect((await call(`/a/${id}/${encodeURIComponent(other.key)}`, { headers: { cookie } })).status).toBe(404);
    const nobody = await call(path, { redirect: "manual" });
    expect(nobody.status).toBe(303);
    expect(nobody.headers.get("location")).toBe(`/signin?next=${encodeURIComponent(`/r/${id}`)}`);
  });

  it("says a gone file is no longer available, with the 30-day sentence only for an old case", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const { id, key } = await caseWith(orgId, PNG, "image/png", "logo.png");
    await bucket.delete(key);
    const fresh = await call(`/a/${id}/${encodeURIComponent(key)}`, { headers: { cookie } });
    expect(fresh.status).toBe(410);
    const page = await html(fresh);
    expect(page).toContain("The original file is no longer available.");
    expect(page).not.toContain("30 days");
    expect(page).toContain(`href="/r/${id}"`);
    await db
      .prepare("UPDATE cases SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 31 * 864e5).toISOString(), id)
      .run();
    const old = await html(await call(`/a/${id}/${encodeURIComponent(key)}`, { headers: { cookie } }));
    expect(old).toContain("Original files are deleted after 30 days for privacy.");
  });

  it("answers a failed read with Try again, which opens the file once the store answers", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const { id, key } = await caseWith(orgId, PNG, "image/png", "logo.png");
    const path = `/a/${id}/${encodeURIComponent(key)}`;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const get = vi.spyOn(bucket, "get").mockRejectedValueOnce(new Error("R2 down"));
    const failed = await call(path, { headers: { cookie } });
    expect(failed.status).toBe(503);
    const page = await html(failed);
    expect(page).toContain("Sorry, something broke on our side.");
    const retry = /href="([^"]+)"[^>]*>Try again/.exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(retry).toBe(path);
    get.mockRestore();
    const again = await call(retry as string, { headers: { cookie } });
    expect(again.status).toBe(200);
    expect(await bytes(again)).toEqual(PNG);
  });
});
