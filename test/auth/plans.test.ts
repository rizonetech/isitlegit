import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "../../src/auth/gate";
import { type OrgEnv, requireOrg } from "../../src/auth/org";
import {
  extendTrial,
  FEATURES,
  type Feature,
  hasFeature,
  type Plan,
  PlanUnavailable,
  planOf,
  requireFeature,
  setPlan,
  TRIAL_DAYS,
} from "../../src/auth/plans";
import { addInviteCode } from "../fixtures/auth/members";
import { authEnv, call, ORIGIN, redeem, sessionCookie, stubSmtp2go } from "./helpers";

// Plans, the trial and feature flags (D07 T02 §8; spec 2b), against the migrated D1.
const db = (env as unknown as Env).DB;
const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());

// An organisation made `ageDays` ago (as Better Auth stores createdAt: ISO text).
async function orgAged(ageDays: number, now = Date.now()) {
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Org', ?, ?)`)
    .bind(id, `org-${id.slice(0, 8)}`, new Date(now - ageDays * DAY).toISOString())
    .run();
  return id;
}

// Spec 2b, written out apart from FEATURES: what each plan includes.
const SPEC: Record<Plan, Feature[]> = {
  free: ["counterparty-verdict"],
  protect: [
    "counterparty-verdict",
    "identity",
    "impersonation-alerts",
    "staff-inbox",
    "bank-change",
    "closed-loop",
    "monitor",
    "payment-document",
  ],
  msp: Object.keys(FEATURES) as Feature[],
  trial: Object.keys(FEATURES) as Feature[],
};

describe("planOf and hasFeature", () => {
  it("puts a new organisation on its 14-day trial, counted from its createdAt", async () => {
    const now = new Date();
    const id = await orgAged(0, now.getTime());
    const state = await planOf(db, id, now);
    expect(state).toMatchObject({ plan: "trial", daysLeft: TRIAL_DAYS });
    expect(state?.plan === "trial" && state.trialEndsAt).toBe(new Date(now.getTime() + TRIAL_DAYS * DAY).toISOString());
  });

  it("ends the trial at its last second, and treats an expired trial as free", async () => {
    const now = Date.now();
    const lastSecond = await orgAged(TRIAL_DAYS - 1 / 86_400, now);
    const ended = await orgAged(TRIAL_DAYS, now);
    expect((await planOf(db, lastSecond, new Date(now)))?.plan).toBe("trial");
    expect((await planOf(db, ended, new Date(now)))?.plan).toBe("free");
    expect(await hasFeature(db, ended, "identity", new Date(now))).toBe(false);
    expect(await hasFeature(db, ended, "counterparty-verdict", new Date(now))).toBe(true);
  });

  it("follows the whole feature-by-plan matrix of spec 2b", async () => {
    const trial = await orgAged(1);
    const free = await orgAged(30);
    const protect = await orgAged(30);
    const msp = await orgAged(30);
    await setPlan(db, protect, "protect");
    await setPlan(db, msp, "msp");
    const orgs: Record<Plan, string> = { trial, free, protect, msp };
    for (const plan of Object.keys(orgs) as Plan[])
      for (const feature of Object.keys(FEATURES) as Feature[])
        expect(await hasFeature(db, orgs[plan], feature), `${plan} ${feature}`).toBe(SPEC[plan].includes(feature));
  });

  it("changes with the operator: upgrade, downgrade, an extended trial that expires again, daily_cases kept", async () => {
    const now = Date.now();
    const id = await orgAged(20, now);
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, 7)").bind(id).run();
    expect(await hasFeature(db, id, "monitor", new Date(now))).toBe(false);
    expect(await setPlan(db, id, "protect")).toBe(true);
    expect(await hasFeature(db, id, "monitor", new Date(now))).toBe(true);
    expect(await setPlan(db, id, "free")).toBe(true);
    expect(await hasFeature(db, id, "monitor", new Date(now))).toBe(false);
    expect(await extendTrial(db, id, new Date(now + 3 * DAY), new Date(now))).toBe(true);
    expect(await planOf(db, id, new Date(now))).toMatchObject({ plan: "trial", daysLeft: 3 });
    expect(await hasFeature(db, id, "monitor", new Date(now))).toBe(true);
    expect(await hasFeature(db, id, "monitor", new Date(now + 3 * DAY + 1))).toBe(false);
    expect(
      (
        await db
          .prepare("SELECT daily_cases FROM org_limits WHERE org_id = ?")
          .bind(id)
          .first<{ daily_cases: number }>()
      )?.daily_cases,
    ).toBe(7);
  });

  it("refuses an invalid plan, a past extension and an unknown organisation", async () => {
    const id = await orgAged(1);
    await expect(setPlan(db, id, "gold" as never)).rejects.toThrow(RangeError);
    await expect(extendTrial(db, id, new Date(Date.now() - DAY))).rejects.toThrow(RangeError);
    await expect(extendTrial(db, id, new Date("not a date"))).rejects.toThrow(RangeError);
    expect(await setPlan(db, "no-such-org", "protect")).toBe(false);
    expect(await planOf(db, "no-such-org")).toBeNull();
    expect(await hasFeature(db, "no-such-org", "counterparty-verdict")).toBe(false);
  });

  it("throws PlanUnavailable when the plan cannot be read, never answering free", async () => {
    const broken = { prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error("D1 down")) }) }) };
    await expect(hasFeature(broken as unknown as D1Database, "x", "identity")).rejects.toThrow(PlanUnavailable);
  });
});

describe("requireFeature through the Worker", () => {
  async function owner() {
    const smtp = stubSmtp2go();
    try {
      const email = `plan-${crypto.randomUUID().slice(0, 8)}@example.org`;
      const code = `code-${crypto.randomUUID()}`;
      await addInviteCode(db, code);
      const signedUp = await call("/api/auth/sign-up/invite-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, organizationName: "Plan Org", consent: true }),
      });
      if (signedUp.status !== 201) throw new Error(`signup ${signedUp.status}`);
      const cookie = sessionCookie(await redeem(smtp.sends.at(-1)?.link ?? ""));
      const orgId = (
        await db
          .prepare("SELECT org_id FROM invite_redemptions WHERE email = ?")
          .bind(email)
          .first<{ org_id: string }>()
      )?.org_id as string;
      return { cookie, orgId };
    } finally {
      smtp.restore();
    }
  }
  const app = new Hono<OrgEnv>();
  app.use("/protected/*", requireSession, requireOrg);
  app.get("/protected/identity", requireFeature("identity"), (c) => c.json({ ok: true }));
  const visit = (cookie: string, workerEnv: Env = authEnv) =>
    app.fetch(new Request(`${ORIGIN}/protected/identity`, { headers: { cookie } }), workerEnv);

  it("passes a trial organisation, refuses an expired one with the plans that include it, and 503s an outage", async () => {
    const { cookie, orgId } = await owner();
    expect((await visit(cookie)).status).toBe(200);
    await db
      .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 30 * DAY).toISOString(), orgId)
      .run();
    const refused = await visit(cookie);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "plan", feature: "identity", plans: ["protect", "msp"] });
    const failing = new Proxy(db, {
      get(target, name) {
        if (name === "prepare")
          return (sql: string) => {
            if (sql.includes("org_limits l")) throw new Error("D1 down");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    expect((await visit(cookie, { ...authEnv, DB: failing })).status).toBe(503);
    await setPlan(db, orgId, "protect");
    expect((await visit(cookie)).status).toBe(200);
  });
});
