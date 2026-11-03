import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSV_HEADER, median, weeklyCounts, weeklyStats, weekStart } from "../../src/db/case-stats";
import { ulid } from "../../src/db/ulid";
import { kindLine, verdictTime } from "../../src/web/pages/cases-view";
import { call, signIn, target } from "../auth/helpers";

// The Cases list's weekly stats and their CSV (D07 T04 §2; board `Cases` stats panel): cases by the SAST week they
// arrived in, every state counted, the median to a stored verdict, counts only in the CSV, and its refusals as pages.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function org(name: string) {
  const id = `org-stats-${++n}-${crypto.randomUUID().slice(0, 6)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, new Date().toISOString())
    .run();
  return id;
}
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;
async function member(orgId: string) {
  const email = `stats-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const uid = await userId(email);
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, uid, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, uid).run();
  return { cookie, email, uid };
}
type Made = {
  at: string;
  status?: "received" | "running" | "done" | "partial";
  verdict?: "safe" | "suspicious" | "malicious" | null;
  decidedAt?: string | null;
  subject?: string;
};
async function made(orgId: string, c: Made) {
  const id = ulid();
  const status = c.status ?? "done";
  const verdict = c.verdict === undefined ? "safe" : c.verdict;
  await db
    .prepare(
      `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at, forwarded_by, source_kind, original_subject, original_from_address)
       VALUES (?, ?, 'email', ?, ?, 1, ?, ?, 'someone@demo.isitlegit.co.za', 'mail', ?, 'secret-sender@evil.example')`,
    )
    .bind(id, orgId, status, verdict, c.at, c.at, c.subject ?? "Secret subject words")
    .run();
  if (c.decidedAt && verdict)
    await db
      .prepare(
        `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at)
         VALUES (?, ?, 'h', 0.9, '[]', '[]', 'model', ?)`,
      )
      .bind(id, verdict, c.decidedAt)
      .run();
  return id;
}
const plus = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const get = (path: string, cookie?: string) =>
  call(path, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });

// Friday 2026-10-30 12:00 SAST; its week began Monday 2026-10-26 00:00 SAST (2026-10-25T22:00Z).
const NOW = new Date("2026-10-30T10:00:00Z");
const MONDAY = "2026-10-25T22:00:00.000Z";

describe("weekStart", () => {
  it("is the Monday 00:00 SAST at or before now", () => {
    expect(weekStart(NOW)).toBe(MONDAY);
    expect(weekStart(new Date(MONDAY))).toBe(MONDAY);
    // Sunday 23:59 SAST belongs to the week before.
    expect(weekStart(new Date("2026-10-25T21:59:00Z"))).toBe("2026-10-18T22:00:00.000Z");
    // Monday 01:30 SAST is still Sunday in UTC: the SAST Monday counts.
    expect(weekStart(new Date("2026-10-25T23:30:00Z"))).toBe(MONDAY);
  });
});

