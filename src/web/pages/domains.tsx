// The domain verification page's route (D07 T02 §15): `GET /settings/domains/:domain` draws a claim of the active
// organisation for an owner or admin; `POST` to the same address runs one action (check, send, verify) through the
// same functions the JSON routes use (src/auth/domains.ts), then answers 303 back to the page with what happened
// (post, redirect, get). A post must come from the app's own origin and name the organisation its page was drawn for;
// a form left open across an organisation switch changes nothing. Every answer is private. The page is
// ./domains-view.tsx.
import { Hono } from "hono";
import { clientIp } from "../../auth/audit";
import {
  type Actor,
  checkDomain,
  domainClaimView,
  registrable,
  sendDomainCode,
  verifyDomainCode,
} from "../../auth/domains";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { DomainNotFound, DomainPage, DomainRoleRefusal, RESULTS, type Result } from "./domains-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";

export const domainPageRoutes = new Hono<GateEnv>();

function outage(request: Request, why: string) {
  const url = new URL(request.url);
  const ref = reference(500);
  console.log(JSON.stringify({ event: "domain-page", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: url.pathname });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });
const back = (domain: string, result: Result) => {
  const query = new URLSearchParams({ r: result.r });
  if (result.seen) query.set("seen", result.seen);
  if (result.to) query.set("to", result.to);
  return new Response(null, {
    status: 303,
    headers: { ...HEADERS, location: `/settings/domains/${encodeURIComponent(domain)}?${query}` },
  });
};

// The signed-in owner or admin of the active organisation, or the page that refuses them.
async function manager(env: Env, signedIn: SignedIn, request: Request) {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage(request, "membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email }) };
  if (!["owner", "admin"].includes(membership.org.role)) {
    const name = await env.DB.prepare(`SELECT name FROM "organization" WHERE id = ?`)
      .bind(membership.org.id)
      .first<{ name: string }>();
    return {
      refused: html(
        <DomainRoleRefusal orgName={name?.name ?? "your organisation"} reference={reference(403)} now={new Date()} />,
        403,
      ),
    };
  }
  return { org: membership.org };
}

const domainOf = (param: string) => registrable(param.toLowerCase()) ?? param.toLowerCase();

domainPageRoutes.get(
  "/settings/domains/:domain",
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await manager(c.env, signedIn, c.req.raw);
    if ("refused" in who) return who.refused;
    const domain = domainOf(c.req.param("domain"));
    const url = new URL(c.req.url);
    const r = url.searchParams.get("r");
    const result: Result | null =
      r && (RESULTS as readonly string[]).includes(r)
        ? {
            r,
            ...(url.searchParams.get("seen") ? { seen: url.searchParams.get("seen") ?? "" } : {}),
            ...(url.searchParams.get("to") ? { to: url.searchParams.get("to") ?? "" } : {}),
          }
        : null;
    try {
      const [view, shell] = await Promise.all([
        domainClaimView(c.env.DB, who.org.id, domain),
        memberShell(c.env.DB, signedIn.user, who.org.id, "domains"),
      ]);
      const now = new Date();
      if (!view)
        return html(
          <DomainNotFound
            shell={shell}
            domain={domain}
            switched={result?.r === "switched"}
            reference={reference(404)}
            now={now}
          />,
          404,
        );
      return html(<DomainPage shell={shell} view={view} result={result} now={now} />);
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

domainPageRoutes.post(
  "/settings/domains/:domain",
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site changes nothing.
    if (c.req.header("origin") !== new URL(c.env.APP_URL).origin)
      return new Response("Forbidden", { status: 403, headers: HEADERS });
    const signedIn = c.get("signedIn");
    const who = await manager(c.env, signedIn, c.req.raw);
    if ("refused" in who) return who.refused;
    const domain = domainOf(c.req.param("domain"));
    const form = await c.req.formData().catch(() => null);
    const field = (name: string) => {
      const value = form?.get(name);
      return typeof value === "string" ? value : "";
    };
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (field("org") !== who.org.id) return back(domain, { r: "switched" });
    const actor: Actor = {
      db: c.env.DB,
      secret: c.env.BETTER_AUTH_SECRET ?? "",
      orgId: who.org.id,
      userId: signedIn.user.id,
      ip: clientIp(c.req.raw.headers),
    };
    try {
      const action = field("action");
      if (action === "check") {
        const checked = await checkDomain(actor, domain);
        // A claim removed meanwhile: the page answers its 404.
        if (checked.kind === "gone") return back(domain, { r: "gone" });
        return back(domain, {
          r: `check-${checked.kind}`,
          ...(checked.kind === "different" ? { seen: checked.seen } : {}),
        });
      }
      if (action === "send") {
        const sent = await sendDomainCode(c.env, actor, domain, field("local"));
        if (sent.kind === "gone") return back(domain, { r: "gone" });
        if (sent.kind === "already") return back(domain, { r: "check-verified" });
        return back(domain, { r: `send-${sent.kind}`, ...("to" in sent ? { to: sent.to } : {}) });
      }
      if (action === "verify") {
        const proved = await verifyDomainCode(actor, domain, field("code"));
        if (proved.kind === "gone") return back(domain, { r: "gone" });
        if (proved.kind === "already") return back(domain, { r: "check-verified" });
        return back(domain, { r: `verify-${proved.kind}` });
      }
      return back(domain, { r: "unavailable" });
    } catch (error) {
      console.log(JSON.stringify({ event: "domain-page", outcome: "unavailable", error: (error as Error).name }));
      return back(domain, { r: "unavailable" });
    }
  },
);
