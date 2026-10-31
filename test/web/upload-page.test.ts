import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { todayUsage } from "../../src/db/case-list";
import { createCase, DEFAULT_DAILY_CASES } from "../../src/db/cases";
import { untilMidnight } from "../../src/web/pages/upload-view";
import { call, signIn, stubSmtp2go } from "../auth/helpers";
import { addInviteCode } from "../fixtures/auth/members";

// The upload page (D01 T03 §6; design/SPEC.md M2): the page and its usage line, and the form answered without the app
// script (303 to the report, or the page again at the API's status with the board's words) and with it (the report's
// address, or the alert alone), the API's own rules kept in src/intake/upload.ts.
const db = env.DB;
const enc = (text: string) => new TextEncoder().encode(text);
const PDF = enc("%PDF-1.4\n% an invoice\n%%EOF\n");
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]);
// A browser's own form submission: it asks for a page.
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

async function member(organizationName = "Karoo Couriers") {
  const email = `page-uploader-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const code = `code-${crypto.randomUUID()}`;
  await addInviteCode(db, code);
  const smtp = stubSmtp2go();
  try {
    const made = await call("/api/auth/sign-up/invite-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, organizationName, consent: true }),
    });
    if (made.status !== 201) throw new Error(`signup answered ${made.status}`);
  } finally {
    smtp.restore();
  }
  const { cookie } = await signIn(email);
  const org = await db
    .prepare(`SELECT m."organizationId" AS id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
    .bind(email)
    .first<{ id: string }>();
  return { cookie, orgId: org?.id as string };
}
function post(cookie: string | null, bytes: Uint8Array, name: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  return call("/upload", {
    method: "POST",
    body: form,
    headers: { accept: BROWSER, ...(cookie ? { cookie } : {}), ...extra },
  });
}
const SCRIPT = (name: string, size: number) => ({
  "x-upload-script": "1",
  "x-file-name": encodeURIComponent(name),
  "x-file-size": String(size),
});
// The alert region to the end of its form (the shell has forms of its own before it).
const alertOf = (html: string) => {
  const at = html.indexOf('id="upload-alert"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</form>", at));
};

describe("the upload page", () => {
  it("draws the drop zone, the file input, the accepted kinds and today's usage for a member", async () => {
    const { cookie, orgId } = await member();
    for (let i = 0; i < 3; i++) await createCase(db, { orgId, channel: "email", headersAvailable: true });
    const res = await call("/upload", { headers: { cookie, accept: BROWSER } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Check a file<\/h1>/);
    expect(html).toContain("Drop one file here");
    expect(html).toMatch(/<label for="upload-file"[\s\S]*Choose a file[\s\S]*<\/label>/);
    expect(html).toMatch(/<input id="upload-file" name="file" type="file" required=""/);
    expect(html).toContain("One file at a time, up to 25 MB");
    for (const kind of [
      "A saved email",
      "Invoice, proof of payment or bank letter",
      "Screenshot or photo",
      "Voice note or voicemail",
    ])
      expect(html, kind).toContain(kind);
    expect(html).toContain("Not accepted: programs, archives, Word or Excel files");
    expect(html).toContain(`Karoo Couriers has used <strong>3 of ${DEFAULT_DAILY_CASES}</strong> checks today.`);
    expect(html).toMatch(/href="\/settings\/plan"[^>]*>See your plan/);
    expect(html).toMatch(/<form method="post" action="\/upload" enctype="multipart\/form-data"/);
    expect(html).toMatch(/Check this file/);
    expect(html).toMatch(/id="upload-alert" role="alert"/);
  });

  it("sends a visitor who is not signed in to sign in, and back", async () => {
    const res = await call("/upload", { headers: { accept: BROWSER } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/signin?next=%2Fupload");
  });

  it("counts today's cases against the organisation's own limit, or the default", async () => {
    const a = await member("Counted");
    const b = await member("Other");
    await createCase(db, { orgId: a.orgId, channel: "email", headersAvailable: true });
    await createCase(db, { orgId: b.orgId, channel: "email", headersAvailable: true });
    // A case from before midnight SAST is not today's.
    await db
      .prepare("UPDATE cases SET created_at = ? WHERE id = (SELECT id FROM cases WHERE org_id = ? LIMIT 1)")
      .bind("2020-01-01T00:00:00.000Z", b.orgId)
      .run();
    expect(await todayUsage(db, a.orgId)).toEqual({ used: 1, limit: DEFAULT_DAILY_CASES });
    expect(await todayUsage(db, b.orgId)).toEqual({ used: 0, limit: DEFAULT_DAILY_CASES });
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, 7)").bind(a.orgId).run();
    expect(await todayUsage(db, a.orgId)).toEqual({ used: 1, limit: 7 });
  });

  it("says how long until 00:00 SAST", () => {
    expect(untilMidnight(new Date("2026-10-31T12:48:00Z"))).toBe("9 hours 12 minutes");
    expect(untilMidnight(new Date("2026-10-31T21:59:00Z"))).toBe("1 minute");
  });
});

describe("the upload form without the script", () => {
  // The same file under the same name and type within the day is the API's repeat (src/intake/upload.ts).
  it("answers a file with a 303 to its report, and the same file again with the first report", async () => {
    const { cookie } = await member();
    const first = await post(cookie, PDF, "invoice.pdf");
    expect(first.status).toBe(303);
    const report = first.headers.get("location") ?? "";
    expect(report).toMatch(/^\/r\/[0-9A-Z]{26}$/);
    expect((await call(report, { headers: { cookie, accept: BROWSER } })).status).toBe(200);
    const again = await post(cookie, PDF, "invoice.pdf");
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(report);
  });

  it("answers a refused type at 415 with the API's reason in the alert region", async () => {
    const { cookie } = await member();
    const res = await post(cookie, EXE, "invoice.pdf.exe");
    expect(res.status).toBe(415);
    const alert = alertOf(await res.text());
    expect(alert).toContain("We cannot check this file.");
    expect(alert.length).toBeGreaterThan(200);
  });

  it("answers the daily limit at 429 with the time left and About your plan, and keeps Choose a file", async () => {
    const { cookie, orgId } = await member();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, 0)").bind(orgId).run();
    const res = await post(cookie, PDF, "invoice.pdf");
    expect(res.status).toBe(429);
    const html = await res.text();
    const alert = alertOf(html);
    expect(alert).toContain("Karoo Couriers has used all 0 checks for today.");
    expect(alert).toMatch(/Checks start again at 00:00 SAST, in \d+ hours? \d+ minutes?|in \d+ (hours?|minutes?)/);
    expect(alert).toMatch(/href="\/settings\/plan"[^>]*>About your plan/);
    expect(html).not.toMatch(/<input id="upload-file"[^>]*disabled/);
  });

  it("answers an expired session from a browser's own form with the signed-out page at 401, not a redirect", async () => {
    const res = await post("better-auth.session_token=expired.invalid", PDF, "invoice.pdf");
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Your session ended.");
    expect(html).toMatch(
      /href="\/signin\?next=%2Fupload"[^>]*>Sign in again<\/a> and choose the file once more; nothing was uploaded\./,
    );
  });

  it("refuses a body that is not one file in the field file with the API's words", async () => {
    const { cookie } = await member();
    const form = new FormData();
    form.append("note", "hello");
    const res = await call("/upload", { method: "POST", body: form, headers: { accept: BROWSER, cookie } });
    expect(res.status).toBe(400);
    expect(alertOf(await res.text())).toContain("Send exactly one file, in a field named file, and nothing else.");
  });
});

describe("the upload form with the script", () => {
  it("answers the report's address for a file", async () => {
    const { cookie } = await member();
    const res = await post(cookie, PDF, "invoice.pdf", SCRIPT("invoice.pdf", PDF.length));
    expect(res.status).toBe(204);
    expect(res.headers.get("x-location")).toMatch(/^\/r\/[0-9A-Z]{26}$/);
  });

  it("answers a refusal with the alert alone, naming the file", async () => {
    const { cookie } = await member();
    const res = await post(cookie, EXE, "invoice.pdf.exe", SCRIPT("invoice.pdf.exe", EXE.length));
    expect(res.status).toBe(415);
    const html = await res.text();
    expect(html).not.toContain("<html");
    expect(html).toContain("We cannot check &quot;invoice.pdf.exe&quot;.");
  });

  it("answers an expired session with the signed-out words alone", async () => {
    const res = await post("better-auth.session_token=expired.invalid", PDF, "a.pdf", SCRIPT("a.pdf", PDF.length));
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).not.toContain("<html");
    expect(html).toContain("Your session ended.");
  });
});
