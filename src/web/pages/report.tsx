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
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readEvidence } from "../../checks/evidence";
import { getCase } from "../../db/cases";
import { getVerdict } from "../../db/verdicts";
import { verifyReportLink } from "../report-link";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { ReportDocument } from "./report-view";

export { HEADERS } from "./errors";
export { shownState } from "./report-view";

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const reportRoutes = new Hono<{ Bindings: Env }>();

// A redirect with the report's own privacy headers.
const redirect = (to: string) => new Response(null, { status: 303, headers: { ...HEADERS, location: to } });

reportRoutes.get("/cases/:caseId", (c) => {
  const id = c.req.param("caseId");
  return CASE_ID.test(id) ? redirect(`/r/${id}`) : errorPage(404, id);
});

reportRoutes.get("/r/:caseId", async (c) => {
  const id = c.req.param("caseId");
  const url = new URL(c.req.url);
  const hasLink = ["o", "e", "s"].some((name) => url.searchParams.has(name));
  if (!CASE_ID.test(id)) return errorPage(404, id);
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
        const out = await render(c.env.DB, member.orgId, id, "member", user, undefined, active ?? null);
        if (out) return answer(out);
      }
    }
    // 2 and 3. A signed link.
    if (hasLink) {
      const link = await verifyReportLink(c.env.REPORT_LINK_SECRET, url);
      if (link.ok && link.caseId === id)
        return answer((await render(c.env.DB, link.orgId, id, "public", null, link.expires)) ?? errorPage(404, id));
      if (!link.ok && link.reason === "expired") return answer(errorPage(410, id));
      return answer(errorPage(404, id));
    }
    // 4. Nobody yet: sign in, then back here.
    if (!user) return answer(redirect(`/signin?next=${encodeURIComponent(`/r/${id}`)}`));
    return answer(errorPage(404, id));
  } catch (error) {
    // The reference the page shows is the one logged, so support can find the failure by it.
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "report", outcome: "unavailable", reference: ref, error: (error as Error).name }),
    );
    return answer(errorPage(500, id, { ref, retry: `/r/${id}${hasLink ? url.search : ""}` }));
  }
});

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
): Promise<Response | null> {
  const found = await getCase(db, orgId, id);
  if (!found.ok) {
    if (found.error.code === "not_found") return null;
    throw new Error(found.error.message);
  }
  const evidence = await readEvidence(db, id);
  // A verdict that cannot be read is the error page, never a report without its verdict.
  const verdict = await getVerdict(db, id);
  if (verdict && !verdict.ok) throw new Error(verdict.error.message);
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
      />,
    ),
    { headers: HEADERS },
  );
}
