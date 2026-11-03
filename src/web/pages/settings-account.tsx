// The Account page's routes (D07 T08 §3; design/SPEC.md M9): `GET /settings/account` draws the signed-in member's own
// name, email, passkeys and sessions from the stored rows, scoped to the member; `POST /settings/account` saves a changed
// name through Better Auth's own handler in process (its hooks run), then answers 303 back with what happened, signed for
// the member and ten minutes (post, redirect, get). The page is ./settings-account-view.tsx. Removing a passkey or a
// session and adding or renaming a passkey are D07 T08 §13 and §14.
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { closeOrganisation, organisationClosedAt } from "../../auth/closure";
import { readSmallForm } from "../../auth/form";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { NAME_LIMIT, nameFits } from "../../auth/names";
import { activeMembership } from "../../auth/org";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import {
  AccountConfirm,
  AccountPage,
  type AccountPasskey,
  type AccountProps,
  type AccountSession,
  deviceOf,
  OUTCOMES,
  type Outcome,
  PasskeyRename,
} from "./settings-account-view";

export const accountRoutes = new Hono<GateEnv>();

const PATH = "/settings/account";
// The credential id a browser makes (base64url).
const CREDENTIAL = /^[A-Za-z0-9_-]{1,1024}$/;

function outage(why: string, retry = PATH) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "account", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry });
}
// Where an outage's Try again goes: the Account page, and for the read back of a lost add the same read back, so the
// credential it names is not lost to the outage (whether the session or the passkeys could not be read).
const retryOf = (url: string) => {
  const q = new URL(url).searchParams;
  const cred = q.get("cred") ?? "";
  return q.get("reconcile") === "add" && CREDENTIAL.test(cred)
    ? `${PATH}?reconcile=add&cred=${encodeURIComponent(cred)}`
    : PATH;
};
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });

// What a change did, carried in the redirect and signed over the member and the moment.
const OUTCOME_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`account-result\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
async function back(secret: string, userId: string, outcome: Outcome) {
  const at = Date.now();
  const query = new URLSearchParams({ r: outcome.r, t: String(at) });
  // The name a failed save was asked to make, bounded, so the field keeps it for another try.
  const typed = outcome.name ? Array.from(outcome.name).slice(0, NAME_LIMIT).join("") : "";
  if (typed) query.set("n", typed);
  query.set("s", await sign(secret, [userId, outcome.r, typed, String(at)].join("\n")));
  return new Response(null, { status: 303, headers: { ...HEADERS, location: `${PATH}?${query}` } });
}
async function outcomeOf(secret: string, userId: string, url: URL): Promise<Outcome | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const at = Number(q.get("t"));
  if (!r || !(OUTCOMES as readonly string[]).includes(r) || !Number.isFinite(at)) return null;
  if (Date.now() - at > OUTCOME_TTL_MS || at > Date.now() + 60_000) return null;
  const typed = q.get("n") ?? "";
  if (Array.from(typed).length > NAME_LIMIT) return null;
  return q.get("s") === (await sign(secret, [userId, r, typed, String(at)].join("\n")))
    ? { r: r as Outcome["r"], ...(typed ? { name: typed } : {}) }
    : null;
}

const iso = (value: string | number | null) => (value === null ? null : new Date(value).toISOString());

// The member's own passkeys and sessions, newest first. `signedIn.session.id` marks this device.
export async function readAccount(db: D1Database, signedIn: SignedIn) {
  const userId = signedIn.user.id;
  const [passkeys, sessions] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, "credentialID" AS cred, "deviceType" AS deviceType, "createdAt" AS added FROM "passkey" WHERE "userId" = ? ORDER BY "createdAt" DESC, id`,
      )
      .bind(userId)
      .all<{ id: string; name: string | null; cred: string; deviceType: string; added: string | number | null }>(),
    db
      .prepare(
        `SELECT id, "userAgent" AS ua, "createdAt" AS created, "updatedAt" AS updated FROM "session" WHERE "userId" = ? AND "expiresAt" > ? ORDER BY "updatedAt" DESC, id`,
      )
      .bind(userId, new Date().toISOString())
      .all<{ id: string; ua: string | null; created: string | number; updated: string | number }>(),
  ]);
  const keys: AccountPasskey[] = passkeys.results.map((k) => ({
    id: k.id,
    credentialId: k.cred,
    name: k.name?.trim() || "Unnamed passkey",
    addedAt: iso(k.added),
    deviceType: k.deviceType,
  }));
  const rows: AccountSession[] = sessions.results.map((s) => ({
    id: s.id,
    device: deviceOf(s.ua),
    current: s.id === signedIn.session.id,
    signedInAt: new Date(s.created).toISOString(),
    lastActiveAt: new Date(s.updated).toISOString(),
  }));
  return { passkeys: keys, sessions: rows };
}

