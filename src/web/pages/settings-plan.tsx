// The Plan page's route (D07 T08 §4; design/SPEC.md M10): `GET /settings/plan` draws the active organisation's plan from
// `planOf` (D07 T02 §8, the one place a plan is worked out) and the day's usage from `todayUsage`, for every role,
// read-only. A plan or usage that cannot be read is the retryable outage every member page gives, never the free plan.
import { Hono } from "hono";
import type { GateEnv } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { planOf } from "../../auth/plans";
import { todayUsage } from "../../db/case-list";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { PlanPage } from "./settings-plan-view";

export const planRoutes = new Hono<GateEnv>();

function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "plan", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/settings/plan" });
}

planRoutes.get(
  "/settings/plan",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const membership = await activeMembership(c.env, signedIn);
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage("membership")
        : errorPage(403, "", { email: signedIn.user.email });
    const orgId = membership.org.id;
    try {
      const now = new Date();
      const [shell, plan, usage] = await Promise.all([
        memberShell(c.env.DB, signedIn.user, orgId, "plan"),
        planOf(c.env.DB, orgId, now),
        todayUsage(c.env.DB, orgId, now),
      ]);
      if (!plan) return outage("organisation");
      return new Response(String(<PlanPage shell={shell} plan={plan} usage={usage} />), { headers: HEADERS });
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);
