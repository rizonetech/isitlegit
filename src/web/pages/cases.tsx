// The Cases list's route (D07 T04 §1): `GET /cases` behind the session gate and the active organisation, answering a
// member with no organisation (or one just removed) with the E3 page and a read that fails with the E5 page, whose Try
// again keeps the filters, a session store it cannot read included. A results request from a page drawn for another
// organisation (switched in another tab) reloads the whole page, so the heading and switcher never name the wrong one.
// The page itself is ./cases-view.tsx.
import { Hono } from "hono";
import type { GateEnv } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { verifiedSenders } from "../../auth/senders";
import { filtersFrom, listCases } from "../../db/case-list";
import { CasesPage, ORG_HEADER } from "./cases-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";

export const casesRoutes = new Hono<GateEnv>();

// The E5 page for a read that fails, its reference the one logged and Try again the address asked for.
function outage(request: Request, why: string) {
  const url = new URL(request.url);
  const ref = reference(500);
  console.log(JSON.stringify({ event: "cases", outcome: "unavailable", reference: ref, error: why }));
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
        : errorPage(403, "", { email: signedIn.user.email });
    // Drawn for another organisation than the active one: the whole page again, at the address asked for.
    const drawnFor = c.req.header(ORG_HEADER);
    if (drawnFor && drawnFor !== membership.org.id)
      return new Response(null, { status: 204, headers: { ...HEADERS, "hx-redirect": c.req.url } });
    const now = new Date();
    try {
      const [list, shell] = await Promise.all([
        listCases(c.env.DB, membership.org.id, filters, now),
        memberShell(c.env.DB, signedIn.user, membership.org.id, "cases"),
      ]);
      if (!list.ok) return outage(c.req.raw, list.error.code);
      const senders =
        list.value.total === 0 ? await verifiedSenders(c.env.DB, membership.org.id) : { domains: [], addresses: [] };
      return new Response(
        String(<CasesPage shell={shell} list={list.value} filters={filters} senders={senders} now={now} />),
        { headers: HEADERS },
      );
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);
