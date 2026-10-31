import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  clearDailyCapOverrideStatement,
  DEFAULT_DAILY_CASES,
  dailyCapBinds,
  dailyCapSql,
  extendTrialStatement,
  setDailyCapOverrideStatement,
  setPlanStatement,
} from "../../src/auth/plan-sql";
import { planOf } from "../../src/auth/plans";
import { admitCase } from "../../src/db/cases";

// The daily case cap by plan (D07 T08 §8; design/SPEC.md S5: Free check, up to 5 checks a day): one SQL expression read
// in the statement that admits, the override first, else the effective plan by planOf's own trial rule.
const db = (env as unknown as Env).DB;
const DAY = 86_400_000;

async function orgAged(ageDays: number, now = Date.now()) {
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Org', ?, ?)`)
    .bind(id, `org-${id.slice(0, 8)}`, new Date(now - ageDays * DAY).toISOString())
    .run();
  return id;
}
const run = (s: { sql: string; params: unknown[] }) =>
  db
    .prepare(s.sql)
    .bind(...s.params)
    .run();
const capOf = async (orgId: string, now = new Date()) =>
  (
    await db
      .prepare(`SELECT ${dailyCapSql()} AS cap`)
      .bind(...dailyCapBinds(orgId, now))
      .first<{ cap: number }>()
  )?.cap;
// The plan planOf reads, and the cap it should carry.
const expected = async (orgId: string, now: Date) => {
  const state = await planOf(db, orgId, now);
  return state?.plan === "free" ? 5 : 50;
};

describe("dailyCapSql", () => {
  it("follows the effective plan, agreeing with planOf at every edge of the trial", async () => {
    const now = new Date();
    // A trial with no org_limits row: inside its 14 days, at its last second, and just past it.
    const young = await orgAged(3, now.getTime());
    const ending = await orgAged(14, now.getTime() + 1000);
    const lapsed = await orgAged(14, now.getTime());
    const old = await orgAged(30, now.getTime());
    expect(await capOf(young, now)).toBe(50);
    expect(await capOf(ending, now)).toBe(50);
    expect(await capOf(lapsed, now)).toBe(5);
    expect(await capOf(old, now)).toBe(5);
    // Stored plans, and an extended trial that has not ended.
    const free = await orgAged(1, now.getTime());
    await run(setPlanStatement(free, "free"));
    const protect = await orgAged(40, now.getTime());
    await run(setPlanStatement(protect, "protect"));
    const msp = await orgAged(40, now.getTime());
    await run(setPlanStatement(msp, "msp"));
    const extended = await orgAged(30, now.getTime());
    await run(extendTrialStatement(extended, new Date(now.getTime() + 5 * DAY), now));
    expect(await capOf(free, now)).toBe(5);
    expect(await capOf(protect, now)).toBe(50);
    expect(await capOf(msp, now)).toBe(50);
    expect(await capOf(extended, now)).toBe(50);
    // Its extension ended: Free again.
    expect(await capOf(extended, new Date(now.getTime() + 6 * DAY))).toBe(5);
    for (const id of [young, ending, lapsed, old, free, protect, msp, extended])
      expect(await capOf(id, now), id).toBe(await expected(id, now));
    // An organisation that is not found: the default.
    expect(await capOf("org-nowhere", now)).toBe(DEFAULT_DAILY_CASES);
  });

  it("reads the operator's override first, and Use plan limit puts the plan's cap back", async () => {
    const id = await orgAged(1);
    await run(setPlanStatement(id, "free"));
    await run(setDailyCapOverrideStatement(id, 20));
    expect(await capOf(id)).toBe(20);
    await run(setDailyCapOverrideStatement(id, 0));
    expect(await capOf(id)).toBe(0);
    await run(clearDailyCapOverrideStatement(id));
    expect(await capOf(id)).toBe(5);
    expect(() => setDailyCapOverrideStatement(id, 51)).toThrow(RangeError);
    expect(() => setDailyCapOverrideStatement(id, -1)).toThrow(RangeError);
    expect(() => setDailyCapOverrideStatement(id, 2.5)).toThrow(RangeError);
    // An organisation that does not exist gets no row.
    await run(setDailyCapOverrideStatement("org-nowhere", 9));
    expect(await db.prepare("SELECT 1 FROM org_limits WHERE org_id = 'org-nowhere'").first()).toBeNull();
  });
});