describe("weeklyStats", () => {
  it("counts every state by the week of arrival, verdicts from done or partial cases, the median to the stored verdict", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const tue = "2026-10-27T08:00:00.000Z";
    await made(a, { at: MONDAY, verdict: "malicious", decidedAt: plus(MONDAY, 40) });
    await made(a, { at: tue, verdict: "suspicious", decidedAt: plus(tue, 50) });
    await made(a, { at: tue, verdict: "safe", decidedAt: plus(tue, 30) });
    await made(a, { at: tue, status: "partial", verdict: "suspicious", decidedAt: plus(tue, 70) });
    await made(a, { at: tue, status: "partial", verdict: null });
    await made(a, { at: tue, status: "received", verdict: null });
    await made(a, { at: tue, status: "running", verdict: null });
    // Last week: one on Sunday 23:59:59 SAST whose verdict came on Monday, and one earlier.
    const sunday = "2026-10-25T21:59:59.000Z";
    await made(a, { at: sunday, verdict: "malicious", decidedAt: plus(sunday, 120) });
    await made(a, { at: "2026-10-20T08:00:00.000Z", verdict: "safe", decidedAt: "2026-10-20T08:01:00.000Z" });
    // Another organisation's cases, this week, never.
    await made(b, { at: tue, verdict: "malicious", decidedAt: plus(tue, 5) });
    const stats = await weeklyStats(db, a, NOW);
    expect(stats.lastWeekChecked).toBe(2);
    expect(stats.thisWeek).toEqual({
      weekStart: MONDAY,
      checked: 7,
      malicious: 1,
      suspicious: 2,
      safe: 1,
      unfinished: 3,
      // 30, 40, 50, 70: the mean of the middle two.
      medianSecondsToVerdict: 45,
      kinds: { phishing: 0, invoice: 0, impersonation: 0 },
    });
    const weeks = await weeklyCounts(db, a, NOW, 2);
    expect(weeks[1]).toMatchObject({ checked: 2, malicious: 1, safe: 1, medianSecondsToVerdict: 90 });
  });

  it("reads no median for a week with no verdict, and an odd count's middle value", async () => {
    const a = await org("Karoo Couriers");
    await made(a, { at: "2026-10-27T08:00:00.000Z", status: "running", verdict: null });
    expect((await weeklyStats(db, a, NOW)).thisWeek.medianSecondsToVerdict).toBeNull();
    expect(median([5, 1, 9])).toBe(5);
    expect(median([])).toBeNull();
  });

  it("words the median as the board does", () => {
    expect(verdictTime(48)).toBe("48 s");
    expect(verdictTime(89)).toBe("89 s");
    expect(verdictTime(90)).toBe("1 min 30 s");
    expect(verdictTime(125)).toBe("2 min 5 s");
    expect(verdictTime(180)).toBe("3 min");
    expect(verdictTime(null)).toBe("No verdicts yet");
  });
});

describe("the stats panel on the Cases page", () => {
  it("draws this week's tiles, the same under any filter, and none on the first-run state", async () => {
    const a = await org("Karoo Couriers");
    const now = new Date();
    const thisWeek = weekStart(now);
    await made(a, { at: plus(thisWeek, 60), verdict: "malicious", decidedAt: plus(thisWeek, 108) });
    await made(a, { at: plus(thisWeek, 120), verdict: "safe", decidedAt: plus(thisWeek, 168) });
    await made(a, { at: plus(thisWeek, -3600), verdict: "safe", decidedAt: plus(thisWeek, -3500) });
    const { cookie } = await member(a);
    for (const path of ["/cases", "/cases?verdict=safe&period=7", "/cases?q=nothing"]) {
      const html = await (await get(path, cookie)).text();
      const panel = html.slice(html.indexOf('<section id="case-stats"'), html.indexOf("</section>"));
      const text = panel.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
      expect(text, path).toContain("|Checked this week|2|1 last week|");
      expect(text, path).toContain("|Malicious or suspicious|1|");
      expect(text, path).toContain("|Median time to verdict|48 s|Export counts as CSV|");
      expect(panel).toMatch(/<dd class="[^"]*text-mal[^"]*">1<\/dd>/);
      expect(panel).toContain(`href="/cases/stats.csv?org=${a}"`);
      expect(panel).not.toContain("download=");
    }
    // The panel joins every results request's out-of-band swap.
    expect(await (await get("/cases", cookie)).text()).toContain(
      'hx-select-oob="#case-count,#case-stats,#case-period-state,#case-range-state,#case-checker-state"',
    );
    const fresh = await org("Empty Freight");
    const html = await (await get("/cases", (await member(fresh)).cookie)).text();
    expect(html).toContain("Check your first suspicious email.");
    expect(html).not.toContain('id="case-stats"');
  });

  it("answers a stats read that fails with the 503 page, never zeros", async () => {
    const a = await org("Karoo Couriers");
    await made(a, { at: new Date().toISOString() });
    const { cookie } = await member(a);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("LEFT JOIN case_verdicts")) throw new Error("D1_ERROR: stats down");
      return prepare(sql);
    });
    const res = await get("/cases", cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("Checked this week");
  });
});

