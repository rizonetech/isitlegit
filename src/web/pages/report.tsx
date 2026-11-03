// The report route (D07 T03 §1; design spec 4.7, 4.8; design/SPEC.md M3, E1, E2): `GET /r/:caseId` opens a case to a
// member of its organisation (any of theirs, read from Better Auth's `member` table; `requireOrg` checks the active one
// only) or to a valid signed link (src/web/report-link.ts), and to no one else. Access is decided in one order:
//
//   1. a session whose user is a member of the case's organisation: the member view, whatever link comes with it;
//   2. otherwise a valid signed link: the public view;
//   3. otherwise an authentic link past its expiry: 410 (its signature held, so it discloses nothing new);
//   4. otherwise, with no session and no link at all: sign in first, then back here;
//   5. everything else (a session without membership, a bad link, a missing case): one 404, byte for byte the same.
//
// A read that fails is an outage: 503 with a retry, never a 404 and never part of a report. `GET /cases/:caseId` is the
// member's address for the same report. Until D07 T03 §2 and §3 draw the verdict and evidence cards, the page shows the
// case's real state: its badge, its state in words, when it arrived and its evidence, never a placeholder.
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readCheckOutcomes, readEvidence } from "../../checks/evidence";
import { type CaseFilters, filtersFrom, ignoredDates, PAGE_SIZE } from "../../db/case-filters";
import { caseNeighbours, checkerName } from "../../db/case-list";
import { readCaseEvents, readReplySend } from "../../db/case-progress";
import { getCase } from "../../db/cases";
import { readFeedback } from "../../db/feedback";
import { readModelTrace, readTraceSends } from "../../db/model-trace";
import { getVerdict } from "../../db/verdicts";
import { replyAwaited, TraceMail } from "../components/model-trace";
import { verifyReportLink } from "../report-link";
import { casesHref, reportHref } from "./cases-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { headerKey, MetaLine, ReportHeader } from "./report-header";
import { type LiveProps, ReportLive } from "./report-live";
import { progressOf } from "./report-progress";
import { retryNoteOf } from "./report-retry";
import { cited } from "./report-verdict";
import { headerFacts, ReportDocument, type ReportSteps } from "./report-view";

export { HEADERS } from "./errors";
export { shownState } from "./report-view";

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const reportRoutes = new Hono<{ Bindings: Env }>();

// The list context a Cases row carries (D07 T04 §9): present only with its marker, parsed as the list parses it.
const navFiltersOf = (url: URL): CaseFilters | null =>
  url.searchParams.get("list") === "1" ? filtersFrom(url.searchParams) : null;
const navQuery = (filters: CaseFilters, id: string) => reportHref(filters, id).slice(`/r/${id}`.length);

// A redirect with the report's own privacy headers.
const redirect = (to: string) => new Response(null, { status: 303, headers: { ...HEADERS, location: to } });

// Only a case id's shape is a case (D07 T04 §2): the route claims a ULID and nothing else, so `/cases/stats.csv` and any
// later `/cases/<word>` route are never read as a case whatever the mount order; any other `/cases/<x>` is answered with
// this same 404 by src/web/pages/cases.tsx.
reportRoutes.get("/cases/:caseId{[0-9A-HJKMNP-TV-Z]{26}}", (c) => {
  const id = c.req.param("caseId");
  return CASE_ID.test(id) ? redirect(`/r/${id}`) : errorPage(404, id);
});

reportRoutes.get("/r/:caseId", (c) => serve(c, "page"));
// The running report's poll (D07 T03 §4): the same access order, answering the live region only. Any answer but the
// region (no access, an expired or bad link, a missing case) sends the page to the full report, which gives that answer
// as a page (`HX-Redirect`); an outage is a 503 the page keeps polling through.
reportRoutes.get("/r/:caseId/status", (c) => serve(c, "status"));
// The model trace's mail section refreshing itself while a send is unsettled (D07 T03 §5): a member's only, the section alone.
reportRoutes.get("/r/:caseId/trace-mail", (c) => serve(c, "mail"));

