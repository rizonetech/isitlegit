// The member frame's data (D07 T01 §3's `AppShell`, member variant) for a signed-in member on one organisation's page
// (first used by the report, D07 T03 §1): the organisation, the member's others for the switcher, the plan words, the
// member's name and role. Read in one batch; a read that fails is an outage the page answers as one, never a frame with
// guessed parts.

import { planOf } from "../../auth/plans";
import type { MemberPage, MemberShellProps } from "../components/AppShell";

type Membership = { organizationId: string; name: string; role: string };

export class ShellUnavailable extends Error {
  override name = "ShellUnavailable";
}

export async function memberShell(
  db: D1Database,
  user: { id: string; name: string; email: string },
  orgId: string,
  active: MemberPage,
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
  const current = memberships.find((m) => m.organizationId === orgId);
  if (!current) throw new ShellUnavailable("the member is not in this organisation");
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
    // The Monitor's new findings (D05 T04 §5) are counted once its findings are stored; until then there are none.
    monitorNew: 0,
    plan:
      plan.plan === "trial"
        ? { trialDaysLeft: plan.daysLeft }
        : { name: plan.plan === "free" ? "Free" : plan.plan === "msp" ? "MSP" : "Protect" },
    user: { name: user.name || user.email, role: current.role.charAt(0).toUpperCase() + current.role.slice(1) },
  };
}
