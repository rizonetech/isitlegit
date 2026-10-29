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
    `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Org', 'org-1', '2026-10-01T00:00:00.000Z')`,
  );
  const run: Runner = async (_command, args) => {
    const sql = args[args.indexOf("--command") + 1] as string;
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
});
