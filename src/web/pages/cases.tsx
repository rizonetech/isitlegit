// The Cases list's route (D07 T04 §1): `GET /cases` behind the session gate and the active organisation, answering a
// member with no organisation (or one just removed) with the E3 page and a read that fails with the E5 page, whose Try
// again keeps the filters, a session store it cannot read included. A results request from a page drawn for another
// organisation (switched in another tab) reloads the whole page, so the heading and switcher never name the wrong one.
// The page itself is ./cases-view.tsx.
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { GateEnv } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { verifiedSenders } from "../../auth/senders";
import { searchTooLong } from "../../db/case-filters";
import { filtersFrom, listCases } from "../../db/case-list";
import { CSV_WEEKS, countsCsv, weeklyCounts, weeklyStats } from "../../db/case-stats";
import { CasesPage, ORG_HEADER } from "./cases-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { COOKIE, hiddenIn, stepsOf } from "./welcome-steps";
import { doneCount } from "./welcome-view";

export const casesRoutes = new Hono<GateEnv>();

// The E5 page for a read that fails, its reference the one logged and Try again the address asked for.
function outage(request: Request, why: string, event = "cases") {
  const url = new URL(request.url);
  const ref = reference(500);
  console.log(JSON.stringify({ event, outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: `${url.pathname}${url.search}` });
}

casesRoutes.get(
  "/cases",
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const filters = filtersFrom(new URL(c.req.url).searchParams);
    const membership = await activeMembership(c.env, signedIn);
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage(c.req.raw, "membership")
        : errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" });
    // Drawn for another organisation than the active one: the whole page again, at the address asked for.
    const drawnFor = c.req.header(ORG_HEADER);
    if (drawnFor && drawnFor !== membership.org.id)
      return new Response(null, { status: 204, headers: { ...HEADERS, "hx-redirect": c.req.url } });
    const now = new Date();
    try {
      // The weekly stats (D07 T04 §2) are the organisation's whatever the filters, read beside the list so every
      // results request redraws them too; a failed read is the 503 page, never a panel of zeros.
      const [list, shell, stats] = await Promise.all([
        listCases(c.env.DB, membership.org.id, filters, now),
        memberShell(c.env.DB, signedIn.user, membership.org.id, "cases"),
        weeklyStats(c.env.DB, membership.org.id, now),
      ]);
      if (!list.ok) return outage(c.req.raw, list.error.code);
      // No cases at all now (the last one withdrawn since the page was drawn): the first-run page has no results region
      // for a results request to fill, so the whole page loads again at the address asked for.
      if (list.value.total === 0 && c.req.header("hx-request") === "true")
        return new Response(null, { status: 204, headers: { ...HEADERS, "hx-redirect": c.req.url } });
      const senders =
        list.value.total === 0 ? await verifiedSenders(c.env.DB, membership.org.id) : { domains: [], addresses: [] };
      // The way to the setup list, until all five steps are done: a failed read never blocks the Cases list.
      const setup =
        c.req.header("hx-request") === "true"
          ? null
          : await stepsOf(c.env.DB, membership.org.id)
              .then((steps) => ({
                done: doneCount(steps),
                hidden: hiddenIn(getCookie(c, COOKIE)).includes(membership.org.id),
              }))
              .catch(() => null);
      return new Response(
        String(
          <CasesPage
            shell={shell}
            list={list.value}
            filters={filters}
            senders={senders}
            stats={stats}
            now={now}
            setup={setup}
            searchLong={searchTooLong(new URL(c.req.url).searchParams.get("q"))}
          />,
        ),
        { headers: HEADERS },
      );
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

// The weekly counts as CSV (D07 T04 §2, board `Cases` "Export counts as CSV"): the last 12 weeks, newest first, counts
// only. Behind the same gate and organisation as the list, its failures answered with the same pages.
casesRoutes.get(
  "/cases/stats.csv",
  sessionGate((request) => outage(request, "session", "cases-csv")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const membership = await activeMembership(c.env, signedIn);
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage(c.req.raw, "membership", "cases-csv")
        : errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" });
    // Asked from a page drawn for another organisation than the active one (switched in another tab): the Cases page
    // of the active one, whose export is then the member's to press, never the other organisation's counts unasked.
    const asked = new URL(c.req.url).searchParams.get("org");
    if (asked && asked !== membership.org.id)
      return new Response(null, { status: 303, headers: { ...HEADERS, location: "/cases" } });
    try {
      const weeks = await weeklyCounts(c.env.DB, membership.org.id, new Date(), CSV_WEEKS);
      return new Response(countsCsv(weeks), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="isitlegit-weekly-counts.csv"',
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return outage(c.req.raw, (error as Error).name, "cases-csv");
    }
  },
);

// Any other `/cases/<x>`: not a case id's shape, so not a case, answered with the report's own 404 page without a read
// (src/web/pages/report.tsx claims only a ULID).
casesRoutes.get("/cases/:other", (c) => errorPage(404, c.req.param("other")));
