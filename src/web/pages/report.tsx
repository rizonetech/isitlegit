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
import { CHECK_ADDRESS } from "../components/AppShell";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { type ErrorCode, ErrorState, referenceLine } from "../components/States";
import { verifyReportLink } from "../report-link";
import { memberShell } from "./member-shell";
import { ReportDocument } from "./report-view";

export { shownState } from "./report-view";

export const HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
  // The signed link's query goes nowhere else: the page loads only its own files.
  "referrer-policy": "same-origin",
  "content-type": "text/html; charset=utf-8",
};

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function page(title: string, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(String(<Document title={title}>{body as never}</Document>), {
    status,
    headers: { ...HEADERS, ...extra },
  });
}

const reference = (code: number | string) =>
  `${code}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;

const forward = (
  <>
    Forwarding still works: send suspicious mail to <strong class="font-mono text-ink">{CHECK_ADDRESS}</strong> as
    usual.
  </>
);

// The error pages this route answers with, in E1, E2 and E5's compositions (D07 T08 §1 later owns them all). Their
// actions are the boards' own: the cases list (D07 T04 §1) and the upload page (D01 T03 §6) are their sections' pages.
// `retry` is the page an outage's "Try again" opens: the address asked for, its signed link kept, so a link holder is
// not sent to sign in. `ref` is the reference shown, the same one the outage's log line carries.
function errorPage(
  code: Extract<ErrorCode, 404 | 410 | 500>,
  caseId: string,
  options: { retry?: string; ref?: string; now?: Date } = {},
) {
  const footer = referenceLine(options.ref ?? reference(code), options.now ?? new Date());
  const body =
    code === 404 ? (
      <ErrorState
        code={404}
        title="We can't show you that page."
        actions={[
          <Button variant="dark" href="/cases">
            Go to your cases
          </Button>,
          <Button variant="ghost" href="/upload">
            Check a file
          </Button>,
        ]}
        note={forward}
        footer={footer}
      >
        It may not exist, the address may be mistyped, or it may belong to an organisation you are not part of. We don't
        say which, so case links never reveal anything.
      </ErrorState>
    ) : code === 410 ? (
      <ErrorState
        code={410}
        title="This report link has expired."
        actions={[
          <Button variant="dark" href={`/signin?next=${encodeURIComponent(`/r/${caseId}`)}`}>
            Sign in to see the case
          </Button>,
        ]}
        note={
          <>
            No account? Forward the email again to <strong class="font-mono text-ink">{CHECK_ADDRESS}</strong> for a
            fresh report.
          </>
        }
        footer={footer}
      >
        Links in our reply emails work for 7 days, so an old email can't be used to read a report. The case itself stays
        in your organisation's account: sign in to open it.
      </ErrorState>
    ) : (
      <ErrorState
        code={500}
        title="Sorry, something broke on our side."
        actions={[
          <Button variant="dark" href={options.retry ?? `/r/${caseId}`}>
            Try again
          </Button>,
          <Button variant="ghost" href="mailto:support@isitlegit.co.za">
            Email support
          </Button>,
        ]}
        note={forward}
        footer={footer}
      >
        This was our fault, not yours. Try again in a minute. If it keeps happening, send us the reference below.
      </ErrorState>
    );
  const titles = { 404: "Not found", 410: "Link expired", 500: "Something broke" } as const;
  return page(
    titles[code],
    <main id="content" class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle">
      {body}
    </main>,
    code === 500 ? 503 : code,
    code === 500 ? { "retry-after": "5" } : {},
  );
}

export const reportRoutes = new Hono<{ Bindings: Env }>();

reportRoutes.get("/cases/:caseId", (c) => {
  const id = c.req.param("caseId");
  return CASE_ID.test(id) ? c.redirect(`/r/${id}`, 303) : errorPage(404, id);
});

reportRoutes.get("/r/:caseId", async (c) => {
  const id = c.req.param("caseId");
  const url = new URL(c.req.url);
  const hasLink = ["o", "e", "s"].some((name) => url.searchParams.has(name));
  if (!CASE_ID.test(id)) return errorPage(404, id);
  try {
    // 1. A member of the case's organisation.
    const read = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    const user = read.response?.user;
    if (user) {
      const member = await c.env.DB.prepare(
        `SELECT c.org_id AS orgId FROM cases c JOIN "member" m ON m."organizationId" = c.org_id WHERE c.id = ? AND m."userId" = ?`,
      )
        .bind(id, user.id)
        .first<{ orgId: string }>();
      if (member) {
        const out = await render(c.env.DB, member.orgId, id, "member", user);
        if (out) {
          for (const cookie of read.headers.getSetCookie()) out.headers.append("set-cookie", cookie);
          return out;
        }
      }
    }
    // 2 and 3. A signed link.
    if (hasLink) {
      const link = await verifyReportLink(c.env.REPORT_LINK_SECRET, url);
      if (link.ok && link.caseId === id)
        return (await render(c.env.DB, link.orgId, id, "public", null, link.expires)) ?? errorPage(404, id);
      if (!link.ok && link.reason === "expired") return errorPage(410, id);
      return errorPage(404, id);
    }
    // 4. Nobody yet: sign in, then back here.
    if (!user) return c.redirect(`/signin?next=${encodeURIComponent(`/r/${id}`)}`, 303);
    return errorPage(404, id);
  } catch (error) {
    // The reference the page shows is the one logged, so support can find the failure by it.
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "report", outcome: "unavailable", reference: ref, error: (error as Error).name }),
    );
    return errorPage(500, id, { ref, retry: `/r/${id}${hasLink ? url.search : ""}` });
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
): Promise<Response | null> {
  const found = await getCase(db, orgId, id);
  if (!found.ok) {
    if (found.error.code === "not_found") return null;
    throw new Error(found.error.message);
  }
  const evidence = await readEvidence(db, id);
  const shell =
    view === "member"
      ? await memberShell(db, user as { id: string; name: string; email: string }, orgId, "cases")
      : null;
  return new Response(
    String(
      <ReportDocument
        stored={found.value}
        evidence={evidence}
        shell={shell}
        {...(linkExpires ? { linkExpires } : {})}
      />,
    ),
    { headers: HEADERS },
  );
}