// The closure state of the session's active organisation, read directly (a closed one is no longer an active
// membership): its name, the member's role there, and when it was closed.
export const FRESH_MS = 10 * 60_000;
// Fresh means authenticated within the last ten minutes, from the session's creation (its authentication), never
// its activity: a renewed or long-lived session is not fresh (D07 T02 §26).
export const freshSession = (signedIn: SignedIn, now = new Date()) =>
  now.getTime() - new Date(signedIn.session.createdAt).getTime() < FRESH_MS;

async function closureFor(env: Env, signedIn: SignedIn, wanted?: string | null) {
  const orgId = wanted ?? (signedIn.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  if (!orgId) return undefined;
  const [org, member, closedAt] = await Promise.all([
    env.DB.prepare(`SELECT name FROM "organization" WHERE id = ?`).bind(orgId).first<{ name: string }>(),
    env.DB.prepare(`SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
      .bind(orgId, signedIn.user.id)
      .first<{ role: string }>(),
    organisationClosedAt(env.DB, orgId),
  ]);
  if (!org || !member) return undefined;
  return { orgId, orgName: org.name, role: member.role, closedAt };
}

// The member frame when they have an active organisation, else none (the account is theirs whatever the organisation).
async function frameFor(env: Env, signedIn: SignedIn) {
  const membership = await activeMembership(env, signedIn);
  if (membership.ok) return { shell: await memberShell(env.DB, signedIn.user, membership.org.id, "account") };
  if (membership.reason === "unavailable") throw new Error("membership");
  return { shell: null };
}

accountRoutes.get(
  PATH,
  sessionGate((request) => outage("session", retryOf(request.url))),
  async (c) => {
    const signedIn = c.get("signedIn");
    try {
      const url = new URL(c.req.url);
      const [{ shell }, account, outcome, closure] = await Promise.all([
        frameFor(c.env, signedIn),
        readAccount(c.env.DB, signedIn),
        outcomeOf(c.env.BETTER_AUTH_SECRET ?? "", signedIn.user.id, url),
        closureFor(c.env, signedIn),
      ]);
      // A passkey add whose answer never came: the page names the credential the device made (`cred`), so the stored passkey
      // with that credential is the one just saved, offered for naming; none is not "nothing was saved" (the request may still
      // be finishing) but "not yet", with a way to check again. Another passkey
      // added meanwhile, here or on another device, is never taken for it.
      let reconcile: AccountProps["reconcile"];
      const cred = url.searchParams.get("cred") ?? "";
      if (url.searchParams.get("reconcile") === "add" && CREDENTIAL.test(cred)) {
        const saved = account.passkeys.find((k) => k.credentialId === cred);
        reconcile = saved ? { kind: "added", id: saved.id, name: saved.name } : { kind: "none", cred };
      }
      return html(
        <AccountPage
          shell={shell}
          user={signedIn.user}
          {...account}
          outcome={outcome}
          reconcile={reconcile}
          closure={closure}
          now={new Date()}
        />,
      );
    } catch (error) {
      return outage(
        (error as Error).name === "Error" ? (error as Error).message : (error as Error).name,
        retryOf(c.req.url),
      );
    }
  },
);

accountRoutes.get(
  "/settings/account/close",
  sessionGate(() => outage("session")),
  (c) =>
    confirmPage(c, async () => {
      const closure = await closureFor(c.env, c.get("signedIn"), new URL(c.req.url).searchParams.get("org"));
      if (!closure) return { r: "gone" };
      if (closure.role !== "owner") return { r: "refused" };
      if (closure.closedAt) return { r: "org-closed" };
      if (!freshSession(c.get("signedIn")))
        return {
          title: `Sign in again to close ${closure.orgName}`,
          lines: [
            `For a change this final, sign in again first: your last sign-in was more than ten minutes ago.`,
            `You will come back to this confirmation for ${closure.orgName}, and nothing is closed until you press Close account there.`,
          ],
          action: "step-up",
          id: closure.orgId,
          label: "Sign in again",
        };
      const deletion = new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-GB", {
        timeZone: "Africa/Johannesburg",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      return {
        confirm: await sign(c.env.BETTER_AUTH_SECRET ?? "", `${c.get("signedIn").user.id}\nclose\n${closure.orgId}`),
        title: `Close ${closure.orgName}?`,
        lines: [
          `${closure.orgName} will refuse new cases at once, and its members will no longer be able to open it.`,
          `Its stored mail, cases and history will be deleted by ${deletion} (within 30 days of closing). This cannot be undone.`,
        ],
        action: "close-account",
        id: closure.orgId,
        label: "Close account",
        extra: {
          href: `/settings/account/close/export?org=${closure.orgId}`,
          label: "Download the case summaries first",
        },
      };
    }),
);

// The case-summary export (D07 T02 §26): every case of the organisation as one CSV, for its owner only, open or
// closed. Read in pages until none are left, so no case is silently omitted.
accountRoutes.get(
  "/settings/account/close/export",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const closure = await closureFor(c.env, signedIn, new URL(c.req.url).searchParams.get("org"));
    if (!closure) return errorPage(404, "", { email: signedIn.user.email });
    if (closure.role !== "owner") return errorPage(403, "", { email: signedIn.user.email });
    const rows: string[] = ["case,received,status,verdict"];
    const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    try {
      for (let offset = 0; ; offset += 500) {
        const page = await c.env.DB.prepare(
          `SELECT id, created_at, status, verdict FROM cases WHERE org_id = ? ORDER BY created_at, id LIMIT 500 OFFSET ?`,
        )
          .bind(closure.orgId, offset)
          .all<{ id: string; created_at: string; status: string; verdict: string | null }>();
        for (const r of page.results) rows.push([r.id, r.created_at, r.status, r.verdict ?? ""].map(csv).join(","));
        if (page.results.length < 500) break;
      }
    } catch {
      return outage("export", "/settings/account/close");
    }
    return c.body(`${rows.join("\n")}\n`, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cases-${closure.orgId}.csv"`,
    });
  },
);

// The three destructive changes, through Better Auth's own handler in process. Whatever the answer, the result is read from
// the stored rows before it is told: gone is done, still there is not, a partial sign-out is said as partial, and a read that
// cannot be made is its own unresolved state.
async function change(c: Context<GateEnv>, action: string, id: string) {
  const signedIn = c.get("signedIn");
  const secret = c.env.BETTER_AUTH_SECRET ?? "";
  const userId = signedIn.user.id;
  const origin = new URL(c.env.APP_URL).origin;
  const call = (path: string, body: object) => {
    const headers = new Headers({ "content-type": "application/json", origin });
    for (const field of ["cookie", "cf-connecting-ip", "user-agent"]) {
      const value = c.req.header(field);
      if (value) headers.set(field, value);
    }
    return createAuth(c.env).handler(
      new Request(`${origin}${"/api/auth/"}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  };
  const signin = () =>
    new Response(null, { status: 303, headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent(PATH)}` } });
  const unresolved = () => back(secret, userId, { r: "unresolved" });
  try {
    if (action === "remove-passkey") {
      if (!(await ownPasskey(c.env.DB, userId, id))) return back(secret, userId, { r: "gone" });
      const res = await call("passkey/delete-passkey", { id }).catch(() => null);
      if (res && (res.status === 401 || res.status === 403)) return signin();
      try {
        const left = await ownPasskey(c.env.DB, userId, id);
        return back(secret, userId, left ? { r: "passkey-still" } : { r: "passkey-removed" });
      } catch {
        return unresolved();
      }
    }
    if (action === "sign-out-session") {
      const row = await ownSession(c.env.DB, userId, id);
      if (!row) return back(secret, userId, { r: "gone" });
      if (row.id === signedIn.session.id) return back(secret, userId, { r: "this-device" });
      const res = await call("revoke-session", { token: row.token }).catch(() => null);
      if (res && (res.status === 401 || res.status === 403)) return signin();
      try {
        const left = await ownSession(c.env.DB, userId, id);
        return back(secret, userId, left ? { r: "session-still" } : { r: "session-out" });
      } catch {
        return unresolved();
      }
    }
    // Every other session: the ones open before are named, and the ones open after are compared by identity, so a sign-in
    // made elsewhere meanwhile is neither a removal nor a failure to remove.
    const openOthers = async () =>
      new Set(
        (
          await c.env.DB.prepare(`SELECT id FROM "session" WHERE "userId" = ? AND id <> ? AND "expiresAt" > ?`)
            .bind(userId, signedIn.session.id, new Date().toISOString())
            .all<{ id: string }>()
        ).results.map((r) => r.id),
      );
    let before: Set<string>;
    try {
      before = await openOthers();
    } catch {
      return unresolved();
    }
    const res = await call("revoke-other-sessions", {}).catch(() => null);
    if (res && (res.status === 401 || res.status === 403)) return signin();
    try {
      const after = await openOthers();
      const left = [...before].filter((id) => after.has(id)).length;
      return back(
        secret,
        userId,
        left === 0 ? { r: "others-out" } : left < before.size ? { r: "partial" } : { r: "others-none" },
      );
    } catch {
      return unresolved();
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "account", outcome: "change-failed", error: (error as Error).name }));
    return unresolved();
  }
}