describe("GET /cases/stats.csv", () => {
  it("is the last 12 weeks' counts, newest first, summing to checked, with no message content", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const thisWeek = weekStart(new Date());
    await made(a, { at: plus(thisWeek, 60), verdict: "malicious", decidedAt: plus(thisWeek, 90) });
    await made(a, { at: plus(thisWeek, 61), status: "running", verdict: null });
    await made(a, { at: plus(thisWeek, -86_400 * 3), verdict: "safe", decidedAt: plus(thisWeek, -86_400 * 3 + 10) });
    await made(b, { at: plus(thisWeek, 60), verdict: "suspicious", decidedAt: plus(thisWeek, 70) });
    const { cookie } = await member(a);
    const res = await get("/cases/stats.csv", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="isitlegit-weekly-counts.csv"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    const lines = body.trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(13);
    const sast = new Date(Date.parse(thisWeek) + 2 * 3_600_000).toISOString().slice(0, 10);
    expect(lines[1]).toBe(`${sast},2,1,0,0,1,30`);
    expect(lines[2]?.split(",").slice(1)).toEqual(["1", "0", "0", "1", "0", "10"]);
    for (const line of lines.slice(1)) {
      const [, checked, ...rest] = line.split(",");
      const parts = rest.slice(0, 4).map(Number);
      expect(parts.reduce((x, y) => x + y, 0)).toBe(Number(checked));
    }
    expect(body).not.toContain("Secret subject");
    expect(body).not.toContain("secret-sender");
  });

  it("refuses as the list does: sign in, the 403 page, and the 503 page with a retry that then works", async () => {
    const anon = await get("/cases/stats.csv");
    expect(anon.status).toBe(303);
    expect(target(anon)).toBe(`/signin?next=${encodeURIComponent("/cases/stats.csv")}`);
    const a = await org("Karoo Couriers");
    const { cookie, uid } = await member(a);
    await db.prepare(`DELETE FROM "member" WHERE "userId" = ?`).bind(uid).run();
    expect((await get("/cases/stats.csv", cookie)).status).toBe(403);
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`)
      .bind(`m-${crypto.randomUUID()}`, a, uid, new Date().toISOString())
      .run();
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = NULL WHERE "userId" = ?`).bind(uid).run();
    expect((await get("/cases/stats.csv", cookie)).status).toBe(403);
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(a, uid).run();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("LEFT JOIN case_verdicts")) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const failed = await get("/cases/stats.csv", cookie);
    vi.restoreAllMocks();
    expect(failed.status).toBe(503);
    const html = await failed.text();
    const shown = /Reference (500-[0-9A-F]{6})/.exec(html)?.[1];
    expect(lines.map((l) => JSON.parse(l)).find((e) => e.event === "cases-csv")).toMatchObject({ reference: shown });
    expect(html).toContain('href="/cases/stats.csv"');
    const retried = await get("/cases/stats.csv", cookie);
    expect(retried.status).toBe(200);
    expect((await retried.text()).startsWith(CSV_HEADER)).toBe(true);
  });
});

describe("/cases/<x> routing", () => {
  it("serves the CSV at /cases/stats.csv, a case id's report at /cases/<id>, and any other shape the 404 page unread", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    expect((await get("/cases/stats.csv", cookie)).headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const id = ulid();
    const report = await get(`/cases/${id}`, cookie);
    expect(report.status).toBe(303);
    expect(target(report)).toBe(`/r/${id}`);
    const reads: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      reads.push(sql);
      return prepare(sql);
    });
    for (const path of ["/cases/not-a-case", `/cases/${id.toLowerCase()}`, "/cases/stats.txt"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("text/html");
    }
    expect(reads).toEqual([]);
  });
});

