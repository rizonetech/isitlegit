import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  clearDailyCapOverrideStatement,
  setDailyCapOverrideStatement,
  setPlanStatement,
} from "../../src/auth/plan-sql";
import { todayUsage } from "../../src/db/case-list";
import { createCase, DEFAULT_DAILY_CASES } from "../../src/db/cases";
import { uploadKey } from "../../src/intake/upload";
import { alertFor, megabytes, TOO_LARGE_AUDIO, TOO_LARGE_FILE, untilMidnight } from "../../src/web/pages/upload-view";
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
    expect(html).toContain("Word, Excel or PowerPoint file");
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
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 7)").bind(a.orgId).run();
    expect(await todayUsage(db, a.orgId)).toEqual({ used: 1, limit: 7 });
  });

  it("reads a Free organisation's usage against its plan's 5 a day (D07 T08 §8)", async () => {
    const { cookie, orgId } = await member("Free Freight");
    const plan = setPlanStatement(orgId, "free");
    await db
      .prepare(plan.sql)
      .bind(...plan.params)
      .run();
    for (let i = 0; i < 5; i++) await createCase(db, { orgId, channel: "email", headersAvailable: true });
    expect(await todayUsage(db, orgId)).toEqual({ used: 5, limit: 5 });
    const html = await (await call("/upload", { headers: { cookie, accept: BROWSER } })).text();
    expect(html).toContain("Free Freight has used <strong>5 of 5</strong> checks today.");
  });

  it("reads an operator's raised cap of 500 as the limit on the page, and the plan's cap again once it is cleared (D07 T08 §15)", async () => {
    const { cookie, orgId } = await member("Eval Freight");
    const set = setDailyCapOverrideStatement(orgId, 500);
    await db
      .prepare(set.sql)
      .bind(...set.params)
      .run();
    for (let i = 0; i < 3; i++) await createCase(db, { orgId, channel: "email", headersAvailable: true });
    const raised = await (await call("/upload", { headers: { cookie, accept: BROWSER } })).text();
    expect(raised).toContain("Eval Freight has used <strong>3 of 500</strong> checks today.");
    const clear = clearDailyCapOverrideStatement(orgId);
    await db
      .prepare(clear.sql)
      .bind(...clear.params)
      .run();
    const back = await (await call("/upload", { headers: { cookie, accept: BROWSER } })).text();
    expect(back).toContain("Eval Freight has used <strong>3 of 50</strong> checks today.");
  });

  it("says how long until 00:00 SAST, in whole minutes rounded up", () => {
    expect(untilMidnight(new Date("2026-10-31T12:48:00Z"))).toBe("9 hours 12 minutes");
    expect(untilMidnight(new Date("2026-10-31T21:59:00Z"))).toBe("1 minute");
    // 9 hours 59 minutes and some seconds reads 10 hours, never "9 hours 60 minutes".
    expect(untilMidnight(new Date("2026-10-31T12:00:30Z"))).toBe("10 hours");
  });

  it("names a file just over the limit by more than the limit, and gives advice for its kind", () => {
    expect(megabytes(25 * 1024 * 1024 + 1)).toBe("25.1 MB");
    const now = new Date();
    const pdf = alertFor(413, "", { name: "scan.pdf", size: 31 * 1024 * 1024 }, null, now);
    expect(pdf.title).toBe('"scan.pdf" is 31 MB. The limit is 25 MB.');
    expect(pdf.detail).toBe(TOO_LARGE_FILE);
    expect(alertFor(413, "", { name: "meeting.mp3", size: 31 * 1024 * 1024 }, null, now).detail).toBe(TOO_LARGE_AUDIO);
    expect(alertFor(413, "", { name: null, size: null }, null, now).title).toBe(
      "The file is larger than 25 MB, the most that can be checked.",
    );
  });

  it("lists only audio the intake takes (no M4A)", async () => {
    const { cookie } = await member();
    const html = await (await call("/upload", { headers: { cookie, accept: BROWSER } })).text();
    expect(html).toContain(".ogg, .opus, .wav or .mp3, up to 10 minutes");
    expect(html).not.toContain(".m4a");
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
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 1)").bind(orgId).run();
    await createCase(db, { orgId, channel: "email", headersAvailable: true });
    const res = await post(cookie, PDF, "invoice.pdf");
    expect(res.status).toBe(429);
    const html = await res.text();
    const alert = alertOf(html);
    expect(alert).toContain("Karoo Couriers has used all 1 checks for today.");
    expect(alert).toMatch(/Checks start again at 00:00 SAST, in \d+ hours? \d+ minutes?|in \d+ (hours?|minutes?)/);
    expect(alert).toMatch(/href="\/settings\/plan"[^>]*>About your plan/);
    expect(html).not.toMatch(/<input id="upload-file"[^>]*disabled/);
  });

  it("says a paused organisation's checks are paused, promising no reset at midnight (D07 T08 §8)", async () => {
    const { cookie, orgId } = await member();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 0)").bind(orgId).run();
    const page = await (await call("/upload", { headers: { cookie, accept: BROWSER } })).text();
    // Open paused, before any file is chosen: the zone in its paused state and the alert saying why.
    expect(page).toMatch(/data-state="paused"/);
    expect(page).toContain("Uploads paused");
    expect(page).not.toContain("Uploads paused until midnight");
    expect(alertOf(page)).toContain("Checks are paused for Karoo Couriers.");
    const res = await post(cookie, PDF, "invoice.pdf");
    expect(res.status).toBe(429);
    const alert = alertOf(await res.text());
    expect(alert).toContain("Checks are paused for Karoo Couriers.");
    expect(alert).toContain("Ask IsItLegit to turn them back on.");
    expect(alert).not.toMatch(/00:00 SAST|midnight|Try again/);
    expect(alert).toMatch(/href="\/settings\/plan"[^>]*>About your plan/);
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
    expect(alertOf(await res.text())).toContain(
      "Send exactly one file in a field named file, and at most one replayRunId field, and nothing else.",
    );
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

  it("answers a malformed file name with the refusal, never a server error", async () => {
    const res = await post("better-auth.session_token=expired.invalid", PDF, "a.pdf", {
      "x-upload-script": "1",
      "x-file-name": "%",
      "x-file-size": "3",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-upload-alert")).toBe("1");
    expect(await res.text()).toContain("Your session ended.");
  });

  it("answers an expired session with the signed-out words alone", async () => {
    const res = await post("better-auth.session_token=expired.invalid", PDF, "a.pdf", SCRIPT("a.pdf", PDF.length));
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).not.toContain("<html");
    expect(html).toContain("Your session ended.");
  });
});

