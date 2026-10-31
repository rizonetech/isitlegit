// The invitation page's routes (D07 T02 §14): `GET /invite/:id` reads the invitation with its organisation and inviter
// and answers for who is here; `POST /invite/:id` accepts or declines it for the signed-in invitee only, from the app's
// own origin, through Better Auth's own invitation endpoints (whose accept hook records the one use, src/auth/auth.ts,
// migration 0012). Accepting makes the joined organisation the session's active one and lands on the Cases list. Every
// answer is private, unindexed and keeps the invitation's address from other sites; a read or write that fails is said
// as one, never as a success. The page is src/web/pages/invite.tsx.
import { Hono } from "hono";
import { errorPage, reference } from "../web/pages/errors";
import { type InvitationView, InvitePage, type InviteState } from "../web/pages/invite";
import { createAuth } from "./auth";
import { readSmallForm } from "./form";

export const INVITE_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
  "referrer-policy": "same-origin",
  "content-type": "text/html; charset=utf-8",
};

type Row = {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
  organizationId: string;
  organization: string;
  inviter: string;
  used: number;
  // Whether the invited address is a member of the organisation now: an acceptance is complete only with it.
  joined: number;
};

export const invitationRoutes = new Hono<{ Bindings: Env }>();

const page = (state: InviteState, status = 200, cookies: string[] = []) => {
  const out = new Response(String(<InvitePage state={state} />), { status, headers: INVITE_HEADERS });
  for (const cookie of cookies) out.headers.append("set-cookie", cookie);
  return out;
};
function outage(why: string, retry: string, cookies: string[] = []) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "invitation", outcome: "unavailable", reference: ref, error: why }));
  const out = errorPage(500, "", { ref, retry });
  for (const [name, value] of Object.entries(INVITE_HEADERS)) out.headers.set(name, value);
  for (const cookie of cookies) out.headers.append("set-cookie", cookie);
  return out;
}

