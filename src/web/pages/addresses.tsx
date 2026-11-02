// The single-address verification page's route (D07 T04 §27; design/SPEC.md M8a): `GET /settings/addresses/:address` draws
// a claim of the active organisation for an owner or admin; `POST` to the same address runs one action (send a new code,
// verify the code) through the same functions the JSON routes use (src/auth/domains.ts `sendAddressCode` and
// `verifyAddressCode`), then answers 303 back to the page with what happened (post, redirect, get). A post must come from
// the app's own origin and name the organisation its page was drawn for; a form left open across an organisation switch
// changes nothing. What an action did travels in the address signed for the organisation, the address and ten minutes,
// so a crafted link cannot make the page claim an outcome. An address that is not this organisation's own, whoever's it
// is, is the same not-found page. Every answer is private. The page is ./addresses-view.tsx.
import { Hono } from "hono";
import { clientIp } from "../../auth/audit";
import { type Actor, addressClaimView, sendAddressCode, verifyAddressCode } from "../../auth/domains";
import { readSmallForm } from "../../auth/form";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { AddressNotFound, AddressPage, AddressRoleRefusal, RESULTS, type Result } from "./addresses-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";

export const addressPageRoutes = new Hono<GateEnv>();

// An address is one path segment (`/settings/addresses/remove/<address>` has two, so it is never read as one). Its length
// and shape are not decided by the route: encoded, an address of the longest length is longer than any pattern, so a
// segment that is no claim here (too long, no @) is answered by the page as the same not-found as any other.
const ADDRESS = "{[^/]+}";

function outage(request: Request, why: string) {
  const url = new URL(request.url);
  const ref = reference(500);
  console.log(JSON.stringify({ event: "address-page", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: url.pathname });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });
const RESULT_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`address-result\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const signed = (orgId: string, address: string, r: Result, at: number) => [orgId, address, r.r, String(at)].join("\n");
const pathOf = (address: string) => `/settings/addresses/${encodeURIComponent(address)}`;
// The redirect to an address page carrying what an action just did, signed for the organisation and the address.
export async function toAddressPage(secret: string, orgId: string, address: string, result: Result) {
  const at = Date.now();
  const query = new URLSearchParams({ r: result.r, t: String(at) });
  query.set("s", await sign(secret, signed(orgId, address, result, at)));
  return new Response(null, { status: 303, headers: { ...HEADERS, location: `${pathOf(address)}?${query}` } });
}
async function resultOf(secret: string, orgId: string, address: string, url: URL): Promise<Result | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const at = Number(q.get("t"));
  if (!r || !(RESULTS as readonly string[]).includes(r) || !Number.isFinite(at)) return null;
  if (Date.now() - at > RESULT_TTL_MS || at > Date.now() + 60_000) return null;
  const result: Result = { r };
  return q.get("s") === (await sign(secret, signed(orgId, address, result, at))) ? result : null;
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
        <AddressRoleRefusal orgName={name?.name ?? "your organisation"} reference={reference(403)} now={new Date()} />,
        403,
      ),
    };
  }
  return { org: membership.org };
}

const addressOf = (param: string) => param.trim().toLowerCase();

addressPageRoutes.get(
  `/settings/addresses/:address${ADDRESS}`,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await manager(c.env, signedIn, c.req.raw);
    if ("refused" in who) return who.refused;
    const address = addressOf(c.req.param("address"));
    const url = new URL(c.req.url);
    try {
      const [view, shell, result] = await Promise.all([
        addressClaimView(c.env.DB, who.org.id, address),
        memberShell(c.env.DB, signedIn.user, who.org.id, "domains"),
        resultOf(c.env.BETTER_AUTH_SECRET ?? "", who.org.id, address, url),
      ]);
      const now = new Date();
      if (!view)
        return html(
          <AddressNotFound
            shell={shell}
            address={address}
            switched={result?.r === "switched"}
            reference={reference(404)}
            now={now}
          />,
          404,
        );
      return html(<AddressPage shell={shell} view={view} result={result} now={now} />);
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

addressPageRoutes.post(
  `/settings/addresses/:address${ADDRESS}`,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site changes nothing.
    if (c.req.header("origin") !== new URL(c.env.APP_URL).origin)
      return errorPage(403, "", { email: c.get("signedIn").user.email });
    const signedIn = c.get("signedIn");
    const who = await manager(c.env, signedIn, c.req.raw);
    if ("refused" in who) return who.refused;
    const address = addressOf(c.req.param("address"));
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const to = (result: Result) => toAddressPage(secret, who.org.id, address, result);
    // The page's few short fields, read with a bound before parsing: anything larger changes nothing.
    const form = await readSmallForm(c.req.raw, { org: 200, action: 20, code: 100 });
    if (!form) return to({ r: "unavailable" });
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (form.org !== who.org.id) return to({ r: "switched" });
    const actor: Actor = {
      db: c.env.DB,
      secret,
      orgId: who.org.id,
      userId: signedIn.user.id,
      ip: clientIp(c.req.raw.headers),
      defer: (work) => c.executionCtx.waitUntil(work),
    };
    // A claim removed meanwhile: the page itself answers the not-found.
    const gone = () => new Response(null, { status: 303, headers: { ...HEADERS, location: pathOf(address) } });
    try {
      if (form.action === "send") {
        const sent = await sendAddressCode(c.env, actor, address, false);
        if (sent.kind === "gone") return gone();
        if (sent.kind === "already") return to({ r: "already" });
        if (["sent", "unknown", "failed", "locked", "limit", "busy", "sending"].includes(sent.kind))
          return to({ r: `send-${sent.kind}` });
        return to({ r: "unavailable" });
      }
      if (form.action === "verify") {
        const proved = await verifyAddressCode(actor, address, form.code ?? "");
        if (proved.kind === "gone") return gone();
        if (proved.kind === "already") return to({ r: "already" });
        return to({ r: `verify-${proved.kind}` });
      }
      return to({ r: "unavailable" });
    } catch (error) {
      console.log(JSON.stringify({ event: "address-page", outcome: "unavailable", error: (error as Error).name }));
      return to({ r: "unavailable" });
    }
  },
);