describe("the export bound to the organisation the page shows", () => {
  it("answers the active organisation's CSV, and a page drawn for another sends the member to Cases, never its counts", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Fynbos Freight")];
    const { cookie, uid } = await member(a);
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`)
      .bind(`m-${crypto.randomUUID()}`, b, uid, new Date().toISOString())
      .run();
    expect((await get(`/cases/stats.csv?org=${a}`, cookie)).headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    // Switched to B in another tab: the export pressed on A's page.
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(b, uid).run();
    const stale = await get(`/cases/stats.csv?org=${a}`, cookie);
    expect(stale.status).toBe(303);
    expect(target(stale)).toBe("/cases");
    expect(stale.headers.get("content-disposition")).toBeNull();
    // An organisation the member is not in, named by hand: the same.
    expect((await get("/cases/stats.csv?org=org-not-mine", cookie)).status).toBe(303);
  });
});

describe("the stats at volume", () => {
  it("reads 10,000 cases' week and 12 weeks of counts within a second each", async () => {
    const a = await org("Large Tenant");
    const now = new Date();
    const start = Date.parse(weekStart(now)) - 11 * 7 * 86_400_000;
    const span = now.getTime() - start;
    for (let from = 0; from < 10_000; from += 500) {
      const batch = [];
      for (let i = from; i < from + 500; i++) {
        const at = new Date(start + Math.floor((span * i) / 10_000)).toISOString();
        const id = ulid();
        batch.push(
          db
            .prepare(
              `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at, source_kind)
               VALUES (?, ?, 'email', 'done', ?, 1, ?, ?, 'mail')`,
            )
            .bind(id, a, i % 3 ? "safe" : "malicious", at, at),
          db
            .prepare(
              `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at)
               VALUES (?, ?, 'h', 0.9, '[]', '[]', 'model', ?)`,
            )
            .bind(id, i % 3 ? "safe" : "malicious", plus(at, 30 + (i % 60))),
        );
      }
      await db.batch(batch);
    }
    let started = performance.now();
    const week = await weeklyStats(db, a, now);
    const weekMs = performance.now() - started;
    started = performance.now();
    const twelve = await weeklyCounts(db, a, now, 12);
    const csvMs = performance.now() - started;
    console.log(
      JSON.stringify({
        event: "case-stats-bench",
        cases: 10_000,
        weekMs: Math.round(weekMs),
        csvMs: Math.round(csvMs),
      }),
    );
    expect(twelve.reduce((sum, w) => sum + w.checked, 0)).toBe(10_000);
    expect(week.thisWeek.checked).toBeGreaterThan(0);
    expect(weekMs).toBeLessThan(1000);
    expect(csvMs).toBeLessThan(1000);
  }, 120_000);
});

describe("threat kinds (D07 T04 §18)", () => {
  const ev = async (
    id: string,
    check: string,
    severity = "high",
    detail = "{}",
    run: string | null = "run-1",
    seq = 1,
  ) => {
    if (run)
      await db
        .prepare("UPDATE cases SET run_id = ? WHERE id = ?")
        .bind(run === "stale" ? "run-1" : run, id)
        .run();
    await db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Seeded for the kinds test', ?, 1)`,
      )
      .bind(id, run === "stale" ? "run-old" : (run ?? "run-1"), `E${seq}`, seq, check, severity, detail)
      .run();
  };
  const tue = "2026-10-27T08:00:00.000Z";

  it("counts flagged cases once, by positive evidence on the current run, in precedence order", async () => {
    const a = await org("Karoo Couriers");
    const b = await org("Elsewhere");
    for (let i = 0; i < 5; i++) await ev(await made(a, { at: tue, verdict: "malicious" }), "link.credential_form");
    for (let i = 0; i < 3; i++) await ev(await made(a, { at: tue, verdict: "suspicious" }), "invoice.detected", "info");
    await ev(await made(a, { at: tue, verdict: "malicious" }), "domain.lookalike", "high");
    // A malware-only flagged case counts in no kind; a safe invoice case and an unfinished one never count.
    await ev(await made(a, { at: tue, verdict: "malicious" }), "attachment.executable", "critical");
    await ev(await made(a, { at: tue, verdict: "safe" }), "invoice.detected", "info");
    await ev(await made(a, { at: tue, status: "running", verdict: null }), "invoice.detected", "info");
    // Precedence: invoice plus lookalike counts as invoice, once. Partial with a verdict counts.
    const both = await made(a, { at: tue, status: "partial", verdict: "suspicious" });
    await ev(both, "domain.lookalike", "high", "{}", "run-1", 1);
    await ev(both, "invoice.detected", "info", "{}", "run-1", 2);
    // Not-compared and unconfirmed items are not findings; stale-run evidence is not the current run.
    await ev(await made(a, { at: tue, verdict: "malicious" }), "domain.lookalike", "info");
    await ev(
      await made(a, { at: tue, verdict: "malicious" }),
      "vision.brand_domain_mismatch",
      "info",
      JSON.stringify({ confirmed: false }),
    );
    await ev(await made(a, { at: tue, verdict: "malicious" }), "domain.lookalike", "high", "{}", "stale");
    await ev(await made(b, { at: tue, verdict: "malicious" }), "invoice.detected", "info");
    const stats = await weeklyStats(db, a, NOW);
    expect(stats.thisWeek.kinds).toEqual({ phishing: 5, invoice: 4, impersonation: 1 });
    expect(stats.thisWeek.malicious + stats.thisWeek.suspicious).toBe(14);
    const total = Object.values(stats.thisWeek.kinds).reduce((x, y) => x + y, 0);
    expect(total).toBeLessThanOrEqual(stats.thisWeek.malicious + stats.thisWeek.suspicious);
  });

  it("orders the line descending, ties in board order, and draws nothing when no kind is present", () => {
    expect(kindLine({ phishing: 5, invoice: 3, impersonation: 1 })).toBe("5 phishing, 3 invoice, 1 impersonation");
    expect(kindLine({ phishing: 1, invoice: 5, impersonation: 3 })).toBe("5 invoice, 3 impersonation, 1 phishing");
    expect(kindLine({ phishing: 2, invoice: 2, impersonation: 0 })).toBe("2 phishing, 2 invoice");
    expect(kindLine({ phishing: 0, invoice: 0, impersonation: 0 })).toBe("");
  });
});

