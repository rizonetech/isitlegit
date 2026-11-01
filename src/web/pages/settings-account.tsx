// The Account page's routes (D07 T08 §3; design/SPEC.md M9): `GET /settings/account` draws the signed-in member's own
// name, email, passkeys and sessions from the stored rows, scoped to the member; `POST /settings/account` saves a changed
// name through Better Auth's own handler in process (its hooks run), then answers 303 back with what happened, signed for
// the member and ten minutes (post, redirect, get). The page is ./settings-account-view.tsx. Removing a passkey or a
// session and adding or renaming a passkey are D07 T08 §13 and §14.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readSmallForm } from "../../auth/form";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { NAME_LIMIT } from "../../auth/names";
import { activeMembership } from "../../auth/org";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import {
  AccountPage,
  type AccountPasskey,
  type AccountSession,
  deviceOf,
  OUTCOMES,
  type Outcome,
} from "./settings-account-view";

export const accountRoutes = new Hono<GateEnv>();

const PATH = "/settings/account";

function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "account", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: PATH });
}
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
        `SELECT id, name, "deviceType" AS deviceType, "createdAt" AS added FROM "passkey" WHERE "userId" = ? ORDER BY "createdAt" DESC, id`,
      )
      .bind(userId)
      .all<{ id: string; name: string | null; deviceType: string; added: string | number | null }>(),
    db
      .prepare(
        `SELECT id, "userAgent" AS ua, "createdAt" AS created, "updatedAt" AS updated FROM "session" WHERE "userId" = ? AND "expiresAt" > ? ORDER BY "updatedAt" DESC, id`,
      )
      .bind(userId, new Date().toISOString())
      .all<{ id: string; ua: string | null; created: string | number; updated: string | number }>(),
  ]);
  const keys: AccountPasskey[] = passkeys.results.map((k, n) => ({
    id: k.id,
    name: k.name?.trim() || `Passkey ${passkeys.results.length - n}`,
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

// The member frame when they have an active organisation, else none (the account is theirs whatever the organisation).
async function frameFor(env: Env, signedIn: SignedIn) {
  const membership = await activeMembership(env, signedIn);
  if (membership.ok) return { shell: await memberShell(env.DB, signedIn.user, membership.org.id, "account") };
  if (membership.reason === "unavailable") throw new Error("membership");
  return { shell: null };
}

accountRoutes.get(
  PATH,
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    try {
      const [{ shell }, account, outcome] = await Promise.all([
        frameFor(c.env, signedIn),
        readAccount(c.env.DB, signedIn),
        outcomeOf(c.env.BETTER_AUTH_SECRET ?? "", signedIn.user.id, new URL(c.req.url)),
      ]);
      return html(<AccountPage shell={shell} user={signedIn.user} {...account} outcome={outcome} now={new Date()} />);
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
    const form = await readSmallForm(c.req.raw, { action: 20, name: NAME_LIMIT * 4 });
    if (!form || form.action !== "name") return back(secret, signedIn.user.id, { r: "refused" });
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
