import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putArtefact, putAttachment } from "../../src/intake/store";
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

// A whole 1x1 PNG, and the same file cut short (its end marker gone), as a damaged attachment arrives.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);
const CUT = PNG.slice(0, PNG.byteLength - 20);
function b64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
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
// `rendered`: a file the pipeline made itself (a page render); otherwise an attachment that came with the message.
async function caseWith(orgId: string, body: Uint8Array, mediaType: string, name: string, rendered = false) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  const stored = rendered
    ? await putArtefact({ bucket, db }, id, "page", name, body, mediaType)
    : await putAttachment({ bucket, db }, id, name, body, mediaType);
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

describe("the reference logo beside a crop (D07 T03 s14)", () => {
  it("serves a brand's reference to the case's member only, and says not found for a brand with none", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const { id } = await caseWith(orgId, PNG, "image/png", "page.png", true);
    const digest = await crypto.subtle.digest("SHA-256", PNG as BufferSource);
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = "ref/logos/20260101T000000Z/nimbusmail.png";
    await bucket.put(key, PNG);
    await bucket.put(
      "ref/logos/index.json",
      JSON.stringify({
        version: 1,
        generation: "20260101T000000Z",
        generated_at: "2026-01-01T00:00:00Z",
        logos: [
          {
            slug: "nimbusmail",
            brand: "NimbusMail",
            key,
            page_url: "https://nimbusmail.example/",
            source_url: "https://nimbusmail.example/logo.png",
            source_kind: "fictional",
            use: "detection-reference",
            fetched_at: "2026-01-01T00:00:00Z",
            media_type: "image/png",
            width: 1,
            height: 1,
            sha256: sha,
            fictional: true,
          },
        ],
        missing: [],
      }),
    );
    const served = await call(`/a/${id}/${encodeURIComponent("ref-logo:NimbusMail")}?inline=1`, {
      headers: { cookie },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    const stranger = await call(`/a/${id}/${encodeURIComponent("ref-logo:NimbusMail")}?inline=1`);
    expect(stranger.status).toBe(303);
    const link = await signReportLink(SECRET, id, orgId);
    const holder = await call(
      `/a/${id}/${encodeURIComponent("ref-logo:NimbusMail")}${link.slice(link.indexOf("?"))}&inline=1`,
    );
    expect(holder.status).toBe(200);
    expect(new Uint8Array(await holder.arrayBuffer())).toEqual(PNG);
    const none = await call(`/a/${id}/${encodeURIComponent("ref-logo:UnknownBrand")}?inline=1`, {
      headers: { cookie },
    });
    expect(none.status).toBe(404);
    await bucket.delete(key);
    await bucket.delete("ref/logos/index.json");
  });
});

describe("the artefact route", () => {
  // Real 2x2 images (Pillow 13), and each damaged as attachments arrive damaged: cut short, a byte changed, padded.
  const IMAGES = {
    "image/png": PNG,
    "image/jpeg": b64(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z",
    ),
    "image/gif": b64("R0lGODdhAgACAIEAAMgeHgAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7"),
    "image/webp": b64("UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoCAAIAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA"),
  } as const;
  const LOSSLESS_WEBP = b64("UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQjyLXo/+BiOh/AAA=");

  it("recognises a whole passive raster image by its structure", () => {
    for (const [type, body] of Object.entries(IMAGES)) expect(passiveImage(body), type).toBe(type);
    expect(passiveImage(LOSSLESS_WEBP)).toBe("image/webp");
  });

  it("refuses a damaged image of each kind, and a file that only starts like one", () => {
    for (const [type, body] of Object.entries(IMAGES)) {
      expect(passiveImage(body.slice(0, body.byteLength - 4)), `${type} cut short`).toBeNull();
      expect(passiveImage(body.slice(0, Math.floor(body.byteLength / 2))), `${type} cut in half`).toBeNull();
      expect(passiveImage(new Uint8Array([...body, 0, 0, 0, 0])), `${type} padded`).toBeNull();
    }
    // A byte inside the image data (the IDAT chunk's data starts at 41): only its CRC tells.
    const flipped = PNG.slice();
    flipped[45] = (flipped[45] as number) ^ 0xff;
    expect(passiveImage(flipped), "png with a changed byte").toBeNull();
    // A scan with no frame before it: the real JPEG with its SOF0 segment cut out.
    const jpg = IMAGES["image/jpeg"];
    const sof = jpg.findIndex((x, i) => x === 0xff && jpg[i + 1] === 0xc0);
    const sofEnd = sof + 2 + (((jpg[sof + 2] as number) << 8) | (jpg[sof + 3] as number));
    expect(
      passiveImage(new Uint8Array([...jpg.slice(0, sof), ...jpg.slice(sofEnd)])),
      "a jpeg with no frame",
    ).toBeNull();
    // A lossless WebP whose image chunk lacks its signature byte.
    const vp8l = LOSSLESS_WEBP.slice();
    vp8l[20] = 0x00;
    expect(passiveImage(vp8l), "a webp whose image chunk is not one").toBeNull();
    expect(
      passiveImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9])),
      "the review's jpeg",
    ).toBeNull();
    expect(passiveImage(enc("GIF89a\x01\0\x01\0\0\0\0;")), "a gif with no image").toBeNull();
    expect(passiveImage(enc("RIFF\x08\0\0\0WEBPVP8 ")), "a webp with no image chunk").toBeNull();
    for (const text of [
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "<html><script>1</script>",
      "GIF89",
      "RIFF\0\0\0\0AVI ",
    ])
      expect(passiveImage(enc(text)), text).toBeNull();
  });

  it("downloads a drawn card's file for a member with its exact bytes, and shows a rendered image inline when asked", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const { id } = await caseWith(orgId, PNG, "image/png", "logo.png", true);
    const report = await html(await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } }));
    const download = await call(fileLink(report), { headers: { cookie } });
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await bytes(download)).toEqual(PNG);
    const res = await call(`${fileLink(report)}?inline=1`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await bytes(res)).toEqual(PNG);
  });

  // D07 T09 §6: a recording asked for inline plays, for a member and a signed-link holder alike.
  it("serves a recording inline as audio when asked, under the same ownership checks", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    const OGG = (() => {
      const b = new Uint8Array(27 + 8 + 4);
      b.set(enc("OggS"), 0);
      b.set(enc("OpusHead"), 27);
      return b;
    })();
    const { id } = await caseWith(orgId, OGG, "audio/ogg", "voice-note.ogg", true);
    const report = await html(await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } }));
    const href = fileLink(report);
    const asAttachment = await call(href, { headers: { cookie } });
    expect(asAttachment.headers.get("content-disposition")).toMatch(/^attachment;/);
    const play = await call(`${href}?inline=1`, { headers: { cookie } });
    expect(play.status).toBe(200);
    expect(play.headers.get("content-type")).toBe("audio/ogg");
    expect(play.headers.get("content-disposition")).toBe("inline");
    expect(await bytes(play)).toEqual(OGG);
    const link = await signReportLink(SECRET, id, orgId);
    const holderReport = await html(await call(link, { headers: { accept: "text/html" } }));
    const holderPlay = await call(`${fileLink(holderReport)}&inline=1`);
    expect(holderPlay.status).toBe(200);
    expect(holderPlay.headers.get("content-type")).toBe("audio/ogg");
    const stranger = await call(`${href}?inline=1`);
    expect(stranger.status).toBe(303);
    expect(await bytes(stranger)).not.toEqual(OGG);
    // The type comes from the bytes, never the name: a WAV with no extension, and one named as another format.
    const WAVH = (() => {
      const b = new Uint8Array(16);
      b.set(enc("RIFF"), 0);
      b.set(enc("WAVE"), 8);
      return b;
    })();
    for (const name of ["voicemail", "voicemail.mp3"]) {
      const named = await caseWith(orgId, WAVH, "audio/wav", name, true);
      const namedReport = await html(await call(`/r/${named.id}`, { headers: { cookie, accept: "text/html" } }));
      const played = await call(`${fileLink(namedReport)}?inline=1`, { headers: { cookie } });
      expect(played.headers.get("content-type"), name).toBe("audio/wav");
      expect(played.headers.get("content-disposition"), name).toBe("inline");
    }
  });

  it("downloads a drawn capture for a signed-link holder as an attachment with its exact bytes, and shows it inline when asked", async () => {
    const orgId = await org();
    const { id } = await caseWith(orgId, PNG, "image/png", "capture.png", true);
    const link = await signReportLink(SECRET, id, orgId);
    const report = await html(await call(link, { headers: { accept: "text/html" } }));
    const href = fileLink(report);
    expect(href).toContain("&s=");
    const download = await call(href);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="[^"]+"$/);
    expect(await bytes(download)).toEqual(PNG);
    const inline = await call(`${href}&inline=1`);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-disposition")).toBe("inline");
    expect(await bytes(inline)).toEqual(PNG);
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

  it("never draws a file that came with the message, a whole image included, even asked inline", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    // The review's header-only WebP, and a whole PNG: both arrived as attachments.
    const headerOnly = Uint8Array.from("5249464612000000574542505650384c050000002f0000000000".match(/../g) ?? [], (h) =>
      parseInt(h, 16),
    );
    for (const [body, name] of [
      [headerOnly, "photo.webp"],
      [PNG, "logo.png"],
    ] as const) {
      const { id, key } = await caseWith(orgId, body, "image/webp", name);
      const res = await call(`/a/${id}/${encodeURIComponent(key)}?inline=1`, { headers: { cookie } });
      expect(res.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition"), name).toMatch(/^attachment;/);
    }
  });

  it("serves HTML, SVG, a damaged image and an HTML file declared as an image as inert downloads, even asked inline", async () => {
    const orgId = await org();
    const cookie = await member(orgId);
    for (const [body, type, name] of [
      ["<html><script>alert(1)</script></html>", "text/html", "page.html"],
      ["<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/svg+xml", "logo.svg"],
      ["<html><script>alert(1)</script></html>", "image/png", "fake.png"],
      [CUT, "image/png", "cut.png"],
    ] as const) {
      const { id, key } = await caseWith(orgId, typeof body === "string" ? enc(body) : body, type, name, true);
      const res = await call(`/a/${id}/${encodeURIComponent(key)}?inline=1`, { headers: { cookie } });
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
    const expired = await call(`${path}${old.search}`);
    expect(expired.status).toBe(410);
    // An expired link is told from a deleted file by the mark, not by the status.
    expect(expired.headers.get("x-artefact-state")).toBe("link-expired");
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
    expect(fresh.headers.get("x-artefact-state")).toBe("gone");
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

  for (const [where, fail] of [
    ["storage", () => vi.spyOn(bucket, "get").mockRejectedValueOnce(new Error("R2 down"))],
    [
      "database",
      () => {
        const prepare = db.prepare.bind(db);
        let once = true;
        return vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
          if (once && /FROM artefacts WHERE r2_key/.test(sql)) {
            once = false;
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return prepare(sql);
        });
      },
    ],
  ] as const)
    for (const reader of ["member", "link holder"] as const)
      it(`answers a failed ${where} read for a ${reader} with Try again, which opens the file once the store answers`, async () => {
        const orgId = await org();
        const cookie = reader === "member" ? await member(orgId) : undefined;
        const { id, key } = await caseWith(orgId, PNG, "image/png", "logo.png");
        const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost");
        const path = `/a/${id}/${encodeURIComponent(key)}${reader === "member" ? "" : link.search}`;
        const headers: Record<string, string> = cookie ? { cookie } : {};
        vi.spyOn(console, "log").mockImplementation(() => {});
        const spy = fail();
        const failed = await call(path, { headers });
        expect(failed.status).toBe(503);
        expect(failed.headers.get("x-artefact-state")).toBe("unavailable");
        const page = await html(failed);
        expect(page).toContain("This file could not be loaded just now.");
        expect(page).toContain(`href="/r/${id}${reader === "member" ? "" : link.search.replaceAll("&", "&amp;")}"`);
        const retry = /href="([^"]+)"[^>]*>Try again/.exec(page)?.[1]?.replaceAll("&amp;", "&");
        expect(retry).toBe(path);
        spy.mockRestore();
        const again = await call(retry as string, { headers });
        expect(again.status).toBe(200);
        expect(await bytes(again)).toEqual(PNG);
      });
});
