// The organisation's team history (D07 T02 §6), for its owners only: the role changes, invitation revocations and
// removals the audit trail recorded (./audit), newest first, filtered by action and date. Read by the member console's
// team page (D07 T04 §3). An admin, a member and another organisation's owner are refused; a row never leaves its
// organisation, and rows with none (a refused sign-in, a rate limit) are the operator's alone (D07 T05 §2).
import { Hono } from "hono";
import { z } from "zod";
import { readTeamHistory, TEAM_ACTIONS } from "./audit";
import { requireSession } from "./gate";
import { type OrgEnv, requireOrg } from "./org";

const Filter = z.strictObject({
  action: z.enum(TEAM_ACTIONS).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const teamHistoryRoutes = new Hono<OrgEnv>();
teamHistoryRoutes.use("*", requireSession, requireOrg);
teamHistoryRoutes.onError(() =>
  Response.json({ error: "the history could not be read just now; try again in a moment" }, { status: 503 }),
);

teamHistoryRoutes.get("/history", async (c) => {
  if (c.get("org").role !== "owner")
    return Response.json({ error: "only an owner reads the team history" }, { status: 403 });
  const filter = Filter.safeParse(c.req.query());
  if (!filter.success)
    return Response.json({ error: "filter by action and by dates in ISO 8601 (from, to)" }, { status: 400 });
  const rows = await readTeamHistory(c.env.DB, c.get("org").id, filter.data);
  return c.json({
    changes: rows.map((row) => ({
      at: row.at,
      action: row.kind,
      outcome: row.outcome,
      actor: row.actor_id,
      target: row.target_id,
      detail: row.detail_json ? (JSON.parse(row.detail_json) as unknown) : null,
    })),
  });
});
