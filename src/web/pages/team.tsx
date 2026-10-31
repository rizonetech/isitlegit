// The Team page's routes (D07 T04 §3; design/SPEC.md M7): `GET /team` draws the active organisation's members;
// `GET /team/remove/:memberId` asks before a removal; `POST /team` runs one change (a role, a removal) through Better
// Auth's own HTTP handler with a request built from the member's, so D07 T02's hooks (the member lock, the previous
// role, the audit, the sessions ended, the last-owner rule) run whole, then answers 303 back to `/team` with what
// happened, signed for the organisation and ten minutes (post, redirect, get). A post must come from the app's own origin
// and name the organisation its page was drawn for; anything else changes nothing. The page is ./team-view.tsx.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import {
  mayRemove,
  OUTCOMES,
  type Outcome,
  type Reader,
  RemoveConfirm,
  type Role,
  type TeamMember,
  TeamPage,
} from "./team-view";

export const teamRoutes = new Hono<GateEnv>();

function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "team", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/team" });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });

// A member's role as the page treats it: Better Auth stores a comma list, and the strongest names the row.
export function roleOf(stored: string): Role {
  const roles = stored.split(",").map((r) => r.trim());
  return roles.includes("owner") ? "owner" : roles.includes("admin") ? "admin" : "member";
}

// The organisation's members, joined first first, with each one's newest session's last refresh.
export async function readMembers(db: D1Database, orgId: string): Promise<TeamMember[]> {
  const rows = (
    await db
      .prepare(
        `SELECT m.id AS member_id, m.role, u.id AS user_id, u.name, u.email,
           (SELECT s."updatedAt" FROM "session" s WHERE s."userId" = u.id ORDER BY s."updatedAt" DESC LIMIT 1) AS last
         FROM "member" m JOIN "user" u ON u.id = m."userId"
         WHERE m."organizationId" = ? ORDER BY m."createdAt", m.id`,
      )
      .bind(orgId)
      .all<{
        member_id: string;
        role: string;
        user_id: string;
        name: string;
        email: string;
        last: string | number | null;
      }>()
  ).results;
  return rows.map((r) => ({
    memberId: r.member_id,
    userId: r.user_id,
    name: r.name.trim(),
    email: r.email,
    role: roleOf(r.role),
    lastActive: r.last === null ? null : new Date(typeof r.last === "number" ? r.last : r.last).toISOString(),
  }));
}

