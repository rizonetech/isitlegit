// Plans, the trial and feature flags (D07 T02 §8; spec 2b). Checking is free; protection is paid. During the event
// there is no billing: every organisation's 14-day trial unlocks everything. The trial is counted from the
// organisation's own `createdAt` (whichever way it was made), or to `org_limits.trial_ends_at` when the operator extended
// it; `org_limits.plan` is set only once the organisation leaves the trial (free, Protect, MSP). An expired trial is free.
// The plan that governs a feature is the protected organisation's, never an anonymous checker's.
import { createMiddleware } from "hono/factory";
import type { Statement } from "../meta/budget-sql";
import type { OrgEnv } from "./org";
import { extendTrialStatement, STORED_PLANS, setPlanStatement } from "./plan-sql";

export type Plan = "trial" | "free" | "protect" | "msp";
export { STORED_PLANS };
export const TRIAL_DAYS = 14;

// Each spec 2b feature and the plans that include it.
export const FEATURES = {
  "counterparty-verdict": ["trial", "free", "protect", "msp"],
  identity: ["trial", "protect", "msp"],
  "impersonation-alerts": ["trial", "protect", "msp"],
  "staff-inbox": ["trial", "protect", "msp"],
  "bank-change": ["trial", "protect", "msp"],
  "closed-loop": ["trial", "protect", "msp"],
  monitor: ["trial", "protect", "msp"],
  "payment-document": ["trial", "protect", "msp"],
  "msp-console": ["trial", "msp"],
  "msp-branding": ["trial", "msp"],
} as const satisfies Record<string, readonly Plan[]>;
export type Feature = keyof typeof FEATURES;

export type PlanState =
  | { plan: "trial"; trialEndsAt: string; daysLeft: number }
  | { plan: "free"; trialEndedAt: string | null }
  | { plan: "protect" | "msp" };

// A plan that could not be read: never taken for the free plan, never a granted feature.
export class PlanUnavailable extends Error {
  override name = "PlanUnavailable";
}

const DAY_MS = 86_400_000;

export async function planOf(db: D1Database, orgId: string, now = new Date()): Promise<PlanState | null> {
  let row: { createdAt: string; plan: string | null; trial_ends_at: string | null } | null;
  try {
    row = await db
      .prepare(
        `SELECT o."createdAt" AS createdAt, l.plan AS plan, l.trial_ends_at AS trial_ends_at FROM "organization" o LEFT JOIN org_limits l ON l.org_id = o.id WHERE o.id = ?`,
      )
      .bind(orgId)
      .first();
  } catch (error) {
    throw new PlanUnavailable(`the plan could not be read (${(error as Error).name})`);
  }
  if (!row) return null;
  if (row.plan === "protect" || row.plan === "msp") return { plan: row.plan };
  const end = row.trial_ends_at
    ? new Date(row.trial_ends_at)
    : new Date(new Date(row.createdAt).getTime() + TRIAL_DAYS * DAY_MS);
  if (row.plan !== "free" && now < end)
    return {
      plan: "trial",
      trialEndsAt: end.toISOString(),
      daysLeft: Math.ceil((end.getTime() - now.getTime()) / DAY_MS),
    };
  return { plan: "free", trialEndedAt: row.plan === "free" && !row.trial_ends_at ? null : end.toISOString() };
}

export async function hasFeature(db: D1Database, orgId: string, feature: Feature, now = new Date()): Promise<boolean> {
  const state = await planOf(db, orgId, now);
  return state !== null && (FEATURES[feature] as readonly Plan[]).includes(state.plan);
}

// A route's gate, after requireOrg: 403 naming the plans that include the feature, or 503 when the plan could not be
// read (an outage neither grants the feature nor passes for the free plan).
export const requireFeature = (feature: Feature) =>
  createMiddleware<OrgEnv>(async (c, next) => {
    let allowed: boolean;
    try {
      allowed = await hasFeature(c.env.DB, c.get("org").id, feature);
    } catch {
      return Response.json(
        { error: "your plan could not be checked just now; try again in a moment" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    if (!allowed)
      return Response.json(
        {
          error: `this needs a plan that includes it (${FEATURES[feature].filter((p) => p !== "trial").join(" or ")})`,
          code: "plan",
          feature,
          plans: FEATURES[feature].filter((p) => p !== "trial"),
        },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    await next();
  });

const run = (db: D1Database, s: Statement) =>
  db
    .prepare(s.sql)
    .bind(...s.params)
    .run();
export const setPlan = async (db: D1Database, orgId: string, plan: (typeof STORED_PLANS)[number]) =>
  ((await run(db, setPlanStatement(orgId, plan))).meta.changes ?? 0) === 1;
export const extendTrial = async (db: D1Database, orgId: string, until: Date, now = new Date()) =>
  ((await run(db, extendTrialStatement(orgId, until, now))).meta.changes ?? 0) === 1;
