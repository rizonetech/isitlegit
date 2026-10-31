// The Domains and addresses page's routes (D07 T04 §4; design/SPEC.md M8): `GET /settings/domains` draws the lists, for
// a member read-only; `GET /settings/domains/remove/:domain` and `/settings/addresses/remove/:address` ask before a
// removal and say what it really changes; `POST /settings/domains` runs one change through the JSON routes of
// src/auth/domains.ts in process (`domainRoutes.fetch`, with the member's cookie and the app's origin), so the same
// handlers, gates, limits and audit apply as for the API, then answers 303 back with what happened, signed for the
// organisation and ten minutes (post, redirect, get). A post must come from the app's own origin and name the
// organisation its page was drawn for. The page is ./domains-list-view.tsx.
import { type Context, Hono } from "hono";
import { domainRoutes } from "../../auth/domains";
import { readSmallForm } from "../../auth/form";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { getIdentity } from "../../trust/identity";
import {
  type AddressRow,
  type Challenge,
  type DomainRow,
  DomainsListPage,
  monthStart,
  OUTCOMES,
  type Outcome,
  RemoveConfirm,
} from "./domains-list-view";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";

export const domainsListRoutes = new Hono<GateEnv>();

function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "domains-list", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/settings/domains" });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });

// What a change did, carried in the redirect and signed (as the Team page's, ./team.tsx): the organisation, the outcome,
// the claim's name bounded, and the moment, so the page shows only what a change of this organisation did lately.
const OUTCOME_TTL_MS = 10 * 60_000;
const NAME_LIMIT = 80;
const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`domains-result\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const bounded = (name: string) => {
  const chars = Array.from(name);
  return chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT - 1).join("")}…` : name;
};
const signed = (orgId: string, o: Outcome, at: number) => [orgId, o.r, o.what ?? "", String(at)].join("\n");
async function back(secret: string, orgId: string, given: Outcome) {
  const outcome: Outcome = given.what ? { ...given, what: bounded(given.what) } : given;
  const at = Date.now();
  const query = new URLSearchParams({ r: outcome.r });
  if (outcome.what) query.set("w", outcome.what);
  query.set("t", String(at));
  query.set("s", await sign(secret, signed(orgId, outcome, at)));
  return new Response(null, { status: 303, headers: { ...HEADERS, location: `/settings/domains?${query}` } });
}
async function outcomeOf(secret: string, orgId: string, url: URL): Promise<Outcome | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const at = Number(q.get("t"));
  if (!r || !(OUTCOMES as readonly string[]).includes(r) || !Number.isFinite(at)) return null;
  if (Date.now() - at > OUTCOME_TTL_MS || at > Date.now() + 60_000) return null;
  const outcome: Outcome = { r: r as Outcome["r"], ...(q.get("w") ? { what: q.get("w") ?? "" } : {}) };
  return q.get("s") === (await sign(secret, signed(orgId, outcome, at))) ? outcome : null;
}

