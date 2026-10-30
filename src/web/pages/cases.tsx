// The Cases list's route (D07 T04 §1): `GET /cases` behind the session gate and the active organisation, answering a
// member with no organisation (or one just removed) with the E3 page and a read that fails with the E5 page, whose Try
// again keeps the filters. The page itself is ./cases-view.tsx.
import { Hono } from "hono";
import type { GateEnv } from "../../auth/gate";
import { requireSession } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { verifiedSenders } from "../../auth/senders";
import { filtersFrom, listCases } from "../../db/case-list";
import { CasesPage } from "./cases-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";

export const casesRoutes = new Hono<GateEnv>();

casesRoutes.get("/cases", requireSession, async (c) => {
  const signedIn = c.get("signedIn");
  const url = new URL(c.req.url);
  const filters = filtersFrom(url.searchParams);
  const outage = (why: string) => {
    const ref = reference(500);
    console.log(JSON.stringify({ event: "cases", outcome: "unavailable", reference: ref, error: why }));
    return errorPage(500, "", { ref, retry: `${url.pathname}${url.search}` });
  };
  const membership = await activeMembership(c.env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? outage("membership")
      : errorPage(403, "", { email: signedIn.user.email });
  const now = new Date();
  try {
    const [list, shell] = await Promise.all([
      listCases(c.env.DB, membership.org.id, filters, now),
      memberShell(c.env.DB, signedIn.user, membership.org.id, "cases"),
    ]);
    if (!list.ok) return outage(list.error.code);
    const senders =
      list.value.total === 0 ? await verifiedSenders(c.env.DB, membership.org.id) : { domains: [], addresses: [] };
    return new Response(
      String(<CasesPage shell={shell} list={list.value} filters={filters} senders={senders} now={now} />),
      { headers: HEADERS },
    );
  } catch (error) {
    return outage((error as Error).name);
  }
});