describe("the upload form's other answers", () => {
  it("answers a file still being taken at 503 with its retry-after, and without the script says how to try again", async () => {
    const { cookie, orgId } = await member();
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', NULL, ?)",
      )
      .bind(orgId, `upload:${await uploadKey(PDF, "x.pdf", "application/octet-stream")}`, new Date().toISOString())
      .run();
    const res = await post(cookie, PDF, "x.pdf");
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(alertOf(await res.text())).toContain("Choose the file again and select Check this file.");
  });

  it("answers a member with no organisation at 403", async () => {
    const email = `no-org-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const res = await post(cookie, PDF, "x.pdf");
    expect(res.status).toBe(403);
  });

  it("passes the API's cookie on: an ended session's cookie is cleared", async () => {
    // A genuine signed cookie whose session has since ended (its row gone).
    const { cookie } = await member();
    const token = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)?.[1] ?? "").split(".")[0];
    expect((await db.prepare(`DELETE FROM "session" WHERE token = ?`).bind(token).run()).meta.changes).toBe(1);
    const res = await post(cookie, PDF, "invoice.pdf");
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join("; ")).toMatch(/session_token=;|Max-Age=0|expires=Thu, 01 Jan 1970/i);
  });

  it("marks the script's alerts as alerts, and keeps the daily limit's Try again", async () => {
    const { cookie, orgId } = await member();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 1)").bind(orgId).run();
    await createCase(db, { orgId, channel: "email", headersAvailable: true });
    const res = await post(cookie, PDF, "invoice.pdf", SCRIPT("invoice.pdf", PDF.length));
    expect(res.status).toBe(429);
    expect(res.headers.get("x-upload-alert")).toBe("1");
    expect(await res.text()).toContain("data-upload-retry");
  });

  it("draws the daily limit's page paused, Choose a file usable", async () => {
    const { cookie, orgId } = await member();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 1)").bind(orgId).run();
    await createCase(db, { orgId, channel: "email", headersAvailable: true });
    const html = await (await post(cookie, PDF, "invoice.pdf")).text();
    expect(html).toMatch(/data-state="paused"/);
    expect(html).toContain("Uploads paused until midnight");
    expect(html).not.toMatch(/<input id="upload-file"[^>]*disabled/);
  });

  // D07 T03 §41 (the checks lane's D01 T03 §12): an upload that failed before its file was stored uses none of the day, on
  // the page as in the cap, and its replacement uses the slot once.
  it("never reads the day as used by an upload whose file never stored, and counts its replacement once", async () => {
    const { cookie, orgId } = await member();
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 1)").bind(orgId).run();
    const page = async () => (await call("/upload", { headers: { cookie, accept: BROWSER } })).text();
    const line = (html: string) => /has used <strong>(\d+ of \d+)<\/strong> checks today/.exec(html)?.[1];

    // The raw store refuses the write during the upload: the case is kept, ended partial with its admit step failed.
    const real = env.ARTEFACTS.put.bind(env.ARTEFACTS);
    const refuse = vi.spyOn(env.ARTEFACTS, "put").mockImplementation(((key: string, ...rest: unknown[]) => {
      if (String(key).startsWith("raw/")) throw new Error("R2 is down");
      return (real as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never);
    let failed: Response;
    try {
      failed = await post(cookie, PDF, "invoice.pdf");
    } finally {
      refuse.mockRestore();
    }
    expect(failed.status).not.toBe(303);
    const kept = await db.prepare("SELECT status FROM cases WHERE org_id = ?").bind(orgId).all<{ status: string }>();
    expect(kept.results.map((c) => c.status)).toEqual(["partial"]);
    const step = await db
      .prepare("SELECT step, status, error FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE org_id = ?)")
      .bind(orgId)
      .all<{ step: string; status: string; error: string | null }>();
    expect(step.results).toContainEqual({ step: "admit", status: "failed", error: "RawMissing" });

    // The page: the day is still whole, not paused, no limit warning, the file input usable.
    const afterFailure = await page();
    expect(line(afterFailure)).toBe("0 of 1");
    expect(afterFailure).toMatch(/data-state="ready"/);
    expect(afterFailure).not.toMatch(/data-state="paused"/);
    expect(afterFailure).not.toContain("used all");
    // (The paused wording is always in the markup, swapped in by the state attribute; the state is what the reader sees.)
    expect(afterFailure).not.toMatch(/<input id="upload-file"[^>]*disabled/);
    expect(await todayUsage(db, orgId)).toEqual({ used: 0, limit: 1 });

    // Its replacement is admitted and uses the slot once.
    const replacement = await post(cookie, PDF, "invoice.pdf");
    expect(replacement.status).toBe(303);
    const afterReplacement = await page();
    expect(line(afterReplacement)).toBe("1 of 1");
    expect(afterReplacement).not.toContain("2 of 1");
    // Reaching the limit does not pause a fresh page: it stays ready, the file input usable, until an upload is refused.
    expect(afterReplacement).toMatch(/data-state="ready"/);
    expect(afterReplacement).not.toMatch(/data-state="paused"/);
    expect(afterReplacement).not.toContain("used all");
    expect(afterReplacement).not.toMatch(/<input id="upload-file"[^>]*disabled/);
    expect(await todayUsage(db, orgId)).toEqual({ used: 1, limit: 1 });

    // The next upload is past the limit: 429, drawn paused (the page draws the state from that answer, as §6 designed it).
    const past = await post(cookie, PDF, "another.pdf");
    expect(past.status).toBe(429);
    const paused = await past.text();
    expect(paused).toMatch(/data-state="paused"/);
    expect(alertOf(paused)).toContain("has used all 1 checks for today.");
    expect(await todayUsage(db, orgId)).toEqual({ used: 1, limit: 1 });
  });
});