// The member's own passkey or session, by id, or null: another member's id and an expired session read as nothing.
const ownPasskey = (db: D1Database, userId: string, id: string) =>
  db
    .prepare(`SELECT id, name FROM "passkey" WHERE id = ? AND "userId" = ?`)
    .bind(id, userId)
    .first<{ id: string; name: string | null }>();
const ownSession = (db: D1Database, userId: string, id: string) =>
  db
    .prepare(`SELECT id, token, "userAgent" AS ua FROM "session" WHERE id = ? AND "userId" = ? AND "expiresAt" > ?`)
    .bind(id, userId, new Date().toISOString())
    .first<{ id: string; token: string; ua: string | null }>();
const ID = "{[A-Za-z0-9_-]{1,64}}";

const otherSessions = async (db: D1Database, userId: string, current: string) =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ? AND id <> ? AND "expiresAt" > ?`)
      .bind(userId, current, new Date().toISOString())
      .first<{ n: number }>()
  )?.n ?? 0;

async function confirmPage(
  c: Context<GateEnv>,
  build: (userId: string) => Promise<
    | {
        title: string;
        lines: string[];
        action: string;
        id: string;
        label: string;
        confirm?: string;
        extra?: { href: string; label: string };
      }
    | Outcome
  >,
) {
  const signedIn = c.get("signedIn");
  try {
    const [{ shell }, made] = await Promise.all([frameFor(c.env, signedIn), build(signedIn.user.id)]);
    if ("r" in made) return back(c.env.BETTER_AUTH_SECRET ?? "", signedIn.user.id, made);
    return html(<AccountConfirm shell={shell} {...made} />);
  } catch (error) {
    return outage((error as Error).name === "Error" ? (error as Error).message : (error as Error).name);
  }
}

accountRoutes.get(
  `/settings/account/passkeys/:id${ID}/remove`,
  sessionGate(() => outage("session")),
  (c) =>
    confirmPage(c, async (userId) => {
      const key = await ownPasskey(c.env.DB, userId, c.req.param("id"));
      if (!key) return { r: "gone" };
      const name = key.name?.trim() || "this passkey";
      return {
        title: `Remove ${name}?`,
        lines: [
          `You will no longer be able to sign in with ${name}. You can still sign in with an email link, and you can add a passkey again.`,
          "Removing it here does not remove it from your device's password manager: remove it there too. Signed-in sessions are separate: use Sign out other sessions to end those.",
        ],
        action: "remove-passkey",
        id: key.id,
        label: "Remove passkey",
        ...((await otherSessions(c.env.DB, userId, c.get("signedIn").session.id)) > 0
          ? { extra: { href: "/settings/account/sessions/sign-out-others", label: "Sign out other sessions" } }
          : {}),
      };
    }),
);
accountRoutes.get(
  `/settings/account/sessions/:id${ID}/sign-out`,
  sessionGate(() => outage("session")),
  (c) =>
    confirmPage(c, async (userId) => {
      const row = await ownSession(c.env.DB, userId, c.req.param("id"));
      if (!row) return { r: "gone" };
      if (row.id === c.get("signedIn").session.id) return { r: "this-device" };
      const device = deviceOf(row.ua);
      return {
        title: `Sign out ${device}?`,
        lines: [`${device} will be signed out at once. It can sign in again with an email link or a passkey.`],
        action: "sign-out-session",
        id: row.id,
        label: "Sign out session",
      };
    }),
);
accountRoutes.get(
  "/settings/account/sessions/sign-out-others",
  sessionGate(() => outage("session")),
  (c) =>
    confirmPage(c, async () => ({
      title: "Sign out every other session?",
      lines: [
        "Every place you are signed in except this one is signed out at once. This device stays signed in.",
        "Passkeys are not removed: they stay on your account.",
      ],
      action: "sign-out-others",
      id: "others",
      label: "Sign out other sessions",
    })),
);

// Renaming a passkey through Better Auth's own handler in process (its name rule runs there too, src/auth/auth.ts). The
// outcome is told from the stored name, whatever the answer: the name asked for is renamed, anything else is not, and a
// read that cannot be made is its own unresolved state.
async function renamePasskey(c: Context<GateEnv>, id: string, typed: string) {
  const signedIn = c.get("signedIn");
  const secret = c.env.BETTER_AUTH_SECRET ?? "";
  const userId = signedIn.user.id;
  const name = typed.trim();
  try {
    const key = await ownPasskey(c.env.DB, userId, id);
    if (!key) return back(secret, userId, { r: "gone" });
    const refuse = async (error: string) => {
      const { shell } = await frameFor(c.env, signedIn);
      return html(
        <PasskeyRename
          shell={shell}
          id={key.id}
          name={key.name?.trim() ?? ""}
          added={false}
          draft={{ name: typed, error }}
        />,
        400,
      );
    };
    if (!name) return refuse("Enter a name for this passkey.");
    if (!nameFits(typed)) return refuse(`A name is one line of at most ${NAME_LIMIT} characters.`);
    const origin = new URL(c.env.APP_URL).origin;
    const headers = new Headers({ "content-type": "application/json", origin });
    for (const field of ["cookie", "cf-connecting-ip", "user-agent"]) {
      const value = c.req.header(field);
      if (value) headers.set(field, value);
    }
    const res = await createAuth(c.env)
      .handler(
        new Request(`${origin}/api/auth/passkey/update-passkey`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: key.id, name }),
        }),
      )
      .catch(() => null);
    if (res && (res.status === 401 || res.status === 403)) {
      return new Response(null, {
        status: 303,
        headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent(PATH)}` },
      });
    }
    try {
      const now = await ownPasskey(c.env.DB, userId, id);
      if (!now) return back(secret, userId, { r: "gone" });
      const stored = now.name?.trim() ?? "";
      return back(secret, userId, stored === name ? { r: "passkey-renamed" } : { r: "rename-still", name: stored });
    } catch {
      return back(secret, userId, { r: "unresolved" });
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "account", outcome: "rename-failed", error: (error as Error).name }));
    return back(secret, userId, { r: "unresolved" });
  }
}