const MANAGERS = ["owner", "admin"];
async function memberOf(env: Env, signedIn: SignedIn) {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage("membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email }) };
  return { org: membership.org, manage: MANAGERS.some((r) => membership.org.role.split(",").includes(r)) };
}

// The JSON routes of src/auth/domains.ts, called in process with the member's own cookie and the app's origin.
async function api(
  c: Pick<Context<GateEnv>, "env" | "req" | "executionCtx">,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) {
  const origin = new URL(c.env.APP_URL).origin;
  const headers = new Headers({ origin, "content-type": "application/json" });
  for (const name of ["cookie", "cf-connecting-ip", "user-agent"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  return domainRoutes.fetch(
    new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    c.env,
    c.executionCtx,
  );
}

type Claims = { domains: DomainRow[]; addresses: AddressRow[]; domainNames: string[] };
// The lists, scoped by the organisation, for every role; an owner or admin adds each pending claim's challenge from the
// JSON read (which gates to them).
async function readClaims(
  c: Pick<Context<GateEnv>, "env" | "req" | "executionCtx">,
  orgId: string,
  manage: boolean,
  now: Date,
): Promise<Claims> {
  const db = c.env.DB;
  const [domainRows, addressRows, identity] = await Promise.all([
    db
      .prepare("SELECT domain, state, method, verified_at FROM org_domains WHERE org_id = ? ORDER BY domain")
      .bind(orgId)
      .all<{
        domain: string;
        state: "pending" | "verified";
        method: "dns" | "email" | null;
        verified_at: string | null;
      }>(),
    db
      .prepare("SELECT address, state, verified_at FROM org_addresses WHERE org_id = ? ORDER BY address")
      .bind(orgId)
      .all<{ address: string; state: "pending" | "verified"; verified_at: string | null }>(),
    getIdentity(db, orgId),
  ]);
  const challenges = new Map<string, Challenge>();
  if (manage && domainRows.results.some((d) => d.state === "pending")) {
    const res = await api(c, "GET", "/domains");
    if (!res.ok) throw new Error(`domains-read-${res.status}`);
    const read = (await res.json()) as { domains: ({ domain: string } & Partial<Challenge>)[] };
    for (const d of read.domains)
      challenges.set(d.domain, {
        codeExpiresAt: d.codeExpiresAt ?? null,
        lockedUntil: d.lockedUntil ?? null,
        nextCodeAt: d.nextCodeAt ?? null,
      });
  }
  const since = monthStart(now);
  const count = async (sql: string, ...binds: string[]) =>
    (
      await db
        .prepare(sql)
        .bind(...binds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const forDomain = (domain: string) =>
    count(
      "SELECT COUNT(*) AS n FROM cases WHERE org_id = ? AND created_at >= ? AND (forwarded_by LIKE ? OR forwarded_by LIKE ?)",
      orgId,
      since,
      `%@${domain}`,
      `%.${domain}`,
    );
  const forAddress = (address: string) =>
    count(
      "SELECT COUNT(*) AS n FROM cases WHERE org_id = ? AND created_at >= ? AND forwarded_by = ?",
      orgId,
      since,
      address,
    );
  const protectedOn = identity?.effective.on === true;
  const domains: DomainRow[] = domainRows.results.map((d) => ({
    domain: d.domain,
    state: d.state,
    method: d.method,
    verifiedAt: d.verified_at,
    challenge: d.state === "pending" ? (challenges.get(d.domain) ?? null) : null,
    protectedIdentity: d.state === "pending" ? "After verifying" : protectedOn ? "Yes" : "Not set up",
  }));
  const verifiedDomains = domainRows.results.filter((d) => d.state === "verified");
  const addresses: AddressRow[] = [
    ...(await Promise.all(
      verifiedDomains.map(async (d) => ({
        kind: "domain" as const,
        label: `Anyone @${d.domain}`,
        state: "verified" as const,
        verifiedAt: d.verified_at,
        casesThisMonth: await forDomain(d.domain),
      })),
    )),
    ...(await Promise.all(
      addressRows.results.map(async (a) => ({
        kind: "single" as const,
        label: a.address,
        state: a.state,
        verifiedAt: a.verified_at,
        casesThisMonth: await forAddress(a.address),
      })),
    )),
  ];
  return { domains, addresses, domainNames: domainRows.results.map((d) => d.domain) };
}

domainsListRoutes.get(
  "/settings/domains",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    const now = new Date();
    try {
      const [claims, shell, outcome] = await Promise.all([
        readClaims(c, who.org.id, who.manage, now),
        memberShell(c.env.DB, signedIn.user, who.org.id, "domains"),
        outcomeOf(c.env.BETTER_AUTH_SECRET ?? "", who.org.id, new URL(c.req.url)),
      ]);
      return html(
        <DomainsListPage
          shell={shell}
          domains={claims.domains}
          addresses={claims.addresses}
          manage={who.manage}
          outcome={outcome}
        />,
      );
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

// What removing a claim really changes, in words true of this claim and organisation.
async function consequences(
  db: D1Database,
  orgId: string,
  orgName: string,
  kind: "domain" | "address",
  name: string,
): Promise<string[] | null> {
  const identity = await getIdentity(db, orgId);
  const protectedOn = identity?.effective.on === true;
  if (kind === "domain") {
    const claim = await db
      .prepare("SELECT state FROM org_domains WHERE org_id = ? AND domain = ?")
      .bind(orgId, name)
      .first<{ state: string }>();
    if (!claim) return null;
    if (claim.state === "pending") return [`The claim on ${name} is withdrawn. Nothing was accepted because of it.`];
    const verified = (
      await db
        .prepare("SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ? AND state = 'verified'")
        .bind(orgId)
        .first<{ n: number }>()
    )?.n;
    const lines = [
      `Mail from addresses at ${name} will no longer be accepted for ${orgName}, except from an address you proved separately.`,
      "Its verified status and the receiving systems learned for it are forgotten.",
    ];
    if (protectedOn && verified === 1)
      lines.push("It is your only verified domain, so protection of your identity ends until another is verified.");
    return lines;
  }
  const claim = await db
    .prepare("SELECT state FROM org_addresses WHERE org_id = ? AND address = ?")
    .bind(orgId, name)
    .first<{ state: string }>();
  if (!claim) return null;
  if (claim.state === "pending") return [`The claim on ${name} is withdrawn. Nothing was accepted because of it.`];
  const domain = name.split("@")[1] ?? "";
  const domainVerified = await db
    .prepare(
      "SELECT 1 FROM org_domains WHERE org_id = ? AND state = 'verified' AND (? = domain OR ? LIKE '%.' || domain)",
    )
    .bind(orgId, domain, domain)
    .first();
  const lines = [
    domainVerified
      ? `Mail from ${name} is still accepted, because ${domain} is a verified domain of ${orgName}.`
      : `Mail from ${name} will no longer be accepted for ${orgName}.`,
  ];
  if (protectedOn && identity?.financeContact === name)
    lines.push("It is your identity's finance contact, so protection of your identity ends until another is verified.");
  return lines;
}

async function confirmPage(c: Context<GateEnv>, kind: "domain" | "address", raw: string) {
  const signedIn = c.get("signedIn");
  const who = await memberOf(c.env, signedIn);
  if ("refused" in who) return who.refused;
  const secret = c.env.BETTER_AUTH_SECRET ?? "";
  const name = decodeURIComponent(raw).toLowerCase();
  // A claim the reader may not remove is never offered, even by a typed address.
  if (!who.manage) return back(secret, who.org.id, { r: "no-permission" });
  try {
    const shell = await memberShell(c.env.DB, signedIn.user, who.org.id, "domains");
    const lines = await consequences(c.env.DB, who.org.id, shell.organization.name, kind, name);
    if (!lines) return back(secret, who.org.id, { r: "gone", what: name });
    return html(<RemoveConfirm shell={shell} kind={kind} name={name} consequences={lines} />);
  } catch (error) {
    return outage((error as Error).name);
  }
}

domainsListRoutes.get(
  "/settings/domains/remove/:domain{[a-z0-9.-]{3,253}}",
  sessionGate(() => outage("session")),
  (c) => confirmPage(c, "domain", c.req.param("domain")),
);
domainsListRoutes.get(
  "/settings/addresses/remove/:address{[^/]{3,400}}",
  sessionGate(() => outage("session")),
  (c) => confirmPage(c, "address", c.req.param("address")),
);

domainsListRoutes.post(
  "/settings/domains",
  sessionGate(() => outage("session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site, or a post with no origin, changes nothing.
    const origin = new URL(c.env.APP_URL).origin;
    if (c.req.header("origin") !== origin) return new Response("Forbidden", { status: 403, headers: HEADERS });
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const orgId = who.org.id;
    // Not an owner or admin: refused before the body is read, the page drawn with why.
    if (!who.manage) {
      try {
        const [claims, shell] = await Promise.all([
          readClaims(c, orgId, false, new Date()),
          memberShell(c.env.DB, signedIn.user, orgId, "domains"),
        ]);
        return html(
          <DomainsListPage
            shell={shell}
            domains={claims.domains}
            addresses={claims.addresses}
            manage={false}
            outcome={{ r: "no-permission" }}
          />,
          403,
        );
      } catch (error) {
        return outage((error as Error).name);
      }
    }
    // The page's few short fields, read with a bound before parsing: anything larger changes nothing.
    const form = await readSmallForm(c.req.raw, { org: 200, action: 20, domain: 300, target: 400 });
    if (!form) return back(secret, orgId, { r: "refused" });
    const field = (name: string) => form[name] ?? "";
    if (field("org") !== orgId) return back(secret, orgId, { r: "switched" });
    const action = field("action");
    if (!["add", "remove-domain", "remove-address"].includes(action)) return back(secret, orgId, { r: "refused" });
    const redraw = async (status: number, add: { value: string; error: string | null }, outcome: Outcome | null) => {
      const [claims, shell] = await Promise.all([
        readClaims(c, orgId, true, new Date()),
        memberShell(c.env.DB, signedIn.user, orgId, "domains"),
      ]);
      return html(
        <DomainsListPage
          shell={shell}
          domains={claims.domains}
          addresses={claims.addresses}
          manage={true}
          outcome={outcome}
          add={add}
        />,
        status,
      );
    };
    try {
      if (action === "add") {
        const typed = field("domain").trim();
        const res = await api(c, "POST", "/domains", { domain: typed });
        if (res.status === 401)
          return new Response(null, {
            status: 303,
            headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent("/settings/domains")}` },
          });
        const read = (await res.json().catch(() => null)) as { domain?: string; error?: string } | null;
        if (res.ok && read?.domain)
          return new Response(null, {
            status: 303,
            headers: { ...HEADERS, location: `/settings/domains/${encodeURIComponent(read.domain)}` },
          });
        // A refusal the member can act on stays under the field with what they typed; a failure says it could not be
        // confirmed over the stored state, the typed domain kept.
        if (res.status >= 500 || !read?.error) {
          console.log(JSON.stringify({ event: "domains-list", outcome: "add-failed", status: res.status }));
          return await redraw(503, { value: typed, error: null }, { r: "failed", what: typed });
        }
        return await redraw(res.status, { value: typed, error: read.error }, null);
      }
      const kind = action === "remove-domain" ? "domain" : "address";
      const target = field("target").toLowerCase();
      const path =
        kind === "domain" ? `/domains/${encodeURIComponent(target)}` : `/addresses/${encodeURIComponent(target)}`;
      const res = await api(c, "DELETE", path);
      if (res.status === 401)
        return new Response(null, {
          status: 303,
          headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent("/settings/domains")}` },
        });
      if (res.status === 204) return back(secret, orgId, { r: "removed", what: target });
      if (res.status === 404) return back(secret, orgId, { r: "gone", what: target });
      if (res.status === 403) return back(secret, orgId, { r: "no-permission" });
      console.log(JSON.stringify({ event: "domains-list", outcome: "remove-failed", status: res.status }));
      return back(secret, orgId, { r: "failed", what: target });
    } catch (error) {
      console.log(JSON.stringify({ event: "domains-list", outcome: "change-failed", error: (error as Error).name }));
      return back(secret, orgId, { r: "failed" });
    }
  },
);
