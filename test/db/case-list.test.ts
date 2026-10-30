import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, listCases, PAGE_SIZE, periodStart } from "../../src/db/case-list";
import { ulid } from "../../src/db/ulid";

// src/db/case-list.ts (D07 T04 §1): one organisation's cases a page at a time, its filters checked, never another's.
const db = env.DB;
async function made(orgId: string, ageMs = 0) {
  const id = ulid();
  const at = new Date(Date.now() - ageMs).toISOString();
  await db
    .prepare(
      "INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at) VALUES (?, ?, 'email', 'done', 'safe', 1, ?, ?)",
    )
    .bind(id, orgId, at, at)
    .run();
  return id;
}

describe("listCases", () => {
  it("refuses a bad filter value or no organisation, and reads nothing", async () => {
    const bad = await listCases(db, "org-x", { ...DEFAULT_FILTERS, verdict: "evil" as never });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await listCases(db, "org-x", { ...DEFAULT_FILTERS, page: 0 })).toMatchObject({ ok: false });
    expect(await listCases(db, "", DEFAULT_FILTERS)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("pages newest first within one organisation, the last page for one past the end", async () => {
    const org = `org-list-${crypto.randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 2; i++) ids.push(await made(org, i * 1000));
    await made(`${org}-other`);
    const first = await listCases(db, org, DEFAULT_FILTERS);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toMatchObject({ page: 1, pages: 2, matching: PAGE_SIZE + 2, total: PAGE_SIZE + 2 });
    expect(first.value.cases.map((c) => c.id)).toEqual(ids.slice(0, PAGE_SIZE));
    const past = await listCases(db, org, { ...DEFAULT_FILTERS, page: 7 });
    if (!past.ok) throw new Error(past.error.message);
    expect(past.value.page).toBe(2);
    expect(past.value.cases.map((c) => c.id)).toEqual(ids.slice(PAGE_SIZE));
  });

  it("starts a period at SAST midnight, today counted as its first day", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    expect(periodStart("7", now)).toBe("2026-10-23T22:00:00.000Z");
    expect(periodStart("all", now)).toBeNull();
  });

  it("answers a database that cannot be read as a typed refusal", async () => {
    const broken = { batch: () => Promise.reject(new Error("D1_ERROR")), prepare: db.prepare.bind(db) };
    expect(await listCases(broken as unknown as D1Database, "org-x", DEFAULT_FILTERS)).toMatchObject({
      ok: false,
      error: { code: "database" },
    });
  });

  // The list at a realistic history (D07 T04 §1, completion review): 10,000 cases in one organisation and 2,000 in
  // another, every filter's page read within the target (a second at p95) through the organisation's index.
  it("reads a page of 10,000 cases quickly, through the organisation's index", async () => {
    const org = `org-big-${crypto.randomUUID().slice(0, 8)}`;
    const seed = (o: string, count: number) =>
      db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
           INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at, forwarded_by, source_kind)
           SELECT printf('%s%020d', substr(?, 1, 6), i), ?, CASE WHEN i % 4 = 3 THEN 'upload' ELSE 'email' END, 'done',
             CASE i % 3 WHEN 0 THEN 'malicious' WHEN 1 THEN 'suspicious' ELSE 'safe' END, 1,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d minutes', i * 13)),
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d minutes', i * 13)),
             CASE WHEN i % 4 = 3 THEN NULL ELSE 'someone@demo.isitlegit.co.za' END,
             CASE WHEN i % 4 = 3 THEN 'document' ELSE 'mail' END
           FROM n`,
        )
        .bind(count, crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase(), o)
        .run();
    await seed(org, 10_000);
    await seed(`${org}-x`, 2_000);
    const timings: number[] = [];
    for (const f of [
      DEFAULT_FILTERS,
      { ...DEFAULT_FILTERS, period: "all" as const },
      { ...DEFAULT_FILTERS, period: "all" as const, verdict: "malicious" as const, page: 40 },
      { ...DEFAULT_FILTERS, period: "90" as const, channel: "upload" as const },
    ])
      for (let run = 0; run < 5; run++) {
        const started = performance.now();
        const read = await listCases(db, org, f);
        timings.push(performance.now() - started);
        if (!read.ok) throw new Error(read.error.message);
        expect(read.value.total).toBe(10_000);
      }
    timings.sort((x, y) => x - y);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Number.NaN;
    console.log(JSON.stringify({ event: "case-list-timing", cases: 10_000, p95Ms: Math.round(p95) }));
    expect(p95).toBeLessThan(1000);
    const plan = await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM cases c WHERE c.org_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 25",
      )
      .bind(org)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("cases_org_created");
  });
});
