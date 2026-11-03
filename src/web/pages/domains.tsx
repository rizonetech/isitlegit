// The domain verification page's route (D07 T02 §15): `GET /settings/domains/:domain` draws a claim of the active
// organisation for an owner or admin; `POST` to the same address runs one action (check, send, verify) through the
// same functions the JSON routes use (src/auth/domains.ts), then answers 303 back to the page with what happened
// (post, redirect, get). A post must come from the app's own origin and name the organisation its page was drawn for;
// a form left open across an organisation switch changes nothing. What an action did travels in the address signed
// for the organisation, the domain and ten minutes, so a crafted link cannot make the page claim an outcome. Every
// answer is private. The page is ./domains-view.tsx.
import { Hono } from "hono";
import { clientIp } from "../../auth/audit";
import {
  buildApplyUrl,
  CONNECT_KEY_HOST,
  CONNECT_PROVIDER_ID,
  CONNECT_SERVICE_ID,
  discoverConnect,
  importSigningKey,
  templateSupport,
} from "../../auth/domain-connect";
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
import { fresh, resultHolds, signResult } from "../signed-result";
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
// An action's result as the redirect carries it: signed with the auth secret over the organisation, the domain, the
// result and its moment, so the page shows only what an action of this organisation did here in the last ten minutes.
const PURPOSE = "domain-result";
const signed = (orgId: string, domain: string, r: Result, at: number) =>
  [orgId, domain, r.r, r.seen ?? "", r.to ?? "", String(at)].join("\n");
async function back(secret: string, orgId: string, domain: string, result: Result, local?: string) {
  const at = Date.now();
  const query = new URLSearchParams({ r: result.r });
  if (result.seen) query.set("seen", result.seen);
  if (result.to) query.set("to", result.to);
  query.set("t", String(at));
  query.set("s", await signResult(secret, PURPOSE, signed(orgId, domain, result, at)));
  // The recipient chosen stays chosen (it only preselects a radio, so it needs no signature).
  if (local === "admin" || local === "postmaster") query.set("local", local);
  return new Response(null, {
    status: 303,
    headers: { ...HEADERS, location: `/settings/domains/${encodeURIComponent(domain)}?${query}` },
  });
}
// The result a page address carries, when its signature holds for this organisation and domain and it is recent.
async function resultOf(secret: string, orgId: string, domain: string, url: URL): Promise<Result | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const at = Number(q.get("t"));
  if (!r || !(RESULTS as readonly string[]).includes(r) || !fresh(at)) return null;
  const result: Result = {
    r,
    ...(q.get("seen") ? { seen: q.get("seen") ?? "" } : {}),
    ...(q.get("to") ? { to: q.get("to") ?? "" } : {}),
  };
  return (await resultHolds(secret, PURPOSE, signed(orgId, domain, result, at), q.get("s") ?? "")) ? result : null;
}

