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
import { VerifyPage, VerifyUnavailable, VerifyUnknown, type VerifyView } from "./verify-view";

export const verifyRoutes = new Hono<{ Bindings: Env }>();

const html = (body: unknown, status: number) => new Response(String(body), { status, headers: HEADERS });

// The page's answer for an address: unknown, not verified, or protected with what it shows. Protection needs a
// verified domain, so a protected answer whose domains were removed between the reads (an owner removing the last one
// while the page is drawn) is answered as not verified, never as Protected with no domains (round 2).
export type Answer = { kind: "unknown" } | { kind: "view"; view: VerifyView; status: 200 | 404 };
export async function answerFor(db: D1Database, slug: string, now = new Date()): Promise<Answer> {
  const orgId = await orgBySlug(db, slug);
  const name = orgId
    ? (await db.prepare(`SELECT name FROM "organization" WHERE id = ?`).bind(orgId).first<{ name: string }>())?.name
    : undefined;
  if (!orgId || !name) return { kind: "unknown" };
  const [identity, entitled] = await Promise.all([getIdentity(db, orgId), hasFeature(db, orgId, "identity")]);
  const notVerified: Answer = { kind: "view", view: { kind: "not-verified", name }, status: 404 };
  if (!identity?.effective.on || !entitled) return notVerified;
  const [domains, since] = await Promise.all([orgDomains(db, orgId), protectedSince(db, orgId)]);
  const verified = domains.filter((d) => d.state === "verified").map((d) => d.domain);
  if (verified.length === 0) return notVerified;
  return {
    kind: "view",
    view: { kind: "protected", name, domains: verified, verifiedOn: since, checkedAt: now.toISOString() },
    status: 200,
  };
}

verifyRoutes.get("/v/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    const answer = await answerFor(c.env.DB, slug);
    if (answer.kind === "unknown") return html(<VerifyUnknown reference={reference(404)} now={new Date()} />, 404);
    return html(<VerifyPage view={answer.view} />, answer.status);
  } catch (error) {
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "verify-page", outcome: "unavailable", reference: ref, error: (error as Error).name }),
    );
    return html(<VerifyUnavailable reference={ref} now={new Date()} retry={`/v/${encodeURIComponent(slug)}`} />, 503);
  }
});
