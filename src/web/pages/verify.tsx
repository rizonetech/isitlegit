// The verify page's route (D05 T02 §6): `GET /v/:slug`, public, no session. The identity is found by its public
// address; it is shown as protected only while its protection is in effect (a verified domain, the finance contact
// verified, the switch on) and its plan includes `identity`, both read now. A known business not protected now is
// the Not verified state with 404; an unknown address the site's 404; a failed read the error page with a retry and
// 503, never either answer. Only the registered name, the verified domains and the date protection was switched on
// are read for the page. The page is ./verify-view.tsx.
import { Hono } from "hono";
import { hasFeature } from "../../auth/plans";
import { getIdentity, orgDomains, protectedSince } from "../../trust/identity";
import { orgBySlug } from "../../trust/public-slug";
import { HEADERS, reference } from "./errors";
import { VerifyPage, VerifyUnavailable, VerifyUnknown } from "./verify-view";

export const verifyRoutes = new Hono<{ Bindings: Env }>();

const html = (body: unknown, status: number) => new Response(String(body), { status, headers: HEADERS });

verifyRoutes.get("/v/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = c.env.DB;
  try {
    const orgId = await orgBySlug(db, slug);
    const name = orgId
      ? (await db.prepare(`SELECT name FROM "organization" WHERE id = ?`).bind(orgId).first<{ name: string }>())?.name
      : undefined;
    if (!orgId || !name) return html(<VerifyUnknown reference={reference(404)} now={new Date()} />, 404);
    const [identity, entitled] = await Promise.all([getIdentity(db, orgId), hasFeature(db, orgId, "identity")]);
    if (!identity?.effective.on || !entitled) return html(<VerifyPage view={{ kind: "not-verified", name }} />, 404);
    const [domains, since] = await Promise.all([orgDomains(db, orgId), protectedSince(db, orgId)]);
    return html(
      <VerifyPage
        view={{
          kind: "protected",
          name,
          domains: domains.filter((d) => d.state === "verified").map((d) => d.domain),
          verifiedOn: since,
          checkedAt: new Date().toISOString(),
        }}
      />,
      200,
    );
  } catch (error) {
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "verify-page", outcome: "unavailable", reference: ref, error: (error as Error).name }),
    );
    return html(<VerifyUnavailable reference={ref} now={new Date()} retry={`/v/${encodeURIComponent(slug)}`} />, 503);
  }
});
