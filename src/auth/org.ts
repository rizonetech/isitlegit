// The active organisation (D07 T02 §3, spec 4.8). requireOrg runs after requireSession on every app route: it takes the
// organisation from the session's activeOrganizationId only (never from the request) and checks the membership on every
// request through Better Auth, so a member removed a moment ago is refused at once. Routes read the organisation and the
// member's role from the context and scope every query by that organisation.
import { isAPIError } from "better-auth/api";
import { createMiddleware } from "hono/factory";
import { errorPage, reference } from "../web/pages/errors";
import { createAuth } from "./auth";
import { readSmallForm } from "./form";
import type { SignedIn } from "./gate";
import { MAX_RETURN_PATH, sameSitePath } from "./paths";

export type ActiveOrg = { id: string; role: string };
export type OrgEnv = { Bindings: Env; Variables: { signedIn: SignedIn; org: ActiveOrg } };

const refused = (error: string) => Response.json({ error }, { status: 403, headers: { "cache-control": "no-store" } });
// Better Auth answers a definite refusal with a 4xx APIError; a 5xx one (its own read failing) or anything else is the
// service failing (D1 unreachable), which still refuses the request but says so, to be retried, rather than telling a
// member they do not belong. Its internal session read turns a failing store into a 401, so callers read the session
// themselves first (requireSession; the switch below) and do not count on the status alone.
export const isRefusal = (error: unknown) => isAPIError(error) && error.statusCode < 500;
const unavailable = () =>
  Response.json(
    { error: "the organisation could not be checked just now; try again in a moment" },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
  );

// The session's active organisation and the member's role in it, read the one way every route reads it: the API's
// requireOrg below and the member pages (D07 T04 §1), which answer the same outcomes as pages.
export type ActiveMembership =
  | { ok: true; org: ActiveOrg }
  | { ok: false; reason: "no-organisation" | "not-a-member" | "closed" | "unavailable" };
export async function activeMembership(env: Env, signedIn: SignedIn): Promise<ActiveMembership> {
  const active = (signedIn.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  if (!active) return { ok: false, reason: "no-organisation" };
  // The membership through Better Auth's adapter for the session the gate already read: a second session read inside
  // the plugin (getActiveMember) would turn a failing store into "not signed in", a refusal instead of an outage.
  let member: { role: string } | null;
  try {
    const { adapter } = await createAuth(env).$context;
    member = await adapter.findOne<{ role: string }>({
      model: "member",
      where: [
        { field: "userId", value: signedIn.user.id },
        { field: "organizationId", value: active },
      ],
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!member) return { ok: false, reason: "not-a-member" };
  // A closed organisation refuses here, at the one read every app route makes, so its members' sessions reach no
  // write boundary (domains, addresses, uploads) after closure (D07 T02 §9).
  const closed = await env.DB.prepare(`SELECT "closedAt" AS closedAt FROM "organization" WHERE id = ?`)
    .bind(active)
    .first<{ closedAt: string | null }>()
    .catch(() => null);
  if (closed?.closedAt) return { ok: false, reason: "closed" };
  return { ok: true, org: { id: active, role: member.role } };
}

export const requireOrg = createMiddleware<OrgEnv>(async (c, next) => {
  const read = await activeMembership(c.env, c.get("signedIn"));
  if (!read.ok) {
    if (read.reason === "unavailable") return unavailable();
    return refused(
      read.reason === "no-organisation"
        ? "choose an organisation first"
        : read.reason === "closed"
          ? "this organisation is closed"
          : "you are not a member of this organisation",
    );
  }
  c.set("org", read.org);
  await next();
});

// The app shell's organisation switcher posts here (D07 T01 §3): only from the app's own pages, and only to an
// organisation the member belongs to (Better Auth checks), then on to /cases with the active one changed.
export async function switchOrganisation(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(env.APP_URL).origin) return new Response("Forbidden", { status: 403 });
  const form = await readSmallForm(request, { organizationId: 200, next: MAX_RETURN_PATH });
  if (!form) return new Response("Request too large", { status: 413 });
  const organizationId = form.organizationId;
  if (!organizationId) return new Response("Bad Request", { status: 400 });
  // A form post, so an outage is the E5 error page (a reference, Try again back where the press came from, support),
  // never the API's JSON: the switcher in the app shell and the invitation page's Open (D07 T02 §14) both post here.
  const failed = () => {
    const ref = reference(500);
    console.log(JSON.stringify({ event: "org-switch", outcome: "unavailable", reference: ref }));
    const page = errorPage(500, "", { ref, retry: sameSitePath(form.next) ? form.next : "/cases" });
    return new Response(page.body, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "retry-after": "5" },
    });
  };
  const auth = createAuth(env);
  try {
    // Read the session first: inside the plugin a failed session read becomes "not signed in" (401), an outage
    // indistinguishable from a refusal; Better Auth's getSession throws a 5xx for it instead.
    if (!(await auth.api.getSession({ headers: request.headers }))) return new Response("Forbidden", { status: 403 });
    const { headers } = await auth.api.setActiveOrganization({
      headers: request.headers,
      body: { organizationId },
      returnHeaders: true,
    });
    const out = new Response(null, { status: 303, headers: { location: "/cases" } });
    for (const cookie of headers.getSetCookie()) out.headers.append("set-cookie", cookie);
    return out;
  } catch (error) {
    return isRefusal(error) ? new Response("Forbidden", { status: 403 }) : failed();
  }
}
