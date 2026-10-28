// The active organisation (D07 T02 §3, spec 4.8). requireOrg runs after requireSession on every app route: it takes the
// organisation from the session's activeOrganizationId only (never from the request) and checks the membership on every
// request through Better Auth, so a member removed a moment ago is refused at once. Routes read the organisation and the
// member's role from the context and scope every query by that organisation.
import { isAPIError } from "better-auth/api";
import { createMiddleware } from "hono/factory";
import { createAuth } from "./auth";
import type { SignedIn } from "./gate";

export type ActiveOrg = { id: string; role: string };
export type OrgEnv = { Bindings: Env; Variables: { signedIn: SignedIn; org: ActiveOrg } };

const refused = (error: string) => Response.json({ error }, { status: 403, headers: { "cache-control": "no-store" } });
// Better Auth answers every definite refusal with an APIError; anything else is the service failing (D1 unreachable),
// which still refuses the request but says so, to be retried, rather than telling a member they do not belong.
const unavailable = () =>
  Response.json(
    { error: "the organisation could not be checked just now; try again in a moment" },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
  );

export const requireOrg = createMiddleware<OrgEnv>(async (c, next) => {
  const active = (c.get("signedIn").session as { activeOrganizationId?: string | null }).activeOrganizationId;
  if (!active) return refused("choose an organisation first");
  let member: { organizationId: string; role: string } | null;
  try {
    member = await createAuth(c.env).api.getActiveMember({ headers: c.req.raw.headers });
  } catch (error) {
    if (!isAPIError(error)) return unavailable();
    member = null;
  }
  if (!member || member.organizationId !== active) return refused("you are not a member of this organisation");
  c.set("org", { id: active, role: member.role });
  await next();
});

// The app shell's organisation switcher posts here (D07 T01 §3): only from the app's own pages, and only to an
// organisation the member belongs to (Better Auth checks), then on to /cases with the active one changed.
export async function switchOrganisation(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(env.APP_URL).origin) return new Response("Forbidden", { status: 403 });
  const form = await request.formData().catch(() => null);
  const organizationId = form?.get("organizationId");
  if (typeof organizationId !== "string" || !organizationId) return new Response("Bad Request", { status: 400 });
  try {
    const { headers } = await createAuth(env).api.setActiveOrganization({
      headers: request.headers,
      body: { organizationId },
      returnHeaders: true,
    });
    const out = new Response(null, { status: 303, headers: { location: "/cases" } });
    for (const cookie of headers.getSetCookie()) out.headers.append("set-cookie", cookie);
    return out;
  } catch (error) {
    return isAPIError(error) ? new Response("Forbidden", { status: 403 }) : unavailable();
  }
}