async function serve(c: Context<{ Bindings: Env }>, mode: "page" | "status" | "mail"): Promise<Response> {
  const id = c.req.param("caseId") ?? "";
  const url = new URL(c.req.url);
  // A status poll names the header it holds (`h`, D07 T03 §9's `headerKey`), taken out before anything reads the
  // address: a signed link has exactly its three parameters.
  const held = mode === "status" ? url.searchParams.get("h") : null;
  url.searchParams.delete("h");
  // The dispute intent (D07 T09 §3) is a page parameter, not part of a signed link: taken out before a link is
  // verified, as `h` is, so the mail's dispute link verifies on its three signed parameters alone.
  const dispute = url.searchParams.get("dispute") === "1";
  url.searchParams.delete("dispute");
  const hasLink = ["o", "e", "s"].some((name) => url.searchParams.has(name));
  const report = `/r/${id}${hasLink ? url.search : ""}`;
  const elsewhere = () => new Response(null, { status: 204, headers: { ...HEADERS, "hx-redirect": report } });
  if (!CASE_ID.test(id)) return mode !== "page" ? elsewhere() : errorPage(404, id);
  // A session the read renewed sends its new cookie with whatever this answers (as `requireSession` does), or the
  // browser keeps the old one until it expires and the member is signed out though the session lives on.
  let renewed: string[] = [];
  const answer = (res: Response) => {
    for (const cookie of renewed) res.headers.append("set-cookie", cookie);
    return res;
  };
  try {
    // 1. A member of the case's organisation.
    const read = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    renewed = read.headers.getSetCookie();
    const user = read.response?.user;
    if (user) {
      const member = await c.env.DB.prepare(
        `SELECT c.org_id AS orgId FROM cases c JOIN "member" m ON m."organizationId" = c.org_id WHERE c.id = ? AND m."userId" = ?`,
      )
        .bind(id, user.id)
        .first<{ orgId: string }>();
      if (member) {
        const active = (read.response?.session as { activeOrganizationId?: string | null } | undefined)
          ?.activeOrganizationId;
        const out = await render(
          c.env.DB,
          member.orgId,
          id,
          "member",
          user,
          undefined,
          active ?? null,
          undefined,
          mode,
          url.origin,
          held,
          await retryNoteOf(c.env.BETTER_AUTH_SECRET ?? "", id, url),
          url.searchParams.get("trace") === "1",
          url.searchParams.get("run"),
          dispute,
          navFiltersOf(url),
          ignoredDates(url.searchParams)
            .map((name) => `The ${name} date was not a real date, so it was left out of this run.`)
            .join(" "),
        );
        if (out) return answer(out);
      }
    }
    // 2 and 3. A signed link.
    if (hasLink) {
      const link = await verifyReportLink(c.env.REPORT_LINK_SECRET, `/r/${id}${url.search}`);
      if (link.ok && link.caseId === id) {
        const out = await render(
          c.env.DB,
          link.orgId,
          id,
          "public",
          null,
          link.expires,
          null,
          url.search,
          mode,
          url.origin,
          held,
          undefined,
          false,
          null,
          dispute,
        );
        return answer(out ?? (mode !== "page" ? elsewhere() : errorPage(404, id)));
      }
      if (mode !== "page") return answer(elsewhere());
      if (!link.ok && link.reason === "expired") return answer(errorPage(410, id));
      return answer(errorPage(404, id));
    }
    if (mode !== "page") return answer(elsewhere());
    // 4. Nobody yet: sign in, then back here.
    if (!user) {
      const nav = navFiltersOf(url);
      return answer(redirect(`/signin?next=${encodeURIComponent(`/r/${id}${nav ? navQuery(nav, id) : ""}`)}`));
    }
    return answer(errorPage(404, id));
  } catch (error) {
    // The reference the page shows is the one logged, so support can find the failure by it.
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "report", outcome: "unavailable", reference: ref, mode, error: (error as Error).name }),
    );
    if (mode === "status")
      return answer(new Response(null, { status: 503, headers: { ...HEADERS, "retry-after": "2" } }));
    const nav = navFiltersOf(url);
    return answer(errorPage(500, id, { ref, retry: nav ? `/r/${id}${navQuery(nav, id)}` : report }));
  }
}