describe("threat kinds: weeks, runs and the rendered line (D07 T04 §18)", () => {
  const ev = async (
    id: string,
    check: string,
    severity = "high",
    detail = "{}",
    run: string | null = "run-1",
    seq = 1,
  ) => {
    if (run !== null) await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(run, id).run();
    await db
      .prepare(
        `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Seeded for the kinds test', ?, 1)`,
      )
      .bind(id, run ?? id, `E${seq}`, seq, check, severity, detail)
      .run();
  };

  it("allocates by arrival week, reads the current run alone, and ranks impersonation over phishing", async () => {
    const a = await org("Karoo Couriers");
    const tue = "2026-10-27T08:00:00.000Z";
    // Arrival last week (Sunday 23:59:59 SAST), verdict Monday: last week's kind, not this week's.
    const lastWeek = await made(a, {
      at: "2026-10-25T21:59:59.000Z",
      verdict: "malicious",
      decidedAt: "2026-10-26T08:00:00.000Z",
    });
    await ev(lastWeek, "invoice.detected", "info");
    // Conflicting runs: the old run said invoice, the current run says phishing.
    const conflict = await made(a, { at: tue, verdict: "malicious" });
    await ev(conflict, "invoice.detected", "info", "{}", "run-old", 1);
    await ev(conflict, "link.lure_button", "high", "{}", "run-1", 2);
    // No stored run id: the case's own id is its run (the fallback other readers use).
    const fallback = await made(a, { at: tue, verdict: "suspicious" });
    await ev(fallback, "document.type", "info", JSON.stringify({ type: "invoice" }), null);
    // Impersonation beats phishing on one case; a medium lookalike and a confirmed mismatch both count.
    const imp = await made(a, { at: tue, verdict: "malicious" });
    await ev(imp, "link.credential_form", "high", "{}", "run-1", 1);
    await ev(imp, "domain.lookalike", "medium", "{}", "run-1", 2);
    const brand = await made(a, { at: tue, verdict: "suspicious" });
    await ev(brand, "vision.brand_domain_mismatch", "high", JSON.stringify({ confirmed: true }));
    // A partial case without a verdict never counts.
    const noVerdict = await made(a, { at: tue, status: "partial", verdict: null });
    await ev(noVerdict, "invoice.detected", "info");
    const weeks = await weeklyCounts(db, a, NOW, 2);
    expect(weeks[0]?.kinds).toEqual({ phishing: 1, invoice: 1, impersonation: 2 });
    expect(weeks[1]?.kinds).toEqual({ phishing: 0, invoice: 1, impersonation: 0 });
  });

  it("draws the seeded line on the Cases page tile", async () => {
    const a = await org("Karoo Couriers");
    const thisWeek = weekStart(new Date());
    for (let i = 0; i < 2; i++)
      await ev(
        await made(a, { at: plus(thisWeek, 60 + i), verdict: "malicious", decidedAt: plus(thisWeek, 120) }),
        "link.credential_form",
      );
    await ev(
      await made(a, { at: plus(thisWeek, 90), verdict: "suspicious", decidedAt: plus(thisWeek, 120) }),
      "invoice.detected",
      "info",
    );
    const { cookie } = await member(a);
    const html = await (await get("/cases", cookie)).text();
    const panel = html.slice(html.indexOf('<section id="case-stats"'), html.indexOf("</section>"));
    expect(panel.replace(/<[^>]+>/g, "|")).toContain("|2 phishing, 1 invoice|");
  });
});

