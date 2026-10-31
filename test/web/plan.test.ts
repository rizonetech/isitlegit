import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { setDailyCapOverrideStatement } from "../../src/auth/plan-sql";
import { extendTrial, hasFeature, type PlanState, planOf, setPlan, TRIAL_DAYS } from "../../src/auth/plans";
import { sastDayStart } from "../../src/db/cases";
import { memberShell } from "../../src/web/pages/member-shell";
import {
  sastDate,
  statusOf,
  usageOf,
  TRIAL_DAYS as VIEW_TRIAL_DAYS,
  type PlanState as ViewPlan,
} from "../../src/web/pages/settings-plan-view";
import { authEnv, call, signIn } from "../auth/helpers";

// The Plan page (D07 T08 §4; board `Plan`): the plan from `planOf`, the day's usage against the cap, the three launch
// tiers, every role read-only, nothing of another organisation, and a plan or usage that cannot be read as the
// retryable outage.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const tag = () => crypto.randomUUID().slice(0, 8);
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id as string;
async function person(name: string) {
  const email = `plan-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = await userId(email);
  await db.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).bind(name, id).run();
  return { cookie, email, id };
}
async function organisation(owner: { id: string }, name = "Karoo Couriers", createdDaysAgo = 3) {
  const made = (await createAuth(authEnv).api.createOrganization({
    body: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${tag()}`, userId: owner.id },
  })) as { id: string };
  await db
    .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
    .bind(new Date(Date.now() - createdDaysAgo * 86_400_000).toISOString(), made.id)
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(made.id, owner.id).run();
  return made.id;
}
async function join(orgId: string, who: { id: string }, role: "owner" | "admin" | "member") {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${tag()}${tag()}`, orgId, who.id, role, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, who.id).run();
}
const usedToday = async (orgId: string, n: number) => {
  const at = new Date().toISOString();
  for (let i = 0; i < n; i++)
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, headers_available, created_at, updated_at, forwarded_by, source_kind) VALUES (?, ?, 'email', 'done', 1, ?, ?, 'a@b.example', 'mail')",
      )
      .bind(`c-${tag()}${i}`, orgId, at, at)
      .run();
};
const page = async (cookie: string) => {
  const res = await call("/settings/plan", { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");

describe("the status and usage words", () => {
  it("keeps the view's plan type and trial length equal to planOf's", () => {
    expect(VIEW_TRIAL_DAYS).toBe(TRIAL_DAYS);
    const same: ViewPlan = {} as PlanState;
    expect(same).toBeDefined();
  });

  it("words each plan and each usage state, never below zero left or past a full bar", () => {
    const trial = statusOf(
      { plan: "trial", trialEndsAt: "2026-11-07T08:00:00.000Z", daysLeft: 11 },
      "Karoo",
      "2026-10-24T08:00:00.000Z",
    );
    expect(trial).toMatchObject({
      heading: "Protect trial",
      big: "11 days left of your 14-day trial",
      used: "3 of 14 days",
    });
    expect(trial.text).toContain("until Sat 7 Nov 2026");
    // An extension moves the end: no claim of days used out of fourteen, however long or short it is.
    const extended = statusOf(
      { plan: "trial", trialEndsAt: "2026-11-30T08:00:00.000Z", daysLeft: 5 },
      "K",
      "2026-10-01T08:00:00.000Z",
      new Date("2026-11-25T08:00:00.000Z"),
    );
    // An extension of twelve hours is still an extension.
    const short = statusOf(
      { plan: "trial", trialEndsAt: "2026-11-08T20:00:00.000Z", daysLeft: 15 },
      "K",
      "2026-10-25T08:00:00.000Z",
      new Date("2026-10-26T08:00:00.000Z"),
    );
    expect(short.big).toBe("15 days left of your extended trial");
    expect(extended.big).toBe("5 days left of your extended trial");
    expect(extended.used).toBe("55 days so far");
    expect(extended.progress).toBeUndefined();
    expect(statusOf({ plan: "free", trialEndedAt: "2026-10-20T08:00:00.000Z" }, "K", null).text).toContain(
      "ended on Tue 20 Oct 2026",
    );
    const explicit = statusOf({ plan: "free", trialEndedAt: null }, "K", null).text;
    expect(explicit).toContain("on the free plan");
    expect(explicit).not.toMatch(/trial/i);
    expect(usageOf({ used: 0, limit: 50 })).toMatchObject({ left: 50, percent: 0, paused: false });
    expect(usageOf({ used: 50, limit: 50 })).toMatchObject({ left: 0, percent: 100 });
    expect(usageOf({ used: 60, limit: 5 })).toMatchObject({ left: 0, percent: 100, line: "60 of 5 checks used" });
    expect(usageOf({ used: 3, limit: 0 }).paused).toBe(true);
    expect(sastDate("2026-11-06T22:30:00.000Z")).toBe("Sat 7 Nov 2026");
  });
});

describe("GET /settings/plan", () => {
  it("answers no session with sign-in, and a removed member with the 403 page", async () => {
    const anon = await call("/settings/plan", { headers: { accept: "text/html" } });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/signin?next=${encodeURIComponent("/settings/plan")}`);
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await db.prepare(`DELETE FROM "member" WHERE "organizationId" = ?`).bind(orgId).run();
    expect((await page(owner.cookie)).res.status).toBe(403);
  });

  it("draws a trial with days left, the end date, usage and the tiers, private and uncached, the same to every role", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner, "Karoo Couriers", 3);
    await usedToday(orgId, 27);
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const member = await person("Member");
    await join(orgId, member, "member");
    for (const who of [owner, admin, member]) {
      const { res, html } = await page(who.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const t = text(html);
      expect(t).toContain("11 days left of your 14-day trial");
      expect(t).toContain("27 of 50 checks used");
      expect(t).toContain("23 left today");
      expect(t).toContain("Resets at midnight SAST");
      expect(t).toContain("Up to 5 checks a day");
      expect(t).toContain("from R499");
      expect(t).toContain("Your trial");
      expect(html).toContain('href="mailto:support@isitlegit.co.za"');
    }
  });

  it("draws an expired trial, an explicit Free, Protect and MSP, each on its own tier, from persisted rows", async () => {
    const owner = await person("Owner");
    const lapsed = await organisation(owner, "Lapsed Ltd", 20);
    const lapsedPage = text((await page(owner.cookie)).html);
    expect(lapsedPage).toContain("You are on the free plan");
    expect(lapsedPage).toContain("The Protect trial ended on");
    expect(lapsedPage).toContain("0 of 5 checks used");
    expect(lapsedPage).not.toContain("Your trial");
    // Free assigned by the operator before the trial ended: no end date and no claim of a used trial.
    const fresh = await organisation(owner, "Explicit Free", 2);
    await setPlan(db, fresh, "free");
    const explicit = text((await page(owner.cookie)).html);
    expect(explicit).toContain("is on the free plan");
    expect(explicit).not.toContain("trial ended");
    expect(explicit).not.toContain("Trial used");
    for (const [plan, word] of [
      ["protect", "You are on Protect"],
      ["msp", "You are on MSP"],
    ] as const) {
      const id = await organisation(owner, `${plan} org`, 40);
      await setPlan(db, id, plan);
      const html = (await page(owner.cookie)).html;
      expect(text(html)).toContain(word);
      expect(html.match(/data-current="true"/g)?.length).toBe(1);
      expect(text(html)).toContain("Your plan");
    }
    expect(lapsed).toBeTruthy();
  });

  it("agrees with planOf and hasFeature before expiry, at expiry, and after an operator change", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner, "Agree Ltd", 13);
    const say = async () => text((await page(owner.cookie)).html);
    expect(await say()).toContain("1 day left");
    expect(await hasFeature(db, orgId, "identity")).toBe(true);
    await db
      .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 15 * 86_400_000).toISOString(), orgId)
      .run();
    expect(await say()).toContain("You are on the free plan");
    expect(await hasFeature(db, orgId, "identity")).toBe(false);
    expect(await extendTrial(db, orgId, new Date(Date.now() + 5 * 86_400_000))).toBe(true);
    const extended = await say();
    expect(extended).toContain("5 days left of your extended trial");
    expect(extended).not.toContain("14-day trial");
    expect(extended).not.toContain("of 14 days");
    expect((await planOf(db, orgId))?.plan).toBe("trial");
    await setPlan(db, orgId, "protect");
    expect(await say()).toContain("You are on Protect");
    expect(await hasFeature(db, orgId, "identity")).toBe(true);
  });

  it("shows only its own organisation's plan and usage when a member belongs to two", async () => {
    const owner = await person("Owner");
    const a = await organisation(owner, "Alpha Co", 3);
    await usedToday(a, 4);
    const other = await person("Other");
    const b = await organisation(other, "Beta Co", 40);
    await usedToday(b, 2);
    const alpha = text((await page(owner.cookie)).html);
    expect(alpha).toContain("4 of 50 checks used");
    expect(alpha).not.toContain("Beta Co");
    const beta = text((await page(other.cookie)).html);
    expect(beta).toContain("2 of 5 checks used");
    expect(beta).not.toContain("Alpha Co");
  });

  it("draws usage at the cap, over it and paused, without a reset promise when paused", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner, "Capped Ltd", 3);
    await usedToday(orgId, 5);
    await db
      .prepare(setDailyCapOverrideStatement(orgId, 5).sql)
      .bind(...setDailyCapOverrideStatement(orgId, 5).params)
      .run();
    const capped = (await page(owner.cookie)).html;
    expect(text(capped)).toContain("5 of 5 checks used");
    expect(text(capped)).toContain("0 left today");
    expect(capped).toContain("width: 100%");
    await usedToday(orgId, 3);
    const over = (await page(owner.cookie)).html;
    expect(text(over)).toContain("8 of 5 checks used");
    expect(text(over)).toContain("0 left today");
    expect(over).toContain("width: 100%");
    const paused = setDailyCapOverrideStatement(orgId, 0);
    await db
      .prepare(paused.sql)
      .bind(...paused.params)
      .run();
    const pausedHtml = text((await page(owner.cookie)).html);
    expect(pausedHtml).toContain("Paused by IsItLegit");
    expect(pausedHtml).not.toContain("Resets at midnight");
    expect(pausedHtml).not.toContain("left today");
  });

  it("answers an unreadable plan or usage with the retryable outage, never the free plan, and recovers", async () => {
    const owner = await person("Owner");
    await organisation(owner);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    const failing = (needle: RegExp) =>
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (needle.test(sql)) throw new Error("D1_ERROR: down");
        return prepare(sql);
      });
    failing(/FROM "organization" o LEFT JOIN org_limits l ON l\.id|o\."createdAt" AS createdAt/);
    const noPlan = await page(owner.cookie);
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(noPlan.res.status).toBe(503);
    expect(noPlan.html).toContain('href="/settings/plan"');
    expect(text(noPlan.html)).not.toContain("free plan");
    failing(/SELECT \(SELECT COUNT\(\*\) FROM cases/);
    const noUsage = await page(owner.cookie);
    vi.restoreAllMocks();
    expect(noUsage.res.status).toBe(503);
    expect(noUsage.html).toContain('href="/settings/plan"');
    // Try again, once the reads work.
    const again = await page(owner.cookie);
    expect(again.res.status).toBe(200);
    expect(text(again.html)).toContain("days left");
  });

  it("shows the plan of whichever organisation the same person has active, and the shell agrees with it", async () => {
    const owner = await person("Owner");
    const young = await organisation(owner, "Young Co", 3);
    const old = await organisation(owner, "Old Co", 40);
    await usedToday(young, 6);
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(young, owner.id).run();
    const inYoung = await page(owner.cookie);
    expect(text(inYoung.html)).toContain("11 days left of your 14-day trial");
    expect(text(inYoung.html)).toContain("6 of 50 checks used");
    expect(text(inYoung.html)).toContain("Trial, 11 days");
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(old, owner.id).run();
    const inOld = await page(owner.cookie);
    expect(text(inOld.html)).toContain("You are on the free plan");
    expect(text(inOld.html)).toContain("0 of 5 checks used");
    expect(text(inOld.html)).not.toContain("Young Co's");
  });

  it("crosses the trial's exact end through the page: the last instant is a trial, the next is free, the shell and hasFeature agree", async () => {
    const owner = await person("Owner");
    // Made fourteen days less five seconds ago: the trial ends five seconds from now.
    const orgId = await organisation(owner, "Edge Ltd", 14);
    const created = Date.now() - 14 * 86_400_000 + 5000;
    await db
      .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
      .bind(new Date(created).toISOString(), orgId)
      .run();
    const end = created + 14 * 86_400_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const [at, expected] of [
        [end - 1, "trial"],
        [end, "free"],
        [end + 1, "free"],
      ] as const) {
        vi.setSystemTime(at);
        const when = new Date(at);
        expect((await planOf(db, orgId, when))?.plan, String(at)).toBe(expected);
        const shell = await memberShell(
          db,
          { id: owner.id, name: "Owner", email: owner.email },
          orgId,
          "plan",
          orgId,
          when,
        );
        expect("trialDaysLeft" in shell.plan, String(at)).toBe(expected === "trial");
        expect(await hasFeature(db, orgId, "identity", when), String(at)).toBe(expected === "trial");
        const html = (await page(owner.cookie)).html;
        expect(html.includes("You are on the free plan"), String(at)).toBe(expected === "free");
        expect(html.includes("1 day left of your 14-day trial"), String(at)).toBe(expected === "trial");
        expect(html.includes("Trial, 1 day"), String(at)).toBe(expected === "trial");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a day from SAST midnight through the page: one case just before it is today's, then yesterday's", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner, "Midnight Ltd", 3);
    const midnight = new Date(sastDayStart(new Date())).getTime() + 86_400_000;
    const at = new Date(midnight - 30_000).toISOString();
    await db
      .prepare(
        "INSERT INTO cases (id, org_id, channel, status, headers_available, created_at, updated_at, forwarded_by, source_kind) VALUES (?, ?, 'email', 'done', 1, ?, ?, 'a@b.example', 'mail')",
      )
      .bind(`c-edge-${tag()}`, orgId, at, at)
      .run();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(midnight - 10_000);
      expect(text((await page(owner.cookie)).html)).toContain("1 of 50 checks used");
      vi.setSystemTime(midnight + 10_000);
      expect(text((await page(owner.cookie)).html)).toContain("0 of 50 checks used");
    } finally {
      vi.useRealTimers();
    }
  });
});