// The signed-in owner or admin of the active organisation, or the page that refuses them.
async function manager(env: Env, signedIn: SignedIn, request: Request) {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage(request, "membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" }) };
  if (!["owner", "admin"].includes(membership.org.role)) {
    let name: { name: string } | null;
    try {
      name = await env.DB.prepare(`SELECT name FROM "organization" WHERE id = ?`)
        .bind(membership.org.id)
        .first<{ name: string }>();
    } catch (error) {
      return { refused: outage(request, (error as Error).name) };
    }
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

// Whether Connect may be offered for this domain (D07 T04 §5): the signing key must be set, the domain's registrar
// must publish Domain Connect, and the provider must support IsItLegit's exact template. A provider that cannot
// answer reads "unknown" (Try again stands), never an offer and never a strike-off.
type ConnectOffer = { state: "ready"; providerName: string } | { state: "unknown" } | null;
async function connectOffer(env: Env, domain: string): Promise<ConnectOffer> {
  if (!env.DOMAIN_CONNECT_PRIVATE_KEY) return null;
  try {
    const found = await discoverConnect(domain);
    if (found.state === "unavailable") return { state: "unknown" };
    if (found.state === "unsupported") return null;
    const supported = await templateSupport(found, CONNECT_PROVIDER_ID, CONNECT_SERVICE_ID);
    if (supported.state === "unavailable") return { state: "unknown" };
    if (supported.state === "no") return null;
    return { state: "ready", providerName: found.providerName };
  } catch {
    return { state: "unknown" };
  }
}

domainPageRoutes.get(
  "/settings/domains/:domain",
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await manager(c.env, signedIn, c.req.raw);
    if ("refused" in who) return who.refused;
    const domain = domainOf(c.req.param("domain"));
    const url = new URL(c.req.url);
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const local = url.searchParams.get("local");
    try {
      const [view, shell, result] = await Promise.all([
        domainClaimView(c.env.DB, who.org.id, domain),
        memberShell(c.env.DB, signedIn.user, who.org.id, "domains"),
        resultOf(secret, who.org.id, domain, url),
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
      // Back from the registrar (D07 T04 §5): the return itself runs the check, so the outcome the page shows is
      // the DNS answer, never the return address's word. A claim removed meanwhile falls through to the page's 404.
      if (view.state === "pending" && url.searchParams.get("connect") === "return") {
        const actor: Actor = {
          db: c.env.DB,
          secret,
          orgId: who.org.id,
          userId: signedIn.user.id,
          ip: clientIp(c.req.raw.headers),
          defer: (work) => c.executionCtx.waitUntil(work),
        };
        const checked = await checkDomain(actor, domain);
        if (checked.kind !== "gone")
          return back(secret, who.org.id, domain, {
            r: `check-${checked.kind}`,
            ...(checked.kind === "different" ? { seen: checked.seen } : {}),
          });
      }
      const connect =
        view.state === "pending"
          ? await connectOffer(c.env, domain).then((offer) =>
              offer?.state === "ready"
                ? {
                    state: "ready" as const,
                    providerName: offer.providerName,
                    href: `/settings/domains/${encodeURIComponent(domain)}/connect`,
                  }
                : offer?.state === "unknown"
                  ? { state: "unknown" as const, href: `/settings/domains/${encodeURIComponent(domain)}` }
                  : null,
            )
          : null;
      return html(
        <DomainPage
          shell={shell}
          view={view}
          result={result}
          local={local === "postmaster" ? "postmaster" : "admin"}
          connect={connect}
          now={now}
        />,
      );
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

domainPageRoutes.get(
  "/settings/domains/:domain/connect",
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await manager(c.env, signedIn, c.req.raw);
    if ("refused" in who) return who.refused;
    const domain = domainOf(c.req.param("domain"));
    const page = `/settings/domains/${encodeURIComponent(domain)}`;
    try {
      const view = await domainClaimView(c.env.DB, who.org.id, domain);
      if (view?.state !== "pending")
        return new Response(null, { status: 303, headers: { ...HEADERS, location: page } });
      // The offer is settled again here, never trusted from the page that linked it.
      const pem = c.env.DOMAIN_CONNECT_PRIVATE_KEY;
      if (!pem) return new Response(null, { status: 303, headers: { ...HEADERS, location: page } });
      const found = await discoverConnect(domain);
      if (found.state !== "supported")
        return new Response(null, { status: 303, headers: { ...HEADERS, location: page } });
      const supported = await templateSupport(found, CONNECT_PROVIDER_ID, CONNECT_SERVICE_ID);
      if (supported.state !== "yes")
        return new Response(null, { status: 303, headers: { ...HEADERS, location: page } });
      const key = await importSigningKey(pem).catch(() => null);
      if (!key) return new Response(null, { status: 303, headers: { ...HEADERS, location: page } });
      const apply = await buildApplyUrl({
        discovery: found,
        providerId: CONNECT_PROVIDER_ID,
        serviceId: CONNECT_SERVICE_ID,
        domain,
        txtValue: view.txt.value,
        redirectUri: `${new URL(c.env.APP_URL).origin}${page}?connect=return`,
        privateKey: key,
        keyHost: CONNECT_KEY_HOST,
      });
      return new Response(null, { status: 302, headers: { ...HEADERS, location: apply } });
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
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const to = (result: Result) => back(secret, who.org.id, domain, result, field("local"));
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (field("org") !== who.org.id) return to({ r: "switched" });
    const actor: Actor = {
      db: c.env.DB,
      secret: c.env.BETTER_AUTH_SECRET ?? "",
      orgId: who.org.id,
      userId: signedIn.user.id,
      ip: clientIp(c.req.raw.headers),
      defer: (work) => c.executionCtx.waitUntil(work),
    };
    try {
      const action = field("action");
      if (action === "check") {
        const checked = await checkDomain(actor, domain);
        // A claim removed meanwhile: the page answers its 404.
        if (checked.kind === "gone") return to({ r: "gone" });
        return to({
          r: `check-${checked.kind}`,
          ...(checked.kind === "different" ? { seen: checked.seen } : {}),
        });
      }
      if (action === "send") {
        const sent = await sendDomainCode(c.env, actor, domain, field("local"));
        if (sent.kind === "gone") return to({ r: "gone" });
        if (sent.kind === "already") return to({ r: "check-verified" });
        return to({ r: `send-${sent.kind}`, ...("to" in sent ? { to: sent.to } : {}) });
      }
      if (action === "verify") {
        const proved = await verifyDomainCode(actor, domain, field("code"));
        if (proved.kind === "gone") return to({ r: "gone" });
        if (proved.kind === "already") return to({ r: "check-verified" });
        return to({ r: `verify-${proved.kind}` });
      }
      return to({ r: "unavailable" });
    } catch (error) {
      console.log(JSON.stringify({ event: "domain-page", outcome: "unavailable", error: (error as Error).name }));
      return to({ r: "unavailable" });
    }
  },
);