describe("GET /cases/stats.csv with a chosen period (D07 T04 §19)", () => {
  it("exports the weeks overlapping October 2026, oldest first, and nothing outside them", async () => {
    const a = await org("Karoo Couriers");
    // Weeks beginning 28 Sep, 5, 12, 19 and 26 Oct 2026 (SAST Mondays) overlap October; 21 Sep and 2 Nov do not.
    await made(a, { at: "2026-09-21T08:00:00.000Z", verdict: "safe", decidedAt: "2026-09-21T08:01:00.000Z" });
    await made(a, { at: "2026-09-28T08:00:00.000Z", verdict: "malicious", decidedAt: "2026-09-28T08:01:00.000Z" });
    await made(a, { at: "2026-10-26T08:00:00.000Z", verdict: "safe", decidedAt: "2026-10-26T08:01:00.000Z" });
    await made(a, { at: "2026-11-02T08:00:00.000Z", verdict: "safe", decidedAt: "2026-11-02T08:01:00.000Z" });
    const { cookie } = await member(a);
    const res = await get(`/cases/stats.csv?org=${a}&from=2026-10-01&to=2026-10-31`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="isitlegit-counts-2026-10-01-to-2026-10-31.csv"');
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(lines[1]).toContain(",1,1,0,0,0,");
    // A stale organisation is redirected to Cases, never exported.
    const stale = await get(`/cases/stats.csv?org=org-elsewhere&from=2026-10-01&to=2026-10-31`, cookie);
    expect(stale.status).toBe(303);
  });

  it("refuses a reversed, over-long, missing or unreadable period with an HTML 400 page, never an attachment", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    for (const q of [
      "from=2026-10-31&to=2026-10-01",
      "from=2024-01-01&to=2026-01-02",
      "from=2026-10-01",
      "from=2026-02-30&to=2026-10-01",
      "from=soon&to=2026-10-01",
      "from=&to=2026-10-01",
      "to=2026-10-01&from=",
    ]) {
      const res = await get(`/cases/stats.csv?org=${a}&${q}`, cookie);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("content-type"), q).toContain("text/html");
      expect(res.headers.get("content-disposition"), q).toBeNull();
      const html = await res.text();
      expect(html, q).toContain("That period does not work");
      expect(html, q).toContain('href="/cases"');
    }
  });
});

describe("GET /cases/stats.csv period boundaries (D07 T04 §19)", () => {
  it("accepts a 731-day inclusive span and refuses 732, and reads an old same-day range", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    const ok = await get(`/cases/stats.csv?org=${a}&from=2024-01-01&to=2025-12-31`, cookie);
    expect(ok.status).toBe(200);
    const weeks = (await ok.text()).trimEnd().split("\r\n");
    expect(weeks.length).toBeGreaterThan(13);
    const over = await get(`/cases/stats.csv?org=${a}&from=2024-01-01&to=2026-01-01`, cookie);
    expect(over.status).toBe(400);
    const sameDay = await get(`/cases/stats.csv?org=${a}&from=2026-10-15&to=2026-10-15`, cookie);
    expect(sameDay.status).toBe(200);
    const lines = (await sameDay.text()).trimEnd().split("\r\n");
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["2026-10-12"]);
  });
});
