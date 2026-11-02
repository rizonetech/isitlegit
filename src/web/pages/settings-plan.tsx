// The Plan page's route (D07 T08 §4; design/SPEC.md M10): `GET /settings/plan` draws the active organisation's plan from
// `planOf` (D07 T02 §8, the one place a plan is worked out) and the day's usage from `todayUsage`, for every role,
// read-only. A plan or usage that cannot be read is the retryable outage every member page gives, never the free plan.
import { Hono } from "hono";
import type { GateEnv } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { sameSitePath } from "../../auth/paths";
import { planOf } from "../../auth/plans";
import { todayUsage } from "../../db/case-list";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { PlanPage } from "./settings-plan-view";

export const planRoutes = new Hono<GateEnv>();

// The page asked for, kept by Try again: the origin travels with it when it is a path on this site.
const plansAddress = (from: string | null) =>
  from ? `/settings/plan?from=${encodeURIComponent(from)}` : "/settings/plan";
// Where the member came from (`?from=`): only a same-site path, else nowhere.
const originFrom = (from: string | null | undefined) => (from && sameSitePath(from) ? from : null);
const originOf = (c: { req: { query: (name: string) => string | undefined } }) => originFrom(c.req.query("from"));

function outage(why: string, from: string | null = null) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "plan", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: plansAddress(from) });
}

planRoutes.get(
  "/settings/plan",
  // A session store that cannot be read is the same retryable page, keeping the origin the request carried.
  sessionGate((request) => outage("session", originFrom(new URL(request.url).searchParams.get("from")))),
  async (c) => {
    const from = originOf(c);
    const signedIn = c.get("signedIn");
    const membership = await activeMembership(c.env, signedIn);
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage("membership", from)
        : errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" });
    const orgId = membership.org.id;
    try {
      const now = new Date();
      const [shell, plan, usage, started] = await Promise.all([
        memberShell(c.env.DB, signedIn.user, orgId, "plan"),
        planOf(c.env.DB, orgId, now),
        todayUsage(c.env.DB, orgId, now),
        c.env.DB.prepare(`SELECT "createdAt" AS started FROM "organization" WHERE id = ?`)
          .bind(orgId)
          .first<{ started: string | number }>(),
      ]);
      if (!plan) return outage("organisation", from);
      const startedAt = started ? new Date(started.started).toISOString() : null;
      return new Response(
        String(<PlanPage shell={shell} plan={plan} usage={usage} startedAt={startedAt} now={now} from={from} />),
        {
          headers: HEADERS,
        },
      );
    } catch (error) {
      return outage((error as Error).name, from);
    }
  },
);
