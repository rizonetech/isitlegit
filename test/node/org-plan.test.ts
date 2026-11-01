import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { orgPlan } from "../../scripts/org-plan.ts";
import type { Runner } from "../../scripts/smoke.ts";

// The operator's plan changes (D07 T02 §8): the script's own statements, sent as `wrangler d1 execute` would send them,
// on an in-memory SQLite holding the real migrations.
const read = (name: string) => readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), "utf-8");

function wrangler() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    'CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);',
  );
  db.exec(
    "CREATE TABLE org_limits (org_id TEXT PRIMARY KEY, daily_cases INTEGER NOT NULL DEFAULT 50 CHECK (daily_cases >= 0));",
  );
  db.exec(read("0030_plans.sql"));
  db.exec(
    "ALTER TABLE org_limits ADD COLUMN daily_cases_override INTEGER CHECK (daily_cases_override IS NULL OR daily_cases_override >= 0);",
  );
  db.exec(
    `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Org', 'org-1', '2026-10-01T00:00:00.000Z')`,
  );
  const run: Runner = async (_command, args) => {
    const sql = args[args.indexOf("--command") + 1] as string;
    if (/^\s*select/i.test(sql))
      return JSON.stringify([{ results: db.prepare(sql).all(), success: true, meta: { changes: 0 } }]);
    const changes = Number(db.prepare(sql).run().changes);
    return JSON.stringify([{ results: [], success: true, meta: { changes } }]);
  };
  return { db, run };
}

describe("scripts/org-plan.ts", () => {
  it("sets a plan, extends a trial, and refuses a bad plan, a past date and an unknown organisation", async () => {
    const w = wrangler();
    const now = new Date("2026-10-29T08:00:00Z");
    expect(await orgPlan(["org-1", "protect"], w.run, now)).toBe("org-1: protect");
    expect(w.db.prepare("SELECT plan, daily_cases FROM org_limits").get()).toEqual({
      plan: "protect",
      daily_cases: 50,
    });
    // An extension never replaces a paid plan (final review).
    await expect(orgPlan(["org-1", "extend", "2026-11-05T00:00:00Z"], w.run, now)).rejects.toThrow(/a paid plan/);
    expect(await orgPlan(["org-1", "free"], w.run, now)).toBe("org-1: free");
    expect(await orgPlan(["org-1", "extend", "2026-11-05T00:00:00Z"], w.run, now)).toContain("trial until");
    expect(w.db.prepare("SELECT plan, trial_ends_at FROM org_limits").get()).toEqual({
      plan: null,
      trial_ends_at: "2026-11-05T00:00:00.000Z",
    });
    await expect(orgPlan(["org-1", "gold"], w.run, now)).rejects.toThrow(/no such plan/);
    await expect(orgPlan(["org-1", "extend", "2026-10-01T00:00:00Z"], w.run, now)).rejects.toThrow(/still to come/);
    await expect(orgPlan(["org-9", "free"], w.run, now)).rejects.toThrow(/no organisation/);
    // A mistyped date changes nothing (completion review).
    const before = w.db.prepare("SELECT plan, trial_ends_at FROM org_limits").get();
    for (const bad of [
      "2027-02-30T00:00:00Z",
      "03/04/2027",
      "2027-03-04",
      "2027-03-04T25:00:00Z",
      "2027-03-04T00:00:00",
    ])
      await expect(orgPlan(["org-1", "extend", bad], w.run, now), bad).rejects.toThrow(RangeError);
    expect(w.db.prepare("SELECT plan, trial_ends_at FROM org_limits").get()).toEqual(before);
    expect(await orgPlan(["org-1", "extend", "2027-03-04T09:30:00+02:00"], w.run, now)).toBe(
      "org-1: trial until 2027-03-04T07:30:00.000Z",
    );
  });

  it("sets the daily-cases override up to 500 and reads it back, clears it to the plan's own, and refuses the rest", async () => {
    const w = wrangler();
    const stored = () =>
      w.db.prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = 'org-1'").get();
    expect(await orgPlan(["org-1", "cap", "500"], w.run)).toBe("org-1: daily cap 500");
    expect(stored()).toEqual({ cap: 500 });
    // A previous override is restored the same way, and clearing returns the organisation to its plan's cap.
    expect(await orgPlan(["org-1", "cap", "20"], w.run)).toBe("org-1: daily cap 20");
    expect(await orgPlan(["org-1", "cap", "500"], w.run)).toBe("org-1: daily cap 500");
    expect(await orgPlan(["org-1", "cap", "0"], w.run)).toBe("org-1: daily cap 0");
    expect(await orgPlan(["org-1", "cap", "clear"], w.run)).toBe("org-1: daily cap back to the plan's own");
    expect(stored()).toEqual({ cap: null });
    for (const bad of ["501", "1.5", "abc", "-1", ""])
      await expect(orgPlan(["org-1", "cap", bad], w.run), bad).rejects.toThrow();
    expect(stored()).toEqual({ cap: null });
    await expect(orgPlan(["org-none", "cap", "500"], w.run)).rejects.toThrow(/no organisation org-none/);
    // A failed command is an error, not a silent success.
    const failing: Runner = async () => JSON.stringify([{ success: false }]);
    await expect(orgPlan(["org-1", "cap", "500"], failing)).rejects.toThrow(/did not succeed/);
    // A write that did not land is caught by the read-back.
    const lying: Runner = async (command, args) => {
      const sql = args[args.indexOf("--command") + 1] as string;
      return /^\s*select/i.test(sql)
        ? JSON.stringify([{ results: [{ cap: null }], success: true, meta: { changes: 0 } }])
        : w.run(command, args, "", 0);
    };
    await expect(orgPlan(["org-1", "cap", "300"], lying)).rejects.toThrow(/not what was asked/);
  });
});
