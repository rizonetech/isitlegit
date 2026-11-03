// The Team page's routes (D07 T04 §3; design/SPEC.md M7): `GET /team` draws the active organisation's members;
// `GET /team/remove/:memberId` asks before a removal; `POST /team` runs one change (a role, a removal) through Better
// Auth's own HTTP handler with a request built from the member's, so D07 T02's hooks (the member lock, the previous
// role, the audit, the sessions ended, the last-owner rule) run whole, then answers 303 back to `/team` with what
// happened, signed for the organisation and ten minutes (post, redirect, get). A post must come from the app's own origin
// and name the organisation its page was drawn for; anything else changes nothing. The page is ./team-view.tsx.
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readSmallForm } from "../../auth/form";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { isProtectedAccount, PROTECTED_ACCOUNT } from "../../auth/protected";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import {
  type InviteBatch,
  type InviteDraft,
  inviteRoles,
  mayRemove,
  OUTCOMES,
  type Outcome,
  type PendingInvite,
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

// The organisation's pending invitations, newest first, each with the delivery of its current send read from the stored
// send record (`mail_sends`, key `invite:<id>:<expiry as ISO>`, src/auth/auth.ts): `sent` only on a confirmed send, a
// send that may have gone is `unknown`, and a failed or missing one is `not-sent`.
const asIso = (value: string | number): string => new Date(typeof value === "number" ? value : value).toISOString();
export async function readInvitations(db: D1Database, orgId: string): Promise<PendingInvite[]> {
  const rows = (
    await db
      .prepare(
        `SELECT i.id, i.email, i.role, i."createdAt" AS created, i."expiresAt" AS expires, u.name AS inviter
         FROM "invitation" i LEFT JOIN "user" u ON u.id = i."inviterId"
         WHERE i."organizationId" = ? AND i.status = 'pending' ORDER BY i."createdAt" DESC, i.id`,
      )
      .bind(orgId)
      .all<{
        id: string;
        email: string;
        role: string | null;
        created: string | number;
        expires: string | number;
        inviter: string | null;
      }>()
  ).results;
  if (!rows.length) return [];
  const keys = rows.map((r) => `invite:${r.id}:${asIso(r.expires)}`);
  // D1 binds at most 100 values to one statement: the sends are read in chunks, however many invitations pile up.
  const status = new Map<string, string>();
  for (let from = 0; from < keys.length; from += 50) {
    const chunk = keys.slice(from, from + 50);
    const sends = (
      await db
        .prepare(`SELECT send_key, status FROM mail_sends WHERE send_key IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ send_key: string; status: string }>()
    ).results;
    for (const r of sends) status.set(r.send_key, r.status);
  }
  // A lapsed invitation is not listed beside a newer one for the same address (a renewal whose cancelling of the old
  // one did not finish): the newer one is the one to manage.
  const now = Date.now();
  const live = new Set(rows.filter((r) => Date.parse(asIso(r.expires)) >= now).map((r) => r.email.toLowerCase()));
  return rows.flatMap((r, n) => {
    if (Date.parse(asIso(r.expires)) < now && live.has(r.email.toLowerCase())) return [];
    const sent = status.get(keys[n] as string);
    return [
      {
        id: r.id,
        email: r.email,
        role: roleOf(r.role ?? "member"),
        createdAt: asIso(r.created),
        expiresAt: asIso(r.expires),
        inviter: r.inviter?.trim() || null,
        delivery: (sent === "sent" ? "sent" : sent === "uncertain" || sent === "pending" ? "unknown" : "not-sent") as
          | "sent"
          | "unknown"
          | "not-sent",
      },
    ];
  });
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
// The longest name an outcome carries: the address stays far inside Cloudflare's URL limit whatever a member named
// themselves (a profile name is not bounded where it is written; the app lane is told).
export const OUTCOME_NAME_LIMIT = 80;
const boundedName = (name: string) => {
  const chars = Array.from(name);
  return chars.length > OUTCOME_NAME_LIMIT ? `${chars.slice(0, OUTCOME_NAME_LIMIT - 1).join("")}…` : name;
};
async function back(secret: string, orgId: string, given: Outcome) {
  const outcome: Outcome = given.name ? { ...given, name: boundedName(given.name) } : given;
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
      const reader: Reader = { userId: signedIn.user.id, role: roleOf(who.org.role) };
      const [members, shell, outcome, invites] = await Promise.all([
        readMembers(c.env.DB, who.org.id),
        memberShell(c.env.DB, signedIn.user, who.org.id, "team"),
        outcomeOf(c.env.BETTER_AUTH_SECRET ?? "", who.org.id, new URL(c.req.url)),
        reader.role === "member" ? Promise.resolve([]) : readInvitations(c.env.DB, who.org.id),
      ]);
      const lost = new URL(c.req.url).searchParams.get("unanswered") === "1";
      return html(
        <TeamPage
          shell={shell}
          members={members}
          reader={reader}
          outcome={outcome}
          lost={lost}
          invites={invites}
          now={new Date()}
        />,
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
      // A protected account is not asked about: the page says it cannot be removed (only a reader who could remove
      // anyone else gets here, so nothing is told to those who could not).
      if (isProtectedAccount(member.email))
        return back(secret, who.org.id, { r: "protected", name: member.name || member.email });
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
  if (code.includes(PROTECTED_ACCOUNT)) return "protected";
  if (/WITHOUT.AN.OWNER|LAST.OWNER|ONLY.OWNER/.test(code)) return "last-owner";
  if (/NOT.FOUND|MEMBER_NOT/.test(code) || res.status === 404) return "gone";
  return "no-permission";
}

type InviteAction = {
  action: "invite" | "resend" | "revoke";
  who: { org: { id: string; role: string } };
  signedIn: SignedIn;
  secret: string;
  orgId: string;
  origin: string;
  form: { email: string; role: string; id: string; batch?: string };
};

// An invitation made, sent again or revoked through Better Auth's own handler (its hooks, allowlist and send key run as
// for any request), then answered from the stored state: a refusal the member can act on is the field's error with the
// address kept, a stale row says it is no longer pending, and a failure or a lost answer is never shown as done.
async function invitation(c: Context<GateEnv>, a: InviteAction) {
  const { action, signedIn, secret, orgId, origin } = a;
  const reader: Reader = { userId: signedIn.user.id, role: roleOf(a.who.org.role) };
  const call = (path: string, body: object) => {
    const headers = new Headers({ "content-type": "application/json", origin });
    for (const name of ["cookie", "cf-connecting-ip", "user-agent"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    return createAuth(c.env).handler(
      new Request(`${origin}/api/auth/organization/${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  };
  const signin = () =>
    new Response(null, {
      status: 303,
      headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent("/team")}` },
    });
  // The page redrawn with the panel's refusal under the address, from the stored state.
  const refuse = async (draft: InviteDraft, status: number) => {
    const [members, shell, invites] = await Promise.all([
      readMembers(c.env.DB, orgId),
      memberShell(c.env.DB, signedIn.user, orgId, "team"),
      readInvitations(c.env.DB, orgId),
    ]);
    return html(
      <TeamPage
        shell={shell}
        members={members}
        reader={reader}
        outcome={null}
        invites={invites}
        draft={draft}
        now={new Date()}
      />,
      status,
    );
  };
  try {
    if (action === "invite") {
      // Several addresses at once (D07 T04 §22): split on commas or lines, trim, drop empties, and invite a
      // case-insensitive duplicate once. More than one address (or a Retry, marked `batch`) takes the batch
      // answer below; one address keeps the flow after it, word for word.
      const parts = a.form.email
        .split(/[,\n]/)
        .map((x) => x.trim())
        .filter(Boolean);
      const seen = new Set<string>();
      const addresses: string[] = [];
      const duplicates = new Set<string>();
      for (const part of parts) {
        const key = part.toLowerCase();
        if (seen.has(key)) duplicates.add(key);
        else {
          seen.add(key);
          addresses.push(part);
        }
      }
      if (parts.length > 1 || a.form.batch === "1") {
        const role = a.form.role;
        const draft = (error: string): InviteDraft => ({
          email: a.form.email,
          role: (inviteRoles(reader) as string[]).includes(role) ? (role as InviteDraft["role"]) : "member",
          error,
        });
        if (!(inviteRoles(reader) as string[]).includes(role))
          return await refuse(draft("Choose a role you can give."), 400);
        if (addresses.length > 20)
          return await refuse(draft("Up to 20 addresses at a time. Remove some and try again."), 400);
        if (!addresses.length) return await refuse(draft("Enter the email addresses to invite."), 400);
        const [memberRows, pendingRows] = await Promise.all([
          readMembers(c.env.DB, orgId),
          readInvitations(c.env.DB, orgId),
        ]);
        const memberEmails = new Set(memberRows.map((m) => m.email.toLowerCase()));
        const pendingByEmail = new Map(pendingRows.map((i) => [i.email.toLowerCase(), i] as const));
        const results: InviteBatch["results"] = [];
        const retry: string[] = [];
        let stopped: string | null = null;
        for (const email of addresses) {
          const dup = duplicates.has(email.toLowerCase()) ? "Listed twice, invited once." : undefined;
          if (stopped) {
            results.push({ email, word: "Not invited", detail: stopped });
            continue;
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            results.push({ email, word: "Refused", detail: "Enter a real email address." });
            continue;
          }
          if (memberEmails.has(email.toLowerCase())) {
            results.push({ email, word: "Refused", detail: "That person is already a member of this organisation." });
            continue;
          }
          const heldRow = pendingByEmail.get(email.toLowerCase());
          const held = heldRow?.delivery;
          if (held === "sent") {
            results.push({ email, word: "Refused", detail: "That address already has an invitation below." });
            continue;
          }
          if (held === "unknown") {
            results.push({
              email,
              word: "Unknown",
              detail: "Its invitation is below; whether its email went is not known.",
            });
            continue;
          }
          if (held === "not-sent" && heldRow && !(inviteRoles(reader) as string[]).includes(heldRow.role)) {
            results.push({ email, word: "Refused", detail: "That invitation has a role you cannot give." });
            continue;
          }
          if (held === "not-sent" && heldRow && heldRow.role !== role) {
            results.push({
              email,
              word: "Refused",
              detail: `That invitation was made with a different role (${heldRow.role}). Send it again from the list below.`,
            });
            continue;
          }
          const startedAt = new Date().toISOString();
          let res: Response | null = null;
          try {
            res = await call("invite-member", {
              email,
              role: held === "not-sent" && heldRow ? heldRow.role : role,
              organizationId: orgId,
              ...(held === "not-sent" ? { resend: true } : {}),
            });
          } catch {
            res = null;
          }
          if (held === "not-sent" && heldRow && (res?.ok || res?.status === 502)) {
            const nowRow = await c.env.DB.prepare(`SELECT status FROM "invitation" WHERE id = ?`)
              .bind(heldRow.id)
              .first<{ status: string }>();
            const spent =
              nowRow?.status !== "pending" &&
              (await c.env.DB.prepare(`SELECT 1 AS spent FROM invitation_uses WHERE invitation_id = ?`)
                .bind(heldRow.id)
                .first());
            if (nowRow?.status !== "pending" && !spent) {
              const made = await c.env.DB.prepare(
                `SELECT id FROM "invitation" WHERE "organizationId" = ? AND lower(email) = lower(?) AND status = 'pending' AND id <> ? AND "createdAt" >= ?`,
              )
                .bind(orgId, email, heldRow.id, startedAt)
                .all<{ id: string }>();
              let tidied = true;
              for (const m of made.results) {
                const cancelled = await call("cancel-invitation", { invitationId: m.id }).catch(() => null);
                if (!cancelled?.ok) tidied = false;
              }
              if (!tidied) console.log(JSON.stringify({ event: "team", outcome: "revoked-not-tidied", email }));
              results.push(
                tidied
                  ? { email, word: "Refused", detail: "That invitation was revoked while this was sending." }
                  : {
                      email,
                      word: "Unknown",
                      detail:
                        "It was revoked while this was sending, and tidying up did not finish. Check the invitations below.",
                    },
              );
              continue;
            }
          }
          if (res?.ok) {
            results.push({ email, word: "Sent", ...(dup ? { detail: dup } : {}) });
            pendingByEmail.set(email.toLowerCase(), {
              ...(heldRow ?? ({} as PendingInvite)),
              delivery: "sent",
            } as PendingInvite);
          } else if (res?.status === 401) return signin();
          else if (res?.status === 502) {
            // A 502 covers both a confirmed refusal and a lost answer (the auth hook's own mapping): the stored
            // delivery decides which one this was before it is named or retried.
            const now = await readInvitations(c.env.DB, orgId);
            const heldNow = now.find((i) => i.email.toLowerCase() === email.toLowerCase());
            if (heldNow?.delivery === "unknown") {
              results.push({
                email,
                word: "Unknown",
                detail: "The invitation was made; check it below before sending again.",
              });
              pendingByEmail.set(email.toLowerCase(), heldNow);
            } else {
              results.push({ email, word: "Not sent", detail: "The invitation stands below; its email did not go." });
              retry.push(email);
              if (heldNow) pendingByEmail.set(email.toLowerCase(), heldNow);
            }
          } else if (res?.status === 403) {
            const said = (await res
              .clone()
              .json()
              .catch(() => null)) as { code?: string; message?: string } | null;
            if (/INVITATION.LIMIT/i.test(`${said?.code ?? ""} ${said?.message ?? ""}`)) {
              results.push({
                email,
                word: "Refused",
                detail: "This organisation has too many open invitations. Revoke one, or wait for one to lapse.",
              });
              stopped = "Not tried: too many open invitations.";
            } else {
              results.push({ email, word: "Refused", detail: "You can no longer change the team." });
              stopped = "Not tried: the batch stopped.";
            }
          } else if (res?.status === 429) {
            results.push({
              email,
              word: "Refused",
              detail: "Too many invitations just now. Try again in a little while.",
            });
            stopped = "Not tried: too many invitations just now.";
          } else if (res === null || res.status >= 500) {
            // The answer was lost: what storage holds decides whether Retry may send this one again.
            const now = await readInvitations(c.env.DB, orgId);
            if (now.some((i) => i.email.toLowerCase() === email.toLowerCase())) {
              results.push({
                email,
                word: "Unknown",
                detail: "The invitation was made; check it below before sending again.",
              });
              pendingByEmail.set(
                email.toLowerCase(),
                now.find((i) => i.email.toLowerCase() === email.toLowerCase()) ?? heldRow!,
              );
            } else {
              results.push({
                email,
                word: "Unknown",
                detail: "We could not tell whether it went. Retry sends it again.",
              });
              retry.push(email);
            }
          } else {
            const said = (await res
              .clone()
              .json()
              .catch(() => null)) as { code?: string; message?: string } | null;
            const text = `${said?.code ?? ""} ${said?.message ?? ""}`.toUpperCase();
            results.push({
              email,
              word: "Refused",
              detail: /ALREADY.*MEMBER/.test(text)
                ? "That person is already a member of this organisation."
                : "That address cannot be invited.",
            });
          }
        }
        const [members, shell, invites] = await Promise.all([
          readMembers(c.env.DB, orgId),
          memberShell(c.env.DB, signedIn.user, orgId, "team"),
          readInvitations(c.env.DB, orgId),
        ]);
        return html(
          <TeamPage
            shell={shell}
            members={members}
            reader={reader}
            outcome={null}
            invites={invites}
            inviteBatch={{ role: role as InviteBatch["role"], results, retry }}
            now={new Date()}
          />,
          200,
        );
      }
      const email = addresses[0] ?? a.form.email.trim();
      const role = a.form.role;
      const draft = (error: string): InviteDraft => ({
        email,
        role: (inviteRoles(reader) as string[]).includes(role) ? (role as InviteDraft["role"]) : "member",
        error,
      });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return await refuse(draft("Enter the email address to invite."), 400);
      if (!(inviteRoles(reader) as string[]).includes(role))
        return await refuse(draft("Choose a role you can give."), 400);
      const res = await call("invite-member", { email, role, organizationId: orgId });
      if (res.ok) return back(secret, orgId, { r: "invited", name: email });
      if (res.status === 401) return signin();
      if (res.status === 502) return back(secret, orgId, { r: "invite-unsent", name: email });
      if (res.status === 403) {
        const said = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
        if (/INVITATION.LIMIT/i.test(`${said?.code ?? ""} ${said?.message ?? ""}`))
          return await refuse(
            draft(
              "This organisation has too many open invitations. Revoke one, or wait for one to lapse, then invite again.",
            ),
            403,
          );
        return back(secret, orgId, { r: "no-permission" });
      }
      if (res.status === 429)
        return await refuse(draft("Too many invitations just now. Try again in a little while."), 429);
      if (res.status >= 500) return failed(secret, orgId, `invite-${res.status}`, email);
      const said = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      const text = `${said?.code ?? ""} ${said?.message ?? ""}`.toUpperCase();
      return await refuse(
        draft(
          /ALREADY.*MEMBER/.test(text)
            ? "That person is already a member of this organisation."
            : "That address cannot be invited.",
        ),
        400,
      );
    }
    // Resend and Revoke act on a stored pending invitation of this organisation, or say it is no longer pending.
    const row = await c.env.DB.prepare(
      `SELECT id, email, role, "expiresAt" AS expires FROM "invitation" WHERE id = ? AND "organizationId" = ? AND status = 'pending'`,
    )
      .bind(a.form.id, orgId)
      .first<{ id: string; email: string; role: string | null; expires: string | number }>();
    if (!row) return back(secret, orgId, { r: "invite-gone" });
    // Better Auth does not count a lapsed invitation as one already made, so sending it again makes a new one beside it.
    // The new one is made first and the lapsed one cancelled after: a failure in between leaves the lapsed row to try
    // again from, never an organisation with no invitation to manage (the list shows only the newer one meanwhile).
    const lapsed = action === "resend" && Date.parse(asIso(row.expires)) < Date.now();
    const startedAt = new Date().toISOString();
    const res =
      action === "resend"
        ? await call("invite-member", {
            email: row.email,
            role: roleOf(row.role ?? "member"),
            organizationId: orgId,
            resend: !lapsed,
          })
        : await call("cancel-invitation", { invitationId: row.id });
    // Better Auth finds an invitation by its address, so a resend that reached it after another admin revoked this one
    // would make a fresh invitation and undo the revocation. It offers no atomic form of the two, so the outcome is
    // checked: the selected invitation no longer pending means it was revoked or answered meanwhile, and any invitation
    // this call made for the address is cancelled again, so the revocation holds and the page says it was gone.
    if (action === "resend" && (res.ok || res.status === 502)) {
      const now = await c.env.DB.prepare(`SELECT status FROM "invitation" WHERE id = ?`)
        .bind(row.id)
        .first<{ status: string }>();
      // An invitation spent by an acceptance that did not finish is cancelled by the auth hook on purpose, so that a fresh
      // one is made (src/auth/auth.ts, invitation_uses): that replacement is the recovery, not a revocation undone.
      const spent =
        now?.status !== "pending" &&
        (await c.env.DB.prepare(`SELECT 1 AS spent FROM invitation_uses WHERE invitation_id = ?`).bind(row.id).first());
      if (now?.status !== "pending" && !spent) {
        const made = await c.env.DB.prepare(
          `SELECT id FROM "invitation" WHERE "organizationId" = ? AND lower(email) = lower(?) AND status = 'pending' AND id <> ? AND "createdAt" >= ?`,
        )
          .bind(orgId, row.email, row.id, startedAt)
          .all<{ id: string }>();
        for (const m of made.results) await call("cancel-invitation", { invitationId: m.id }).catch(() => null);
        return back(secret, orgId, { r: "invite-gone", name: row.email });
      }
    }
    if (lapsed && (res.ok || res.status === 502)) {
      const cancelled = await call("cancel-invitation", { invitationId: row.id }).catch(() => null);
      if (!cancelled?.ok)
        console.log(JSON.stringify({ event: "team", outcome: "lapsed-not-cancelled", status: cancelled?.status ?? 0 }));
    }
    if (res.ok) return back(secret, orgId, { r: action === "resend" ? "resent" : "revoked", name: row.email });
    if (res.status === 401) return signin();
    if (res.status === 502 && action === "resend") return back(secret, orgId, { r: "invite-unsent", name: row.email });
    if (res.status === 403) {
      const said = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      if (/INVITATION.LIMIT/i.test(`${said?.code ?? ""} ${said?.message ?? ""}`))
        return back(secret, orgId, { r: "invite-limit", name: row.email });
      return back(secret, orgId, { r: "no-permission" });
    }
    if (res.status === 404 || res.status === 400) return back(secret, orgId, { r: "invite-gone", name: row.email });
    return failed(secret, orgId, `invite-${res.status}`, row.email);
  } catch (error) {
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "team", outcome: "invite-failed", reference: ref, error: (error as Error).name }),
    );
    return back(secret, orgId, { r: "invite-failed", name: a.form.email.trim() });
  }
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
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const orgId = who.org.id;
    // A member changes nothing on the team, refused before the body is read. A plain post is answered 403 with the page
    // and why; an htmx post with the same notice as a redirect, since htmx draws no 4xx answer and the app script would
    // turn it into "may not have reached us".
    if (roleOf(who.org.role) === "member") {
      if (c.req.header("hx-request") === "true") return back(secret, orgId, { r: "no-permission" });
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
    // The page's own few short fields, read with a bound before parsing (src/auth/form.ts): anything larger changes
    // nothing.
    const form = await readSmallForm(c.req.raw, {
      org: 200,
      action: 20,
      member: 200,
      role: 20,
      email: 7000,
      batch: 20,
      invitation: 200,
    });
    if (!form) return back(secret, orgId, { r: "refused" });
    const field = (name: string) => form[name] ?? "";
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (field("org") !== orgId) return back(secret, orgId, { r: "switched" });
    const action = field("action");
    const role = field("role");
    if (action === "invite" || action === "resend" || action === "revoke")
      return invitation(c, {
        action,
        who,
        signedIn,
        secret,
        orgId,
        origin,
        form: { email: field("email"), role, id: field("invitation"), batch: field("batch") },
      });
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
