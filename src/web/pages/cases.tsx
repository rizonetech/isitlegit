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
import { ignoredDates, searchTooLong } from "../../db/case-filters";
import { filtersFrom, listCases } from "../../db/case-list";
import {
  CSV_WEEKS,
  countsCsv,
  dailyCounts,
  dailyCountsCsv,
  periodWeeks,
  weeklyCounts,
  weeklyStats,
} from "../../db/case-stats";
import { calendarRequest } from "./cases-calendar";
import { CasesPage, casesHref, ORG_HEADER } from "./cases-view";
import { errorPage, HEADERS, page, reference } from "./errors";
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

// The organisation's current members for the Checked by select (D07 T04 §10): a name, or the email where the name
// is blank, and the email in brackets where two members share a name, so each option is one colleague.
export async function membersOf(db: D1Database, orgId: string): Promise<{ id: string; label: string }[]> {
  const rows = (
    await db
      .prepare(
        `SELECT u.id AS id, u.name AS name, u.email AS email FROM "user" u
         JOIN "member" m ON m."userId" = u.id WHERE m."organizationId" = ? ORDER BY u.name, u.email`,
      )
      .bind(orgId)
      .all<{ id: string; name: string; email: string }>()
  ).results;
  const names = new Map<string, number>();
  for (const r of rows) {
    const name = r.name.trim();
    if (name) names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1);
  }
  return rows.map((r) => {
    const name = r.name.trim();
    if (!name) return { id: r.id, label: r.email };
    return { id: r.id, label: (names.get(name.toLowerCase()) ?? 0) > 1 ? `${name} (${r.email})` : name };
  });
}

casesRoutes.get(
  "/cases",
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const params = new URL(c.req.url).searchParams;
    let filters = filtersFrom(params);
    const membership = await activeMembership(c.env, signedIn);
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage(c.req.raw, "membership")
        : errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" });
    // Drawn for another organisation than the active one: the whole page again, at the address asked for.
    const drawnFor = c.req.header(ORG_HEADER);
    if (drawnFor && drawnFor !== membership.org.id)
      return new Response(null, { status: 204, headers: { ...HEADERS, "hx-redirect": c.req.url } });
    const calendar = calendarRequest(params);
    const calendarPanel = calendar !== null && c.req.header("hx-request") === "true";
    if (calendar?.range) {
      filters = { ...filters, ...calendar.range, page: 1 };
      if (!calendarPanel)
        return new Response(null, { status: 303, headers: { ...HEADERS, location: casesHref(filters) } });
    }
    const now = new Date();
    try {
      // The weekly stats (D07 T04 §2) are the organisation's whatever the filters, read beside the list so every
      // results request redraws them too; a failed read is the 503 page, never a panel of zeros.
      const [list, shell, stats, members] = await Promise.all([
        listCases(c.env.DB, membership.org.id, filters, now),
        memberShell(c.env.DB, signedIn.user, membership.org.id, "cases"),
        weeklyStats(c.env.DB, membership.org.id, now),
        membersOf(c.env.DB, membership.org.id),
      ]);
      if (!list.ok) return outage(c.req.raw, list.error.code);
      // No cases at all now (the last one withdrawn since the page was drawn): the first-run page has no results region
      // for a results request to fill, so the whole page loads again at the address asked for.
      if (list.value.total === 0 && c.req.header("hx-request") === "true" && !calendarPanel)
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
            datesIgnored={ignoredDates(new URL(c.req.url).searchParams)}
            members={members}
            calendar={calendar?.draft}
          />,
        ),
        {
          status: calendar?.draft.invalid && !calendarPanel ? 400 : 200,
          headers: {
            ...HEADERS,
            ...(calendarPanel ? { "hx-push-url": calendar?.range ? casesHref(filters) : "false" } : {}),
          },
        },
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
    const params = new URL(c.req.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");
    const exact = params.get("exact") === "1";
    if (exact || from !== null || to !== null) {
      const bad = (why: string) =>
        page(
          "Choose a period",
          <main id="content" class="px-16 py-24 md:px-56 md:py-40">
            <h1 class="type-h1">That period does not work</h1>
            <p class="type-body mt-12">{why}</p>
            <p class="type-body mt-12">
              <a href="/cases" class="text-orange-text underline underline-offset-4">
                Back to your cases
              </a>
            </p>
          </main>,
          400,
        );
      const dateOk = (v: string | null): v is string => {
        const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return false;
        const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        return (
          d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
        );
      };
      if (!dateOk(from) || !dateOk(to))
        return bad("Give both dates as real calendar dates, From and To, and try again.");
      const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
      if (span < 0) return bad("The To date is before the From date. Swap them and try again.");
      if (span > 730) return bad("That period is longer than two years. Choose a shorter one and try again.");
      try {
        const csv = exact
          ? dailyCountsCsv(await dailyCounts(c.env.DB, membership.org.id, from, to))
          : countsCsv(await periodWeeks(c.env.DB, membership.org.id, from, to));
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="isitlegit-${exact ? "daily-counts" : "counts"}-${from}-to-${to}.csv"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return outage(c.req.raw, (error as Error).name, "cases-csv");
      }
    }
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