async function readInvitation(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT i.id, i.email, i.role, i.status, i."expiresAt" AS expiresAt, i."organizationId" AS organizationId,
         o.name AS organization, COALESCE(NULLIF(trim(u.name), ''), u.email) AS inviter,
         (SELECT COUNT(*) FROM invitation_uses WHERE invitation_id = i.id) AS used,
         (SELECT COUNT(*) FROM "member" m JOIN "user" mu ON mu.id = m."userId"
           WHERE m."organizationId" = i."organizationId" AND lower(mu.email) = lower(i.email)) AS joined
       FROM invitation i JOIN "organization" o ON o.id = i."organizationId" JOIN "user" u ON u.id = i."inviterId"
       WHERE i.id = ?`,
    )
    .bind(id)
    .first<Row>();
}
const viewOf = (row: Row): InvitationView => ({
  id: row.id,
  organizationId: row.organizationId,
  organization: row.organization,
  inviter: row.inviter,
  email: row.email,
  role: row.role ?? "member",
  expiresAt: new Date(row.expiresAt).toISOString(),
});
// An invitation that can no longer be used, as its state. A membership of the invited address is joined whatever the
// status says (Better Auth puts an acceptance whose activation failed back to pending, with the membership kept);
// then Better Auth's status, its expiry, and a use recorded with no membership after it (an acceptance interrupted
// between its writes, §3, whether or not the status says accepted).
function closedState(row: Row): InviteState | null {
  const invitation = viewOf(row);
  if (row.joined > 0) return { kind: "accepted", invitation };
  if (row.status === "accepted") return { kind: "unfinished", invitation };
  if (row.status === "rejected") return { kind: "declined", invitation };
  if (row.status === "canceled") return { kind: "revoked", invitation };
  if (row.used > 0) return { kind: "unfinished", invitation };
  if (Date.parse(invitation.expiresAt) <= Date.now()) return { kind: "expired", invitation };
  return null;
}
// Whether the invited address already has a passkey, so the invitation offers it (D07 T02 §16): only the invitation's
// holder sees the answer, and the email link stays for everyone.
const hasPasskey = async (db: D1Database, email: string) =>
  (await db
    .prepare(
      `SELECT 1 AS found FROM "passkey" p JOIN "user" u ON u.id = p."userId" WHERE lower(u.email) = lower(?) LIMIT 1`,
    )
    .bind(email)
    .first()) !== null;
const sessionOf = async (env: Env, request: Request) =>
  createAuth(env).api.getSession({ headers: request.headers, returnHeaders: true });

invitationRoutes.get("/invite/:id", async (c) => {
  const id = c.req.param("id").slice(0, 200);
  const path = `/invite/${encodeURIComponent(id)}`;
  let cookies: string[] = [];
  try {
    const read = await sessionOf(c.env, c.req.raw);
    cookies = read.headers.getSetCookie();
    const row = await readInvitation(c.env.DB, id);
    if (!row) return page({ kind: "unknown" }, 404, cookies);
    const email = read.response?.user.email;
    const invitee = email?.toLowerCase() === row.email.toLowerCase();
    const closed = closedState(row);
    // Accepted: its member opens that organisation in one press; anyone else signs in as the invited address, back here.
    if (closed?.kind === "accepted")
      return page({ kind: "accepted", invitation: closed.invitation, member: invitee }, 200, cookies);
    if (closed) return page(closed, 200, cookies);
    const invitation = viewOf(row);
    if (!email)
      return page({ kind: "signed-out", invitation, passkey: await hasPasskey(c.env.DB, row.email) }, 200, cookies);
    if (!invitee) {
      const failed = new URL(c.req.url).searchParams.get("signout") === "failed";
      return page(
        {
          kind: "someone-else",
          invitation,
          signedInAs: email,
          ...(failed ? { problem: "Signing out did not finish. Press Sign out again in a moment." } : {}),
        },
        200,
        cookies,
      );
    }
    return page({ kind: "invitee", invitation, signedInAs: email }, 200, cookies);
  } catch (error) {
    return outage((error as Error).name, path, cookies);
  }
});

invitationRoutes.post("/invite/:id", async (c) => {
  if (c.req.header("origin") !== new URL(c.env.APP_URL).origin)
    return new Response("Forbidden", { status: 403, headers: INVITE_HEADERS });
  const id = c.req.param("id").slice(0, 200);
  const path = `/invite/${encodeURIComponent(id)}`;
  const form = await readSmallForm(c.req.raw, { action: 16 });
  if (!form) return new Response("Request too large", { status: 413, headers: INVITE_HEADERS });
  const action = form.action;
  let cookies: string[] = [];
  let row: Row | null;
  let email: string | undefined;
  try {
    const read = await sessionOf(c.env, c.req.raw);
    cookies = read.headers.getSetCookie();
    email = read.response?.user.email;
    row = await readInvitation(c.env.DB, id);
  } catch (error) {
    return outage((error as Error).name, path, cookies);
  }
  if (!row) return page({ kind: "unknown" }, 404, cookies);
  const closed = closedState(row);
  if (closed?.kind === "accepted")
    return page(
      { kind: "accepted", invitation: closed.invitation, member: email?.toLowerCase() === row.email.toLowerCase() },
      409,
      cookies,
    );
  if (closed) return page(closed, 409, cookies);
  const invitation = viewOf(row);
  // Only the invitee acts: signed out, or signed in as someone else, changes nothing.
  if (!email) return page({ kind: "signed-out", invitation }, 401, cookies);
  if (email.toLowerCase() !== row.email.toLowerCase())
    return page({ kind: "someone-else", invitation, signedInAs: email }, 403, cookies);
  const auth = createAuth(c.env);
  const headers = c.req.raw.headers;
  // Joined: the organisation made active and on to its Cases list; if it cannot be made active, the page says the
  // member has joined and offers to open it, never a Cases list of another organisation.
  const invited = row;
  const joined = async () => {
    const active = await auth.api
      .setActiveOrganization({ headers, body: { organizationId: invited.organizationId }, returnHeaders: true })
      .catch(() => null);
    if (!active) return page({ kind: "accepted", invitation: viewOf(invited), member: true }, 200, cookies);
    const out = new Response(null, { status: 303, headers: { ...INVITE_HEADERS, location: "/cases" } });
    for (const cookie of [...cookies, ...active.headers.getSetCookie()]) out.headers.append("set-cookie", cookie);
    return out;
  };
  try {
    if (action === "decline") {
      await auth.api.rejectInvitation({ headers, body: { invitationId: id } });
      return page({ kind: "declined", invitation }, 200, cookies);
    }
    if (action !== "accept") return page({ kind: "invitee", invitation, signedInAs: email }, 400, cookies);
    await auth.api.acceptInvitation({ headers, body: { invitationId: id } });
    return await joined();
  } catch (error) {
    // Refused or failed: what the invitation is now decides the answer. Read back: still pending and unused is truly
    // "nothing changed"; joined goes on; any other state is said; and an answer that cannot be read back claims nothing.
    console.log(JSON.stringify({ event: "invitation", outcome: "not-finished", error: (error as Error).name }));
    const after = await readInvitation(c.env.DB, id).catch(() => null);
    if (!after)
      return page(
        {
          kind: "invitee",
          invitation,
          signedInAs: email,
          problem: "We could not tell whether that finished. Open the invitation again to see where it stands.",
          recheck: true,
        },
        503,
        cookies,
      );
    const now = closedState(after);
    // Joined after all (a decline refused because an acceptance won, or an acceptance whose own activation failed).
    if (now?.kind === "accepted") return await joined();
    if (now) return page(now, 409, cookies);
    return page(
      {
        kind: "invitee",
        invitation,
        signedInAs: email,
        problem: "That did not finish just now. Nothing changed: press it again in a moment.",
      },
      503,
      cookies,
    );
  }
});
