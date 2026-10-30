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
});