accountRoutes.get(
  `/settings/account/passkeys/:id${ID}/rename`,
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    try {
      const [{ shell }, key] = await Promise.all([
        frameFor(c.env, signedIn),
        ownPasskey(c.env.DB, signedIn.user.id, c.req.param("id")),
      ]);
      if (!key) return back(c.env.BETTER_AUTH_SECRET ?? "", signedIn.user.id, { r: "gone" });
      return html(
        <PasskeyRename
          shell={shell}
          id={key.id}
          name={key.name?.trim() ?? ""}
          added={new URL(c.req.url).searchParams.get("added") === "1"}
        />,
      );
    } catch (error) {
      return outage((error as Error).name === "Error" ? (error as Error).message : (error as Error).name);
    }
  },
);

accountRoutes.post(
  PATH,
  sessionGate(() => outage("session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site, or a post with no origin, changes nothing.
    const origin = new URL(c.env.APP_URL).origin;
    if (c.req.header("origin") !== origin) return new Response("Forbidden", { status: 403, headers: HEADERS });
    const signedIn = c.get("signedIn");
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const form = await readSmallForm(c.req.raw, { action: 20, name: NAME_LIMIT * 4, id: 100, confirm: 120 });
    if (form && ["remove-passkey", "sign-out-session", "sign-out-others"].includes(form.action ?? ""))
      return change(c, form.action as string, form.id ?? "");
    if (form?.action === "step-up")
      return c.redirect(`/signin?next=${encodeURIComponent(`/settings/account/close?org=${form.id ?? ""}`)}`, 303);
    if (form?.action === "close-account") {
      if (!freshSession(signedIn)) return back(secret, signedIn.user.id, { r: "step-up" });
      // Only the confirmation page's own signed evidence closes an organisation: a bare action-and-id post does not.
      const evidence = await sign(secret, `${signedIn.user.id}\nclose\n${form.id ?? ""}`);
      if (!form.confirm || form.confirm !== evidence) return back(secret, signedIn.user.id, { r: "refused" });
      try {
        const closed = await closeOrganisation(c.env.DB, form.id ?? "", signedIn.user.id, new Date());
        return back(secret, signedIn.user.id, closed.ok ? { r: "org-closed" } : { r: "refused" });
      } catch {
        // A failure after the stamp committed reads back as closed; anything else is unresolved, never a 500
        // whose retry lands on a page closure now forbids.
        const stamped = await organisationClosedAt(c.env.DB, form.id ?? "").catch(() => null);
        return back(secret, signedIn.user.id, stamped ? { r: "org-closed" } : { r: "unresolved" });
      }
    }
    if (form?.action === "rename-passkey") return renamePasskey(c, form.id ?? "", form.name ?? "");
    if (form?.action !== "name") return back(secret, signedIn.user.id, { r: "refused" });
    const name = (form.name ?? "").trim();
    const refuse = async (error: string) => {
      try {
        const [{ shell }, account] = await Promise.all([frameFor(c.env, signedIn), readAccount(c.env.DB, signedIn)]);
        return html(
          <AccountPage
            shell={shell}
            user={signedIn.user}
            {...account}
            outcome={null}
            draft={{ name: form.name ?? "", error }}
            now={new Date()}
          />,
          400,
        );
      } catch (failure) {
        return outage((failure as Error).name);
      }
    };
    if (!name) return refuse("Enter your name.");
    try {
      const headers = new Headers({ "content-type": "application/json", origin });
      for (const field of ["cookie", "cf-connecting-ip", "user-agent"]) {
        const value = c.req.header(field);
        if (value) headers.set(field, value);
      }
      const res = await createAuth(c.env).handler(
        new Request(`${origin}/api/auth/update-user`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: form.name ?? "" }),
        }),
      );
      if (res.ok) return back(secret, signedIn.user.id, { r: "saved" });
      // Better Auth's own rule for a name (src/auth/names.ts): one line of at most NAME_LIMIT characters, no control
      // characters. Its refusal is the field's error, the typed name kept.
      if (res.status === 400) return refuse(`A name is one line of at most ${NAME_LIMIT} characters.`);
      if (res.status === 401)
        return new Response(null, {
          status: 303,
          headers: { ...HEADERS, location: `/signin?next=${encodeURIComponent(PATH)}` },
        });
      console.log(JSON.stringify({ event: "account", outcome: "name-failed", status: res.status }));
      return back(secret, signedIn.user.id, { r: "failed", name });
    } catch (error) {
      console.log(JSON.stringify({ event: "account", outcome: "name-failed", error: (error as Error).name }));
      return back(secret, signedIn.user.id, { r: "failed", name });
    }
  },
);