describe("admission by plan", () => {
  it("admits five checks a day for a Free organisation and refuses the sixth as capped", async () => {
    const orgId = await orgAged(30);
    for (let i = 0; i < 5; i++)
      expect((await admitCase(db, { orgId, channel: "email", headersAvailable: true })).ok, `case ${i + 1}`).toBe(true);
    expect(await admitCase(db, { orgId, channel: "email", headersAvailable: true })).toMatchObject({
      ok: false,
      error: { code: "capped" },
    });
  });
});

describe("migration 0055", () => {
  const migration = () => {
    const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0055"));
    if (!found) throw new Error("migration 0055 is missing");
    return found;
  };
  it("adds a nullable override that refuses a negative cap", async () => {
    const columns = (await db.prepare("PRAGMA table_info(org_limits)").all<{ name: string; notnull: number }>())
      .results;
    expect(columns.find((c) => c.name === "daily_cases_override")).toMatchObject({ notnull: 0 });
    const id = await orgAged(1);
    await expect(
      db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, -1)").bind(id).run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("carries every operator-set cap across as the override, and nothing else", async () => {
    // The table as it stood before 0055, with rows of every kind, then 0055's own statements run against it.
    await db
      .prepare(
        "CREATE TABLE org_limits_before_0055 (org_id TEXT PRIMARY KEY, daily_cases INTEGER NOT NULL DEFAULT 50 CHECK (daily_cases >= 0), plan TEXT, trial_ends_at TEXT)",
      )
      .run();
    await db.batch([
      db.prepare("INSERT INTO org_limits_before_0055 VALUES ('a', 50, 'free', NULL)"),
      db.prepare("INSERT INTO org_limits_before_0055 VALUES ('b', 7, NULL, '2026-11-20T00:00:00.000Z')"),
      db.prepare("INSERT INTO org_limits_before_0055 VALUES ('c', 0, 'protect', NULL)"),
      db.prepare("INSERT INTO org_limits_before_0055 VALUES ('d', 200, NULL, NULL)"),
    ]);
    const before = (await db.prepare("SELECT * FROM org_limits_before_0055 ORDER BY org_id").all()).results;
    for (const query of migration().queries) {
      if (/INSERT INTO org_limits \(org_id, daily_cases_override\)/.test(query)) continue;
      await db.prepare(query.replace(/\borg_limits\b/g, "org_limits_before_0055")).run();
    }
    const after = (
      await db
        .prepare(
          "SELECT org_id, daily_cases, plan, trial_ends_at, daily_cases_override FROM org_limits_before_0055 ORDER BY org_id",
        )
        .all()
    ).results;
    expect(after.map((r) => r.daily_cases_override)).toEqual([null, 7, 0, 200]);
    // Nothing else changed.
    expect(after.map(({ daily_cases_override: _, ...rest }) => rest)).toEqual(before);
    await db.prepare("DROP TABLE org_limits_before_0055").run();
  });

  it("holds Fynbos Freight at 50 only where it exists, its plan and trial untouched", async () => {
    const fynbos = "ZF5SufztotybeXIWVncExFAVu9GYZ8Fu";
    const insert = migration().queries.find((q) => /INSERT INTO org_limits \(org_id, daily_cases_override\)/.test(q));
    expect(insert).toBeDefined();
    // Not there: no row.
    await db.prepare(insert as string).run();
    expect(await db.prepare("SELECT 1 FROM org_limits WHERE org_id = ?").bind(fynbos).first()).toBeNull();
    // There, on an extended trial: the override set, the trial kept, the cap 50 even once the trial has ended.
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos Freight', ?, ?)`)
      .bind(fynbos, `fynbos-${crypto.randomUUID().slice(0, 6)}`, new Date(Date.now() - 40 * DAY).toISOString())
      .run();
    await db
      .prepare("INSERT INTO org_limits (org_id, plan, trial_ends_at) VALUES (?, NULL, '2026-11-20T00:00:00.000Z')")
      .bind(fynbos)
      .run();
    await db.prepare(insert as string).run();
    expect(
      await db
        .prepare("SELECT plan, trial_ends_at, daily_cases_override FROM org_limits WHERE org_id = ?")
        .bind(fynbos)
        .first(),
    ).toEqual({ plan: null, trial_ends_at: "2026-11-20T00:00:00.000Z", daily_cases_override: 50 });
    expect(await capOf(fynbos, new Date("2026-12-01T00:00:00Z"))).toBe(50);
  });
});