// What a change did, carried in the redirect: signed with the auth secret over the organisation, the outcome, the
// member's name and the moment, so the page shows only what a change of this organisation did in the last ten minutes.
const OUTCOME_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`team-result\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const signed = (orgId: string, o: Outcome, at: number) => [orgId, o.r, o.name ?? "", String(at)].join("\n");
async function back(secret: string, orgId: string, outcome: Outcome) {
  const at = Date.now();
  const query = new URLSearchParams({ r: outcome.r });
  if (outcome.name) query.set("n", outcome.name);
  query.set("t", String(at));
  query.set("s", await sign(secret, signed(orgId, outcome, at)));
  return new Response(null, { status: 303, headers: { ...HEADERS, location: `/team?${query}` } });
}
async function outcomeOf(secret: string, orgId: string, url: URL): Promise<Outcome | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const at = Number(q.get("t"));
  if (!r || !(OUTCOMES as readonly string[]).includes(r) || !Number.isFinite(at)) return null;
  if (Date.now() - at > OUTCOME_TTL_MS || at > Date.now() + 60_000) return null;
  const outcome: Outcome = { r: r as Outcome["r"], ...(q.get("n") ? { name: q.get("n") ?? "" } : {}) };
  return q.get("s") === (await sign(secret, signed(orgId, outcome, at))) ? outcome : null;
}

// A change that failed or whose answer was lost: its reference logged, the page redrawn with it named as unconfirmed.
function failed(secret: string, orgId: string, why: string, name?: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "team", outcome: "change-failed", reference: ref, error: why }));
  return back(secret, orgId, { r: "failed", ...(name ? { name } : {}) });
}

// The signed-in member of the active organisation, or the page that refuses them.
async function memberOf(env: Env, signedIn: SignedIn) {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage("membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email }) };
  return { org: membership.org };
}

teamRoutes.get(
  "/team",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    try {
      const [members, shell, outcome] = await Promise.all([
        readMembers(c.env.DB, who.org.id),
        memberShell(c.env.DB, signedIn.user, who.org.id, "team"),
        outcomeOf(c.env.BETTER_AUTH_SECRET ?? "", who.org.id, new URL(c.req.url)),
      ]);
      const reader: Reader = { userId: signedIn.user.id, role: roleOf(who.org.role) };
      const lost = new URL(c.req.url).searchParams.get("unanswered") === "1";
      return html(
        <TeamPage shell={shell} members={members} reader={reader} outcome={outcome} lost={lost} now={new Date()} />,
      );
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

// A member id as Better Auth mints it (letters, digits, '-' and '_'), so the route claims no other path.
teamRoutes.get(
  "/team/remove/:memberId{[A-Za-z0-9_-]{1,64}}",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    try {
      const [members, shell] = await Promise.all([
        readMembers(c.env.DB, who.org.id),
        memberShell(c.env.DB, signedIn.user, who.org.id, "team"),
      ]);
      const member = members.find((m) => m.memberId === c.req.param("memberId"));
      // Not a member of this organisation (removed meanwhile, or another's): the page says so, nothing asked.
      if (!member) return back(secret, who.org.id, { r: "gone" });
      // A removal the reader may not make (a member, an admin and an owner, their own row) is never offered, even by a
      // typed address: the page says so instead.
      const reader: Reader = { userId: signedIn.user.id, role: roleOf(who.org.role) };
      if (!mayRemove(reader, member)) return back(secret, who.org.id, { r: "no-permission" });
      return html(<RemoveConfirm shell={shell} member={member} />);
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

// Better Auth's refusal of a change, as the page words it.
async function answerOf(res: Response): Promise<Outcome["r"] | "signin" | "failed"> {
  if (res.status === 401) return "signin";
  if (res.status === 409) return "locked";
  if (res.status >= 500) return "failed";
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  const code = `${body?.code ?? ""} ${body?.message ?? ""}`.toUpperCase();
  if (/WITHOUT.AN.OWNER|LAST.OWNER|ONLY.OWNER/.test(code)) return "last-owner";
  if (/NOT.FOUND|MEMBER_NOT/.test(code) || res.status === 404) return "gone";
  return "no-permission";
}

teamRoutes.post(
  "/team",
  sessionGate(() => outage("session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site, or a post with no origin, changes nothing.
    const origin = new URL(c.env.APP_URL).origin;
    if (c.req.header("origin") !== origin) return new Response("Forbidden", { status: 403, headers: HEADERS });
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    const form = await c.req.formData().catch(() => null);
    const field = (name: string) => {
      const value = form?.get(name);
      return typeof value === "string" ? value : "";
    };
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const orgId = who.org.id;
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (field("org") !== orgId) return back(secret, orgId, { r: "switched" });
    // A member changes nothing on the team: refused outright (403), the page drawn with why.
    if (roleOf(who.org.role) === "member") {
      try {
        const [members, shell] = await Promise.all([
          readMembers(c.env.DB, orgId),
          memberShell(c.env.DB, signedIn.user, orgId, "team"),
        ]);
        const reader: Reader = { userId: signedIn.user.id, role: "member" };
        return html(
          <TeamPage
            shell={shell}
            members={members}
            reader={reader}
            outcome={{ r: "no-permission" }}
            now={new Date()}
          />,
          403,
        );
      } catch (error) {
        return outage((error as Error).name);
      }
    }
    const action = field("action");
    const role = field("role");
    // Not a request this page sends (an unknown action, a role that does not exist): refused, nothing claimed.
    if (action !== "remove" && !(action === "role" && ["owner", "admin", "member"].includes(role)))
      return back(secret, orgId, { r: "refused" });
    try {
      const members = await readMembers(c.env.DB, orgId);
      const target = members.find((m) => m.memberId === field("member"));
      if (!target) return back(secret, orgId, { r: "gone" });
      const name = target.name || target.email;
      if (action === "role" && target.role === role) return back(secret, orgId, { r: "unchanged", name });
      // Better Auth's own handler, with the member's cookie and the app's origin, so its hooks run as for any request.
      const path = action === "role" ? "update-member-role" : "remove-member";
      const body =
        action === "role"
          ? { memberId: target.memberId, role, organizationId: orgId }
          : { memberIdOrEmail: target.memberId, organizationId: orgId };
      const headers = new Headers({ "content-type": "application/json", origin });
      for (const name of ["cookie", "cf-connecting-ip", "user-agent"]) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      const res = await createAuth(c.env).handler(
        new Request(`${origin}/api/auth/organization/${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
      );
      if (res.ok) return back(secret, orgId, { r: action === "role" ? "role-changed" : "removed", name });
      const answer = await answerOf(res);
      if (answer === "signin")
        return new Response(null, {
          status: 303,
          headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent("/team")}` },
        });
      // A failure or an uncertain answer: logged, and the page redrawn from the stored state with the change named as
      // unconfirmed, never as done. A notice, not the 503 page, so htmx draws it in place as it draws every answer.
      if (answer === "failed") return failed(secret, orgId, `auth-${res.status}`, name);
      // Better Auth names an admin's refused removal of the only owner as the last-owner rule; to the admin it is a
      // permission they lack, and the guard's words are the owner's own.
      const said = answer === "last-owner" && roleOf(who.org.role) !== "owner" ? "no-permission" : answer;
      return back(secret, orgId, { r: said, name });
    } catch (error) {
      return failed(secret, orgId, (error as Error).name);
    }
  },
);