// The case and its evidence, scoped to the organisation (one query each), drawn in its frame; null when there is no
// such case in that organisation.
async function render(
  db: D1Database,
  orgId: string,
  id: string,
  view: "member" | "public",
  user: { id: string; name: string; email: string } | null,
  linkExpires?: number,
  activeOrgId: string | null = null,
  // A link holder's signature parameters, which the cards' file links and the status poll carry.
  link?: string,
  mode: "page" | "status" | "mail" = "page",
  // The address the reader is on, for the header's Copy link (D07 T03 §9), and the header a poll holds.
  origin = "",
  held: string | null = null,
  // A member's refused retry, carried signed by the address (D07 T03 §20).
  retry: LiveProps["retry"] = null,
  // The address's `?trace=1` (D07 T03 §5): the model trace open, as the demo shows it.
  traceOpen = false,
  // The run a mail refresh was drawn for (D07 T03 §5): its answer is that run's alone.
  traceRun: string | null = null,
  // The member came to dispute the verdict (D07 T03 §22): the closed control is focused, with the board's line.
  dispute = false,
  // The filtered list the member came from (D07 T04 §9), or null: its steps are a member's, on the full page only.
  navFilters: CaseFilters | null = null,
  // A date bound the address named but did not give as a real date, in words (D07 T04 §9).
  navNotice = "",
): Promise<Response | null> {
  const found = await getCase(db, orgId, id);
  if (!found.ok) {
    if (found.error.code === "not_found") return null;
    throw new Error(found.error.message);
  }
  // The findings and coverage of the run the case read was on, named once (D01 T01 §19's completion review): a retry
  // started between these reads leaves the page one attempt's, never one run's evidence beside another's outcomes.
  const run = found.value.runId ?? id;
  // The trace's mail section alone (D07 T03 §5): a member's, past running; anyone else has nothing to refresh.
  if (mode === "mail") {
    // Only for the run the section was drawn for: another tab's retry makes this one's answer nothing, never the new
    // run's mail beside the old run's calls.
    if (view !== "member" || found.value.status === "received" || found.value.status === "running" || traceRun !== run)
      return new Response(null, { status: 204, headers: HEADERS });
    const awaiting = replyAwaited(
      found.value.channel,
      found.value.status,
      progressOf(await readCaseEvents(db, id, run)),
      new Date(),
    );
    return new Response(
      String(<TraceMail caseId={id} run={run} awaiting={awaiting} sends={await readTraceSends(db, id, run)} />),
      { headers: HEADERS },
    );
  }

  const evidence = await readEvidence(db, id, run);
  // Progress is pinned to the same run as everything above (a retry landing between the reads cannot join two runs), and
  // a retry whose start is unconfirmed is a fact of that stored state: `received` under a retry's run id that has
  // recorded no step yet (D07 T03 §20).
  const events = await readCaseEvents(db, id, run);
  const progress = progressOf(events);
  const confirming = found.value.status === "received" && found.value.runId !== null && events.length === 0;
  const coverage = await readCheckOutcomes(db, id, run);
  const delivery = await readReplySend(db, id, run);
  // A member's own feedback (D07 T03 §6); a link holder has no control.
  const mine = view === "member" && user ? await readFeedback(db, id, user.id) : undefined;
  const feedback =
    mine === undefined ? {} : { feedback: mine && { kind: mine.kind, note: mine.note, at: mine.updatedAt } };
  // A verdict that cannot be read is the error page, never a report without its verdict.
  const verdict = await getVerdict(db, id);
  if (verdict && !verdict.ok) throw new Error(verdict.error.message);
  // The header (D07 T03 §9): who sent it in, named only to a member, and the report's own address to copy (a member's
  // plain one, opened by session; a link holder's signed one).
  // The model trace (D07 T03 §5): a member's, and only once the report is past running, so the poll that finishes it
  // carries it and a running poll never pays for it; pinned to the same run as everything above.
  const trace =
    view === "member" && found.value.status !== "received" && found.value.status !== "running"
      ? {
          run,
          data: await readModelTrace(db, id, run),
          facts: {
            findings: evidence.filter((e) => e.check !== "not_checked").length,
            cited: verdict?.value ? cited(verdict.value) : null,
          },
        }
      : null;
  const checker = view === "member" ? await checkerName(db, orgId, found.value) : null;
  const copy = `${origin}/r/${id}${view === "public" ? (link ?? "") : ""}`;
  const facts = headerFacts(found.value, checker);
  // The neighbours in the run the member came from (D07 T04 §9): a failed read is the report's failure, never
  // steps quietly missing; a case outside the run says so and keeps the way back.
  let steps: ReportSteps | undefined;
  // A poll whose header is unchanged swaps no header, so it needs no neighbours (round 7, optimization).
  const pollSettled = mode === "status" && held === headerKey(facts, view);
  if (view === "member" && navFilters && !pollSettled) {
    const neighbours = await caseNeighbours(db, orgId, navFilters, id);
    if (!neighbours.ok) throw new Error(neighbours.error.message);
    const back = (page: number) => casesHref({ ...navFilters, page });
    const notice = navNotice;
    const orgChanged = activeOrgId !== null && activeOrgId !== orgId;
    steps = neighbours.value
      ? {
          previous: neighbours.value.previous ? reportHref(navFilters, neighbours.value.previous) : null,
          next: neighbours.value.next ? reportHref(navFilters, neighbours.value.next) : null,
          back: back(Math.max(1, Math.ceil(neighbours.value.position / PAGE_SIZE))),
          position: neighbours.value.position,
          matching: neighbours.value.matching,
          ...(notice ? { notice } : {}),
          ...(orgChanged ? { orgChanged: true } : {}),
        }
      : {
          previous: null,
          next: null,
          back: back(1),
          unmatched: true,
          ...(notice ? { notice } : {}),
          ...(orgChanged ? { orgChanged: true } : {}),
        };
  }
  if (mode === "status")
    return new Response(
      String(
        <ReportLive
          caseId={id}
          status={found.value.status}
          verdict={verdict?.value ?? null}
          sourceKind={found.value.sourceKind}
          channel={found.value.channel}
          delivery={delivery}
          {...feedback}
          evidence={evidence}
          progress={progress}
          coverage={coverage}
          view={view}
          {...(link ? { link } : {})}
          retry={retry}
          confirming={confirming}
          trace={trace}
          traceOpen={traceOpen}
          uploadName={found.value.uploadName}
          meta={<MetaLine facts={facts} view={view} />}
          headerKey={headerKey(facts, view)}
          {...(view === "member" && navFilters ? { navQuery: navQuery(navFilters, id) } : {})}
        />,
      ) +
        // The header out of band when it differs from the one the page holds, so a report opened before its message
        // was parsed shows the subject and sender once they are stored, and a reader's focus or selection in the
        // header survives every poll that changes nothing.
        (held === headerKey(facts, view)
          ? ""
          : String(
              <ReportHeader facts={facts} view={view} copy={copy} oob {...(steps ? { backHref: steps.back } : {})} />,
            )),
      { headers: HEADERS },
    );
  const shell =
    view === "member"
      ? await memberShell(db, user as { id: string; name: string; email: string }, activeOrgId ?? orgId, "cases", orgId)
      : null;
  return new Response(
    String(
      <ReportDocument
        stored={found.value}
        verdict={verdict?.value ?? null}
        evidence={evidence}
        shell={shell}
        {...(linkExpires ? { linkExpires } : {})}
        {...(link ? { link } : {})}
        progress={progress}
        coverage={coverage}
        delivery={delivery}
        {...feedback}
        checker={checker}
        copy={copy}
        retry={retry}
        confirming={confirming}
        trace={trace}
        traceOpen={traceOpen}
        {...(dispute ? { dispute: true } : {})}
        {...(steps ? { steps } : {})}
        {...(view === "member" && navFilters ? { navQuery: navQuery(navFilters, id) } : {})}
      />,
    ),
    { headers: HEADERS },
  );
}
