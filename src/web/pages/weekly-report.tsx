// The one-step unsubscribe for the Friday weekly counts (D07 T04 §20): a signed link in every report, no sign-in
// needed. It clears only the opt-in it was issued under; a stale, replayed or tampered link is answered plainly.

import { Hono } from "hono";
import type { GateEnv } from "../../auth/gate";
import { readWeeklyToken } from "../../mail/weekly-report";
import { page } from "./errors";

export const weeklyReportRoutes = new Hono<GateEnv>();

const message = (title: string, body: string, status = 200) =>
  page(
    title,
    <main id="content" class="px-16 py-24 md:px-56 md:py-40">
      <h1 class="type-h1">{title}</h1>
      <p class="type-body mt-12">{body}</p>
      <p class="type-body mt-12">
        <a href="/settings/account" class="text-orange-text underline underline-offset-4">
          Your account settings
        </a>
      </p>
    </main>,
    status,
  );

weeklyReportRoutes.get("/weekly-report/unsubscribe", async (c) => {
  const token = new URL(c.req.url).searchParams.get("token") ?? "";
  const held = await readWeeklyToken(c.env.BETTER_AUTH_SECRET ?? "", token).catch(() => null);
  if (!held)
    return message(
      "That link does not work",
      "It may have been copied incompletely. You can stop the weekly counts in your account settings instead.",
      400,
    );
  try {
    const row = await c.env.DB.prepare(`SELECT opted_in_at FROM weekly_report_optins WHERE org_id = ? AND user_id = ?`)
      .bind(held.orgId, held.userId)
      .first<{ opted_in_at: string }>();
    if (!row)
      return message(
        "Already unsubscribed",
        "You are not receiving the weekly counts. You can start them again in your account settings.",
      );
    if (row.opted_in_at !== held.optedInAt)
      return message(
        "Already changed",
        "That link belongs to an earlier choice. Your current setting stands; you can change it in your account settings.",
      );
    const done = await c.env.DB.prepare(
      `DELETE FROM weekly_report_optins WHERE org_id = ? AND user_id = ? AND opted_in_at = ?`,
    )
      .bind(held.orgId, held.userId, held.optedInAt)
      .run();
    if (!done.meta.changes)
      return message(
        "Already unsubscribed",
        "You are not receiving the weekly counts. You can start them again in your account settings.",
      );
    return message(
      "Unsubscribed",
      "You will not receive the weekly counts again unless you switch them back on in your account settings.",
    );
  } catch {
    return message(
      "That did not work",
      "We could not change your setting just now. Try the link again, or use your account settings.",
      500,
    );
  }
});
