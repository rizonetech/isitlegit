// The member frame's data (D07 T01 §3's `AppShell`, member variant) for a signed-in member (first used by the report,
// D07 T03 §1): the session's active organisation as the current one (the switcher and every organisation-scoped page
// act on it, `requireOrg`), the member's others for the switcher, the plan words, the member's name and role. A page
// about another of the member's organisations (a report opened from a link) still shows the active one as current;
// `fallback` is the frame's organisation when the session has none, or one the member has since left. A read that
// fails is an outage the page answers as one, never a frame with guessed parts.

import { planOf } from "../../auth/plans";
import type { MemberPage, MemberShellProps } from "../components/AppShell";

type Membership = { organizationId: string; name: string; role: string };

export class ShellUnavailable extends Error {
  override name = "ShellUnavailable";
}

export async function memberShell(
  db: D1Database,
  user: { id: string; name: string; email: string },
  activeOrgId: string,
  active: MemberPage,
  fallback: string = activeOrgId,
  now = new Date(),
): Promise<Omit<MemberShellProps, "children">> {
  let memberships: Membership[];
  try {
    memberships = (
      await db
        .prepare(
          `SELECT m."organizationId" AS organizationId, o.name AS name, m.role AS role FROM "member" m JOIN "organization" o ON o.id = m."organizationId" WHERE m."userId" = ? ORDER BY o.name`,
        )
        .bind(user.id)
        .all<Membership>()
    ).results;
  } catch (error) {
    throw new ShellUnavailable(`the member's organisations could not be read (${(error as Error).name})`);
  }
  const current =
    memberships.find((m) => m.organizationId === activeOrgId) ?? memberships.find((m) => m.organizationId === fallback);
  if (!current) throw new ShellUnavailable("the member is not in this organisation");
  const orgId = current.organizationId;
  const plan = await planOf(db, orgId, now).catch((error: Error) => {
    throw new ShellUnavailable(error.message);
  });
  if (!plan) throw new ShellUnavailable("the organisation could not be read");
  return {
    variant: "member",
    active,
    organization: { id: orgId, name: current.name },
    otherOrganizations: memberships
      .filter((m) => m.organizationId !== orgId)
      .map((m) => ({ id: m.organizationId, name: m.name })),
    // The Monitor's new findings (D05 T04 §5), counted from the findings store.
    monitorNew: await db
      .prepare("SELECT COUNT(*) AS n FROM monitor_findings WHERE org_id = ? AND status = 'new'")
      .bind(orgId)
      .first<{ n: number }>()
      .then((row) => row?.n ?? 0)
      .catch((error: Error) => {
        throw new ShellUnavailable(`the monitor's new findings could not be counted (${error.name})`);
      }),
    plan:
      plan.plan === "trial"
        ? { trialDaysLeft: plan.daysLeft }
        : { name: plan.plan === "free" ? "Free" : plan.plan === "msp" ? "MSP" : "Protect" },
    user: { name: user.name || user.email, role: current.role.charAt(0).toUpperCase() + current.role.slice(1) },
  };
}
